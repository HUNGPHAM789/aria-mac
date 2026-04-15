// Model alias registry + fallback chain.
//
// The DB key `aria_model` stores an ALIAS (friendly short name). At dispatch
// time we resolve alias → {provider, realModelName, label}. `/model <alias>`
// is the only user-facing knob. Default alias: sonnet (Claude SDK).
// Fallback chain: sonnet → gemma → gpt-oss (so Claude outage drops to local).

export type ModelProvider = 'claude' | 'ollama';

export interface ResolvedModel {
  /** The friendly alias used by users + stored in DB. */
  alias: string;
  provider: ModelProvider;
  /** Real model identifier passed to the backend API. */
  model: string;
  /** Human-readable label for /model and dashboards. */
  label: string;
}

export const DEFAULT_ALIAS = 'sonnet';

export const MODEL_ALIASES: Record<string, ResolvedModel> = {
  sonnet:    { alias: 'sonnet',    provider: 'claude', model: 'claude-sonnet-4-6',       label: 'Claude Sonnet 4.6 (SDK)' },
  opus:      { alias: 'opus',      provider: 'claude', model: 'claude-opus-4-6',         label: 'Claude Opus 4.6 (SDK)' },
  haiku:     { alias: 'haiku',     provider: 'claude', model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (SDK)' },
  gemma:     { alias: 'gemma',     provider: 'ollama', model: 'gemma4:26b',              label: 'gemma4:26b (local Ollama)' },
  'gpt-oss': { alias: 'gpt-oss',   provider: 'ollama', model: 'gpt-oss:20b',             label: 'gpt-oss:20b (local Ollama)' },
};

/** When the primary model errors with a rotate/fallback-eligible reason,
 *  try these in order. Sonnet falls back to local models so an upstream
 *  Claude outage doesn't silence ARIA. */
export const FALLBACK_CHAIN: string[] = ['sonnet', 'gemma', 'gpt-oss'];

/** Resolve an alias or a legacy raw name. Legacy forms still work so nothing
 *  stored in old DBs breaks: `ollama:<model>` → ollama path; `claude-*` →
 *  claude path; anything else → ollama with raw name. */
export function resolveModel(input: string | undefined | null): ResolvedModel {
  if (!input) return MODEL_ALIASES[DEFAULT_ALIAS];
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  const direct = MODEL_ALIASES[lower];
  if (direct) return direct;
  if (lower.startsWith('ollama:')) {
    const raw = trimmed.slice(7);
    return { alias: lower, provider: 'ollama', model: raw, label: `${raw} (local, raw)` };
  }
  if (lower.startsWith('claude-')) {
    return { alias: lower, provider: 'claude', model: trimmed, label: `${trimmed} (SDK)` };
  }
  // Unknown — assume Ollama raw (preserves back-compat with old DB values).
  return { alias: lower, provider: 'ollama', model: trimmed, label: `${trimmed} (unrecognized — treating as Ollama)` };
}

/** Build the fallback sequence starting with the caller's chosen alias.
 *  Dedup so the primary isn't retried at the end. */
export function resolveFallbackChain(primary: string | undefined | null): ResolvedModel[] {
  const start = resolveModel(primary);
  const seen = new Set<string>();
  const out: ResolvedModel[] = [];
  const push = (r: ResolvedModel) => {
    const key = `${r.provider}:${r.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  push(start);
  for (const alias of FALLBACK_CHAIN) push(resolveModel(alias));
  return out;
}

export function listAliases(): ResolvedModel[] {
  return Object.values(MODEL_ALIASES);
}

export function isValidAliasOrLegacy(input: string): boolean {
  const lower = input.trim().toLowerCase();
  if (MODEL_ALIASES[lower]) return true;
  if (lower.startsWith('ollama:') && lower.length > 7) return true;
  if (lower.startsWith('claude-') && lower.length > 7) return true;
  return false;
}
