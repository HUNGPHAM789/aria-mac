// Claude Agent SDK backend — lets ARIA use Claude subscription via the
// first-party SDK, alongside the existing Ollama loop. Select with
// ARIA_LLM=claude (default: ollama). ARIA_CLAUDE_MODEL overrides the
// default (claude-sonnet-4-6); allowed: claude-opus-4-6, claude-sonnet-4-6,
// claude-haiku-4-5.
//
// How it works:
//   1. Wrap ARIA's action tools (create_skill, spawn_agent, recall, …) as
//      an in-process MCP server via createSdkMcpServer. Each tool's
//      JSON-schema parameters is converted to a Zod object shape.
//   2. Call query() with the user message + MCP server + systemPrompt.
//      The SDK runs its own tool loop; our handlers fire when Claude
//      invokes an ARIA tool, and we emit the same stream events the
//      Ollama loop emits so the dashboard/Telegram gateways see
//      consistent behavior.
//   3. Read SDKResultMessage at the end, strip any <action> blocks, and
//      return the same ClaudeResponse shape the Ollama path returns.

import { query, createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { log } from './logger.js';
import { insertMessage as dbInsertMessage, getRecentMessages } from '../db/index.js';
import { extractActions, stripActionBlocks, type ClaudeResponse, type RunClaudeOptions, type StreamEvent } from './core.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Build a Zod object shape from ARIA's JSON-schema parameter description.
// Handles the common cases in ARIA tool defs: object w/ properties, string,
// number, boolean, array of primitives. Falls back to z.any() for unknown.
function jsonSchemaToZod(param: unknown): ZodTypeAny {
  if (!param || typeof param !== 'object') return z.any();
  const p = param as Record<string, unknown>;
  const type = p.type as string | undefined;
  if (type === 'string') return z.string();
  if (type === 'number' || type === 'integer') return z.number();
  if (type === 'boolean') return z.boolean();
  if (type === 'array') {
    const items = p.items ? jsonSchemaToZod(p.items) : z.any();
    return z.array(items);
  }
  if (type === 'object' && p.properties) {
    const shape: Record<string, ZodTypeAny> = {};
    const required = new Set((p.required as string[] | undefined) ?? []);
    for (const [k, v] of Object.entries(p.properties as Record<string, unknown>)) {
      const field = jsonSchemaToZod(v);
      shape[k] = required.has(k) ? field : field.optional();
    }
    return z.object(shape as ZodRawShape);
  }
  return z.any();
}

function jsonSchemaShape(param: unknown): ZodRawShape {
  // Build a mutable shape directly (avoid z.object(...).shape which is frozen in zod v4).
  if (!param || typeof param !== 'object') return { args: z.any() };
  const p = param as Record<string, unknown>;
  if (p.type !== 'object' || !p.properties) return { args: z.any() };
  const shape: Record<string, ZodTypeAny> = {};
  const required = new Set((p.required as string[] | undefined) ?? []);
  for (const [k, v] of Object.entries(p.properties as Record<string, unknown>)) {
    const field = jsonSchemaToZod(v);
    shape[k] = required.has(k) ? field : field.optional();
  }
  return shape as ZodRawShape;
}

export interface RunClaudeBackendArgs {
  message: string;
  systemPrompt: string;
  opts: RunClaudeOptions;
}

export async function runClaudeBackend({ message, systemPrompt, opts }: RunClaudeBackendArgs): Promise<ClaudeResponse> {
  const { onStream, corr, threadId, extraTools, ephemeral = false } = opts;
  const model = opts.model || process.env.ARIA_CLAUDE_MODEL || DEFAULT_MODEL;
  const startedAt = Date.now();
  const sessionId = opts.sessionId ?? (threadId ? `session:${threadId}` : `session:${Date.now()}`);

  if (corr) log('request_in', corr, { thread: threadId, model, msgLen: message.length });

  // Build MCP server exposing ARIA action tools.
  const ariaTools = (extraTools ?? []).map(t => {
    return tool(
      t.name,
      t.description,
      jsonSchemaShape(t.parameters),
      async (args) => {
        if (corr) log('tool_use', corr, { thread: threadId, tool: t.name });
        onStream?.({ type: 'tool_use', toolName: t.name, toolUseId: t.name });
        let result: string;
        try {
          result = await t.execute(args as Record<string, unknown>);
        } catch (err) {
          result = `Tool error: ${(err as Error).message}`;
        }
        const truncated = result.length > 600 ? result.slice(0, 600) + `\n…(+${result.length - 600} chars)` : result;
        if (corr) log('tool_result', corr, { thread: threadId, tool: t.name, outLen: result.length });
        onStream?.({ type: 'tool_result', toolName: t.name, output: truncated });
        return { content: [{ type: 'text' as const, text: result }] };
      },
    );
  });

  const mcpServers: Options['mcpServers'] = ariaTools.length
    ? { 'aria-actions': createSdkMcpServer({ name: 'aria-actions', version: '1.0.0', tools: ariaTools }) }
    : undefined;

  // Build prompt. SDK supports string prompt or async iterable of user
  // messages for multi-turn; we send the full recent history as preamble
  // and the new message as the actual prompt, because SDK's session_id
  // management differs from ARIA's thread-based sessions.
  let preamble = '';
  if (!ephemeral) {
    try {
      const history = getRecentMessages(sessionId, 12);
      const ordered = [...history].reverse();
      const MAX_PER_MSG = 800;
      if (ordered.length) {
        preamble = ordered
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => {
            const c = m.content.length > MAX_PER_MSG ? m.content.slice(0, MAX_PER_MSG) + '…' : m.content;
            return `${m.role === 'user' ? 'Boss' : 'Previous ARIA'}: ${c}`;
          })
          .join('\n\n');
        if (preamble) preamble = `<recent-conversation>\n${preamble}\n</recent-conversation>\n\n`;
      }
    } catch { /* first turn */ }
  }

  const prompt = `${preamble}${message}`;

  if (!ephemeral) {
    try { dbInsertMessage(sessionId, 'user', message); } catch { /* ignore */ }
  }

  // Drive the SDK. allowedTools omitted → SDK built-ins (Read/Write/Bash/
  // Grep/etc.) all available alongside our MCP tools. Users who want
  // ARIA-only can set ARIA_CLAUDE_ALLOWED_TOOLS to a comma list.
  const allowedTools = process.env.ARIA_CLAUDE_ALLOWED_TOOLS?.split(',').map(s => s.trim()).filter(Boolean);

  const q = query({
    prompt,
    options: {
      model,
      systemPrompt,
      mcpServers,
      allowedTools,
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
    },
  });

  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let lastToolOutput: string | undefined;

  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        // Surface assistant text chunks to the stream so UI stays live.
        const blocks = (msg.message.content ?? []) as Array<{ type: string; text?: string; name?: string }>;
        for (const b of blocks) {
          if (b.type === 'text' && b.text) {
            onStream?.({ type: 'text', text: b.text });
          }
          if (b.type === 'tool_use' && b.name) {
            // SDK built-in tool call (Read/Bash/etc.) — emit event; MCP
            // tools already emit from their handler.
            if (!b.name.startsWith('mcp__')) {
              onStream?.({ type: 'tool_use', toolName: b.name, toolUseId: b.name });
            }
          }
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          finalText = msg.result ?? '';
          inputTokens = (msg.usage as { input_tokens?: number } | undefined)?.input_tokens ?? 0;
          outputTokens = (msg.usage as { output_tokens?: number } | undefined)?.output_tokens ?? 0;
        } else {
          finalText = `❌ Claude SDK error: ${JSON.stringify(msg).slice(0, 400)}`;
        }
      } else if (msg.type === 'user') {
        // Echoes + tool results. Track last tool result so task-runner
        // can pass it between steps (matches Ollama loop behavior).
        const content = (msg.message.content ?? []) as Array<{ type: string; content?: unknown }>;
        let sawToolResult = false;
        for (const b of content) {
          if (b.type === 'tool_result') {
            sawToolResult = true;
            const text = typeof b.content === 'string' ? b.content
              : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map(x => x.text ?? '').join('\n')
              : '';
            if (text) lastToolOutput = text;
          }
        }
        // Tool batch finished — signal display layer to open a fresh segment.
        if (sawToolResult) onStream?.({ type: 'segment_break' });
      }
    }
  } catch (err) {
    finalText = `❌ Claude SDK error: ${(err as Error).message}`;
  }

  const elapsed = Date.now() - startedAt;
  if (corr) log('request_out', corr, {
    thread: threadId,
    model,
    ms: elapsed,
    textLen: finalText.length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });

  if (!ephemeral && finalText) {
    try { dbInsertMessage(sessionId, 'assistant', finalText); } catch { /* ignore */ }
  }

  const actions = extractActions(finalText);
  const visibleText = stripActionBlocks(finalText);

  // Post-turn: fire background review. Fire-and-forget.
  if (!ephemeral && threadId && corr) {
    const { maybeScheduleReview } = await import('./background-review.js');
    maybeScheduleReview({
      threadId,
      corr,
      userMessage: message,
      assistantText: visibleText,
      toolsUsed: [], // SDK handles tool calls internally; we don't track per-turn list yet
    });
  }

  return {
    text: visibleText,
    sessionId,
    actions,
    lastToolOutput,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

export function isClaudeBackendActive(): boolean {
  return (process.env.ARIA_LLM ?? '').toLowerCase() === 'claude';
}
