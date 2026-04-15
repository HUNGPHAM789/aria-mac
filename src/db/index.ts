import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as sqliteVec from 'sqlite-vec';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _db: Database.Database | null = null;
let _vecLoaded = false;

// Dynamic embedding dimension — default 3072 (Gemini); overridden at runtime if using Ollama
let _embeddingDim = 768; // Default to Ollama nomic-embed-text; Gemini overrides to 3072

export function getEmbeddingDim(): number { return _embeddingDim; }
export function setEmbeddingDim(dim: number): void { _embeddingDim = dim; }

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DATABASE_PATH ?? './data/aria.db';
  _db = new Database(dbPath, { allowExtension: true } as Database.Options);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension BEFORE running schema (so vec0 virtual tables work)
  try {
    sqliteVec.load(_db as unknown as { loadExtension: (p: string, e?: string) => void });
    _vecLoaded = true;
  } catch (err) {
    console.warn('[ARIA] sqlite-vec load failed — vector search disabled:', (err as Error).message);
  }

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  _db.exec(schema);

  // Migration: add pid column to agent_tasks if missing
  const columns = _db.prepare("PRAGMA table_info(agent_tasks)").all() as { name: string }[];
  if (!columns.some(c => c.name === 'pid')) {
    _db.exec('ALTER TABLE agent_tasks ADD COLUMN pid INTEGER');
  }
  if (!columns.some(c => c.name === 'last_heartbeat')) {
    _db.exec('ALTER TABLE agent_tasks ADD COLUMN last_heartbeat INTEGER');
  }
  if (!columns.some(c => c.name === 'current_phase')) {
    _db.exec('ALTER TABLE agent_tasks ADD COLUMN current_phase TEXT');
  }
  if (!columns.some(c => c.name === 'progress_summary')) {
    _db.exec('ALTER TABLE agent_tasks ADD COLUMN progress_summary TEXT');
  }
  if (!columns.some(c => c.name === 'agent_type')) {
    _db.exec("ALTER TABLE agent_tasks ADD COLUMN agent_type TEXT DEFAULT 'general'");
  }
  if (!columns.some(c => c.name === 'parent_task_id')) {
    _db.exec('ALTER TABLE agent_tasks ADD COLUMN parent_task_id TEXT');
  }

  // FTS5 over messages — content-synced, auto-maintained via triggers.
  // Enables `session_search` tool to query prior conversations by text.
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        session_id UNINDEXED,
        role UNINDEXED,
        content='messages',
        content_rowid='id',
        tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, session_id, role)
        VALUES (new.id, new.content, new.session_id, new.role);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
        VALUES('delete', old.id, old.content, old.session_id, old.role);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
        VALUES('delete', old.id, old.content, old.session_id, old.role);
        INSERT INTO messages_fts(rowid, content, session_id, role)
        VALUES (new.id, new.content, new.session_id, new.role);
      END;
    `);
    // Backfill if the FTS table is empty but messages exist (first-run on existing DB).
    const ftsCount = (_db.prepare('SELECT COUNT(*) as c FROM messages_fts').get() as { c: number }).c;
    const msgCount = (_db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    if (msgCount > 0 && ftsCount < msgCount) {
      _db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
      console.log(`[ARIA] messages_fts backfilled for ${msgCount} rows`);
    }
  } catch (err) {
    console.warn('[ARIA] messages_fts create failed:', (err as Error).message);
  }

  // Create vec0 virtual tables after extension is loaded
  if (_vecLoaded) {
    try {
      _db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings
        USING vec0(id integer primary key, embedding float[${getEmbeddingDim()}]);
      `);
      _db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS codebase_embeddings
        USING vec0(id integer primary key, embedding float[${getEmbeddingDim()}]);
      `);
      _db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS summary_embeddings
        USING vec0(id integer primary key, embedding float[${getEmbeddingDim()}]);
      `);
    } catch (err) {
      console.warn('[ARIA] vec0 virtual table create failed:', (err as Error).message);
      _vecLoaded = false;
    }
  }

  return _db;
}

export function isVecEnabled(): boolean {
  getDb();
  return _vecLoaded;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export function insertMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): void {
  getDb()
    .prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)')
    .run(sessionId, role, content);
}

export function getRecentMessages(sessionId: string, limit = 20): { role: string; content: string }[] {
  return getDb()
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(sessionId, limit) as { role: string; content: string }[];
}

