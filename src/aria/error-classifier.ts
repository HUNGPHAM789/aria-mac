// Error classification — Hermes-lite port of agent/error_classifier.py.
// Stateless: takes (error, context) and returns a ClassifiedError describing
// reason + recovery hints (retryable, should_compress, should_rotate,
// should_fallback). Callers decide what to do with the hints. Currently
// logs-only in ARIA; future work hooks these into retry/fallback/compress
// paths once multi-provider support lands.
//
// 8 reason classes (subset of Hermes's 14 — the rest add multi-provider
// nuance ARIA doesn't use yet):
//   auth                401/403 + 'invalid api key'/'unauthorized'/...
//   billing             402 + 'insufficient credits'/'quota exceeded'/...
//   rate_limit          429 + 'rate limit'/'try again in'/...
//   overloaded          503/529
//   server_error        500/502/5xx
//   timeout             transport errors + connection_reset
//   context_overflow    'context length'/'max_model_len'/'token limit'/...
//   model_not_found     404 + 'model not found'/'invalid model'/...
//   unknown             fallback

export type FailoverReason =
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'context_overflow'
  | 'model_not_found'
  | 'unknown';

export interface ClassifiedError {
  reason: FailoverReason;
  retryable: boolean;
  should_compress: boolean;
  should_rotate: boolean;
  should_fallback: boolean;
  status: number | null;
  message: string;
  summary: string;
}

// Pattern banks — same ordering priority as Hermes.

const AUTH_PATTERNS = [
  /\binvalid[_ ]api[_ ]key\b/i,
  /\bauthentication[_ ]failed?\b/i,
  /\bunauthori[sz]ed\b/i,
  /\binvalid token\b/i,
  /\btoken expired\b/i,
  /\btoken revoked\b/i,
  /\baccess denied\b/i,
];

const BILLING_PATTERNS = [
  /\binsufficient credits?\b/i,
  /\bcredit balance\b/i,
  /\bcredits have been exhausted\b/i,
  /\btop up your credits\b/i,
  /\bpayment required\b/i,
  /\bbilling hard limit\b/i,
  /\bexceeded your current quota\b/i,
  /\baccount is deactivated\b/i,
  /\bplan does not include\b/i,
  /\bkey limit exceeded\b/i,
  /\bspending limit\b/i,
];

const RATE_LIMIT_PATTERNS = [
  /\brate[_ ]limit(?:ed|_exceeded)?\b/i,
  /\btoo many requests\b/i,
  /\bthrottled\b/i,
  /\brequests per (?:minute|second|day|hour)\b/i,
  /\btokens per minute\b/i,
  /\btry again in\b/i,
  /\bplease retry after\b/i,
  /\bresource[_ ]exhausted\b/i,
  /\brate increased too quickly\b/i,  // Alibaba/DashScope
];

const CONTEXT_OVERFLOW_PATTERNS = [
  /\bcontext length\b/i,
  /\bcontext size\b/i,
  /\bmaximum context\b/i,
  /\btoken limit\b/i,
  /\btoo many tokens\b/i,
  /\breduce the length\b/i,
  /\bexceeds the limit\b/i,
  /\bcontext window\b/i,
  /\bprompt is too long\b/i,
  /\bmax_tokens\b/i,
  /\bexceeds the max_model_len\b/i,  // vLLM
  /\bmax_model_len\b/i,
  /\bprompt length\b/i,
  /\bcontext length exceeded\b/i,     // Ollama
  /\btruncating input\b/i,
  /\bslot context\b/i,                 // llama.cpp
  /\bn_ctx_slot\b/i,
];

const MODEL_NOT_FOUND_PATTERNS = [
  /\bis not a valid model\b/i,
  /\binvalid model\b/i,
  /\bmodel not found\b/i,
  /\bmodel_not_found\b/i,
  /\bdoes not exist\b/i,
  /\bno such model\b/i,
  /\bunknown model\b/i,
  /\bunsupported model\b/i,
];

const SERVER_DISCONNECT_PATTERNS = [
  /\bserver disconnected\b/i,
  /\bpeer closed connection\b/i,
  /\bconnection reset by peer\b/i,
  /\bnetwork connection lost\b/i,
  /\bunexpected eof\b/i,
  /\bincomplete chunked read\b/i,
];

const TRANSPORT_ERROR_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'ConnectError',
  'ReadTimeout',
  'ConnectTimeout',
  'PoolTimeout',
  'APIConnectionError',
  'APITimeoutError',
  'FetchError',
]);

function extractStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const direct = e.status ?? e.statusCode ?? e.status_code;
  if (typeof direct === 'number') return direct;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp && typeof resp.status === 'number') return resp.status;
  return null;
}

