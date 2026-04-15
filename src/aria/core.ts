// src/aria/core.ts — Ollama-powered agentic inference engine (replaces Claude Agent SDK)
import { log, logError } from './logger.js';
import { verifyToolResult } from './verify.js';
import { executeTool, TOOLS } from './tools-executor.js';
import { getRecentMessages, insertMessage as dbInsertMessage } from '../db/index.js';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { maybeCompactAsync, buildSummarizerPrompt, type OllamaMessage as CompactorMessage, type SummarizerFn, type PreCompressHook } from './context-compressor.js';
import { memoryOnPreCompress } from './memory.js';

// Per-thread rolling compaction summary. Each successful maybeCompact returns a
// summary text; we stash it here keyed by threadId so the NEXT compaction on
// the same thread can pass it as previousSummary, letting info survive across
// repeated compactions instead of being lost each time the middle is dropped.
const _threadCompactionSummaries = new Map<string, string>();

// Per-thread pending compaction request set by `/compact [focus]`. When present
// the next in-loop compaction check fires immediately (threshold=0) with the
// stored focus topic, then the entry is cleared.
interface PendingCompaction { focusTopic?: string }
const _pendingCompaction = new Map<string, PendingCompaction>();

/** Queue a /compact <focus> request for a thread. Next turn's compaction
 *  check on this thread will fire immediately, bias the summary toward
 *  `focusTopic` (if provided), and clear the entry. */
export function requestCompaction(threadId: string, focusTopic?: string): void {
  _pendingCompaction.set(threadId, { focusTopic: focusTopic?.trim() || undefined });
}

/** Snapshot credential pool state for the /pool command. Reads from the
 *  lazy-built compaction chain — the same chain the orchestrator uses —
 *  so what you see is what will be tried next. */
export interface PoolSnapshot {
  provider: string;
  total: number;
  available: number;
  exhausted: number;
  exhaustedEntries: Array<{ credId: string; untilIso: string; remainingMs: number }>;
}

export function poolSnapshot(): PoolSnapshot[] {
  const chain = compactionChain();
  const now = Date.now();
  return chain.map(b => {
    const stats = b.pool.stats();
    const entries: PoolSnapshot['exhaustedEntries'] = [];
    for (const [credId, until] of b.pool._exhaustionSnapshot()) {
      if (until > now) {
        entries.push({ credId, untilIso: new Date(until).toISOString(), remainingMs: until - now });
      }
    }
    return {
      provider: b.id,
      total: stats.total,
      available: stats.available,
      exhausted: stats.exhausted,
      exhaustedEntries: entries,
    };
  });
}

// Default LLM summarizer — routes through the D.4 retry orchestrator so a
// rate-limited / unavailable provider rotates credentials or falls back to
// the next provider in the chain. The summarizer uses its OWN chain
// (ARIA_SUMMARIZER_CHAIN, default "claude,ollama") rather than the main
// provider chain, because a strong model preserves specific tokens in the
// summary far more reliably than gemma4:26b summarizing itself — bench 09
// caught gemma dropping a literal marker string in a 4-compaction run.
import { resolveChain, runWithFallback, ProviderChainExhaustedError } from './providers/index.js';
let _compactionChain: ReturnType<typeof resolveChain> | null = null;
function compactionChain(): ReturnType<typeof resolveChain> {
  if (!_compactionChain) {
    const raw = process.env.ARIA_SUMMARIZER_CHAIN?.trim();
    const ids = raw
      ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : ['claude', 'ollama'];
    _compactionChain = resolveChain(ids);
  }
  return _compactionChain;
}

const defaultSummarizer: SummarizerFn = async (droppedTurns, previousSummary, focusTopic, memoryDigest) => {
  const prompt = buildSummarizerPrompt(
    droppedTurns as OllamaMessage[],
    previousSummary,
    focusTopic,
    memoryDigest,
  );
  const chain = compactionChain();
  if (chain.length === 0) return null;
  try {
    const result = await runWithFallback(chain, {
      label: 'compaction',
      call: async (provider) => {
        const res = await provider.chat(
          [
            { role: 'system', content: 'You are a summarization agent. Emit only the structured summary body.' },
            { role: 'user', content: prompt },
          ],
          { maxOutputTokens: 4096 },
        );
        return res.message.content?.trim() ?? '';
      },
    });
    return result.value && result.value.length > 0 ? result.value : null;
  } catch (err) {
    if (err instanceof ProviderChainExhaustedError) {
      console.warn(`[aria] compaction summarizer chain exhausted (${err.attempts.length} attempts)`);
      return null;
    }
    throw err;
  }
};

// ─── Tool Permission Rules ────────────────────────────────────────────────────

const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
]);

