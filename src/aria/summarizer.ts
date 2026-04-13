import { runSimpleInference } from './core.js';
import {
  getRecentMessages,
  insertConversationSummary,
  getRecentSummaries,
  getAllSummaries,
  upsertSummaryEmbedding,
  searchSummaryEmbeddings,
  isVecEnabled,
  type ConversationSummary,
} from '../db/index.js';
import { log } from './logger.js';

// Re-export embedText from memory.ts to avoid circular dep — import lazily
let _embedText: ((text: string) => Promise<Float32Array | null>) | null = null;
async function getEmbedText(): Promise<(text: string) => Promise<Float32Array | null>> {
  if (!_embedText) {
    const mod = await import('./memory.js');
    _embedText = (mod as { embedText?: (text: string) => Promise<Float32Array | null> }).embedText
      ?? (async () => null);
  }
  return _embedText;
}

// ─── Configuration ──────────────────────────────────────────────────────

const SUMMARY_MIN_MESSAGES = 6;       // Don't summarize very short conversations
const SUMMARY_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between summaries per thread
const MAX_MESSAGES_FOR_SUMMARY = 30;  // Limit context sent to summarizer

const _lastSummaryAt = new Map<string, number>();

// ─── Generate Summary ───────────────────────────────────────────────────

export async function maybeGenerateSummary(
  threadId: string,
  sessionId: string | null,
  corr?: string,
): Promise<void> {
  // Cooldown check
  const lastAt = _lastSummaryAt.get(threadId) ?? 0;
  if (Date.now() - lastAt < SUMMARY_COOLDOWN_MS) return;

  // Check message count
  const sid = sessionId ?? threadId;
  const messages = getRecentMessages(sid, MAX_MESSAGES_FOR_SUMMARY);
  if (messages.length < SUMMARY_MIN_MESSAGES) return;

  _lastSummaryAt.set(threadId, Date.now());

  try {
    // Build conversation text for the summarizer
    const convoText = messages
      .reverse() // oldest first
      .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
      .join('\n');

    const summaryPrompt = `Summarize this conversation in exactly 3-5 bullet points. Focus on:
- What was worked on (specific features, files, bugs)
- Key decisions made
- What's still pending or next

Format: plain text bullet points, no markdown headers. Be specific — names, paths, numbers.
Keep total under 400 characters.

Conversation:
${convoText.slice(0, 6000)}`;

    const systemPrompt = 'You are a conversation summarizer. Output only the bullet-point summary, nothing else.';

    // Use a lightweight inference call for summarization
    const summaryText = await runSimpleInference(summaryPrompt, systemPrompt);

    if (!summaryText.trim()) return;

    // Extract topics from the summary (simple keyword extraction)
    const topics = extractTopics(summaryText);

    // Store the summary
    const summaryId = insertConversationSummary(threadId, summaryText.trim(), {
      sessionId: sessionId ?? undefined,
      topics,
      msgCount: messages.length,
    });

    // Embed for semantic search
    if (isVecEnabled()) {
      const embedFn = await getEmbedText();
      const embedding = await embedFn(summaryText);
      if (embedding) {
        upsertSummaryEmbedding(summaryId, embedding);
      }
    }

    if (corr) log('summary_generated', corr, { thread: threadId, summaryId, msgCount: messages.length });
    console.log(`[ARIA] Session summary generated for ${threadId} (${messages.length} msgs)`);
  } catch (err) {
    console.error('[ARIA] Summary generation error:', err);
  }
}

// ─── Topic Extraction ───────────────────────────────────────────────────

function extractTopics(summary: string): string {
  // Simple: extract capitalized words, filenames, and tech terms
  const techTerms = new Set([
    'api', 'sdk', 'rag', 'mcp', 'ui', 'ux', 'db', 'sql', 'css', 'html',
    'react', 'next', 'node', 'supabase', 'telegram', 'vercel', 'git',
    'typescript', 'tailwind', 'gemini', 'claude', 'aria', 'hydra', 'antera',
    'owllio', 'auth', 'deploy', 'test', 'bug', 'fix', 'refactor',
  ]);

  const words = summary.toLowerCase().split(/[\s,.\-:;()/]+/);
  const topics = words.filter(w =>
    w.length > 2 && (techTerms.has(w) || /\.(ts|js|tsx|json|md|sql)$/.test(w))
  );
  return [...new Set(topics)].slice(0, 8).join(',');
}

// ─── Load Recent Context ────────────────────────────────────────────────
// Used by the system prompt builder to inject "what we did recently"

export function loadRecentSessionContext(threadId: string): string {
  const summaries = getRecentSummaries(threadId, 3);
  if (summaries.length === 0) return '';

  const lines = summaries.map(s => {
    const ago = formatTimeAgo(s.created_at);
    return `[${ago}] ${s.summary.trim()}`;
  });

  return `\n## Recent Sessions (${threadId})\n${lines.join('\n\n')}`;
}

export function loadGlobalRecentContext(): string {
  const summaries = getAllSummaries(5);
  if (summaries.length === 0) return '';

  const lines = summaries.map(s => {
    const ago = formatTimeAgo(s.created_at);
    const thread = s.thread_id.replace('telegram:', 'TG:');
    return `[${ago} — ${thread}] ${s.summary.slice(0, 200).trim()}`;
  });

  return `\n## Recent Activity Across All Threads\n${lines.join('\n\n')}`;
}

// ─── Semantic Search ────────────────────────────────────────────────────

export async function searchSummaries(queryText: string): Promise<Array<ConversationSummary & { distance?: number }>> {
  // Try semantic search first
  if (isVecEnabled()) {
    const embedFn = await getEmbedText();
    const qEmb = await embedFn(queryText);
    if (qEmb) {
      const hits = searchSummaryEmbeddings(qEmb, 8);
      if (hits.length > 0) {
        const allSummaries = getAllSummaries(50);
        const byId = new Map(allSummaries.map(s => [s.id, s]));
        return hits
          .map(h => ({ ...byId.get(h.id)!, distance: h.distance }))
          .filter(s => s.id != null);
      }
    }
  }

  // Keyword fallback
  const { searchSummariesByKeyword } = await import('../db/index.js');
  return searchSummariesByKeyword(queryText);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatTimeAgo(unixSec: number): string {
  const diffSec = Math.floor(Date.now() / 1000) - unixSec;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  const days = Math.floor(diffSec / 86400);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}
