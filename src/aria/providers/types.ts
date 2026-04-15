// Provider abstraction — Track D Phase D.1.
//
// Every LLM call surface (Ollama, Claude SDK, OpenRouter, Gemini, …) adapts
// to this interface. The retry orchestrator (Phase D.4) iterates a chain of
// providers, swapping credentials within a provider's pool and failing over
// to the next provider when the error classifier says to.
//
// Runtime is still routed via core.ts / claude-backend.ts today — this file
// introduces only the typed surface + implementations. Wiring into the
// agentic loop lands in D.4.

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

export interface ProviderToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderChatOptions {
  model?: string;
  tools?: ProviderToolDef[];
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Max output tokens (provider-specific defaults apply when omitted). */
  maxOutputTokens?: number;
}

export interface ProviderChatResponse {
  /** Assistant message returned by the model. */
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
    /** Some providers (gemma) emit thinking traces separately. */
    thinking?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  /** Provider-specific raw payload for debugging; never relied on by callers. */
  raw?: unknown;
}

export interface ProviderCapabilities {
  /** True if the provider honors the `tools` parameter natively (function
   *  calling). Providers that only support prompt-engineered tool use
   *  should return false so the orchestrator can down-weight them on
   *  tool-heavy tasks. */
  nativeToolCalls: boolean;
  /** True if the provider can stream assistant deltas (future D.4 streaming). */
  streaming: boolean;
  /** Approximate context window size in tokens. Used by error classifier to
   *  decide whether to request compression on context_overflow. */
  contextWindow: number;
}

export interface Provider {
  /** Stable identifier — used in logs, credential-pool keying, chain config. */
  readonly id: string;
  /** Default model name this instance is configured to call. */
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  /** Single non-streaming chat completion. Throws on transport / API error;
   *  the caller (retry orchestrator) uses error-classifier.ts to decide
   *  whether to retry / rotate credential / fall back to next provider. */
  chat(messages: ProviderMessage[], opts?: ProviderChatOptions): Promise<ProviderChatResponse>;
}