export interface MessageSearchHit {
  rowid: number;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  rank: number;
}

// FTS5 search across ALL prior messages. Returns ranked snippets with
// <mark>…</mark> highlighting on the matched terms. Query supports
// FTS5 syntax: bare words, "exact phrase", prefix*, OR, NOT, NEAR(a b).
export function searchMessagesFts(query: string, limit = 12): MessageSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  try {
    const rows = getDb()
      .prepare(`
        SELECT
          m.id         AS rowid,
          m.session_id AS sessionId,
          m.role       AS role,
          snippet(messages_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet,
          m.created_at AS createdAt,
          bm25(messages_fts) AS rank
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(q, limit) as MessageSearchHit[];
    return rows;
  } catch (err) {
    // Any FTS5 parse/column error (e.g. 'no such column: xyz' when user
    // query contains dashes that FTS5 parses as column syntax) → fall
    // back to LIKE so the user gets something rather than a crash.
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    try {
      return getDb()
        .prepare(`
          SELECT id AS rowid, session_id AS sessionId, role, substr(content, 1, 200) AS snippet,
                 created_at AS createdAt, 0 AS rank
          FROM messages
          WHERE content LIKE ? ESCAPE '\\'
          ORDER BY created_at DESC
          LIMIT ?
        `)
        .all(like, limit) as MessageSearchHit[];
    } catch {
      throw err; // original FTS error wins if LIKE also fails
    }
  }
}

// ─── Agent Tasks ─────────────────────────────────────────────────────────────

export interface AgentTask {
  id: number;
  task_id: string;
  description: string;
  full_prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: string | null;
  error: string | null;
  spawned_at: number;
  completed_at: number | null;
  notified: number;
  pid: number | null;
  last_heartbeat: number | null;
  current_phase: string | null;
  progress_summary: string | null;
  agent_type: string | null;
  parent_task_id: string | null;
}

export function insertAgentTask(taskId: string, description: string, fullPrompt: string): void {
  getDb()
    .prepare("INSERT INTO agent_tasks (task_id, description, full_prompt, status) VALUES (?, ?, ?, 'pending')")
    .run(taskId, description, fullPrompt);
}

export function startAgentTask(taskId: string): void {
  getDb()
    .prepare("UPDATE agent_tasks SET status = 'running' WHERE task_id = ?")
    .run(taskId);
}

export function completeAgentTask(taskId: string, result: string): void {
  getDb()
    .prepare("UPDATE agent_tasks SET status = 'completed', result = ?, completed_at = unixepoch() WHERE task_id = ?")
    .run(result, taskId);
}

export function failAgentTask(taskId: string, error: string): void {
  getDb()
    .prepare("UPDATE agent_tasks SET status = 'failed', error = ?, completed_at = unixepoch() WHERE task_id = ?")
    .run(error, taskId);
}

export function getUnnotifiedCompletedTasks(): AgentTask[] {
  return getDb()
    .prepare("SELECT * FROM agent_tasks WHERE status IN ('completed','failed') AND notified = 0 ORDER BY completed_at ASC")
    .all() as AgentTask[];
}

export function markTaskNotified(taskId: string): void {
  getDb()
    .prepare('UPDATE agent_tasks SET notified = 1 WHERE task_id = ?')
    .run(taskId);
}

export function getRecentTasks(limit = 10): AgentTask[] {
  return getDb()
    .prepare('SELECT * FROM agent_tasks ORDER BY spawned_at DESC LIMIT ?')
    .all(limit) as AgentTask[];
}

export function updateAgentPid(taskId: string, pid: number): void {
  getDb()
    .prepare('UPDATE agent_tasks SET pid = ? WHERE task_id = ?')
    .run(pid, taskId);
}

export function touchAgentHeartbeat(taskId: string): void {
  getDb()
    .prepare('UPDATE agent_tasks SET last_heartbeat = unixepoch() WHERE task_id = ?')
    .run(taskId);
}

export function getRunningTasks(): AgentTask[] {
  return getDb()
    .prepare("SELECT * FROM agent_tasks WHERE status = 'running' ORDER BY spawned_at DESC")
    .all() as AgentTask[];
}

export function getTaskById(taskId: string): AgentTask | null {
  return (getDb()
    .prepare('SELECT * FROM agent_tasks WHERE task_id = ?')
    .get(taskId) as AgentTask) ?? null;
}

export function cancelAgentTask(taskId: string): void {
  getDb()
    .prepare("UPDATE agent_tasks SET status = 'failed', error = 'Cancelled by user', completed_at = unixepoch() WHERE task_id = ?")
    .run(taskId);
}

// ─── Identity Traits ─────────────────────────────────────────────────────────

export function getTraits(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT trait_key, trait_value FROM identity_traits')
    .all() as { trait_key: string; trait_value: string }[];
  return Object.fromEntries(rows.map(r => [r.trait_key, r.trait_value]));
}

export function upsertTrait(key: string, value: string): void {
  getDb()
    .prepare(`
      INSERT INTO identity_traits (trait_key, trait_value)
      VALUES (?, ?)
      ON CONFLICT(trait_key) DO UPDATE SET
        trait_value = excluded.trait_value,
        updated_at  = unixepoch()
    `)
    .run(key, value);
}

// ─── Skills ──────────────────────────────────────────────────────────────────

export function upsertSkill(name: string, description: string, content: string): void {
  getDb()
    .prepare(`
      INSERT INTO skills (skill_name, description, content)
      VALUES (?, ?, ?)
      ON CONFLICT(skill_name) DO UPDATE SET
        description = excluded.description,
        content     = excluded.content,
        updated_at  = unixepoch()
    `)
    .run(name, description, content);
}

export function getAllSkills(): { skill_name: string; description: string }[] {
  return getDb()
    .prepare('SELECT skill_name, description FROM skills ORDER BY created_at DESC')
    .all() as { skill_name: string; description: string }[];
}

export function deleteSkillRow(name: string): boolean {
  const info = getDb().prepare('DELETE FROM skills WHERE skill_name = ?').run(name);
  return info.changes > 0;
}

// ─── Preferences ─────────────────────────────────────────────────────────────

export function upsertPreference(key: string, value: string): void {
  getDb()
    .prepare(`
      INSERT INTO preferences (pref_key, pref_value)
      VALUES (?, ?)
      ON CONFLICT(pref_key) DO UPDATE SET
        pref_value = excluded.pref_value,
        updated_at = unixepoch()
    `)
    .run(key, value);
}

export function getMessageCount(sessionId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
    .get(sessionId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function getPreference(key: string): string | null {
  const row = getDb()
    .prepare('SELECT pref_value FROM preferences WHERE pref_key = ?')
    .get(key) as { pref_value: string } | undefined;
  return row?.pref_value ?? null;
}

// ─── Per-Thread Sessions ─────────────────────────────────────────────────────
// Each conversation surface (telegram chat, MC sender, web session) gets its
// own Claude session so contexts don't bleed across Boss/Jarvis/MC.

export function getThreadSessionId(threadId: string): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
    .get(threadId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function saveThreadSessionId(threadId: string, sessionId: string): void {
  getDb()
    .prepare(`
      INSERT INTO thread_sessions (thread_id, session_id)
      VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = unixepoch()
    `)
    .run(threadId, sessionId);
}

export function clearThreadSessionId(threadId: string): void {
  getDb().prepare('DELETE FROM thread_sessions WHERE thread_id = ?').run(threadId);
}

// ─── Shared Session (back-compat shims → default thread) ─────────────────────
// Old code that calls getSharedSessionId/saveSharedSessionId keeps working;
// it just uses thread_id = 'default'. New code should use per-thread fns.

const LEGACY_THREAD = 'default';

export function getSharedSessionId(): string | null {
  return getThreadSessionId(LEGACY_THREAD);
}

export function saveSharedSessionId(sessionId: string): void {
  saveThreadSessionId(LEGACY_THREAD, sessionId);
}

export function clearSharedSessionId(): void {
  clearThreadSessionId(LEGACY_THREAD);
}

// ─── Memory Files (sqlite-vec index metadata) ────────────────────────────────

export interface MemoryFileRow {
  id: number;
  file_path: string;
  file_label: string;
  file_name: string;
  always_load: number;
  char_count: number;
  content_hash: string;
  updated_at: number;
}

export function upsertMemoryFile(row: Omit<MemoryFileRow, 'id' | 'updated_at'>): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO memory_files (file_path, file_label, file_name, always_load, char_count, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_label   = excluded.file_label,
      file_name    = excluded.file_name,
      always_load  = excluded.always_load,
      char_count   = excluded.char_count,
      content_hash = excluded.content_hash,
      updated_at   = unixepoch()
  `).run(row.file_path, row.file_label, row.file_name, row.always_load, row.char_count, row.content_hash);
  return (db.prepare('SELECT id FROM memory_files WHERE file_path = ?')
    .get(row.file_path) as { id: number }).id;
}

