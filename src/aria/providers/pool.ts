// Credential pool — Track D Phase D.2.
//
// A per-provider rotating pool of credentials (API keys, base URLs, tokens).
// The retry orchestrator (D.4) calls next() to pick the current credential,
// and markExhausted(id, until) when a rate-limit / auth failure says to park
// the credential for a while.
//
// Persistence: exhaustion state is mirrored to a JSON file on disk so a
// process restart doesn't hammer a known-rate-limited key. The pool itself
// (the credential values) comes from env vars — we never write secrets to
// the pool file.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

export interface CredentialEntry<T> {
  /** Stable identifier — short hash of the value, or an explicit label. */
  id: string;
  value: T;
}

interface PersistedState {
  /** key = entry.id → value = "exhausted until" epoch ms */
  exhausted: Record<string, number>;
  updated: number;
}

const DEFAULT_POOL_DIR = join(homedir(), '.aria');
const DEFAULT_POOL_FILE_NAME = 'credential-pool.json';

/** Stable short id for a credential value — 10-char sha256 prefix so the
 *  persistence file is human-inspectable without leaking the secret. */
export function idForValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

export interface CredentialPoolOptions<T> {
  /** Pool name — used to scope persistence per provider (e.g. "openrouter"). */
  name: string;
  entries: Array<CredentialEntry<T>>;
  /** Override the on-disk persistence path. Default: ~/.aria/credential-pool.json */
  persistPath?: string;
  /** Disable persistence entirely (useful for tests). */
  disablePersistence?: boolean;
}

export class CredentialPool<T> {
  readonly name: string;
  private entries: Array<CredentialEntry<T>>;
  private exhausted: Map<string, number>;
  private cursor: number;
  private readonly persistPath: string | null;

  constructor(opts: CredentialPoolOptions<T>) {
    this.name = opts.name;
    this.entries = [...opts.entries];
    this.exhausted = new Map();
    this.cursor = 0;
    this.persistPath = opts.disablePersistence ? null : (opts.persistPath ?? join(DEFAULT_POOL_DIR, DEFAULT_POOL_FILE_NAME));
    this.loadPersisted();
  }

  /** Pick the next available credential (round-robin). Returns null if every
   *  entry is currently exhausted. Side effect: advances the internal cursor. */
  next(): CredentialEntry<T> | null {
    if (this.entries.length === 0) return null;
    const now = Date.now();
    // Evict stale exhaustion entries.
    for (const [id, until] of this.exhausted) {
      if (until <= now) this.exhausted.delete(id);
    }
    for (let i = 0; i < this.entries.length; i++) {
      const idx = (this.cursor + i) % this.entries.length;
      const entry = this.entries[idx];
      if (!this.exhausted.has(entry.id)) {
        this.cursor = (idx + 1) % this.entries.length;
        return entry;
      }
    }
    return null;
  }

  /** Mark a credential exhausted until the given epoch ms. 0 or past timestamps
   *  are no-ops. Persists the exhaustion table so a process restart remembers. */
  markExhausted(id: string, until: number): void {
    if (!Number.isFinite(until) || until <= Date.now()) return;
    if (!this.entries.some(e => e.id === id)) return;
    this.exhausted.set(id, until);
    this.persist();
  }

  /** Clear a credential's exhaustion state (e.g. manual reset). */
  markHealthy(id: string): void {
    if (this.exhausted.delete(id)) this.persist();
  }

  /** Inventory snapshot — useful for dashboards + logs. */
  stats(): { total: number; exhausted: number; available: number } {
    const now = Date.now();
    let live = 0;
    for (const [, until] of this.exhausted) if (until > now) live++;
    return { total: this.entries.length, exhausted: live, available: this.entries.length - live };
  }

  /** Test/debug accessor — not part of the stable surface. */
  _exhaustionSnapshot(): Map<string, number> {
    return new Map(this.exhausted);
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private loadPersisted(): void {
    if (!this.persistPath) return;
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, 'utf-8');
      const doc = JSON.parse(raw) as Record<string, PersistedState>;
      const state = doc[this.name];
      if (!state || !state.exhausted) return;
      const now = Date.now();
      for (const [id, until] of Object.entries(state.exhausted)) {
        if (typeof until === 'number' && until > now && this.entries.some(e => e.id === id)) {
          this.exhausted.set(id, until);
        }
      }
    } catch (err) {
      console.warn(`[aria] CredentialPool(${this.name}): failed to load persisted state — ${(err as Error).message}`);
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      let doc: Record<string, PersistedState> = {};
      if (existsSync(this.persistPath)) {
        try { doc = JSON.parse(readFileSync(this.persistPath, 'utf-8')) as Record<string, PersistedState>; }
        catch { doc = {}; }
      }
      doc[this.name] = {
        exhausted: Object.fromEntries(this.exhausted),
        updated: Date.now(),
      };
      // Atomic write: write to temp then rename.
      const tmp = this.persistPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch (err) {
      console.warn(`[aria] CredentialPool(${this.name}): failed to persist — ${(err as Error).message}`);
    }
  }
}

// ─── Env loaders ────────────────────────────────────────────────────────────
//
// Helpers to build pools from comma/newline-delimited env vars. Each provider
// wiring in D.3 uses one of these so ARIA operators can list multiple
// credentials without touching code.
//
//   ARIA_OPENROUTER_KEYS="sk-or-aaa,sk-or-bbb"
//   ARIA_GEMINI_KEYS="AIza...1,AIza...2,AIza...3"
//   ARIA_OLLAMA_URLS="http://localhost:11434,http://100.74.126.100:11434"
//   ARIA_CLAUDE_TOKENS="tok1,tok2"  (future: parse from `claude login` store)

export function parseEnvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export function credentialsFromEnv(envVar: string): Array<CredentialEntry<string>> {
  return parseEnvList(process.env[envVar]).map(value => ({ id: idForValue(value), value }));
}
