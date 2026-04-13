import { readFileSync, existsSync, readdirSync, statSync, watch, type FSWatcher } from 'fs';
import { join, relative, extname, basename } from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { embedText } from './memory.js';
import { log } from './logger.js';
import {
  isVecEnabled,
  getActiveProjects,
  upsertProject,
  upsertCodebaseFile,
  getCodebaseFileByPath,
  listCodebaseFiles,
  upsertCodebaseEmbedding,
  hasCodebaseEmbedding,
  searchCodebaseEmbeddings,
  type Project,
  type CodebaseFile,
  type VecSearchHit,
} from '../db/index.js';

// ─── Key File Patterns ──────────────────────────────────────────────────
// Files that are most useful for understanding a project.

const KEY_FILE_PATTERNS: Array<{ pattern: RegExp; type: string; priority: number }> = [
  // Config & project identity
  { pattern: /^package\.json$/, type: 'config', priority: 10 },
  { pattern: /^tsconfig\.json$/, type: 'config', priority: 8 },
  { pattern: /^\.env\.example$/, type: 'config', priority: 7 },
  { pattern: /^next\.config\.(js|mjs|ts)$/, type: 'config', priority: 9 },
  { pattern: /^tailwind\.config\.(js|ts)$/, type: 'config', priority: 6 },
  { pattern: /^supabase\/.*\.sql$/, type: 'schema', priority: 8 },
  { pattern: /^prisma\/schema\.prisma$/, type: 'schema', priority: 9 },
  { pattern: /^drizzle\/.*\.ts$/, type: 'schema', priority: 8 },

  // Entry points & routes
  { pattern: /^(src\/)?app\/layout\.(tsx?|jsx?)$/, type: 'route', priority: 9 },
  { pattern: /^(src\/)?app\/page\.(tsx?|jsx?)$/, type: 'route', priority: 9 },
  { pattern: /^(src\/)?app\/api\/.*\/route\.(ts|js)$/, type: 'route', priority: 8 },
  { pattern: /^(src\/)?pages\/.*\.(tsx?|jsx?)$/, type: 'route', priority: 7 },
  { pattern: /^(src\/)?(index|main|app)\.(tsx?|jsx?|py)$/, type: 'code', priority: 9 },
  { pattern: /^bot\/(index|supervisor)\.(ts|js)$/, type: 'code', priority: 9 },

  // Core lib files
  { pattern: /^(src\/)?lib\/.*\.(ts|js)$/, type: 'code', priority: 6 },
  { pattern: /^(src\/)?utils?\/.*\.(ts|js)$/, type: 'code', priority: 5 },
  { pattern: /^(src\/)?services?\/.*\.(ts|js)$/, type: 'code', priority: 6 },
  { pattern: /^(src\/)?hooks?\/.*\.(ts|js)$/, type: 'code', priority: 5 },
  { pattern: /^(src\/)?components\/.*\.(tsx?|jsx?)$/, type: 'code', priority: 4 },

  // DB schemas
  { pattern: /schema\.sql$/, type: 'schema', priority: 8 },
  { pattern: /migrations?\/.*\.(sql|ts)$/, type: 'schema', priority: 6 },

  // Documentation
  { pattern: /^README\.md$/, type: 'readme', priority: 10 },
  { pattern: /^CLAUDE\.md$/, type: 'readme', priority: 9 },
  { pattern: /^docs\/.*\.md$/, type: 'readme', priority: 5 },
];

// Directories to always skip
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', '.vercel',
  '.turbo', 'coverage', '__pycache__', '.mypy_cache', 'vendor',
  '.svelte-kit', '.nuxt', '.output',
]);

// Max file size to index (50KB — bigger files are noise)
const MAX_FILE_SIZE = 50_000;
const MAX_FILES_PER_PROJECT = 80;

// ─── File Discovery ─────────────────────────────────────────────────────

interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  fileType: string;
  priority: number;
}

