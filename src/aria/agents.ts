// src/aria/agents.ts — Background agent spawning via Ollama (replaces Claude Agent SDK)
import { randomUUID } from 'crypto';
import { runClaude, type RunClaudeOptions } from './core.js';
import {
  getDb,
  insertAgentTask,
  startAgentTask,
  completeAgentTask,
  failAgentTask,
  updateAgentProgress,
  touchAgentHeartbeat,
  getRunningTasks,
  cancelAgentTask as dbCancelAgent,
  getUnnotifiedCompletedTasks,
  markTaskNotified,
  insertAgentMessage,
  type AgentTask,
} from '../db/index.js';
import { getTaskWorkspace } from './workspace.js';
import { log } from './logger.js';
import { buildSystemPrompt } from './core.js';
import { loadIdentity, loadTraitsFromDb } from './identity.js';
import { loadHenryMemoryAsync, loadAvailableSkills } from './memory.js';

const AGENT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour max per agent
const MAX_CONCURRENT_AGENTS = 3;

// ─── Agent Type Definitions ─────────────────────────────────────────────────

export interface AgentTypeDefinition {
  description: string;
  prompt: string;
  tools: string[];
  maxTurns: number;
}

export const AGENT_TYPES: Record<string, AgentTypeDefinition> = {
  coder: {
    description: 'Writes, edits, and debugs code. Use for building features, fixing bugs, refactoring.',
    prompt: `You are a coding agent working for ARIA on Boss Henry's Mac M4.
You have access to the full filesystem and all coding tools.
Work in the shared workspace when creating new files.
Be thorough — write, test, and verify your work.
When done, summarize what you built and any issues found.`,
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    maxTurns: 80,
  },
  researcher: {
    description: 'Researches topics, reads docs, searches the web. Use for investigation, analysis, fact-finding.',
    prompt: `You are a research agent working for ARIA on Boss Henry's Mac M4.
Search the web, read documentation, analyze codebases.
Produce concise, actionable findings — not essays.
Cite sources. Flag uncertainties.`,
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
    maxTurns: 40,
  },
  reviewer: {
    description: 'Reviews code, PRs, and plans for quality, security, and correctness. Read-only.',
    prompt: `You are a code review agent working for ARIA.
Review code for bugs, security issues, performance problems, and style.
Be specific — cite file:line. Suggest fixes, don't just point out problems.
Categorize issues: critical / warning / nit.`,
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    maxTurns: 30,
  },
  'general-purpose': {
    description: 'General purpose agent for any task. Full tool access.',
    prompt: `You are a general-purpose agent working for ARIA on Boss Henry's Mac M4.
You have full access to all tools. Complete the task thoroughly.
When done, summarize what you accomplished.`,
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxTurns: 60,
  },
};

// ─── Active Agent Tracking ───────────────────────────────────────────────────

interface ActiveAgent {
  abortController: AbortController;
  timeout: NodeJS.Timeout;
  agentType: string;
  description: string;
  startedAt: number;
}

const activeAgents = new Map<string, ActiveAgent>();

export interface SpawnResult {
  taskId: string;
  description: string;
  agentType: string;
}

export interface SpawnCapError {
  error: string;
}

export function getActiveAgentIds(): string[] {
  return Array.from(activeAgents.keys());
}

export function getActiveAgentInfo(): Array<{ taskId: string; agentType: string; description: string; elapsedMs: number }> {
  const now = Date.now();
  return Array.from(activeAgents.entries()).map(([taskId, a]) => ({
    taskId,
    agentType: a.agentType,
    description: a.description,
    elapsedMs: now - a.startedAt,
  }));
}

export function cancelAgent(taskId: string): boolean {
  const entry = activeAgents.get(taskId);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  entry.abortController.abort();
  dbCancelAgent(taskId);
  activeAgents.delete(taskId);
  console.log(`[ARIA] Agent cancelled: ${taskId.slice(0, 8)}`);
  return true;
}

// ─── Progress Callback Type ─────────────────────────────────────────────────

export interface AgentProgressEvent {
  taskId: string;
  agentType: string;
  description: string;
  type: 'started' | 'progress' | 'completed' | 'failed';
  summary?: string;
  elapsedMs?: number;
}