export function getMemoryFileByPath(filePath: string): MemoryFileRow | null {
  return (getDb().prepare('SELECT * FROM memory_files WHERE file_path = ?').get(filePath) as MemoryFileRow) ?? null;
}

export function listMemoryFiles(): MemoryFileRow[] {
  return getDb().prepare('SELECT * FROM memory_files').all() as MemoryFileRow[];
}

export function upsertMemoryEmbedding(fileId: number, embedding: Float32Array): void {
  if (!isVecEnabled()) return;
  const db = getDb();
  // vec0 id corresponds to memory_files.id — delete+insert to upsert
  // CAST is required: better-sqlite3 passes JS numbers as floats, but vec0 wants strict ints
  db.prepare('DELETE FROM memory_embeddings WHERE id = CAST(? AS INTEGER)').run(fileId);
  db.prepare('INSERT INTO memory_embeddings(id, embedding) VALUES (CAST(? AS INTEGER), ?)')
    .run(fileId, Buffer.from(embedding.buffer));
}

export interface VecSearchHit {
  id: number;
  distance: number;
}

export function hasMemoryEmbedding(fileId: number): boolean {
  if (!isVecEnabled()) return false;
  const row = getDb()
    .prepare('SELECT id FROM memory_embeddings WHERE id = CAST(? AS INTEGER)')
    .get(fileId) as { id: number } | undefined;
  return !!row;
}