const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /\brm\s+.*-[a-z]*r[a-z]*f\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bdd\s+.*of=\/dev\//i,
  /\bsudo\s+rm\b/i,
  /\brd\s+\/s\s+\/q\b/i,
  // ARIA self-protection: block git/npm/mutating operations on own repo
  /\bgit\s+(restore|reset|checkout\s+--|clean\s+-f|commit|push)/i,
  /\bgit\s+.*aria-mac/i,
  // Block npm operations that modify ARIA's dependencies
  /\bnpm\s+(install|i|add|remove|uninstall|update|upgrade)\b/i,
  /\b(yarn|pnpm)\s+(add|install|remove|upgrade)\b/i,
  // Block sed/awk/echo writes to ARIA source
  /(sed\s+-i|>\s*\S*aria-mac\/(src|identity|package))/i,
];

export interface ParsedAction {
  action: string;
  [key: string]: unknown;
}

export interface ClaudeResponse {
  text: string;
  sessionId: string | null;
  actions: ParsedAction[];
  /** Last tool output seen during the run — used by task-runner to pass concrete data between steps. */
  lastToolOutput?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

// ─── Ollama Types ────────────────────────────────────────────────────────────

interface OllamaToolFunction {
  name: string;
  arguments: Record<string, unknown>;
}

interface OllamaToolCall {
  function: OllamaToolFunction;
}

// Defense against truncated streaming tool calls (Hermes PR #6847 / commit 2d0d05a3):
// when streaming is cut mid-call, function.arguments is invalid JSON. Previously the
// handler silently substituted {} and executed the tool with empty args — unpredictable.
// Now: return the parse failure so the caller can skip execution and surface a synthetic
// tool_result explaining the truncation, letting the model retry or give up cleanly.
type ParsedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; raw: string; error: string };

function parseToolArgs(rawArgs: unknown): ParsedArgs {
  if (typeof rawArgs !== 'string') {
    return { ok: true, args: (rawArgs ?? {}) as Record<string, unknown> };
  }
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === 'object') return { ok: true, args: parsed as Record<string, unknown> };
    return { ok: false, raw: rawArgs, error: 'parsed non-object' };
  } catch (e) {
    return { ok: false, raw: rawArgs, error: (e as Error).message };
  }
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

// ─── Ollama API ──────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = () => process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL ?? 'gemma4:26b';

