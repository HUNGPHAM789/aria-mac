// OpenRouter provider — direct HTTPS to https://openrouter.ai/api/v1/chat/completions.
// OpenAI-compatible shape; credentials are rotated by the retry orchestrator
// (D.2 credential pool). Minimal implementation today — proven path is Ollama
// + Claude; OpenRouter is here so the chain resolver can route to it without
// further code changes once an API key lands in the pool.

import type { Provider, ProviderCapabilities, ProviderChatOptions, ProviderChatResponse, ProviderMessage } from './types.js';

const DEFAULT_MODEL = 'openai/gpt-5-codex';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface OpenRouterProviderConfig {
  id?: string;
  apiKey: string;
  model?: string;
  contextWindow?: number;
  /** Optional referer shown in OpenRouter usage dashboards. */
  referer?: string;
  title?: string;
}

export class OpenRouterProvider implements Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly apiKey: string;
  private readonly referer?: string;
  private readonly title?: string;

  constructor(cfg: OpenRouterProviderConfig) {
    if (!cfg.apiKey) throw new Error('OpenRouterProvider: apiKey required');
    this.id = cfg.id ?? 'openrouter';
    this.model = cfg.model ?? DEFAULT_MODEL;
    this.apiKey = cfg.apiKey;
    this.referer = cfg.referer;
    this.title = cfg.title;
    this.capabilities = {
      nativeToolCalls: true,
      streaming: true,
      contextWindow: cfg.contextWindow ?? 128_000,
    };
  }

  async chat(messages: ProviderMessage[], opts: ProviderChatOptions = {}): Promise<ProviderChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      })),
    };
    if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
    if (opts.maxOutputTokens) body.max_tokens = opts.maxOutputTokens;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.referer) headers['HTTP-Referer'] = this.referer;
    if (this.title) headers['X-Title'] = this.title;

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        const err: Error & { status?: number; body?: unknown } = new Error(`OpenRouter ${res.status}: ${errText.slice(0, 500)}`);
        err.status = res.status;
        try { err.body = JSON.parse(errText); } catch { err.body = errText; }
        throw err;
      }
      const data = (await res.json()) as {
        choices: Array<{ message: { role: 'assistant'; content?: string; tool_calls?: ProviderMessage['tool_calls'] } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      if (!choice) throw new Error('OpenRouter response missing choices[0]');
      return {
        message: {
          role: 'assistant',
          content: choice.message.content ?? '',
          tool_calls: choice.message.tool_calls,
        },
        usage: {
          input_tokens: data.usage?.prompt_tokens,
          output_tokens: data.usage?.completion_tokens,
        },
        raw: data,
      };
    } finally {
      clearTimeout(timeout);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