type OnAgentProgress = (event: AgentProgressEvent) => void | Promise<void>;

let _onAgentProgress: OnAgentProgress | null = null;

export function setAgentProgressHandler(handler: OnAgentProgress): void {
  _onAgentProgress = handler;
}

function emitProgress(event: AgentProgressEvent): void {
  if (_onAgentProgress) {
    Promise.resolve(_onAgentProgress(event)).catch(err => {
      console.error('[ARIA] Progress handler error:', err);
    });
  }
}

// ─── Spawn Agent ─────────────────────────────────────────────────────────────

export function spawnAgent(
  description: string,
  prompt: string,
  agentType: string = 'general-purpose',
  corr?: string,
): SpawnResult | SpawnCapError {
  const running = getRunningTasks();
  if (running.length >= MAX_CONCURRENT_AGENTS) {
    const list = running
      .map(t => `• \`${t.task_id.slice(0, 8)}\` — ${t.description.slice(0, 60)}`)
      .join('\n');
    return {
      error: `At the concurrent limit of ${MAX_CONCURRENT_AGENTS} agents.\n\nCurrently running:\n${list}\n\nWait for one to finish or use /cancel <id> to free a slot.`,
    };
  }

  const taskId = randomUUID();
  const resolvedType = AGENT_TYPES[agentType] ? agentType : 'general-purpose';

  insertAgentTask(taskId, description, prompt);
  startAgentTask(taskId);

  getDb().prepare('UPDATE agent_tasks SET agent_type = ? WHERE task_id = ?').run(resolvedType, taskId);

  const abortController = new AbortController();

  const timeout = setTimeout(() => {
    console.warn(`[ARIA] Agent ${taskId.slice(0, 8)} timed out after 1 hour, aborting...`);
    abortController.abort();
    failAgentTask(taskId, 'Agent timed out after 1 hour');
    activeAgents.delete(taskId);
    emitProgress({ taskId, agentType: resolvedType, description, type: 'failed', summary: 'Timed out after 1 hour' });
  }, AGENT_TIMEOUT_MS);

  activeAgents.set(taskId, {
    abortController,
    timeout,
    agentType: resolvedType,
    description,
    startedAt: Date.now(),
  });

  emitProgress({ taskId, agentType: resolvedType, description, type: 'started' });

  const workspaceDir = getTaskWorkspace(taskId);
  const workspaceContext = `\n\nShared workspace for this task: ${workspaceDir}\nWrite output files here so other agents and ARIA can access them.`;

  runAgentAsync(taskId, resolvedType, description, prompt + workspaceContext, abortController, corr)
    .catch(err => {
      console.error(`[ARIA] Agent ${taskId.slice(0, 8)} async error:`, err);
    });

  console.log(`[ARIA] Agent spawned (Ollama): ${taskId.slice(0, 8)} — [${resolvedType}] ${description}`);
  return { taskId, description, agentType: resolvedType };
}

