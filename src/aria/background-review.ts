// Background skill/memory review — port of Hermes run_agent.py:2169-2268.
// Every N turns per thread, after a normal response is delivered, spawn a
// fire-and-forget review task that looks at the recent turn and asks the
// model whether (a) a new skill is worth creating, (b) an existing skill
// is worth patching, or (c) a memory note is worth storing. Fully async,
// never blocks the main turn.
//
// Node is single-process, so we don't need worker_threads like Hermes did
// with Python + threading. A Promise.resolve().then(...) is enough — the
// main turn has already returned by the time this runs.
//
// Config (env):
//   ARIA_BACKGROUND_REVIEW=off    — disable entirely (default: on)
//   ARIA_BACKGROUND_REVIEW_EVERY=N — fire every N turns per thread (default: 10)

import { log } from './logger.js';
import { listSkills } from './skills.js';

export interface ReviewTurnSnapshot {
  threadId: string;
  corr: string;
  userMessage: string;
  assistantText: string;
  toolsUsed: string[];
}

interface ReviewState {
  turnsSinceReview: number;
  running: boolean;
}

const _state = new Map<string, ReviewState>();
// Guard re-entry: background review itself calls runClaude(ephemeral=true),
// which would otherwise trigger another review. This set tracks corr IDs
// currently executing inside a review.
const _reviewCorrs = new Set<string>();

function reviewEvery(): number {
  const n = parseInt(process.env.ARIA_BACKGROUND_REVIEW_EVERY ?? '10', 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

function reviewEnabled(): boolean {
  return (process.env.ARIA_BACKGROUND_REVIEW ?? 'on').toLowerCase() !== 'off';
}

export function isInsideReview(corr: string): boolean {
  return _reviewCorrs.has(corr);
}

// Called by runClaude post-response. Decides whether to fire a review,
// returns immediately. Does NOT await the review.
export function maybeScheduleReview(snap: ReviewTurnSnapshot): void {
  if (!reviewEnabled()) return;
  if (isInsideReview(snap.corr)) return; // don't recurse
  if (!snap.assistantText || snap.assistantText.length < 20) return; // nothing useful

  const state = _state.get(snap.threadId) ?? { turnsSinceReview: 0, running: false };
  state.turnsSinceReview += 1;
  _state.set(snap.threadId, state);

  if (state.turnsSinceReview < reviewEvery()) return;
  if (state.running) return; // prior review still in flight

  state.turnsSinceReview = 0;
  state.running = true;

  // Fire and forget. Errors logged but never surfaced.
  Promise.resolve()
    .then(() => runReview(snap))
    .catch((err) => {
      log('error', snap.corr, { where: 'background_review', err: (err as Error).message });
    })
    .finally(() => {
      const s = _state.get(snap.threadId);
      if (s) s.running = false;
    });
}

async function runReview(snap: ReviewTurnSnapshot): Promise<void> {
  const reviewCorr = `${snap.corr}-review`;
  _reviewCorrs.add(reviewCorr);
  const started = Date.now();
  try {
    // Lazy-import to avoid a cycle with core.ts (core → this file → core).
    const { runClaude } = await import('./core.js');
    const { buildAriaTools } = await import('./tools.js');

    const skills = listSkills();
    const skillsIndex = skills.length
      ? skills.map(s => `  • ${s.skill_name} — ${s.description}`).join('\n')
      : '(none yet)';

    const systemPrompt = `You are ARIA running a lightweight post-turn review. You just finished a conversation turn with Boss.

Your job now: decide if ANY of the following would help Boss on future turns:
1. Create a new skill — capture a repeatable workflow worth invoking later
2. Patch an existing skill — fix/extend something that almost worked
3. No action — the turn didn't surface anything reusable

Rules:
- Be conservative. Most turns do NOT need action. Doing nothing is the right answer most of the time.
- If you DO act, call exactly one tool (create_skill | edit_skill | patch_skill) and nothing else.
- Do not create skills that duplicate existing ones in the index below.
- Skill content MUST begin with --- frontmatter block containing name + description.
- After the tool call (or if taking no action), reply with ONE short line summarizing what you did or why you did nothing.

Current skills:
${skillsIndex}`;

    const userMessage = `<recent-turn>
Boss asked:
${snap.userMessage.slice(0, 1500)}

ARIA replied:
${snap.assistantText.slice(0, 2000)}

Tools used: ${snap.toolsUsed.join(', ') || 'none'}
</recent-turn>

Review this turn. Act if it surfaces a reusable pattern; otherwise say "no action needed".`;

    const extraTools = buildAriaTools({ corr: reviewCorr, threadId: `review:${snap.threadId}` });

    const result = await runClaude(userMessage, systemPrompt, {
      corr: reviewCorr,
      threadId: `review:${snap.threadId}`,
      extraTools,
      ephemeral: true,
      maxTurns: 6,
    });

    log('background_review_done', reviewCorr, {
      thread: snap.threadId,
      ms: Date.now() - started,
      textLen: result.text.length,
      actions: result.actions?.length ?? 0,
    });
  } finally {
    _reviewCorrs.delete(reviewCorr);
  }
}