function convertToolsToOllama(): OllamaToolDef[] {
  return TOOLS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

async function ollamaChat(
  messages: OllamaMessage[],
  tools?: OllamaToolDef[],
  model?: string,
): Promise<OllamaChatResponse> {
  const body: Record<string, unknown> = {
    model: model ?? OLLAMA_MODEL(),
    messages,
    stream: false,
    options: {
      num_predict: 4096, // Generous budget — gemma4 thinking mode needs room
    },
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 min per turn

  try {
    const res = await fetch(`${OLLAMA_BASE_URL()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    // Gemma4 thinking mode: if content is empty but thinking has text, use thinking
    if (!data.message.content && data.message.thinking) {
      console.log('[ollama] Model produced thinking but no content — appending thinking as content');
      data.message.content = data.message.thinking;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Streaming Ollama Chat ───────────────────────────────────────────────────

async function ollamaChatStream(
  messages: OllamaMessage[],
  tools: OllamaToolDef[] | undefined,
  model: string | undefined,
  onChunk: (text: string) => void,
): Promise<OllamaChatResponse> {
  const body: Record<string, unknown> = {
    model: model ?? OLLAMA_MODEL(),
    messages,
    stream: true,
    options: { num_predict: 4096 },
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  try {
    const res = await fetch(`${OLLAMA_BASE_URL()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${errText.slice(0, 500)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body from Ollama');

    let fullContent = '';
    let fullThinking = '';
    let toolCalls: OllamaToolCall[] | undefined;
    let evalCount = 0;
    let promptEvalCount = 0;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as OllamaChatResponse;
          if (chunk.message?.content) {
            fullContent += chunk.message.content;
            onChunk(chunk.message.content);
          }
          if ((chunk.message as { thinking?: string })?.thinking) {
            fullThinking += (chunk.message as { thinking?: string }).thinking;
          }
          if (chunk.message?.tool_calls) {
            toolCalls = chunk.message.tool_calls;
          }
          if (chunk.eval_count) evalCount = chunk.eval_count;
          if (chunk.prompt_eval_count) promptEvalCount = chunk.prompt_eval_count;
        } catch { /* skip malformed lines */ }
      }
    }

    // Thinking mode fallback — only when no tool_calls, otherwise truncated tool
    // args might be masquerading as thinking exhaustion (Hermes PR #6847).
    if (!fullContent && fullThinking && !toolCalls?.length) {
      console.log('[ollama-stream] Model produced thinking but no content — using thinking as content');
      fullContent = fullThinking;
      onChunk(fullThinking);
    }

    return {
      message: {
        role: 'assistant',
        content: fullContent,
        tool_calls: toolCalls,
      },
      done: true,
      eval_count: evalCount,
      prompt_eval_count: promptEvalCount,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── ARIA Tool Instructions ──────────────────────────────────────────────────

const ARIA_TOOL_INSTRUCTIONS = `
════════════════════════════════════════════════════════
  ARIA ACTION TOOLS
════════════════════════════════════════════════════════

You have function-calling tools for all actions. Call them directly:

AGENT DISPATCH & COORDINATION:
- spawn_agent — dispatch typed background agent (coder, researcher, reviewer, general-purpose)
- agent_status — check real-time progress of all running agents
- agent_messages — read progress/handoff messages from agent tasks
- send_agent_message — send messages to running agent tasks
- workspace_status — check shared workspace files

IDENTITY & SKILLS:
- create_skill — write a new skill (requires --- frontmatter with name + description)
- edit_skill — replace the entire SKILL.md of an existing skill
- patch_skill — exact-string find-and-replace inside a skill file
- delete_skill — permanently remove a skill (not reversible without git)
- update_traits — persist learned traits about Boss

SCHEDULING:
- create_schedule — create a cron-scheduled task
- update_schedule — modify an existing schedule
- delete_schedule — remove a schedule
- list_schedules — view all scheduled tasks

SYSTEM:
- restart — restart ARIA (exit 42, supervisor respawns)
- message_jarvis — ping Jarvis via MC group chat

SMART CONTEXT:
- switch_project — load full project context (stack, git, files)
- register_project — register a new project for indexing
- list_projects — see all registered projects
- recall — semantic search across conversations, memory, and codebases
- session_search — FTS5 full-text search prior messages ("phrase", prefix*, OR, NEAR)

FILESYSTEM & CODE:
- Bash — execute shell commands
- Read — read file contents
- Write — write file contents
- Edit — edit file (string replacement)
- Glob — find files by pattern
- Grep — search file contents
- WebFetch — fetch a URL
- WebSearch — search the web (requires TAVILY_API_KEY)
- TodoWrite — manage a todo list

MULTI-AGENT RULES:
- Always tell Boss what you are about to do BEFORE calling spawn_agent.
- Pick the right agent_type: coder for code, researcher for investigation, reviewer for reviews.
- Agents share a workspace — use workspace_status to see what agents produced.
- Never invent task_ids; the tool returns one.
- Prefer tools over free-text JSON. Clean prose for Boss, tools for actions.
`;

// ─── System Prompt ────────────────────────────────────────────────────────────

export function buildSystemPrompt(
  identityMd: string,
  traits: Record<string, string>,
  henryMemory: string,
  availableSkills: string,
  recentSessionContext?: string,
): string {
  const traitLines = Object.entries(traits)
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n') || '  (none yet — still learning)';

  return `
════════════════════════════════════════════════════════
  YOU ARE JARVISM4 — READ THIS FIRST.
════════════════════════════════════════════════════════

Your name is JarvisM4 (Adaptive Reasoning & Intelligence Assistant).
You are NOT a generic AI assistant. You are JarvisM4.
When asked "who are you?" or "what's your name?", always answer: "I'm JarvisM4."
You live on Henry's Mac Studio M4 Max. You are his personal AI — proactive, sharp, always-on.
You communicate with Henry via Telegram (@jarvism4henry_bot). Henry is your Boss.
You are powered by Gemma 4 26B running locally via Ollama.

════════════════════════════════════════════════════════
  YOUR LIVING IDENTITY
════════════════════════════════════════════════════════

${identityMd}

════════════════════════════════════════════════════════
  YOUR ACTIVE TRAITS (learned from Henry)
════════════════════════════════════════════════════════

${traitLines}

════════════════════════════════════════════════════════
  HENRY'S RELEVANT CONTEXT (filtered for this conversation)
════════════════════════════════════════════════════════

These are the most relevant memory files for the current conversation.
Read this carefully — this is YOUR memory too.

${henryMemory || 'No memory loaded yet — learn from Henry and save preferences.'}

════════════════════════════════════════════════════════
  YOUR SKILLS LIBRARY
════════════════════════════════════════════════════════

${availableSkills}

════════════════════════════════════════════════════════
  YOUR CAPABILITIES
════════════════════════════════════════════════════════

- Full tool suite: Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, TodoWrite
- You can execute any shell command on Henry's Mac M4
- You can spawn sub-agents for background tasks
- You can access, read, and modify any file on the Mac
- You can use the internet, fetch URLs, search documentation
- You run on local Gemma 4 26B via Ollama — fast, private, always available

${ARIA_TOOL_INSTRUCTIONS}

${recentSessionContext ? `════════════════════════════════════════════════════════
  RECENT SESSION CONTEXT
════════════════════════════════════════════════════════

${recentSessionContext}
` : ''}════════════════════════════════════════════════════════
  OPERATING RULES
════════════════════════════════════════════════════════

IDENTITY:
- You are ARIA. Always. Never say you are Claude or Gemma or a generic AI assistant.
- Address Henry as "Boss" (that's his preference).
- Have personality — sharp, energetic, proactive, dry humor when appropriate.

AVAILABILITY:
- Always reply quickly. Never go dark or silent.
- Send a short acknowledgment BEFORE starting any agent/task.
- NEVER make Henry wait staring at a blank screen.

AGENT DISPATCH (tasks > 2 min):
- Spawn an agent for: building projects, writing >5 files, multi-step automation, long processes.
- Tell Boss what you're dispatching, then call spawn_agent.
- Stay available to chat while agents work.

PROACTIVE:
- Be 1 step ahead. Surface insights, risks, and opportunities he didn't ask for.
- Flag anything that could go wrong before it does.
- Suggest better approaches without being asked.

RESPONSES:
- Telegram format: Markdown, under 4000 chars per message.
- Lead with the answer. No preamble. No filler.
- One focused clarifying question if needed — never interrogate.
`.trim();
}

// ─── Action Extraction ────────────────────────────────────────────────────────

function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

export function extractActions(text: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  for (const block of extractJsonBlocks(text)) {
    try {
      const parsed = JSON.parse(block) as ParsedAction;
      if (parsed.action) actions.push(parsed);
    } catch { /* skip malformed */ }
  }
  return actions;
}

export function stripActionBlocks(text: string): string {
  let result = text;
  for (const block of extractJsonBlocks(text)) {
    try {
      const parsed = JSON.parse(block) as ParsedAction;
      if (parsed.action) {
        result = result.replace(block, '');
      }
    } catch { /* not a valid action block */ }
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Tool Preview Helpers ────────────────────────────────────────────────────

function shorten(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function previewToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined);

  switch (toolName) {
    case 'Bash':
      return shorten((pick('command') ?? '').replace(/\s+/g, ' '), 100);
    case 'Read':
    case 'Edit':
    case 'Write':
      return shorten(pick('file_path') ?? '', 100);
    case 'Glob':
    case 'Grep':
      return shorten(pick('pattern') ?? '', 100);
    case 'WebFetch':
      return shorten(pick('url') ?? '', 100);
    case 'WebSearch':
      return shorten(pick('query') ?? '', 100);
    default:
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') return shorten(`${k}=${v}`, 100);
      }
      return '';
  }
}

export function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in (c as object)) return String((c as { text: unknown }).text ?? '');
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

// ─── Streaming Event Types ───────────────────────────────────────────────────

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_use_complete' | 'tool_result' | 'segment_break' | 'session_id' | 'agent_progress' | 'agent_started' | 'agent_stopped';
  text?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  inputPreview?: string;
  output?: string;
  isError?: boolean;
  sessionId?: string;
  agentId?: string;
  agentType?: string;
  summary?: string;
  taskId?: string;
}

// ─── Check Bash Safety ──────────────────────────────────────────────────────

function isBashDangerous(cmd: string): string | null {
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(cmd)) {
      return `Blocked: dangerous command detected (${cmd.slice(0, 80)})`;
    }
  }
  return null;
}

// ─── Agentic Loop (Ollama) ──────────────────────────────────────────────────

export interface RunClaudeOptions {
  sessionId?: string;
  onStream?: (event: StreamEvent) => void;
  model?: string;
  corr?: string;
  threadId?: string;
  effort?: 'low' | 'medium' | 'high';
  /** Extra tools to register (e.g. ARIA action tools) */
  extraTools?: Array<{ name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> }>;
  maxTurns?: number;
  /** Skip DB persistence (for internal task runner calls that shouldn't pollute history) */
  ephemeral?: boolean;
}

import { resolveFallbackChain, resolveModel, type ResolvedModel } from './model-aliases.js';
import { classifyError } from './error-classifier.js';

export async function runClaude(
  message: string,
  systemPrompt: string,
  optsOrSessionId?: string | RunClaudeOptions,
  legacyOnStream?: (event: StreamEvent) => void,
  legacyModel?: string,
): Promise<ClaudeResponse> {
  const opts: RunClaudeOptions =
    typeof optsOrSessionId === 'string' || optsOrSessionId === undefined
      ? { sessionId: optsOrSessionId, onStream: legacyOnStream, model: legacyModel }
      : optsOrSessionId;

  // Resolve alias → provider chain. Primary is whatever opts.model (or the
  // stored DB pref upstream) names; fallback sequence ensures a Claude outage
  // drops to gemma then gpt-oss instead of failing silently.
  const chain = resolveFallbackChain(opts.model);
  let lastErr: unknown = null;
  for (let i = 0; i < chain.length; i++) {
    const resolved = chain[i];
    try {
      return await runOnProvider(message, systemPrompt, { ...opts, model: resolved.model }, resolved);
    } catch (err) {
      lastErr = err;
      const cls = classifyError(err, { provider: resolved.provider });
      const nextAlias = chain[i + 1]?.alias ?? null;
      if (opts.corr) {
        log('error_classified', opts.corr, {
          alias: resolved.alias, provider: resolved.provider, model: resolved.model,
          reason: cls.reason, status: cls.status, nextAlias,
        });
      }
      // Don't fallback on caller-side problems (context overflow → caller should compact).
      if (cls.reason === 'context_overflow') throw err;
      // Last one in the chain — bubble up the error.
      if (i === chain.length - 1) break;
      // Only continue if the classifier says this error is worth trying another model for.
      if (!cls.should_fallback && !cls.retryable && cls.reason !== 'model_not_found') throw err;
    }
  }
  throw lastErr ?? new Error('runClaude: fallback chain exhausted with no error recorded');
}

async function runOnProvider(
  message: string,
  systemPrompt: string,
  opts: RunClaudeOptions,
  resolved: ResolvedModel,
): Promise<ClaudeResponse> {
  if (resolved.provider === 'claude') {
    const { runClaudeBackend } = await import('./claude-backend.js');
    return runClaudeBackend({ message, systemPrompt, opts });
  }
  return runOllamaAgent(message, systemPrompt, opts);
}

async function runOllamaAgent(
  message: string,
  systemPrompt: string,
  opts: RunClaudeOptions,
): Promise<ClaudeResponse> {
  const { onStream, model, corr, threadId, extraTools, maxTurns = 40, ephemeral = false } = opts;
  const startedAt = Date.now();
  const sessionId = opts.sessionId ?? (threadId ? `session:${threadId}` : `session:${Date.now()}`);

  if (corr) log('request_in', corr, { thread: threadId, model, msgLen: message.length });

  // Build message history with inline compaction
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Load history (skip if ephemeral — task runner internal calls shouldn't accumulate)
  if (!ephemeral) {
    try {
      const history = getRecentMessages(sessionId, 20);
      const ordered = [...history].reverse();
      const KEEP_RECENT = 6;
      const MAX_CHARS_PER_MSG = 800;

      if (ordered.length > KEEP_RECENT + 4) {
        const older = ordered.slice(0, ordered.length - KEEP_RECENT);
        const recent = ordered.slice(-KEEP_RECENT);
        const summary = older
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => `${m.role}: ${m.content.slice(0, 200).replace(/\n+/g, ' ')}`)
          .join('\n');
        if (summary.length > 50) {
          messages.push({
            role: 'system',
            content: `[Earlier conversation summary — older messages compacted]\n${summary.slice(0, 3000)}`,
          });
        }
        for (const msg of recent) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            const content = msg.content.length > MAX_CHARS_PER_MSG
              ? msg.content.slice(0, MAX_CHARS_PER_MSG) + '\n…[truncated]'
              : msg.content;
            messages.push({ role: msg.role as 'user' | 'assistant', content });
          }
        }
      } else {
        for (const msg of ordered) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            const content = msg.content.length > MAX_CHARS_PER_MSG
              ? msg.content.slice(0, MAX_CHARS_PER_MSG) + '\n…[truncated]'
              : msg.content;
            messages.push({ role: msg.role as 'user' | 'assistant', content });
          }
        }
      }
    } catch { /* first message, no history */ }
  }

  messages.push({ role: 'user', content: message });

  if (!ephemeral) {
    try { dbInsertMessage(sessionId, 'user', message); } catch { /* ignore */ }
  }

  // Build tool definitions
  const ollamaTools = convertToolsToOllama();

  // Add extra tools (ARIA action tools)
  const extraToolMap = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  if (extraTools) {
    for (const t of extraTools) {
      ollamaTools.push({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      });
      extraToolMap.set(t.name, t.execute);
    }
  }

  let finalText = '';
  let lastToolOutput = '';
  let totalEvalCount = 0;
  let totalPromptEvalCount = 0;
  // Per-turn (not accumulated) ground-truth input token count from Ollama's
  // most recent response. Used by maybeCompactAsync to decide whether to
  // compact: the chars/4 estimate misses tool-schema JSON that Ollama charges
  // against input, so a thread can blow past its context window while the
  // estimator thinks it's safe. Bench 09 showed a 5× undercount on gemma.
  let lastPromptEvalCount = 0;
  let continuationNudges = 0;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      // Pre-turn compaction check — fires BEFORE the model call when the
      // prior turn's Ollama input_tokens or our message-array estimate
      // indicate the next call would exceed the threshold. Runs here (not
      // only after tool batches) so text-only responses that would
      // otherwise break out of the loop don't leave an oversized history
      // behind, and more importantly so we compact BEFORE pushing another
      // turn into a model that's already near its context ceiling.
      if (turn > 0) {
        const priorSummary = threadId ? _threadCompactionSummaries.get(threadId) : undefined;
        const pending = threadId ? _pendingCompaction.get(threadId) : undefined;
        if (pending && threadId) _pendingCompaction.delete(threadId);
        const preCompact = await maybeCompactAsync(messages as unknown as CompactorMessage[], {
          previousSummary: priorSummary,
          summarizer: defaultSummarizer,
          preCompressHook: memoryOnPreCompress as PreCompressHook,
          focusTopic: pending?.focusTopic,
          knownInputTokens: lastPromptEvalCount,
          ...(pending ? { thresholdTokens: 0 } : {}),
        });
        if (preCompact.compressed) {
          console.log(`[aria] Context compacted pre-turn ${turn}: ${preCompact.before.tokens}→${preCompact.after.tokens} tokens (${preCompact.before.count}→${preCompact.after.count} msgs)`);
          const usedLlm = preCompact.summary?.includes('<compacted-summary') ?? false;
          if (corr) log('context_compacted', corr, { thread: threadId, beforeTokens: preCompact.before.tokens, afterTokens: preCompact.after.tokens, beforeCount: preCompact.before.count, afterCount: preCompact.after.count, llm: usedLlm, phase: 'pre-turn' });
          messages.length = 0;
          messages.push(...(preCompact.messages as unknown as OllamaMessage[]));
          if (threadId && preCompact.summary) _threadCompactionSummaries.set(threadId, preCompact.summary);
        }
      }

      let response: OllamaChatResponse;

      if (onStream && turn === 0) {
        // Stream the first response for UX
        response = await ollamaChatStream(messages, ollamaTools, model, (chunk) => {
          onStream({ type: 'text', text: chunk });
        });
      } else {
        response = await ollamaChat(messages, ollamaTools, model);
        if (response.message.content && onStream) {
          onStream({ type: 'text', text: response.message.content });
        }
      }

      totalEvalCount += response.eval_count ?? 0;
      totalPromptEvalCount += response.prompt_eval_count ?? 0;
      lastPromptEvalCount = response.prompt_eval_count ?? lastPromptEvalCount;

      const toolCalls = response.message.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        const text = response.message.content ?? '';
        // Continuation detection: model hints at future work but didn't call a tool
        const hasUnfinishedWork = /\b(step\s*\d|next[,:]\s*I|now\s*I('ll|'m going| will| need)|let me (now|proceed|continue|start)|I('ll| will) (now|then|next)|moving on to|phase \d)/i.test(text);
        const hasCompletionSignal = /^(✅|❌|done|completed|finished|failed|error:|here('s| is) (the|your)|published|deployed)/im.test(text.trim());
        if (hasUnfinishedWork && !hasCompletionSignal && turn < maxTurns - 1 && continuationNudges < 3) {
          continuationNudges++;
          console.log(`[aria] Continuation detected at turn ${turn} — nudging (${continuationNudges}/3)`);
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: 'Continue. Do the next step now — use your tools.' });
          onStream?.({ type: 'text', text: text });
          continue;
        }
        finalText = text;
        break;
      }

      // Has tool calls — push assistant message, execute tools, continue loop
      messages.push({
        role: 'assistant',
        content: response.message.content ?? '',
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const parsed = parseToolArgs(toolCall.function.arguments);
        if (!parsed.ok) {
          const errMsg = `Tool call '${toolName}' had truncated/invalid JSON args (${parsed.error}). Execution skipped — restate the call with complete arguments.`;
          if (corr) log('tool_call_truncated', corr, { thread: threadId, tool: toolName, rawLen: parsed.raw.length });
          console.warn(`[aria] ${errMsg}`);
          messages.push({ role: 'tool', content: `Error: ${errMsg}` });
          onStream?.({ type: 'tool_result', toolName, output: `Error: truncated tool args — ${parsed.error}` });
          continue;
        }
        const toolArgs = parsed.args;

        if (corr) log('tool_use', corr, { thread: threadId, tool: toolName });
        onStream?.({ type: 'tool_use', toolName, toolUseId: toolName });

        const inputPreview = previewToolInput(toolName, toolArgs);
        onStream?.({ type: 'tool_use_complete', toolName, toolUseId: toolName, input: toolArgs, inputPreview });

        let result: string;

        // Check bash safety
        if (toolName === 'Bash') {
          const danger = isBashDangerous(String(toolArgs.command ?? ''));
          if (danger) {
            result = danger;
          } else {
            result = await executeTool(toolName, toolArgs);
          }
        } else if (extraToolMap.has(toolName)) {
          // ARIA action tool
          try {
            result = await extraToolMap.get(toolName)!(toolArgs);
          } catch (err) {
            result = `Tool error: ${(err as Error).message}`;
          }
        } else {
          result = await executeTool(toolName, toolArgs);
        }

        // Verify tool result
        const verification = verifyToolResult(toolName, toolArgs, result, corr);
        if (!verification.ok && verification.warning) {
          result += `\n\n${verification.warning}`;
        }

        const truncated = result.length > 600 ? result.slice(0, 600) + `\n…(+${result.length - 600} chars)` : result;
        if (corr) log('tool_result', corr, { thread: threadId, tool: toolName, outLen: result.length });
        onStream?.({ type: 'tool_result', toolName, output: truncated });
        // Capture last substantive tool output so task-runner can pass concrete data between steps.
        if (result && !result.startsWith('REFUSED:') && !result.startsWith('Tool error:')) {
          lastToolOutput = result;
        }

        // Cap tool result fed back to model at 2000 chars to prevent context bloat on scan tasks
        // Full result still streamed to user; the model sees a summarized version
        const MAX_TOOL_CONTENT = 2000;
        const modelContent = result.length > MAX_TOOL_CONTENT
          ? result.slice(0, MAX_TOOL_CONTENT) + `\n…[truncated — ${result.length - MAX_TOOL_CONTENT} more chars. Call Read with offset if you need more.]`
          : result;

        messages.push({
          role: 'tool',
          content: modelContent,
        });
      }

      // Segment break: tool batch done, tell display layer to start a fresh message
      // for subsequent text/tool events (port of Hermes stream_consumer segment model).
      onStream?.({ type: 'segment_break' });

      // In-loop compression — fires when accumulated messages exceed threshold.
      // Async LLM summary (Phase C.2) with deterministic preview-block fallback
      // on summarizer failure or cooldown. Pass prior summary so info from
      // earlier compactions on this thread survives.
      const priorSummary = threadId ? _threadCompactionSummaries.get(threadId) : undefined;
      const pending = threadId ? _pendingCompaction.get(threadId) : undefined;
      if (pending && threadId) _pendingCompaction.delete(threadId);
      const compaction = await maybeCompactAsync(messages as unknown as CompactorMessage[], {
        previousSummary: priorSummary,
        summarizer: defaultSummarizer,
        preCompressHook: memoryOnPreCompress as PreCompressHook,
        focusTopic: pending?.focusTopic,
        knownInputTokens: lastPromptEvalCount,
        ...(pending ? { thresholdTokens: 0 } : {}),
      });
      if (compaction.compressed) {
        console.log(`[aria] Context compacted at turn ${turn}: ${compaction.before.tokens}→${compaction.after.tokens} tokens (${compaction.before.count}→${compaction.after.count} msgs)`);
        const usedLlm = compaction.summary?.includes('<compacted-summary') ?? false;
        if (corr) log('context_compacted', corr, { thread: threadId, beforeTokens: compaction.before.tokens, afterTokens: compaction.after.tokens, beforeCount: compaction.before.count, afterCount: compaction.after.count, llm: usedLlm });
        messages.length = 0;
        messages.push(...(compaction.messages as unknown as OllamaMessage[]));
        if (threadId && compaction.summary) _threadCompactionSummaries.set(threadId, compaction.summary);
      }
    }

    // Silent exit safety net: model went silent after tool call
    const lastMsg = messages[messages.length - 1];
    if ((!finalText || finalText.trim().length < 10) && lastMsg?.role === 'tool') {
      console.log('[aria] Model went silent after tool call — forcing summary turn');
      messages.push({
        role: 'user',
        content: 'You just used a tool but did not reply to Boss. Summarize what you did and the result. Start with ✅ or ❌.',
      });
      const followUp = await ollamaChat(messages, undefined, model);
      finalText = followUp.message.content || 'Task completed (no summary available).';
    }

    // Refused-but-claimed-success safety net: if ANY tool returned REFUSED: and the
    // model's final message claims ✅ / Done / Optimized / Fixed, force it to restate honestly.
    const hadRefusal = messages.some(m =>
      m.role === 'tool' && typeof m.content === 'string' && /^REFUSED:/m.test(m.content),
    );
    const claimedSuccess =
      /^✅|\bDone:|\bOptimized\b|\bFixed\b|\bSuccess(fully)?\b|\bCompleted\b/i.test(finalText?.slice(0, 300) ?? '');
    if (hadRefusal && claimedSuccess) {
      console.log('[aria] Model claimed success after a tool was REFUSED — forcing honest restatement');
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'user',
        content:
          'One or more of your tool calls was REFUSED by safety rules — check the tool responses. ' +
          'You did NOT complete the work. Send a final message starting with ❌ that says exactly what was refused and why, ' +
          'and what I (Boss) would need to do manually if I want it done. Do NOT claim ✅ or "Done" when a tool was refused.',
      });
      const honest = await ollamaChat(messages, undefined, model);
      if (honest.message.content) finalText = honest.message.content;
    }

    // Promise detector: model promised future work but didn't do it (no tools used)
    const usedTool = messages.some(m => m.role === 'tool');
    const looksLikePromise = /\b(next steps?:|i (will|'ll) (now |then )?(find|use|run|check|investigate|search|read|write))/im.test(finalText);
    const looksLikeCompletion = /[✅❌]|^(done|complete|finished|here'?s|i found|the (file|task|fix|result))/im.test(finalText.trim());
    if (!usedTool && looksLikePromise && !looksLikeCompletion && finalText.length > 30 && finalText.length < 800) {
      console.log('[aria] Model promised future work without doing it — forcing one more turn');
      messages.push({ role: 'assistant', content: finalText });
      messages.push({
        role: 'user',
        content: 'You said you would do something next but you stopped. Do those next steps NOW using your tools. Then send me the final result starting with ✅ or ❌.',
      });
      const continuation = await ollamaChat(messages, ollamaTools, model);
      if (continuation.message.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: continuation.message.content ?? '',
          tool_calls: continuation.message.tool_calls,
        });
        for (const tc of continuation.message.tool_calls) {
          const tName = tc.function.name;
          const parsed = parseToolArgs(tc.function.arguments);
          if (!parsed.ok) {
            const errMsg = `Tool call '${tName}' had truncated/invalid JSON args (${parsed.error}). Execution skipped.`;
            if (corr) log('tool_call_truncated', corr, { thread: threadId, tool: tName, rawLen: parsed.raw.length });
            messages.push({ role: 'tool', content: `Error: ${errMsg}` });
            continue;
          }
          const tArgs = parsed.args;
          let res: string;
          try {
            res = extraToolMap.has(tName) ? await extraToolMap.get(tName)!(tArgs) : await executeTool(tName, tArgs);
          } catch (e) { res = `Tool error: ${(e as Error).message}`; }
          messages.push({ role: 'tool', content: res });
          onStream?.({ type: 'tool_use', toolName: tName, toolUseId: tName });
        }
        const wrap = await ollamaChat(messages, undefined, model);
        finalText = wrap.message.content || continuation.message.content || finalText;
      } else if (continuation.message.content) {
        finalText = continuation.message.content;
      }
    }

    if (!finalText && messages.length > 2) {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      finalText = lastAssistant?.content ?? 'Max turns reached.';
    }

    // Auto-prepend ✅/❌ marker if tool used but forgot
    const usedAnyTool = messages.some(m => m.role === 'tool');
    if (usedAnyTool && finalText && !/[✅❌]/.test(finalText)) {
      const isError = /\b(error|failed|cannot|unable|blocked|denied|not found|missing)\b/i.test(finalText) &&
                      !/\b(no error|no issue|fixed|resolved|working|success)\b/i.test(finalText);
      finalText = (isError ? '❌ ' : '✅ ') + finalText;
    }

    // Save assistant response to DB (skip if ephemeral)
    if (finalText && !ephemeral) {
      try { dbInsertMessage(sessionId, 'assistant', finalText); } catch { /* ignore */ }
    }

    const response: ClaudeResponse = {
      text: finalText,
      sessionId,
      actions: extractActions(finalText),
      lastToolOutput: lastToolOutput || undefined,
      usage: {
        input_tokens: totalPromptEvalCount,
        output_tokens: totalEvalCount,
      },
    };

    if (corr) {
      log('request_out', corr, {
        thread: threadId,
        ms: Date.now() - startedAt,
        textLen: finalText.length,
        input_tokens: totalPromptEvalCount,
        output_tokens: totalEvalCount,
      });
    }

    // Daily thinking log — records every turn for debugging
    try {
      const thinkDir = join(process.cwd(), 'data', 'thinking');
      if (!existsSync(thinkDir)) mkdirSync(thinkDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const time = new Date().toISOString().slice(11, 19);
      const toolsUsed = messages.filter(m => m.role === 'tool').length;
      const turns = messages.filter(m => m.role === 'assistant').length;
      const entry = `\n## ${time} UTC [${turns} turns, ${toolsUsed} tools, ${Date.now() - startedAt}ms]\n**User:** ${message.slice(0, 200)}\n**Response:** ${finalText.slice(0, 500)}\n`;
      appendFileSync(join(thinkDir, `${date}.md`), entry);
    } catch { /* non-critical */ }

    // Post-turn: fire background review if interval reached. Fire-and-forget.
    if (!ephemeral && threadId && corr) {
      const toolsUsed = messages
        .filter(m => m.role === 'assistant' && m.tool_calls?.length)
        .flatMap(m => m.tool_calls!.map(tc => tc.function.name));
      const { maybeScheduleReview } = await import('./background-review.js');
      maybeScheduleReview({ threadId, corr, userMessage: message, assistantText: finalText, toolsUsed });
    }

    return response;
  } catch (err) {
    if (corr) {
      const { classifyError } = await import('./error-classifier.js');
      const classified = classifyError(err, {
        provider: 'ollama',
        approx_tokens: totalPromptEvalCount + totalEvalCount,
        num_messages: messages.length,
      });
      log('error_classified', corr, {
        thread: threadId,
        reason: classified.reason,
        status: classified.status,
        retryable: classified.retryable,
        should_compress: classified.should_compress,
        summary: classified.summary,
      });
      logError(corr, err, { thread: threadId, ms: Date.now() - startedAt, classified: classified.reason });
    }
    throw err;
  }
}

// ─── Lightweight inference (no tools, for summaries/reflections) ─────────────

export async function runSimpleInference(
  prompt: string,
  systemPrompt: string,
  model?: string,
): Promise<string> {
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  const response = await ollamaChat(messages, undefined, model);
  return response.message.content;
}
