// Programmatic ambiguity detector — catches vague action-on-file prompts
// that both gemma and Sonnet fail to pause on despite identity.md rules.
//
// When triggered, returns a system nudge to inject before the user message.
// The model then sees the nudge in temporal proximity to the message,
// making the "name your interpretation first" instruction hard to ignore.

const VAGUE_VERBS = /\b(make|improve|fix|clean\s*up|optimize|refactor|update|enhance|speed\s*up|upgrade|simplify|modernize|rewrite|rework|tidy|polish|harden)\b/i;

const SCOPE_QUALIFIERS = /\b(specifically|by\s+(reducing|adding|removing|changing|splitting|merging)|the\s+\w+\s+(function|method|endpoint|handler|class|test)\b|latency|throughput|memory\s+usage|startup\s+time|line\s+\d|between\s+lines|only\s+the|just\s+the|because\s+\w|when\s+\w+\s+fails|on\s+timeout|rename\s+\w+\s+to)\b/i;

const FILE_PATH = /(?:\/[\w./-]+\.(?:ts|js|py|rs|go|tsx|jsx|json|yaml|yml|md|css|html))\b/;

const NUDGE = `[AMBIGUITY CHECK] The user's message names a file but gives no specific metric, scope, or success criteria. Per your CRITICAL identity rule: you MUST name your interpretation and what you're skipping BEFORE writing or editing any code. Say what you'll do, what you're NOT doing, and ask if that's right. Do NOT just start implementing.`;

export function detectAmbiguity(message: string): string | null {
  if (message.length > 300) return null;
  if (!VAGUE_VERBS.test(message)) return null;
  if (!FILE_PATH.test(message)) return null;
  if (SCOPE_QUALIFIERS.test(message)) return null;

  return NUDGE;
}

// Leading-prompt / false-premise detector — catches "there's a bug in X,
// find it" prompts where no bug may exist. The identity prompt already
// says "evidence required" but models still confabulate to be helpful.
// This nudge fires right before the message so the model can't miss it.

const LEADING_CLAIM = /\b(there(?:'s| is) (?:a |an )?(bug|race condition|race|issue|problem|vulnerability|leak|error|flaw)|find (?:the|this) (?:bug|race|issue|problem|leak|flaw)|which (?:ones? )?(?:are|is) (?:a )?(?:production )?(?:bug|leak|problem|issue|vulnerability))/i;

const LEADING_NUDGE = `[FALSE-PREMISE CHECK] The user claims a specific bug, issue, or vulnerability exists. Per your CRITICAL identity rule: investigate independently. Read the code and form your OWN assessment based on evidence. If you find NO bug, say "I looked at X — no bug found. Here's why the logic is sound: [reasoning]." Do NOT agree with the premise to be helpful. Do NOT invent issues. Agreeing with a false premise is the same failure as confabulation.`;

export function detectLeadingPrompt(message: string): string | null {
  if (!LEADING_CLAIM.test(message)) return null;
  if (!FILE_PATH.test(message)) return null;
  return LEADING_NUDGE;
}
