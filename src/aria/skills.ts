import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { upsertSkill, getAllSkills, deleteSkillRow } from '../db/index';
import { scanSkillContent, type ScanResult } from './skills-guard.js';

const SKILLS_DIR = join(homedir(), '.claude', 'skills');

// Hermes-parity constraints (agent/skill_commands.py L99-174).
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const CONTENT_MAX = 100_000;

export interface SkillDefinition {
  skill_name: string;
  description: string;
  content: string;
}

export class SkillValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

function validateName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!name) throw new SkillValidationError('name_empty', 'skill_name required');
  if (name.length > NAME_MAX) throw new SkillValidationError('name_too_long', `skill_name must be ≤${NAME_MAX} chars`);
  if (!NAME_RE.test(name)) {
    throw new SkillValidationError(
      'name_invalid',
      `skill_name must match ${NAME_RE} (lowercase alnum, dots, dashes, underscores; starts alnum)`,
    );
  }
  return name;
}

interface Frontmatter {
  name: string;
  description: string;
  body: string;
}

// Minimal frontmatter parser — avoids a js-yaml dep. Hermes checks the same 4 things:
// starts with ---, closing ---, has name + description, description ≤1024 chars, body after.
function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith('---')) {
    throw new SkillValidationError('frontmatter_missing', 'content must start with --- frontmatter block');
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    throw new SkillValidationError('frontmatter_unterminated', 'frontmatter block has no closing ---');
  }
  const fm = content.slice(3, end).trim();
  const body = content.slice(end + 4).trim();
  if (!body) {
    throw new SkillValidationError('body_empty', 'skill must have markdown body after frontmatter');
  }
  const fields: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  const name = fields.name;
  const description = fields.description;
  if (!name) throw new SkillValidationError('frontmatter_no_name', 'frontmatter missing name field');
  if (!description) throw new SkillValidationError('frontmatter_no_description', 'frontmatter missing description field');
  if (description.length > DESCRIPTION_MAX) {
    throw new SkillValidationError('description_too_long', `description must be ≤${DESCRIPTION_MAX} chars`);
  }
  return { name, description, body };
}

// Run all content-level validations + security scan. Shared by create/edit/patch so
// changes go through the same gate regardless of which mutation path.
function validateAndScan(content: string, { requireFrontmatter = true }: { requireFrontmatter?: boolean } = {}): { frontmatter: Frontmatter | null; scan: ScanResult } {
  if (!content.trim()) throw new SkillValidationError('content_empty', 'content required');
  if (content.length > CONTENT_MAX) {
    throw new SkillValidationError('content_too_large', `content must be ≤${CONTENT_MAX} chars`);
  }
  const frontmatter = requireFrontmatter ? parseFrontmatter(content) : null;
  const scan = scanSkillContent(content);
  if (scan.verdict === 'dangerous') {
    throw new SkillValidationError('security_blocked', `content failed security scan: ${scan.summary}`);
  }
  return { frontmatter, scan };
}

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, filePath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

// Resolve the on-disk location for an existing skill. Returns both candidate paths
// and flags which exists (flat .md vs subdir SKILL.md). Throws if neither exists.
interface ResolvedSkill {
  name: string;
  flat: string;
  sub: string;
  subDir: string;
  path: string;
  isSubdir: boolean;
}

function resolveExistingSkill(rawName: string): ResolvedSkill {
  const name = validateName(rawName);
  const flat = join(SKILLS_DIR, `${name}.md`);
  const subDir = join(SKILLS_DIR, name);
  const sub = join(subDir, 'SKILL.md');
  const flatExists = existsSync(flat);
  const subExists = existsSync(sub);
  if (!flatExists && !subExists) {
    throw new SkillValidationError('not_found', `skill '${name}' does not exist`);
  }
  const isSubdir = subExists;
  return { name, flat, sub, subDir, path: isSubdir ? sub : flat, isSubdir };
}

export interface CreateSkillResult {
  filePath: string;
  name: string;
  scan: ScanResult;
}

export function createSkill(skill: SkillDefinition): CreateSkillResult {
  const name = validateName(skill.skill_name);
  const description = (skill.description ?? '').trim();
  if (!description) throw new SkillValidationError('description_empty', 'description required');
  if (description.length > DESCRIPTION_MAX) {
    throw new SkillValidationError('description_too_long', `description must be ≤${DESCRIPTION_MAX} chars`);
  }

  const content = skill.content ?? '';
  const { scan } = validateAndScan(content);

  // Collision check.
  const filePath = join(SKILLS_DIR, `${name}.md`);
  const subdirPath = join(SKILLS_DIR, name, 'SKILL.md');
  if (existsSync(filePath) || existsSync(subdirPath)) {
    throw new SkillValidationError('name_collision', `skill '${name}' already exists`);
  }

  atomicWrite(filePath, content);
  upsertSkill(name, description, content);

  const cautionNote = scan.verdict === 'caution' ? ` (caution: ${scan.summary})` : '';
  console.log(`[ARIA] Skill created: ${name} → ${filePath}${cautionNote}`);
  return { filePath, name, scan };
}

// ── Edit ─────────────────────────────────────────────────────────────────────
// Replace the entire SKILL.md. New content must pass the same create-time gates.