function extractMessage(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown>;
  const topMsg = typeof e.message === 'string' ? e.message : '';
  const body = e.body as { error?: { message?: string }; message?: string } | undefined;
  const bodyMsg = body?.error?.message ?? body?.message ?? '';
  // Some SDKs put the raw payload in `body.error.metadata.raw` (OpenRouter).
  const rawMsg = (body as { error?: { metadata?: { raw?: string } } } | undefined)?.error?.metadata?.raw ?? '';
  const parts = [topMsg, bodyMsg, rawMsg].filter(Boolean);
  return parts.join(' | ') || (err instanceof Error ? err.message : '');
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

export interface ClassifyContext {
  provider?: string;
  approx_tokens?: number;
  context_length?: number;
  num_messages?: number;
}

function result(
  reason: FailoverReason,
  message: string,
  status: number | null,
  overrides: Partial<Pick<ClassifiedError, 'retryable' | 'should_compress' | 'should_rotate' | 'should_fallback'>> = {},
): ClassifiedError {
  const defaults: Record<FailoverReason, Pick<ClassifiedError, 'retryable' | 'should_compress' | 'should_rotate' | 'should_fallback'>> = {
    auth:             { retryable: false, should_compress: false, should_rotate: true,  should_fallback: true  },
    billing:          { retryable: false, should_compress: false, should_rotate: true,  should_fallback: true  },
    rate_limit:       { retryable: true,  should_compress: false, should_rotate: true,  should_fallback: true  },
    overloaded:       { retryable: true,  should_compress: false, should_rotate: false, should_fallback: false },
    server_error:     { retryable: true,  should_compress: false, should_rotate: false, should_fallback: false },
    timeout:          { retryable: true,  should_compress: false, should_rotate: false, should_fallback: false },
    context_overflow: { retryable: true,  should_compress: true,  should_rotate: false, should_fallback: false },
    model_not_found:  { retryable: false, should_compress: false, should_rotate: false, should_fallback: true  },
    unknown:          { retryable: true,  should_compress: false, should_rotate: false, should_fallback: false },
  };
  const merged = { ...defaults[reason], ...overrides };
  return {
    reason,
    status,
    message,
    summary: `${reason}${status ? ` (HTTP ${status})` : ''}${merged.should_compress ? ' + compress' : ''}${merged.should_rotate ? ' + rotate' : ''}${merged.should_fallback ? ' + fallback' : ''}`,
    ...merged,
  };
}

export function classifyError(err: unknown, ctx: ClassifyContext = {}): ClassifiedError {
  const status = extractStatus(err);
  const message = extractMessage(err);
  const errorName = (err as { name?: string; constructor?: { name?: string } })?.name
    ?? (err as { constructor?: { name?: string } })?.constructor?.name
    ?? '';

  // 1. HTTP status dispatch (short-circuit paths).
  if (status === 401) return result('auth', message, status);
  if (status === 403) {
    if (matchesAny(message, BILLING_PATTERNS)) return result('billing', message, status);
    return result('auth', message, status);
  }
  if (status === 402) {
    // transient vs permanent: Hermes's _classify_402 logic
    if (matchesAny(message, RATE_LIMIT_PATTERNS) || /\btry again\b|\bresets at\b|\bwindow\b/i.test(message)) {
      return result('rate_limit', message, status);
    }
    return result('billing', message, status);
  }
  if (status === 404 && matchesAny(message, MODEL_NOT_FOUND_PATTERNS)) {
    return result('model_not_found', message, status);
  }
  if (status === 413) return result('context_overflow', message, status, { should_compress: true });
  if (status === 429) return result('rate_limit', message, status);
  if (status === 503 || status === 529) return result('overloaded', message, status);
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return result('server_error', message, status);
  }
  if (status === 400) {
    if (matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) return result('context_overflow', message, status);
    if (matchesAny(message, MODEL_NOT_FOUND_PATTERNS)) return result('model_not_found', message, status);
    if (matchesAny(message, RATE_LIMIT_PATTERNS)) return result('rate_limit', message, status);
    if (matchesAny(message, BILLING_PATTERNS)) return result('billing', message, status);
    // Heuristic: generic 400 + large session → probably context_overflow
    const ctxLen = ctx.context_length ?? 0;
    const approx = ctx.approx_tokens ?? 0;
    if (message.length < 40 && ((ctxLen > 0 && approx > ctxLen * 0.4) || approx > 80_000 || (ctx.num_messages ?? 0) > 80)) {
      return result('context_overflow', message, status, { should_compress: true });
    }
    return result('unknown', message, status, { retryable: false });
  }

  // 2. Pattern match on message when no status (Ollama, transport errors).
  if (matchesAny(message, AUTH_PATTERNS)) return result('auth', message, status);
  if (matchesAny(message, BILLING_PATTERNS)) return result('billing', message, status);
  if (matchesAny(message, RATE_LIMIT_PATTERNS)) return result('rate_limit', message, status);
  if (matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) return result('context_overflow', message, status);
  if (matchesAny(message, MODEL_NOT_FOUND_PATTERNS)) return result('model_not_found', message, status);

  // 3. Transport / disconnect.
  if (TRANSPORT_ERROR_NAMES.has(errorName)) return result('timeout', message, status);
  if (matchesAny(message, SERVER_DISCONNECT_PATTERNS)) {
    const approx = ctx.approx_tokens ?? 0;
    const ctxLen = ctx.context_length ?? 0;
    if ((ctxLen > 0 && approx > ctxLen * 0.6) || approx > 120_000 || (ctx.num_messages ?? 0) > 200) {
      return result('context_overflow', message, status, { should_compress: true });
    }
    return result('timeout', message, status);
  }

  // 4. Fallback.
  return result('unknown', message, status);
}
