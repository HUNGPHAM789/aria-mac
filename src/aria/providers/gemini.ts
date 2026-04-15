// Gemini provider — direct HTTPS to generativelanguage.googleapis.com. Uses
// the OpenAI-compatible endpoint at /v1beta/openai/chat/completions so the
// body shape matches OpenRouter/OpenAI and the retry orchestrator can handle
// all three uniformly. Multi-key rotation is done by the D.2 credential pool,
// not inside this class.

import type { Provider, ProviderCapabilities, ProviderChatOptions, ProviderChatResponse, ProviderMessage } from './types.js';

const DEFAULT_MODEL = 'gemini-2.0-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface GeminiProviderConfig {
  id?: string;
  apiKey: string;
  model?: string;
  contextWindow?: number;
}

export class GeminiProvider implements Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly apiKey: string;

  constructor(cfg: GeminiProviderConfig) {
    if (!cfg.apiKey) throw new Error('GeminiProvider: apiKey required');
    this.id = cfg.id ?? 'gemini';
    this.model = cfg.model ?? DEFAULT_MODEL;
    this.apiKey = cfg.apiKey;
    this.capabilities = {
      nativeToolCalls: true,
      streaming: true,
      contextWindow: cfg.contextWindow ?? 1_000_000,
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

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        const err: Error & { status?: number; body?: unknown } = new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
        err.status = res.status;
        try { err.body = JSON.parse(errText); } catch { err.body = errText; }
        throw err;
      }
      const data = (await res.json()) as {
        choices: Array<{ message: { role: 'assistant'; content?: string; tool_calls?: ProviderMessage['tool_calls'] } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      if (!choice) throw new Error('Gemini response missing choices[0]');
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
