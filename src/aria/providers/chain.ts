// Chain resolver — Track D Phase D.3.
//
// Turns env config into an ordered list of ProviderBinding objects. The
// orchestrator (D.4) iterates the chain, pulls a credential from each
// binding's pool, constructs a provider instance, and invokes it. On
// failure it consults the error classifier and either rotates credential
// within the same binding or moves to the next.
//
// Chain spec:
//   ARIA_PROVIDER_CHAIN="claude,ollama"   # comma-separated ids
// Defaults:
//   - If ARIA_LLM=claude  → "claude,ollama"
//   - Otherwise           → "ollama,claude"
// Bindings are only created for providers that have at least one live
// credential in the pool (or a hardcoded fallback, for Ollama's default URL).

import type { Provider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { ClaudeProvider } from './claude.js';
import { OpenRouterProvider } from './openrouter.js';
import { GeminiProvider } from './gemini.js';
import { CredentialPool, credentialsFromEnv, idForValue, type CredentialEntry } from './pool.js';

export interface ProviderBinding {
  /** Stable id — 'ollama' | 'claude' | 'openrouter' | 'gemini'. */
  readonly id: string;
  /** Pool of credentials (opaque string values). Some providers use URLs
   *  (Ollama), some API keys (OpenRouter/Gemini), some OAuth tokens (Claude). */
  readonly pool: CredentialPool<string>;
  /** Factory: given the chosen credential, produce a provider instance. */
  make(credential: string): Provider;
}

interface BuilderResult {
  binding: ProviderBinding;
  /** When true the binding should be kept even with an empty pool (e.g. Ollama
   *  falls back to the default localhost URL). */
  keepEmpty: boolean;
}

function buildOllamaBinding(): BuilderResult {
  const envEntries = credentialsFromEnv('ARIA_OLLAMA_URLS');
  const entries: CredentialEntry<string>[] = envEntries.length > 0
    ? envEntries
    : [{ id: idForValue('__default__'), value: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434' }];
  const pool = new CredentialPool<string>({ name: 'ollama', entries });
  return {
    keepEmpty: true,
    binding: {
      id: 'ollama',
      pool,
      make: (baseUrl: string) => new OllamaProvider({ baseUrl }),
    },
  };
}

function buildClaudeBinding(): BuilderResult {
  const envEntries = credentialsFromEnv('ARIA_CLAUDE_TOKENS');
  // Claude Agent SDK reads its own OAuth token from ~/.claude — if no env
  // tokens are configured we still ship one binding with a sentinel value so
  // the SDK uses its default login.
  const entries: CredentialEntry<string>[] = envEntries.length > 0
    ? envEntries
    : [{ id: idForValue('__default__'), value: '__default__' }];
  const pool = new CredentialPool<string>({ name: 'claude', entries });
  return {
    keepEmpty: true,
    binding: {
      id: 'claude',
      pool,
      // The ClaudeProvider doesn't take a token param — the SDK resolves its
      // own auth. We still rotate via the pool for exhaustion tracking when
      // future work supports explicit token injection.
      make: (_token: string) => new ClaudeProvider(),
    },
  };
}

function buildOpenRouterBinding(): BuilderResult | null {
  const entries = credentialsFromEnv('ARIA_OPENROUTER_KEYS');
  if (entries.length === 0) return null; // skip when no keys configured
  const pool = new CredentialPool<string>({ name: 'openrouter', entries });
  return {
    keepEmpty: false,
    binding: {
      id: 'openrouter',
      pool,
      make: (apiKey: string) => new OpenRouterProvider({ apiKey }),
    },
  };
}

function buildGeminiBinding(): BuilderResult | null {
  const entries = credentialsFromEnv('ARIA_GEMINI_KEYS');
  if (entries.length === 0) return null;
  const pool = new CredentialPool<string>({ name: 'gemini', entries });
  return {
    keepEmpty: false,
    binding: {
      id: 'gemini',
      pool,
      make: (apiKey: string) => new GeminiProvider({ apiKey }),
    },
  };
}

const BUILDERS: Record<string, () => BuilderResult | null> = {
  ollama: buildOllamaBinding,
  claude: buildClaudeBinding,
  openrouter: buildOpenRouterBinding,
  gemini: buildGeminiBinding,
};

function defaultChainIds(): string[] {
  const raw = process.env.ARIA_PROVIDER_CHAIN?.trim();
  if (raw) return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return (process.env.ARIA_LLM ?? '').toLowerCase() === 'claude'
    ? ['claude', 'ollama']
    : ['ollama', 'claude'];
}

/** Resolve the provider chain from env. Unknown ids are dropped with a warn;
 *  providers with empty pools that aren't `keepEmpty` are skipped silently. */
export function resolveChain(chainIds: string[] = defaultChainIds()): ProviderBinding[] {
  const out: ProviderBinding[] = [];
  for (const id of chainIds) {
    const builder = BUILDERS[id];
    if (!builder) {
      console.warn(`[aria] resolveChain: unknown provider id "${id}" — skipping`);
      continue;
    }
    const result = builder();
    if (!result) continue;
    if (result.binding.pool.stats().available === 0 && !result.keepEmpty) continue;
    out.push(result.binding);
  }
  return out;
}

/** Test hook — build a chain from an explicit list of bindings. */
export function makeChain(bindings: ProviderBinding[]): ProviderBinding[] {
  return [...bindings];
}