function discoverKeyFiles(projectPath: string): DiscoveredFile[] {
  if (!existsSync(projectPath)) return [];

  const found: DiscoveredFile[] = [];

  const walk = (dir: string, depth = 0) => {
    if (depth > 5) return; // don't recurse too deep
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.env.example') continue;
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }

      if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;

      const relPath = relative(projectPath, fullPath).replace(/\\/g, '/');

      // Check against key file patterns
      for (const kfp of KEY_FILE_PATTERNS) {
        if (kfp.pattern.test(relPath)) {
          found.push({
            absolutePath: fullPath,
            relativePath: relPath,
            fileType: kfp.type,
            priority: kfp.priority,
          });
          break;
        }
      }
    }
  };

  walk(projectPath);

  // Sort by priority descending, take top N
  return found
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_FILES_PER_PROJECT);
}

// ─── Index a Single Project ─────────────────────────────────────────────

async function indexProject(project: Project): Promise<{ indexed: number; unchanged: number }> {
  const files = discoverKeyFiles(project.path);
  let indexed = 0;
  let unchanged = 0;

  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f.absolutePath, 'utf-8');
    } catch { continue; }

    const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const existing = getCodebaseFileByPath(f.absolutePath);

    const fileId = upsertCodebaseFile(
      project.id,
      f.absolutePath,
      f.relativePath,
      f.fileType,
      content.length,
      contentHash,
    );

    // Skip if content unchanged and embedding exists
    if (existing && existing.content_hash === contentHash && isVecEnabled() && hasCodebaseEmbedding(fileId)) {
      unchanged++;
      continue;
    }

    // Embed the file with project context for better retrieval
    if (isVecEnabled()) {
      const embedContent = `Project: ${project.name} (${project.stack ?? 'unknown stack'})
File: ${f.relativePath} [${f.fileType}]

${content.slice(0, 6000)}`;

      const embedding = await embedText(embedContent);
      if (embedding) {
        upsertCodebaseEmbedding(fileId, embedding);
        indexed++;
      }
    }
  }

  return { indexed, unchanged };
}

// ─── Index All Active Projects ──────────────────────────────────────────

let _codebaseIndexing = false;