async function runAgentAsync(
  taskId: string,
  agentType: string,
  description: string,
  prompt: string,
  abortController: AbortController,
  corr?: string,
): Promise<void> {
  const startedAt = Date.now();

  try {
    // Build agent system prompt
    const agentDef = AGENT_TYPES[agentType] ?? AGENT_TYPES['general-purpose'];
    const identityMd = loadIdentity();
    const traits = loadTraitsFromDb();
    const memory = await loadHenryMemoryAsync(prompt, corr);
    const skills = loadAvailableSkills();
    const systemPrompt = buildSystemPrompt(identityMd, traits, memory, skills);
    const agentSystemPrompt = `${agentDef.prompt}\n\n${systemPrompt}`;

    // Periodic progress update
    const progressInterval = setInterval(() => {
      if (abortController.signal.aborted) {
        clearInterval(progressInterval);
        return;
      }
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      updateAgentProgress(taskId, `Working... (${elapsed}s elapsed)`);
      touchAgentHeartbeat(taskId);
    }, 30_000);

    const result = await runClaude(prompt, agentSystemPrompt, {
      maxTurns: agentDef.maxTurns,
      corr,
    });

    clearInterval(progressInterval);
    clearTimeout(activeAgents.get(taskId)?.timeout);
    activeAgents.delete(taskId);

    const resultText = result.text || '(Agent completed with no output)';
    completeAgentTask(taskId, resultText);
    insertAgentMessage(taskId, agentType, resultText.slice(0, 2000), 'result');
    emitProgress({
      taskId, agentType, description,
      type: 'completed',
      summary: resultText.slice(0, 200),
      elapsedMs: Date.now() - startedAt,
    });
    console.log(`[ARIA] Agent completed (Ollama): ${taskId.slice(0, 8)} — ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

  } catch (err) {
    clearTimeout(activeAgents.get(taskId)?.timeout);
    activeAgents.delete(taskId);

    const errMsg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted) return;

    failAgentTask(taskId, errMsg.slice(0, 4000));
    insertAgentMessage(taskId, agentType, errMsg.slice(0, 2000), 'error');
    emitProgress({ taskId, agentType, description, type: 'failed', summary: errMsg.slice(0, 200), elapsedMs: Date.now() - startedAt });
    console.error(`[ARIA] Agent failed (Ollama): ${taskId.slice(0, 8)} — ${errMsg.slice(0, 200)}`);
  }
}

// ─── Notification Poller ──────────────────────────────────────────────────────

export function formatAgentNotification(task: AgentTask): string {
  const status = task.status === 'completed' ? '✅ Done' : '❌ Failed';
  const output = (task.result ?? task.error ?? '(no output)').slice(0, 4000);
  const elapsed = task.completed_at && task.spawned_at
    ? `${Math.floor((task.completed_at - task.spawned_at) / 60)}m ${(task.completed_at - task.spawned_at) % 60}s`
    : 'unknown';
  const agentLabel = task.agent_type ? ` [${task.agent_type}]` : '';
  return [
    `*Agent Update*${agentLabel} — ${status}`,
    `*Task:* ${task.description}`,
    `*Duration:* ${elapsed}`,
    '',
    '```',
    output,
    '```',
  ].join('\n');
}

export function startNotificationPoller(
  telegramUserId: number,
  sendMessage: (userId: number, text: string) => Promise<void>,
  intervalMs = 15_000,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    let tasks: AgentTask[];
    try {
      tasks = getUnnotifiedCompletedTasks();
    } catch (err) {
      console.error('[ARIA] Poller DB error:', err);
      return;
    }

    for (const task of tasks) {
      try {
        await sendMessage(telegramUserId, formatAgentNotification(task));
        markTaskNotified(task.task_id);
      } catch (err) {
        console.error(`[ARIA] Failed to notify task ${task.task_id.slice(0, 8)}:`, err);
      }
    }
  }, intervalMs);
}

// ─── Heartbeat Poller ─────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_S = 60;

function formatHeartbeat(task: AgentTask, nowSec: number): string {
  const elapsedSec = nowSec - task.spawned_at;
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  const elapsedStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const shortId = task.task_id.slice(0, 8);
  const typeLabel = task.agent_type ? ` [${task.agent_type}]` : '';
  const progressLine = task.progress_summary ? `\n📊 _${task.progress_summary.slice(0, 120)}_` : '';
  return `🟡 *Agent ${shortId}*${typeLabel} still working — ${elapsedStr} elapsed\n_${task.description.slice(0, 120)}_${progressLine}`;
}

export function startHeartbeatPoller(
  telegramUserId: number,
  sendMessage: (userId: number, text: string) => Promise<void>,
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    let running: AgentTask[];
    try {
      running = getRunningTasks();
    } catch (err) {
      console.error('[ARIA] Heartbeat DB error:', err);
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);

    for (const task of running) {
      const lastBeat = task.last_heartbeat ?? task.spawned_at;
      const sinceLast = nowSec - lastBeat;
      const sinceStart = nowSec - task.spawned_at;
      if (sinceStart < HEARTBEAT_INTERVAL_S) continue;
      if (sinceLast < HEARTBEAT_INTERVAL_S) continue;

      try {
        await sendMessage(telegramUserId, formatHeartbeat(task, nowSec));
        touchAgentHeartbeat(task.task_id);
      } catch (err) {
        console.error(`[ARIA] Heartbeat send failed for ${task.task_id.slice(0, 8)}:`, err);
      }
    }
  }, intervalMs);
}
