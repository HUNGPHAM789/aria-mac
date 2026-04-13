CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL,
  role       TEXT    NOT NULL CHECK(role IN ('user','assistant','system')),
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT    NOT NULL UNIQUE,
  description  TEXT    NOT NULL,
  full_prompt  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK(status IN ('pending','running','completed','failed')),
  result       TEXT,
  error        TEXT,
  spawned_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  notified     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status, notified);

CREATE TABLE IF NOT EXISTS identity_traits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trait_key   TEXT    NOT NULL UNIQUE,
  trait_value TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS skills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name  TEXT    NOT NULL UNIQUE,
  description TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS preferences (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pref_key   TEXT    NOT NULL UNIQUE,
  pref_value TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS thread_sessions (
  thread_id  TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS memory_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path    TEXT    NOT NULL UNIQUE,
  file_label   TEXT    NOT NULL,
  file_name    TEXT    NOT NULL,
  always_load  INTEGER NOT NULL DEFAULT 0,
  char_count   INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_memory_files_always ON memory_files(always_load);

CREATE TABLE IF NOT EXISTS schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  cron        TEXT    NOT NULL,
  prompt      TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT    NOT NULL,
  from_agent TEXT    NOT NULL,
  to_agent   TEXT,
  content    TEXT    NOT NULL,
  msg_type   TEXT    NOT NULL DEFAULT 'info'
             CHECK(msg_type IN ('info','progress','handoff','error','result')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_task ON agent_messages(task_id, created_at);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  path        TEXT    NOT NULL,
  stack       TEXT,
  description TEXT,
  repo        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS codebase_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  file_path    TEXT    NOT NULL UNIQUE,
  relative_path TEXT   NOT NULL,
  file_type    TEXT    NOT NULL DEFAULT 'code',
  char_count   INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_codebase_files_project ON codebase_files(project_id);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT    NOT NULL,
  session_id  TEXT,
  summary     TEXT    NOT NULL,
  topics      TEXT,
  msg_count   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_convo_summaries_thread ON conversation_summaries(thread_id, created_at);