export async function indexAllCodebases(): Promise<void> {
  if (_codebaseIndexing) return;
  _codebaseIndexing = true;
  const startedAt = Date.now();

  try {
    const projects = getActiveProjects();
    let totalIndexed = 0;
    let totalUnchanged = 0;

    for (const project of projects) {
      if (!existsSync(project.path)) {
        console.warn(`[ARIA] Project "${project.name}" path not found: ${project.path}`);
        continue;
      }
      const { indexed, unchanged } = await indexProject(project);
      totalIndexed += indexed;
      totalUnchanged += unchanged;
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(`[ARIA] Codebase indexed: ${totalIndexed} embedded, ${totalUnchanged} unchanged across ${projects.length} projects (${elapsedMs}ms)`);
    log('codebase_indexed', 'index', { projects: projects.length, indexed: totalIndexed, unchanged: totalUnchanged, ms: elapsedMs });
  } catch (err) {
    console.error('[ARIA] Codebase indexing error:', err);
  } finally {
    _codebaseIndexing = false;
  }
}

// ─── Seed Default Projects ──────────────────────────────────────────────
// Called once at startup to register known projects.

export function seedDefaultProjects(): void {
  const defaults: Array<{ name: string; path: string; stack?: string; description?: string; repo?: string }> = [
    {
      name: 'antera',
      path: 'C:\\eslp-app',
      stack: 'Next.js 14, Supabase, Tailwind, 21st SDK',
      description: 'AI-powered ESL teaching platform',
      repo: 'HUNGPHAM789/eslp-app',
    },
    {
      name: 'aria',
      path: 'C:\\workspace\\claude-personal-ai',
      stack: 'Node.js, Claude Agent SDK, Telegraf, SQLite, sqlite-vec',
      description: 'ARIA personal AI assistant (Telegram bot)',
      repo: 'HUNGPHAM789/claude-personal-ai',
    },
    {
      name: 'hydra',
      path: 'C:\\workspace\\hydra',
      stack: 'Node.js, multi-provider LLM router',
      description: 'Free LLM router proxy — 180K req/day across 6 providers',
      repo: 'HUNGPHAM789/hydra',
    },
  ];

  for (const d of defaults) {
    if (existsSync(d.path)) {
      upsertProject(d.name, d.path, { stack: d.stack, description: d.description, repo: d.repo });
    }
  }
}

// ─── Semantic Search Across Codebases ───────────────────────────────────

export async function searchCodebase(queryText: string, k = 8): Promise<Array<CodebaseFile & { distance: number; projectName?: string }>> {
  if (!isVecEnabled()) return [];

  const qEmb = await embedText(queryText);
  if (!qEmb) return [];

  const hits = searchCodebaseEmbeddings(qEmb, k);
  if (hits.length === 0) return [];

  // Resolve file metadata
  const allFiles = listCodebaseFiles();
  const byId = new Map(allFiles.map(f => [f.id, f]));
  const projects = getActiveProjects();
  const projById = new Map(projects.map(p => [p.id, p]));

  return hits
    .map(h => {
      const file = byId.get(h.id);
      if (!file) return null;
      const proj = projById.get(file.project_id);
      return { ...file, distance: h.distance, projectName: proj?.name };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
}

// ─── Get Project Context ────────────────────────────────────────────────
// Used by project switcher — returns a rich context string for a project.

export function getProjectContext(projectName: string): string | null {
  const projects = getActiveProjects();
  const project = projects.find(p => p.name === projectName);
  if (!project) return null;

  const files = listCodebaseFiles(project.id);

  const sections: string[] = [
    `## Project: ${project.name}`,
    `**Path:** ${project.path}`,
    project.stack ? `**Stack:** ${project.stack}` : '',
    project.description ? `**Description:** ${project.description}` : '',
    project.repo ? `**Repo:** ${project.repo}` : '',
    '',
    `**Indexed files (${files.length}):**`,
    ...files.slice(0, 30).map(f => `  ${f.relative_path} [${f.file_type}]`),
    files.length > 30 ? `  ... and ${files.length - 30} more` : '',
  ];

  // Load README if available
  const readmePath = join(project.path, 'README.md');
  if (existsSync(readmePath)) {
    try {
      const readme = readFileSync(readmePath, 'utf-8').slice(0, 2000);
      sections.push('', '**README (first 2000 chars):**', readme);
    } catch { /* skip */ }
  }

  // Recent git activity
  try {
    const gitLog = execSync(
      `git -C "${project.path}" log --oneline -10 --no-decorate 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (gitLog) {
      sections.push('', '**Recent commits:**', gitLog);
    }
  } catch { /* not a git repo or git not available */ }

  return sections.filter(Boolean).join('\n');
}

// ─── File Watcher ───────────────────────────────────────────────────────
// Watch project directories for changes and trigger re-indexing.

const watchers: FSWatcher[] = [];
let _watchDebounce: NodeJS.Timeout | null = null;

export function startFileWatchers(): void {
  const projects = getActiveProjects();

  for (const project of projects) {
    if (!existsSync(project.path)) continue;
    try {
      const watcher = watch(project.path, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Skip noise — node_modules, .git, etc.
        if (SKIP_DIRS.has(filename.split(/[/\\]/)[0])) return;
        // Only care about files that match our patterns
        const ext = extname(filename);
        if (!['.ts', '.tsx', '.js', '.jsx', '.json', '.sql', '.md', '.prisma'].includes(ext)) return;

        // Debounce — batch changes over 5s
        if (_watchDebounce) clearTimeout(_watchDebounce);
        _watchDebounce = setTimeout(() => {
          console.log(`[ARIA] File change detected in ${project.name}, re-indexing...`);
          indexAllCodebases().catch(err => console.error('[ARIA] Watch reindex error:', err));
        }, 5000);
      });
      watchers.push(watcher);
    } catch (err) {
      console.warn(`[ARIA] Could not watch ${project.name} (${project.path}):`, (err as Error).message);
    }
  }

  if (watchers.length > 0) {
    console.log(`[ARIA] File watchers active for ${watchers.length} project(s)`);
  }
}

export function stopFileWatchers(): void {
  for (const w of watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers.length = 0;
  if (_watchDebounce) clearTimeout(_watchDebounce);
}
