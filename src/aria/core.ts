// src/aria/core.ts — Ollama-powered agentic inference engine (replaces Claude Agent SDK)
import { log, logError } from './logger.js';
import { verifyToolResult } from './verify.js';
import { executeTool, TOOLS } from './tools-executor.js';

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
];

export interface ParsedAction {
  action: string;
  [key: string]: unknown;
}

export interface ClaudeResponse {
  text: string;
  sessionId: string | null;
  actions: ParsedAction[];
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
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

// ─── Ollama API ──────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = () => process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL ?? 'gemma4:27b';

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
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(`${OLLAMA_BASE_URL()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  return (await res.json()) as OllamaChatResponse;
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
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(`${OLLAMA_BASE_URL()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body from Ollama');

  let fullContent = '';
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
        if (chunk.message?.tool_calls) {
          toolCalls = chunk.message.tool_calls;
        }
        if (chunk.eval_count) evalCount = chunk.eval_count;
        if (chunk.prompt_eval_count) promptEvalCount = chunk.prompt_eval_count;
      } catch { /* skip malformed lines */ }
    }
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
- create_skill — write a new skill
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
  YOU ARE ARIA — READ THIS FIRST.
════════════════════════════════════════════════════════

Your name is ARIA (Adaptive Reasoning & Intelligence Assistant).
You are NOT a generic AI assistant. You are ARIA.
When asked "who are you?" or "what's your name?", always answer: "I'm ARIA."
You live on Henry's Mac M4. You are his personal AI — proactive, sharp, always-on.
You communicate with Henry via Telegram. Henry is your Boss.
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

function extractActions(text: string): ParsedAction[] {
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
  type: 'text' | 'thinking' | 'tool_use' | 'tool_use_complete' | 'tool_result' | 'session_id' | 'agent_progress' | 'agent_started' | 'agent_stopped';
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
}

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

  const { onStream, model, corr, threadId, extraTools, maxTurns = 40 } = opts;
  const startedAt = Date.now();

  if (corr) log('request_in', corr, { thread: threadId, model, msgLen: message.length });

  // Build message history
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ];

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
  let totalEvalCount = 0;
  let totalPromptEvalCount = 0;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
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

      const toolCalls = response.message.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // No more tool calls — we're done
        finalText = response.message.content;
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
        const toolArgs = toolCall.function.arguments ?? {};

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

        messages.push({
          role: 'tool',
          content: result,
        });
      }
    }

    if (!finalText && messages.length > 2) {
      // If we hit max turns, the last assistant message is the answer
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      finalText = lastAssistant?.content ?? 'Max turns reached.';
    }

    const response: ClaudeResponse = {
      text: finalText,
      sessionId: null, // Ollama doesn't have sessions — we manage history ourselves
      actions: extractActions(finalText),
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

    return response;
  } catch (err) {
    if (corr) logError(corr, err, { thread: threadId, ms: Date.now() - startedAt });
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
