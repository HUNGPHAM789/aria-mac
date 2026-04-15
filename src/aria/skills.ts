import { writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { upsertSkill, getAllSkills } from '../db/index';
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
  if (!content.trim()) throw new SkillValidationError('content_empty', 'content required');
  if (content.length > CONTENT_MAX) {
    throw new SkillValidationError('content_too_large', `content must be ≤${CONTENT_MAX} chars`);
  }

  // Require frontmatter; reject content that's just raw markdown.
  parseFrontmatter(content);

  // Collision check.
  const filePath = join(SKILLS_DIR, `${name}.md`);
  const subdirPath = join(SKILLS_DIR, name, 'SKILL.md');
  if (existsSync(filePath) || existsSync(subdirPath)) {
    throw new SkillValidationError('name_collision', `skill '${name}' already exists`);
  }

  // Security scan BEFORE write. Hermes scans post-write with rollback; we pre-scan
  // because our flat file layout makes pre-scan trivial and avoids the rollback race.
  const scan = scanSkillContent(content);
  if (scan.verdict === 'dangerous') {
    throw new SkillValidationError('security_blocked', `skill content failed security scan: ${scan.summary}`);
  }

  atomicWrite(filePath, content);

  // Register in SQLite (search index + listing).
  upsertSkill(name, description, content);

  const cautionNote = scan.verdict === 'caution' ? ` (caution: ${scan.summary})` : '';
  console.log(`[ARIA] Skill created: ${name} → ${filePath}${cautionNote}`);
  return { filePath, name, scan };
}

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
