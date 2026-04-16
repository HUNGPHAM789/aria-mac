// IMPORTANT: env.ts MUST be first — tsx hoists imports in order,
// so this guarantees dotenv runs before any module reads process.env.
import './env.js';

import http from 'http';
import { bot } from '../telegram/bot.js';
import { getDb, getRunningTasks, failAgentTask } from '../db/index.js';
import { startQualityJudge, getQualityReport } from '../aria/quality-judge.js';
import { startNotificationPoller, startHeartbeatPoller, setAgentProgressHandler } from '../aria/agents.js';
import { seedDefaultProjects, indexAllCodebases, startFileWatchers, stopFileWatchers } from '../aria/codebase.js';
import { startScheduler } from '../aria/scheduler.js';
import { runClaude, buildSystemPrompt, stripActionBlocks, type StreamEvent } from '../aria/core.js';
import { loadIdentity, loadTraitsFromDb } from '../aria/identity.js';
import { loadHenryMemoryAsync, loadAvailableSkills, indexAllMemoryFiles } from '../aria/memory.js';
import { buildAriaTools } from '../aria/tools.js';
import { log, logError, newCorrelationId, rotateLogs } from '../aria/logger.js';
import { getThreadSessionId, saveThreadSessionId, insertMessage, getModel } from '../db/index.js';

// Register all Telegram handlers (side-effect import)
import '../telegram/handlers.js';

// ─── SSE subscriber management for live dashboard terminal ──────────────────
import type { ServerResponse } from 'http';
const sseClients = new Set<ServerResponse>();

// ─── Simple rate limiter for expensive endpoints ────────────────────────────
const _rateBuckets = new Map<string, number[]>();
function rateLimit(key: string, maxPerMin: number): boolean {
  const now = Date.now();
  const bucket = _rateBuckets.get(key) ?? [];
  const recent = bucket.filter(t => now - t < 60_000);
  if (recent.length >= maxPerMin) return false;
  recent.push(now);
  _rateBuckets.set(key, recent);
  return true;
}

