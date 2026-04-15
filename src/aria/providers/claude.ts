// Claude Agent SDK provider — wraps the first-party @anthropic-ai/claude-agent-sdk
// query() call in the Provider interface. Unlike the Ollama provider, Claude's
// SDK is turn-oriented (built-in tool loop) — this adapter issues a single
// one-shot query, returns the assistant text, and does NOT try to round-trip
// tool use here. The retry orchestrator uses this for chain fallback on
// side-channel calls (e.g. compaction summary, pre-compress digest) where a
// one-shot is enough.
//
// Full-loop usage continues to go through claude-backend.ts runClaudeBackend.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Provider,
  ProviderCapabilities,
  ProviderChatOptions,
  ProviderChatResponse,
  ProviderMessage,
} from './types.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface ClaudeProviderConfig {
  id?: string;
  model?: string;
  contextWindow?: number;
  /** Optional system prompt override. When absent, caller's first `system`
   *  message is passed through. */
  systemPromptOverride?: string;
}

function flattenToPrompt(messages: ProviderMessage[]): { system: string; user: string } {
  const systemParts: string[] = [];
  const userParts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else if (m.role === 'user') userParts.push(m.content);
    else if (m.role === 'assistant') userParts.push(`[prior assistant turn]\n${m.content}`);
    // tool messages are intentionally dropped — this is a side-channel adapter.
  }
  return {
    system: systemParts.join('\n\n'),
    user: userParts.join('\n\n'),
  };
}

export class ClaudeProvider implements Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly systemOverride?: string;

  constructor(cfg: ClaudeProviderConfig = {}) {
    this.id = cfg.id ?? 'claude';
    this.model = cfg.model ?? process.env.ARIA_CLAUDE_MODEL ?? DEFAULT_MODEL;
    this.systemOverride = cfg.systemPromptOverride;
    this.capabilities = {
      nativeToolCalls: true,
      streaming: true,
      contextWindow: cfg.contextWindow ?? 200_000,
    };
  }

  async chat(messages: ProviderMessage[], opts: ProviderChatOptions = {}): Promise<ProviderChatResponse> {
    const { system, user } = flattenToPrompt(messages);
    const effectiveSystem = this.systemOverride ?? system;
    // Cooperative cancel via caller's signal. SDK does not expose its own
    // AbortSignal hook today; best-effort abort via for-await.
    const q = query({
      prompt: user,
      options: {
        model: opts.model ?? this.model,
        systemPrompt: effectiveSystem ? { type: 'preset', preset: 'claude_code', append: effectiveSystem } : { type: 'preset', preset: 'claude_code' },
        allowedTools: [], // side-channel: no tool use in this adapter
        permissionMode: 'bypassPermissions',
      },
    });

    let finalText = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const msg of q) {
      if (opts.signal?.aborted) throw new Error('aborted');
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          finalText = msg.result ?? '';
          const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          inputTokens = usage?.input_tokens;
          outputTokens = usage?.output_tokens;
        } else {
          const err: Error & { status?: number } = new Error(`Claude SDK error: ${JSON.stringify(msg).slice(0, 400)}`);
          throw err;
        }
      }
    }

    return {
      message: { role: 'assistant', content: finalText },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }
}
