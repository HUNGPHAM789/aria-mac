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
import { runClaude, buildSystemPrompt, stripActionBlocks } from '../aria/core.js';
import { loadIdentity, loadTraitsFromDb } from '../aria/identity.js';
import { loadHenryMemoryAsync, loadAvailableSkills, indexAllMemoryFiles } from '../aria/memory.js';
import { buildAriaTools } from '../aria/tools.js';
import { log, logError, newCorrelationId, rotateLogs } from '../aria/logger.js';
import { getThreadSessionId, saveThreadSessionId, insertMessage, getModel } from '../db/index.js';

// Register all Telegram handlers (side-effect import)
import '../telegram/handlers.js';

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
      console.log('[ARIA] Bot polling stopped.');
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
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
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
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
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
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
        const lines = rfs(logPath, 'utf-8').trim().split('\n');
        const events = lines.slice(-200).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
      return;
    }

    // ─── Dashboard: send message as user (Claude ↔ ARIA live test) ──
    if (req.method === 'POST' && req.url === '/api/dashboard/send') {
      let body = '';
      req.on('data', (c: Buffer) => body += c.toString());
      req.on('end', async () => {
        try {
          const { message } = JSON.parse(body);
          if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: 'No message' })); return; }
          const corr = newCorrelationId();
          const threadId = 'claude:live-test';
          const identityMd = loadIdentity();
          const traits = loadTraitsFromDb();
          const henryMemory = await loadHenryMemoryAsync(message, corr);
          const availableSkills = loadAvailableSkills();
          const { detectSkillContext } = await import('../aria/memory.js');
          const skillContext = detectSkillContext(message);
          const systemPrompt = buildSystemPrompt(identityMd, traits, henryMemory + skillContext, availableSkills);
          const extraTools = buildAriaTools({ corr, threadId });
          const { runTask, classifyTask } = await import('../aria/task-runner.js');
          const taskType = classifyTask(message);
          const startTime = Date.now();
          let response;
          if (taskType !== 'chat') {
            response = await runTask(message, { systemPrompt, model: getModel(), extraTools, corr, threadId });
          } else {
            response = await runClaude(message, systemPrompt, { model: getModel(), extraTools, corr, threadId });
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply: stripActionBlocks(response.text), elapsed, taskType }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
      const secret = process.env.ARIA_API_SECRET;
      if (secret && req.headers['x-aria-secret'] !== secret) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (c: Buffer) => body += c.toString());
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
          res.end(JSON.stringify({ error: String(err) }));
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