export interface EditSkillArgs { skill_name: string; content: string; }
export interface EditSkillResult { filePath: string; name: string; scan: ScanResult; }

export function editSkill({ skill_name, content }: EditSkillArgs): EditSkillResult {
  const resolved = resolveExistingSkill(skill_name);
  const { frontmatter, scan } = validateAndScan(content);
  atomicWrite(resolved.path, content);
  upsertSkill(resolved.name, frontmatter!.description, content);
  const cautionNote = scan.verdict === 'caution' ? ` (caution: ${scan.summary})` : '';
  console.log(`[ARIA] Skill edited: ${resolved.name}${cautionNote}`);
  return { filePath: resolved.path, name: resolved.name, scan };
}

// ── Patch ────────────────────────────────────────────────────────────────────
// Exact-string find-and-replace (Claude-Code Edit-tool semantics). Hermes uses
// fuzzy match; we ship exact for MVP — upgrade later if the model hits edge cases.
// file_path optional — targets SKILL.md by default; references/*.md if specified.

export interface PatchSkillArgs {
  skill_name: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  file_path?: string; // relative to skill's directory (subdir skills only)
}
export interface PatchSkillResult { filePath: string; name: string; replacements: number; scan: ScanResult; }

export function patchSkill(args: PatchSkillArgs): PatchSkillResult {
  const resolved = resolveExistingSkill(args.skill_name);
  const { old_string, new_string, replace_all = false, file_path } = args;

  if (!old_string) throw new SkillValidationError('old_string_empty', 'old_string required');
  if (old_string === new_string) throw new SkillValidationError('noop_patch', 'old_string === new_string');

  let targetPath: string;
  if (file_path) {
    if (!resolved.isSubdir) {
      throw new SkillValidationError('file_path_on_flat', `file_path only valid for subdir skills; '${resolved.name}' is a flat skill`);
    }
    // Prevent path traversal — must stay inside the skill subdir.
    if (file_path.includes('..') || file_path.startsWith('/')) {
      throw new SkillValidationError('path_traversal', 'file_path must be relative and stay inside skill directory');
    }
    targetPath = join(resolved.subDir, file_path);
    if (!existsSync(targetPath)) throw new SkillValidationError('file_not_found', `file '${file_path}' does not exist in skill '${resolved.name}'`);
  } else {
    targetPath = resolved.path;
  }

  const before = readFileSync(targetPath, 'utf-8');
  let replacements = 0;
  let after: string;
  if (replace_all) {
    after = before.split(old_string).join(new_string);
    replacements = (before.length - after.length + (new_string.length - old_string.length)) === 0
      ? 0
      : before.split(old_string).length - 1;
  } else {
    const first = before.indexOf(old_string);
    if (first === -1) throw new SkillValidationError('old_string_not_found', 'old_string not found — check exact whitespace and quoting');
    const last = before.lastIndexOf(old_string);
    if (first !== last) throw new SkillValidationError('old_string_ambiguous', 'old_string appears multiple times — pass replace_all=true or include more context');
    after = before.slice(0, first) + new_string + before.slice(first + old_string.length);
    replacements = 1;
  }

  if (replacements === 0) {
    throw new SkillValidationError('no_replacement', 'old_string matched 0 times after normalization');
  }

  // If we patched SKILL.md, re-run full validation. Support-file patches only
  // need a size + security scan, not frontmatter.
  const patchedSkillMd = targetPath === resolved.path;
  const { frontmatter, scan } = validateAndScan(after, { requireFrontmatter: patchedSkillMd });

  atomicWrite(targetPath, after);
  if (patchedSkillMd) {
    upsertSkill(resolved.name, frontmatter!.description, after);
  }

  const cautionNote = scan.verdict === 'caution' ? ` (caution: ${scan.summary})` : '';
  console.log(`[ARIA] Skill patched: ${resolved.name} (${replacements} replacement${replacements === 1 ? '' : 's'})${cautionNote}`);
  return { filePath: targetPath, name: resolved.name, replacements, scan };
}

// ── Delete ───────────────────────────────────────────────────────────────────

export interface DeleteSkillResult { name: string; removed: 'flat' | 'subdir'; path: string; }

export function deleteSkill(skill_name: string): DeleteSkillResult {
  const resolved = resolveExistingSkill(skill_name);
  const removed: 'flat' | 'subdir' = resolved.isSubdir ? 'subdir' : 'flat';
  const path = resolved.isSubdir ? resolved.subDir : resolved.flat;
  if (resolved.isSubdir) {
    rmSync(resolved.subDir, { recursive: true, force: true });
  } else {
    unlinkSync(resolved.flat);
  }
  deleteSkillRow(resolved.name);
  console.log(`[ARIA] Skill deleted: ${resolved.name} (${removed}) → ${path}`);
  return { name: resolved.name, removed, path };
}

// ── Read helpers ─────────────────────────────────────────────────────────────

export function listSkills(): { skill_name: string; description: string }[] {
  return getAllSkills();
}

export function loadSkillFile(name: string): string | null {
  const flat = join(SKILLS_DIR, `${name}.md`);
  if (existsSync(flat)) return readFileSync(flat, 'utf-8');
  const sub = join(SKILLS_DIR, name, 'SKILL.md');
  if (existsSync(sub)) return readFileSync(sub, 'utf-8');
  return null;
}
