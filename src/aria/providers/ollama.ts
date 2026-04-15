// Ollama provider — wraps the local /api/chat endpoint. Today this duplicates
// a small slice of core.ts so the retry orchestrator can target a provider
// object without threading a function pointer through. When D.4 ships, core.ts
// will delegate here instead of keeping its own copy.

import type { Provider, ProviderCapabilities, ProviderChatOptions, ProviderChatResponse, ProviderMessage } from './types.js';

const DEFAULT_MODEL = 'gemma4:26b';
const DEFAULT_BASE_URL = 'http://localhost:11434';
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface OllamaProviderConfig {
  id?: string;
  baseUrl?: string;
  model?: string;
  contextWindow?: number;
}

export class OllamaProvider implements Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;

  constructor(cfg: OllamaProviderConfig = {}) {
    this.id = cfg.id ?? 'ollama';
    this.model = cfg.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = cfg.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
    this.capabilities = {
      nativeToolCalls: true,
      streaming: true,
      contextWindow: cfg.contextWindow ?? 128_000,
    };
  }

  async chat(messages: ProviderMessage[], opts: ProviderChatOptions = {}): Promise<ProviderChatResponse> {
    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages,
      stream: false,
      options: {
        num_predict: opts.maxOutputTokens ?? 4096,
      },
    };
    if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;

    // Merge caller signal with our own timeout.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        const err: Error & { status?: number } = new Error(`Ollama API error ${res.status}: ${errText.slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as {
        message: { role: 'assistant'; content?: string; thinking?: string; tool_calls?: ProviderMessage['tool_calls'] };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      // Gemma4 thinking path: if content empty but thinking present, promote.
      const content = data.message.content || data.message.thinking || '';
      return {
        message: {
          role: 'assistant',
          content,
          tool_calls: data.message.tool_calls,
          thinking: data.message.thinking,
        },
        usage: {
          input_tokens: data.prompt_eval_count,
          output_tokens: data.eval_count,
        },
        raw: data,
      };
    } finally {
      clearTimeout(timeout);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
