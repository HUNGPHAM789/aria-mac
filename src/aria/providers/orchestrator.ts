// Retry orchestrator — Track D Phase D.4.
//
// Generic fallback primitive: given a provider chain and a function that
// consumes a Provider, run it with error-classifier-driven retry across
// credentials within a binding and fallback across bindings.
//
// Scope note: this commit ships the primitive + applies it to the context
// compressor summarizer (a low-stakes side-channel call). Full runClaude
// integration is a separate future task because that path is tool-use +
// streaming + state, which needs its own design.

import { classifyError, type ClassifiedError } from '../error-classifier.js';
import { log } from '../logger.js';
import type { Provider } from './types.js';
import type { ProviderBinding } from './chain.js';

const MAX_TOTAL_ATTEMPTS = 8;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 60 * 60_000;      // 1h — auth failures are sticky
const BILLING_COOLDOWN_MS = 24 * 60 * 60_000; // 24h — billing is structural
const BACKOFF_BASE_MS = 400;

export interface RunWithFallbackOptions<T> {
  /** What the caller does with each Provider. Throw to signal failure. */
  call: (provider: Provider) => Promise<T>;
  /** Correlation id for logging. */
  corr?: string;
  /** Tag for log rows so dashboards can filter (e.g. "compaction"). */
  label?: string;
  /** Cap on total attempts across the whole chain. Default 8. */
  maxAttempts?: number;
  /** Abort signal propagated via Provider options (caller's responsibility
   *  to also check it inside `call`). */
  signal?: AbortSignal;
}

export interface ProviderAttempt {
  provider: string;
  credId: string;
  ok: boolean;
  classified?: ClassifiedError;
  elapsedMs: number;
}

export interface RunWithFallbackResult<T> {
  value: T;
  /** The attempt that succeeded. */
  winner: ProviderAttempt;
  /** Every attempt, in order, including failures. Useful for observability. */
  attempts: ProviderAttempt[];
}

export class ProviderChainExhaustedError extends Error {
  readonly attempts: ProviderAttempt[];
  constructor(attempts: ProviderAttempt[], lastMessage: string) {
    super(`All providers exhausted after ${attempts.length} attempts: ${lastMessage}`);
    this.name = 'ProviderChainExhaustedError';
    this.attempts = attempts;
  }
}

function cooldownFor(reason: ClassifiedError['reason']): number {
  switch (reason) {
    case 'rate_limit': return RATE_LIMIT_COOLDOWN_MS;
    case 'overloaded': return RATE_LIMIT_COOLDOWN_MS;
    case 'auth':       return AUTH_COOLDOWN_MS;
    case 'billing':    return BILLING_COOLDOWN_MS;
    case 'server_error': return 30_000;
    case 'timeout':    return 10_000;
    default:           return 30_000;
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

/** Iterate the chain; within each binding rotate credentials via its pool;
 *  on classified errors mark the offending credential exhausted (rotate) or
 *  advance to the next binding (fallback). */
export async function runWithFallback<T>(
  chain: ProviderBinding[],
  opts: RunWithFallbackOptions<T>,
): Promise<RunWithFallbackResult<T>> {
  if (chain.length === 0) throw new Error('runWithFallback: empty chain');
  const attempts: ProviderAttempt[] = [];
  const maxAttempts = opts.maxAttempts ?? MAX_TOTAL_ATTEMPTS;
  let lastMessage = 'no attempts made';
  let consecutiveRetries = 0; // for backoff

  for (let bindingIdx = 0; bindingIdx < chain.length; bindingIdx++) {
    const binding = chain[bindingIdx];

    // Loop inside a binding: pull credentials from the pool until either a
    // call succeeds, the pool is exhausted, or a `should_fallback` error
    // pushes us to the next binding.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (attempts.length >= maxAttempts) {
        throw new ProviderChainExhaustedError(attempts, `${lastMessage} (max attempts=${maxAttempts})`);
      }
      if (opts.signal?.aborted) {
        throw new ProviderChainExhaustedError(attempts, 'aborted');
      }
      const cred = binding.pool.next();
      if (!cred) break; // pool empty → try next binding

      const provider = binding.make(cred.value);
      const startedAt = Date.now();
      if (opts.corr) log('provider_attempted', opts.corr, {
        label: opts.label ?? 'call',
        provider: binding.id,
        credId: cred.id,
        attempt: attempts.length + 1,
      });

      try {
        const value = await opts.call(provider);
        const attempt: ProviderAttempt = {
          provider: binding.id,
          credId: cred.id,
          ok: true,
          elapsedMs: Date.now() - startedAt,
        };
        attempts.push(attempt);
        if (opts.corr) log('provider_succeeded', opts.corr, {
          label: opts.label ?? 'call',
          provider: binding.id,
          credId: cred.id,
          elapsedMs: attempt.elapsedMs,
          attemptNumber: attempts.length,
        });
        return { value, winner: attempt, attempts };
      } catch (err) {
        const classified = classifyError(err, { provider: binding.id });
        const attempt: ProviderAttempt = {
          provider: binding.id,
          credId: cred.id,
          ok: false,
          classified,
          elapsedMs: Date.now() - startedAt,
        };
        attempts.push(attempt);
        lastMessage = classified.summary;
        if (opts.corr) log('provider_failed', opts.corr, {
          label: opts.label ?? 'call',
          provider: binding.id,
          credId: cred.id,
          reason: classified.reason,
          status: classified.status,
          retryable: classified.retryable,
          rotate: classified.should_rotate,
          fallback: classified.should_fallback,
        });

        // Rotate credential within this binding?
        if (classified.should_rotate) {
          binding.pool.markExhausted(cred.id, Date.now() + cooldownFor(classified.reason));
          consecutiveRetries = 0;
          continue; // next cred in same binding
        }
        // Fallback to next binding?
        if (classified.should_fallback) {
          break;
        }
        // Retryable without rotation/fallback: backoff and try same cred.
        if (classified.retryable) {
          consecutiveRetries++;
          const wait = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveRetries - 1), 5000);
          try { await delay(wait, opts.signal); } catch { /* aborted */
            throw new ProviderChainExhaustedError(attempts, 'aborted during backoff');
          }
          continue; // retry same cred
        }
        // Unknown / unclassified non-retryable: fall through to next binding.
        break;
      }
    }
    if (opts.corr) log('provider_pool_exhausted', opts.corr, {
      label: opts.label ?? 'call',
      provider: binding.id,
      nextBinding: chain[bindingIdx + 1]?.id ?? null,
    });
  }

  throw new ProviderChainExhaustedError(attempts, lastMessage);
}
