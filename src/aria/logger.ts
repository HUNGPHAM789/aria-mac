import { appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

const LOG_RETENTION_DAYS = 7;

const LOG_DIR = join(process.cwd(), 'data', 'logs');

function ensureDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

export function rotateLogs(): void {
  try {
    if (!existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(LOG_DIR)) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = join(LOG_DIR, file);
      try {
        if (statSync(fullPath).mtimeMs < cutoff) {
          unlinkSync(fullPath);
          console.log(`[ARIA] Rotated old log: ${file}`);
        }
      } catch { /* skip locked/missing files */ }
    }
  } catch { /* never crash on log rotation */ }
}

function currentLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `${date}.jsonl`);
}

export type LogEvent =
  | 'request_in'
  | 'request_out'
  | 'tool_use'
  | 'tool_result'
  | 'tool_call_truncated'
  | 'background_review_done'
  | 'agent_spawned'
  | 'agent_spawn_rejected'
  | 'tool_permission'
  | 'memory_loaded'
  | 'restart'
  | 'restart_blocked'
  | 'schedule_fire'
  | 'schedule_done'
  | 'schedule_error'
  | 'subagent_start'
  | 'subagent_stop'
  | 'task_progress'
  | 'task_started'
  | 'summary_generated'
  | 'codebase_indexed'
  | 'project_switched'
  | 'recall_search'
  | 'error';

export interface LogRecord {
  ts: string;
  corr: string;
  event: LogEvent;
  thread?: string;
  [k: string]: unknown;
}

export function newCorrelationId(): string {
  return randomBytes(4).toString('hex');
}

export function log(event: LogEvent, corr: string, data: Record<string, unknown> = {}): void {
  try {
    ensureDir();
    const record: LogRecord = {
      ts: new Date().toISOString(),
      corr,
      event,
      ...data,
    };
    appendFileSync(currentLogPath(), JSON.stringify(record) + '\n', 'utf-8');
    
    // Proactive rotation: trigger rotation on every log event
    rotateLogs();
  } catch {
    // Logging must never crash the bot
  }
}

export function logError(corr: string, err: unknown, context: Record<string, unknown> = {}): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log('error', corr, { ...context, message, stack });
}