function broadcastSSE(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

async function main() {
  console.log('[ARIA] Starting up...');

  // Initialize database and run schema
  getDb();
  console.log('[ARIA] Database initialized →', process.env.DATABASE_PATH ?? './data/aria.db');

  // Rotate old logs (keep last 7 days)
  rotateLogs();

  // Start memory indexing in background (embeds new/changed files)
  indexAllMemoryFiles().catch(err => {
    console.error('[ARIA] Memory indexing failed:', err);
  });

  // Auto-reindex memory every 5 minutes
  setInterval(() => {
    indexAllMemoryFiles().catch(err => {
      console.error('[ARIA] Periodic memory reindex failed:', err);
    });
  }, 5 * 60 * 1000);
  console.log('[ARIA] Auto-reindex enabled (every 5m)');

  // Seed default projects and start codebase indexing
  seedDefaultProjects();
  console.log('[ARIA] Default projects seeded');

  indexAllCodebases().catch(err => {
    console.error('[ARIA] Codebase indexing failed:', err);
  });

  // Auto-reindex codebases every 10 minutes
  setInterval(() => {
    indexAllCodebases().catch(err => {
      console.error('[ARIA] Periodic codebase reindex failed:', err);
    });
  }, 10 * 60 * 1000);

  // Start file watchers for active projects (re-index on change)
  startFileWatchers();
  console.log('[ARIA] Codebase indexing + file watchers started');

  // Clean up stale agent tasks from previous crash
  const STALE_TASK_AGE_S = 5 * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const allRunning = getRunningTasks();
  const staleTasks = allRunning.filter((t: { spawned_at: number }) => (nowSec - t.spawned_at) > STALE_TASK_AGE_S);
  const freshTasks = allRunning.length - staleTasks.length;

  for (const task of staleTasks) {
    failAgentTask(task.task_id, 'ARIA restarted — task outcome unknown');
  }
  if (staleTasks.length > 0) {
    console.log(`[ARIA] Cleaned up ${staleTasks.length} stale agent task(s) (older than 5 min)`);
  }
  if (freshTasks > 0) {
    console.log(`[ARIA] ${freshTasks} recent task(s) (<5 min) left intact`);
  }

  // Start agent notification poller
  const allowedId = process.env.ARIA_ALLOWED_TELEGRAM_ID
    ? parseInt(process.env.ARIA_ALLOWED_TELEGRAM_ID, 10)
    : null;

  if (allowedId) {
    startNotificationPoller(
      allowedId,
      (userId, text) =>
        bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' }).then(() => {}),
    );
    console.log('[ARIA] Notification poller started (15s interval)');

    const heartbeatHandle = startHeartbeatPoller(
      allowedId,
      (userId, text) =>
        bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' }).then(() => {}),
    );
    if (heartbeatHandle) {
      console.log('[ARIA] Heartbeat poller started (30s check, 60s ping)');
    }

    // Wire up real-time agent progress → Telegram
    setAgentProgressHandler(async (event) => {
      if (event.type === 'progress' && event.summary) {
        console.log(`[ARIA] Agent ${event.taskId.slice(0, 8)} progress: ${event.summary.slice(0, 80)}`);
      }
      if (event.type === 'completed') {
        console.log(`[ARIA] Agent ${event.taskId.slice(0, 8)} completed (${(event.elapsedMs ?? 0) / 1000}s)`);
      }
      if (event.type === 'failed') {
        console.log(`[ARIA] Agent ${event.taskId.slice(0, 8)} failed: ${event.summary?.slice(0, 80)}`);
      }
    });
    console.log('[ARIA] Agent progress handler wired');

    startScheduler(
      allowedId,
      (userId, text) =>
        bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' }).then(() => {}),
    );
  } else {
    console.warn('[ARIA] ARIA_ALLOWED_TELEGRAM_ID not set — pollers disabled');
  }

  // Quality judge — scores conversation turns every 60s
  startQualityJudge(60000);

  // Launch Telegram long-polling with retry on network errors
  console.log('[ARIA] Launching Telegram bot (long-polling)...');
  const launchWithRetry = async (attempt = 1): Promise<void> => {
    try {
      await bot.launch();
      console.log('[ARIA] Bot polling active.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException)?.code;
      const isTimeout = msg.includes('timed out') || msg.includes('TimeoutError');
      if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND' || isTimeout) {
        const delay = Math.min(attempt * 5, 30);
        console.warn(`[ARIA] Telegram connection failed (${code}), retry #${attempt} in ${delay}s...`);
        await new Promise(r => setTimeout(r, delay * 1000));
        return launchWithRetry(attempt + 1);
      }
      throw err;
    }
  };
  launchWithRetry().catch((err) => {
    console.error('[ARIA] Telegram launch failed permanently:', err);
    process.exit(1);
  });
  console.log('[ARIA] Telegram bot online ✓ Ready — message your bot on Telegram.');

  // ─── HTTP API for MC Group Chat ──────────────────────────────────────────────
  const API_PORT = parseInt(process.env.ARIA_API_PORT ?? '3100', 10);
  const httpServer = http.createServer(async (req, res) => {
    const allowedOrigin = process.env.ARIA_CORS_ORIGIN ?? 'http://127.0.0.1:3100';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Aria-Secret');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // ─── Dashboard: serve UI ──
    if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
      const { readFileSync: rfs } = await import('fs');
      const { join: jn } = await import('path');
      try {
        const html = rfs(jn(process.cwd(), 'dashboard', 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch { res.writeHead(404); res.end('Dashboard not found'); }
      return;
    }

    // ─── Dashboard: list sessions ──
    if (req.method === 'GET' && req.url === '/api/sessions') {
      try {
        const db = getDb();
        const rows = db.prepare(`
          SELECT session_id, COUNT(*) as msg_count, MAX(created_at) as last_msg
          FROM messages GROUP BY session_id ORDER BY last_msg DESC LIMIT 20
        `).all();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      } catch (err) { console.error('[ARIA] API error:', err); res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      return;
    }

    // ─── Dashboard: FTS5 search across all sessions ──
    if (req.method === 'GET' && req.url?.startsWith('/api/search')) {
      try {
        const url = new URL(req.url, 'http://localhost');
        const q = (url.searchParams.get('q') ?? '').slice(0, 500);
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 50);
        if (!q.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'q param required' })); return; }
        const { searchMessagesFts } = await import('../db/index.js');
        const hits = searchMessagesFts(q, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ query: q, count: hits.length, hits }));
      } catch (err) { console.error('[ARIA] API error:', err); res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      return;
    }

    // ─── Dashboard: get messages for a session ──
    if (req.method === 'GET' && req.url?.startsWith('/api/messages')) {
      try {
        const url = new URL(req.url, 'http://localhost');
        const sid = url.searchParams.get('session');
        if (!sid) { res.writeHead(400); res.end('session param required'); return; }
        const db = getDb();
        const rows = db.prepare(`
          SELECT id, role, content, created_at FROM messages
          WHERE session_id = ? ORDER BY id ASC LIMIT 200
        `).all(sid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      } catch (err) { console.error('[ARIA] API error:', err); res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      return;
    }

    // ─── Dashboard: quality report ──
    if (req.method === 'GET' && req.url?.startsWith('/api/quality')) {
      try {
        const url = new URL(req.url, 'http://localhost');
        const hours = parseInt(url.searchParams.get('hours') ?? '24', 10);
        const report = getQualityReport(hours);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
      } catch (err) { console.error('[ARIA] API error:', err); res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      return;
    }

    // ─── Dashboard: provider pool state + recent attempts ──
    if (req.method === 'GET' && req.url?.startsWith('/api/providers')) {
      try {
        const { poolSnapshot } = await import('../aria/core.js');
        const { readFileSync: rfs, existsSync: exs } = await import('fs');
        const { join: jn } = await import('path');
        const url = new URL(req.url, 'http://localhost');
        const hours = parseInt(url.searchParams.get('hours') ?? '24', 10);
        const cutoff = Date.now() - hours * 3600_000;
        // Aggregate provider_* events from today's JSONL.
        const stats: Record<string, { attempts: number; succeeded: number; failed: number; byReason: Record<string, number> }> = {};
        const date = new Date().toISOString().slice(0, 10);
        const logPath = jn(process.cwd(), 'data', 'logs', `${date}.jsonl`);
        const { statSync } = await import('fs');
        const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50MB cap
        if (exs(logPath) && statSync(logPath).size < MAX_LOG_BYTES) {
          for (const line of rfs(logPath, 'utf-8').trim().split('\n')) {
            if (!line) continue;
            try {
              const r = JSON.parse(line) as { ts?: string; event?: string; provider?: string; reason?: string };
              if (!r.event?.startsWith('provider_') || !r.provider) continue;
              const ts = r.ts ? Date.parse(r.ts) : 0;
              if (ts < cutoff) continue;
              const s = stats[r.provider] ??= { attempts: 0, succeeded: 0, failed: 0, byReason: {} };
              if (r.event === 'provider_attempted') s.attempts++;
              if (r.event === 'provider_succeeded') s.succeeded++;
              if (r.event === 'provider_failed') {
                s.failed++;
                if (r.reason) s.byReason[r.reason] = (s.byReason[r.reason] ?? 0) + 1;
              }
            } catch { /* skip malformed */ }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pools: poolSnapshot(), stats, windowHours: hours }));
      } catch (err) { console.error('[ARIA] API error:', err); res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      return;
    }

    // ─── Dashboard: get tool log ──
    if (req.method === 'GET' && req.url?.startsWith('/api/tool-log')) {
      try {
        const { readFileSync: rfs, existsSync: exs } = await import('fs');
        const { join: jn } = await import('path');
        const date = new Date().toISOString().slice(0, 10);
        const logPath = jn(process.cwd(), 'data', 'logs', `${date}.jsonl`);
        if (!exs(logPath)) { res.writeHead(200); res.end('[]'); return; }
        const { statSync: ss } = await import('fs');
        if (ss(logPath).size > 50 * 1024 * 1024) { res.writeHead(200); res.end('[]'); return; } // skip if >50MB
        const lines = rfs(logPath, 'utf-8').trim().split('\n');
        const events = lines.slice(-200).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
      } catch (err) { console.error('[ARIA] API error:', err); res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      return;
    }

    // ─── Dashboard: system status ──
    if (req.method === 'GET' && req.url === '/api/status') {
      try {
        const { poolSnapshot } = await import('../aria/core.js');
        const { getModel } = await import('../db/index.js');
        const uptime = process.uptime();
        const mem = process.memoryUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: getModel(),
          uptime: Math.floor(uptime),
          memory: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
          pools: poolSnapshot(),
          node: process.version,
          pid: process.pid,
        }));
      } catch (err) { console.error('[ARIA] API error:', err); res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      return;
    }

    // ─── Dashboard: usage/cost summary ──
    if (req.method === 'GET' && req.url?.startsWith('/api/usage')) {
      try {
        const { readFileSync: rfs, existsSync: exs, readdirSync } = await import('fs');
        const { join: jn } = await import('path');
        const url = new URL(req.url, 'http://localhost');
        const days = parseInt(url.searchParams.get('days') ?? '7', 10);
        const logDir = jn(process.cwd(), 'data', 'logs');
        const byModel: Record<string, { input: number; output: number; requests: number }> = {};
        const byDay: Record<string, { input: number; output: number; requests: number }> = {};
        const now = Date.now();
        for (let d = 0; d < days; d++) {
          const date = new Date(now - d * 86400_000).toISOString().slice(0, 10);
          const path = jn(logDir, `${date}.jsonl`);
          if (!exs(path)) continue;
          for (const line of rfs(path, 'utf-8').trim().split('\n')) {
            if (!line) continue;
            try {
              const ev = JSON.parse(line) as Record<string, unknown>;
              if (ev.event !== 'request_out') continue;
              const model = (ev.model as string) || 'unknown';
              const inp = (ev.input_tokens as number) || 0;
              const out = (ev.output_tokens as number) || 0;
              const m = byModel[model] ??= { input: 0, output: 0, requests: 0 };
              m.input += inp; m.output += out; m.requests++;
              const dd = byDay[date] ??= { input: 0, output: 0, requests: 0 };
              dd.input += inp; dd.output += out; dd.requests++;
            } catch { /* skip */ }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ days, byModel, byDay }));
      } catch (err) { console.error('[ARIA] API error:', err); res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' })); }
      return;
    }

    // ─── Dashboard: SSE stream for live terminal ──
    if (req.method === 'GET' && req.url === '/api/dashboard/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: connected\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
      sseClients.add(res);
      const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); }
        catch { clearInterval(keepalive); sseClients.delete(res); }
      }, 15000);
      req.on('close', () => { sseClients.delete(res); clearInterval(keepalive); });
      return;
    }

    // ─── Dashboard: send message as user (Claude ↔ ARIA live test) ──
    if (req.method === 'POST' && req.url === '/api/dashboard/send') {
      if (!rateLimit('dashboard_send', 10)) { res.writeHead(429); res.end(JSON.stringify({ error: 'Rate limited — max 10 requests/min' })); return; }
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); if (body.length > 100_000) { res.writeHead(413); res.end('Payload too large'); req.destroy(); } });
      req.on('end', async () => {
        try {
          const { message } = JSON.parse(body);
          if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'No message' })); return; }
          const corr = newCorrelationId();
          const threadId = 'claude:live-test';
          // /compact [focus] — queue a focused compaction on this thread.
          // Runs before runClaude so the next model turn consumes it.
          const compactMatch = /^\s*\/compact(?:\s+(.*))?\s*$/i.exec(message);
          if (compactMatch) {
            const { requestCompaction } = await import('../aria/core.js');
            const focus = (compactMatch[1] ?? '').trim();
            requestCompaction(threadId, focus || undefined);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ reply: focus
              ? `🧭 Compaction queued — next turn will summarize with focus: ${focus}`
              : '🧭 Compaction queued — next turn will summarize this thread.',
              elapsed: '0.0', taskType: 'command', corr }));
            return;
          }
          const identityMd = loadIdentity();
          const traits = loadTraitsFromDb();
          const henryMemory = await loadHenryMemoryAsync(message, corr);
          const availableSkills = loadAvailableSkills();
          const { detectSkillContext } = await import('../aria/memory.js');
          const skillContext = detectSkillContext(message);
          const systemPrompt = buildSystemPrompt(identityMd, traits, henryMemory + skillContext, availableSkills);
          const extraTools = buildAriaTools({ corr, threadId });
          const { runTask, classifyTask } = await import('../aria/task-runner.js');
          const { detectAmbiguity, detectLeadingPrompt } = await import('../aria/ambiguity.js');
          const isAmbiguous = detectAmbiguity(message) !== null || detectLeadingPrompt(message) !== null;
          const taskType = isAmbiguous ? 'chat' : classifyTask(message);
          const startTime = Date.now();
          // Stream events to SSE subscribers for live terminal view
          const onStream = (event: StreamEvent) => {
            broadcastSSE('stream', { ...(event as any), corr, ts: new Date().toISOString() });
          };
          broadcastSSE('task_start', { corr, message: message.slice(0, 200), taskType, ts: new Date().toISOString() });
          let response;
          if (taskType !== 'chat') {
            response = await runTask(message, { systemPrompt, model: getModel(), extraTools, corr, threadId, onStream });
          } else {
            response = await runClaude(message, systemPrompt, { model: getModel(), extraTools, corr, threadId, onStream });
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          broadcastSSE('task_end', { corr, elapsed, taskType, replyLen: response.text.length, ts: new Date().toISOString() });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply: stripActionBlocks(response.text), elapsed, taskType, corr }));
        } catch (err) {
          console.error('[ARIA] Dashboard send error:', err);
          broadcastSSE('task_error', { error: 'Task failed', ts: new Date().toISOString() });
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Task execution failed' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
      if (!rateLimit('api_chat', 20)) { res.writeHead(429); res.end(JSON.stringify({ error: 'Rate limited' })); return; }
      const secret = process.env.ARIA_API_SECRET;
      if (secret && req.headers['x-aria-secret'] !== secret) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); if (body.length > 100_000) { res.writeHead(413); res.end('Payload too large'); req.destroy(); } });
      req.on('end', async () => {
        const startTime = Date.now();
        const corr = newCorrelationId();
        try {
          const { message, sender } = JSON.parse(body);
          if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'No message' })); return; }

          const senderName = sender === 'boss' ? 'Boss Henry' : sender === 'jarvis' ? 'Jarvis' : sender || 'unknown';
          const threadId = `mc:${(sender || 'unknown').toLowerCase()}`;
          console.log(`[ARIA-API] ← ${senderName}: ${message.substring(0, 120)}`);
          log('request_in', corr, { thread: threadId, source: 'mc-http', sender: senderName, msgLen: message.length });

          const contextMessage = `[MC Group Chat — from ${senderName}]: ${message}`;

          const identityMd = loadIdentity();
          const traits = loadTraitsFromDb();
          const henryMemory = await loadHenryMemoryAsync(contextMessage, corr);
          const availableSkills = loadAvailableSkills();
          const systemPrompt = buildSystemPrompt(identityMd, traits, henryMemory, availableSkills);
          const sessionId = getThreadSessionId(threadId) ?? undefined;
          const extraTools = buildAriaTools({ corr, threadId });

          if (sessionId) insertMessage(sessionId, 'user', contextMessage);

          const currentModel = getModel();
          const response = await runClaude(contextMessage, systemPrompt, {
            sessionId,
            model: currentModel,
            extraTools,
            corr,
            threadId,
          });
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          if (response.sessionId) {
            saveThreadSessionId(threadId, response.sessionId);
            if (!sessionId) insertMessage(response.sessionId, 'user', contextMessage);
            insertMessage(response.sessionId, 'assistant', response.text);
          }

          const cleanText = stripActionBlocks(response.text);
          console.log(`[ARIA-API] → Reply (${elapsed}s): ${cleanText.substring(0, 120)}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply: cleanText, sessionId: response.sessionId }));
        } catch (err) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.error(`[ARIA-API] ✗ Error after ${elapsed}s:`, err);
          logError(corr, err, { source: 'mc-http' });
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Request failed' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[ARIA] Port ${API_PORT} in use — HTTP API disabled. Telegram still works.`);
    } else {
      console.error('[ARIA] HTTP server error:', err);
    }
  });

  httpServer.listen(API_PORT, '127.0.0.1', () => {
    console.log(`[ARIA] HTTP API listening on http://127.0.0.1:${API_PORT}/api/chat`);
  });

  // Graceful shutdown
  process.once('SIGINT', () => {
    console.log('\n[ARIA] Shutting down...');
    stopFileWatchers();
    httpServer.close();
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    console.log('\n[ARIA] Shutting down...');
    stopFileWatchers();
    httpServer.close();
    bot.stop('SIGTERM');
  });
}

main().catch(err => {
  console.error('[ARIA] Fatal startup error:', err);
  process.exit(1);
});
