// src/bot/supervisor.ts — Process supervisor for ARIA (macOS version)
import { spawn, execSync, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RESTART_CODE = 42;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const BOT_SCRIPT = resolve(__dirname, 'index.ts');
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const LOCKFILE = resolve(DATA_DIR, 'aria.pid');

const restartTimestamps: number[] = [];
let child: ChildProcess | null = null;
let shuttingDown = false;

// Ensure data directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── Kill stale ARIA instances (macOS) ──────────────────────────────────────
function killStaleInstances() {
  // Kill any process on port 3100 (ARIA HTTP API)
  try {
    execSync('lsof -ti:3100 | xargs kill -9 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 5000,
      shell: '/bin/bash',
    });
  } catch { /* no process on port */ }

  // Check PID lockfile
  if (existsSync(LOCKFILE)) {
    try {
      const oldPid = readFileSync(LOCKFILE, 'utf-8').trim();
      if (oldPid) {
        try {
          execSync(`kill -9 ${oldPid} 2>/dev/null || true`, { timeout: 5000, shell: '/bin/bash' });
          console.log(`[SUPERVISOR] Killed stale ARIA from lockfile (PID ${oldPid})`);
        } catch { /* process already dead */ }
      }
    } catch { /* file read error */ }
    try { unlinkSync(LOCKFILE); } catch { /* already gone */ }
  }
}

function writeLockfile(pid: number) {
  writeFileSync(LOCKFILE, String(pid), 'utf-8');
}

function clearLockfile() {
  try { unlinkSync(LOCKFILE); } catch { /* ok */ }
}

// Clean up before starting
killStaleInstances();

function startBot() {
  if (shuttingDown) return;

  console.log('[SUPERVISOR] Starting ARIA bot...');
  child = spawn('npx', ['tsx', BOT_SCRIPT], {
    shell: '/bin/bash',
    stdio: 'inherit',
    cwd: resolve(__dirname, '..', '..'),
  });

  if (child.pid) writeLockfile(child.pid);

  child.on('exit', (code) => {
    child = null;
    clearLockfile();

    if (shuttingDown) {
      console.log('[SUPERVISOR] Clean shutdown.');
      process.exit(0);
      return;
    }

    if (code === 0) {
      console.log('[SUPERVISOR] Bot exited cleanly.');
      process.exit(0);
      return;
    }

    // Crash loop protection
    const now = Date.now();
    restartTimestamps.push(now);
    while (restartTimestamps.length > 0 && restartTimestamps[0] < now - RESTART_WINDOW_MS) {
      restartTimestamps.shift();
    }
    if (restartTimestamps.length > MAX_RESTARTS) {
      console.error(`[SUPERVISOR] Too many restarts (${MAX_RESTARTS} in ${RESTART_WINDOW_MS / 1000}s). Exiting.`);
      process.exit(1);
      return;
    }

    if (code === RESTART_CODE) {
      console.log('[SUPERVISOR] Restart requested (exit code 42). Respawning in 1s...');
      setTimeout(startBot, 1000);
    } else {
      console.error(`[SUPERVISOR] Bot crashed with code ${code}. Respawning in 5s...`);
      setTimeout(startBot, 5000);
    }
  });
}

// Forward termination signals to child
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[SUPERVISOR] Received ${signal}, forwarding to bot...`);
    shuttingDown = true;
    clearLockfile();
    if (child) {
      child.kill(signal);
    } else {
      process.exit(0);
    }
  });
}

startBot();