export function searchMemoryEmbeddings(queryEmbedding: Float32Array, k = 8): VecSearchHit[] {
  if (!isVecEnabled()) return [];
  return getDb()
    .prepare(`
      SELECT id, distance
      FROM memory_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `)
    .all(Buffer.from(queryEmbedding.buffer), k) as VecSearchHit[];
}

// ─── Codebase Embeddings ────────────────────────────────────────────────

export function upsertCodebaseEmbedding(fileId: number, embedding: Float32Array): void {
  if (!isVecEnabled()) return;
  const db = getDb();
  db.prepare('DELETE FROM codebase_embeddings WHERE id = CAST(? AS INTEGER)').run(fileId);
  db.prepare('INSERT INTO codebase_embeddings(id, embedding) VALUES (CAST(? AS INTEGER), ?)')
    .run(fileId, Buffer.from(embedding.buffer));
}

export function hasCodebaseEmbedding(fileId: number): boolean {
  if (!isVecEnabled()) return false;
  const row = getDb()
    .prepare('SELECT id FROM codebase_embeddings WHERE id = CAST(? AS INTEGER)')
    .get(fileId) as { id: number } | undefined;
  return !!row;
}

export function searchCodebaseEmbeddings(queryEmbedding: Float32Array, k = 8): VecSearchHit[] {
  if (!isVecEnabled()) return [];
  return getDb()
    .prepare('SELECT id, distance FROM codebase_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(Buffer.from(queryEmbedding.buffer), k) as VecSearchHit[];
}

// ─── Summary Embeddings ─────────────────────────────────────────────────

export function upsertSummaryEmbedding(summaryId: number, embedding: Float32Array): void {
  if (!isVecEnabled()) return;
  const db = getDb();
  db.prepare('DELETE FROM summary_embeddings WHERE id = CAST(? AS INTEGER)').run(summaryId);
  db.prepare('INSERT INTO summary_embeddings(id, embedding) VALUES (CAST(? AS INTEGER), ?)')
    .run(summaryId, Buffer.from(embedding.buffer));
}

export function searchSummaryEmbeddings(queryEmbedding: Float32Array, k = 5): VecSearchHit[] {
  if (!isVecEnabled()) return [];
  return getDb()
    .prepare('SELECT id, distance FROM summary_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(Buffer.from(queryEmbedding.buffer), k) as VecSearchHit[];
}

// ─── Agent Messages (inter-agent coordination) ─────────────────────────────

export interface AgentMessage {
  id: number;
  task_id: string;
  from_agent: string;
  to_agent: string | null;
  content: string;
  msg_type: 'info' | 'progress' | 'handoff' | 'error' | 'result';
  created_at: number;
}

export function insertAgentMessage(
  taskId: string,
  fromAgent: string,
  content: string,
  msgType: AgentMessage['msg_type'] = 'info',
  toAgent?: string,
): number {
  const result = getDb()
    .prepare('INSERT INTO agent_messages (task_id, from_agent, to_agent, content, msg_type) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, fromAgent, toAgent ?? null, content, msgType);
  return Number(result.lastInsertRowid);
}

export function getAgentMessages(taskId: string, sinceId = 0): AgentMessage[] {
  return getDb()
    .prepare('SELECT * FROM agent_messages WHERE task_id = ? AND id > ? ORDER BY created_at ASC')
    .all(taskId, sinceId) as AgentMessage[];
}

export function getAgentMessagesByType(taskId: string, msgType: AgentMessage['msg_type']): AgentMessage[] {
  return getDb()
    .prepare('SELECT * FROM agent_messages WHERE task_id = ? AND msg_type = ? ORDER BY created_at ASC')
    .all(taskId, msgType) as AgentMessage[];
}

// ─── Agent Task Extensions (phase tracking) ────────────────────────────────

export function updateAgentPhase(taskId: string, phase: string): void {
  getDb()
    .prepare('UPDATE agent_tasks SET current_phase = ?, updated_at = unixepoch() WHERE task_id = ?')
    .run(phase, taskId);
}

export function updateAgentProgress(taskId: string, summary: string): void {
  getDb()
    .prepare('UPDATE agent_tasks SET progress_summary = ?, last_heartbeat = unixepoch() WHERE task_id = ?')
    .run(summary, taskId);
}

// ─── Projects ───────────────────────────────────────────────────────────

export interface Project {
  id: number;
  name: string;
  path: string;
  stack: string | null;
  description: string | null;
  repo: string | null;
  active: number;
  created_at: number;
  updated_at: number;
}

export function upsertProject(name: string, path: string, opts?: { stack?: string; description?: string; repo?: string }): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO projects (name, path, stack, description, repo)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      path = excluded.path,
      stack = COALESCE(excluded.stack, projects.stack),
      description = COALESCE(excluded.description, projects.description),
      repo = COALESCE(excluded.repo, projects.repo),
      updated_at = unixepoch()
  `).run(name, path, opts?.stack ?? null, opts?.description ?? null, opts?.repo ?? null);
  return (db.prepare('SELECT id FROM projects WHERE name = ?').get(name) as { id: number }).id;
}

export function getProject(name: string): Project | null {
  return (getDb().prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project) ?? null;
}

export function getActiveProjects(): Project[] {
  return getDb().prepare('SELECT * FROM projects WHERE active = 1 ORDER BY name').all() as Project[];
}

export function listAllProjects(): Project[] {
  return getDb().prepare('SELECT * FROM projects ORDER BY active DESC, name').all() as Project[];
}

export function setProjectActive(name: string, active: boolean): void {
  getDb().prepare('UPDATE projects SET active = ?, updated_at = unixepoch() WHERE name = ?').run(active ? 1 : 0, name);
}

// ─── Codebase Files ─────────────────────────────────────────────────────

export interface CodebaseFile {
  id: number;
  project_id: number;
  file_path: string;
  relative_path: string;
  file_type: string;
  char_count: number;
  content_hash: string;
  updated_at: number;
}

export function upsertCodebaseFile(
  projectId: number,
  filePath: string,
  relativePath: string,
  fileType: string,
  charCount: number,
  contentHash: string,
): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO codebase_files (project_id, file_path, relative_path, file_type, char_count, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      relative_path = excluded.relative_path,
      file_type = excluded.file_type,
      char_count = excluded.char_count,
      content_hash = excluded.content_hash,
      updated_at = unixepoch()
  `).run(projectId, filePath, relativePath, fileType, charCount, contentHash);
  return (db.prepare('SELECT id FROM codebase_files WHERE file_path = ?').get(filePath) as { id: number }).id;
}

export function getCodebaseFileByPath(filePath: string): CodebaseFile | null {
  return (getDb().prepare('SELECT * FROM codebase_files WHERE file_path = ?').get(filePath) as CodebaseFile) ?? null;
}

export function listCodebaseFiles(projectId?: number): CodebaseFile[] {
  if (projectId !== undefined) {
    return getDb().prepare('SELECT * FROM codebase_files WHERE project_id = ? ORDER BY relative_path').all(projectId) as CodebaseFile[];
  }
  return getDb().prepare('SELECT * FROM codebase_files ORDER BY project_id, relative_path').all() as CodebaseFile[];
}

export function deleteCodebaseFile(filePath: string): void {
  getDb().prepare('DELETE FROM codebase_files WHERE file_path = ?').run(filePath);
}

// ─── Conversation Summaries ─────────────────────────────────────────────

export interface ConversationSummary {
  id: number;
  thread_id: string;
  session_id: string | null;
  summary: string;
  topics: string | null;
  msg_count: number;
  created_at: number;
}

export function insertConversationSummary(
  threadId: string,
  summary: string,
  opts?: { sessionId?: string; topics?: string; msgCount?: number },
): number {
  const result = getDb().prepare(
    'INSERT INTO conversation_summaries (thread_id, session_id, summary, topics, msg_count) VALUES (?, ?, ?, ?, ?)',
  ).run(threadId, opts?.sessionId ?? null, summary, opts?.topics ?? null, opts?.msgCount ?? 0);
  return Number(result.lastInsertRowid);
}

export function getRecentSummaries(threadId: string, limit = 5): ConversationSummary[] {
  return getDb()
    .prepare('SELECT * FROM conversation_summaries WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(threadId, limit) as ConversationSummary[];
}

export function getAllSummaries(limit = 20): ConversationSummary[] {
  return getDb()
    .prepare('SELECT * FROM conversation_summaries ORDER BY created_at DESC LIMIT ?')
    .all(limit) as ConversationSummary[];
}

export function searchSummariesByKeyword(query: string): ConversationSummary[] {
  // Simple keyword search — semantic search handled via embeddings
  return getDb()
    .prepare("SELECT * FROM conversation_summaries WHERE summary LIKE ? OR topics LIKE ? ORDER BY created_at DESC LIMIT 10")
    .all(`%${query}%`, `%${query}%`) as ConversationSummary[];
}

// ─── Model Selection ─────────────────────────────────────────────────────────

export function getModel(): string {
  // Default to the 'sonnet' alias so a fresh DB routes through Claude SDK
  // with automatic fallback to gemma → gpt-oss on outage (see model-aliases.ts).
  return getPreference('aria_model') ?? 'sonnet';
}

export function setModel(model: string): void {
  upsertPreference('aria_model', model);
}

// ─── Schedules ──────────────────────────────────────────────────────────────

export interface Schedule {
  id: number;
  name: string;
  cron: string;
  prompt: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export function insertSchedule(name: string, cron: string, prompt: string, nextRunAt: number): number {
  const result = getDb().prepare(
    'INSERT INTO schedules (name, cron, prompt, next_run_at) VALUES (?, ?, ?, ?)',
  ).run(name, cron, prompt, nextRunAt);
  return Number(result.lastInsertRowid);
}

export function updateSchedule(id: number, fields: Partial<Pick<Schedule, 'name' | 'cron' | 'prompt' | 'enabled' | 'next_run_at'>>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) { sets.push('name = ?'); vals.push(fields.name); }
  if (fields.cron !== undefined) { sets.push('cron = ?'); vals.push(fields.cron); }
  if (fields.prompt !== undefined) { sets.push('prompt = ?'); vals.push(fields.prompt); }
  if (fields.enabled !== undefined) { sets.push('enabled = ?'); vals.push(fields.enabled); }
  if (fields.next_run_at !== undefined) { sets.push('next_run_at = ?'); vals.push(fields.next_run_at); }
  if (sets.length === 0) return;
  sets.push('updated_at = unixepoch()');
  vals.push(id);
  getDb().prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteSchedule(id: number): void {
  getDb().prepare('DELETE FROM schedules WHERE id = ?').run(id);
}

export function getSchedule(id: number): Schedule | null {
  return (getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Schedule) ?? null;
}

export function listSchedules(): Schedule[] {
  return getDb().prepare('SELECT * FROM schedules ORDER BY enabled DESC, next_run_at ASC').all() as Schedule[];
}

export function getDueSchedules(): Schedule[] {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(
    'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
  ).all(now) as Schedule[];
}

export function markScheduleRun(id: number, nextRunAt: number): void {
  getDb().prepare(
    'UPDATE schedules SET last_run_at = unixepoch(), next_run_at = ?, updated_at = unixepoch() WHERE id = ?',
  ).run(nextRunAt, id);
}
