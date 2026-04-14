// src/aria/quality-judge.ts — Background quality scorer for ARIA conversations
// Watches messages table, scores user→assistant pairs, stores results.

import { getDb } from '../db/index.js';

// ─── DB Setup ──────────────────────────────────────────────────────────────

export function initQualityTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS quality_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_msg_id INTEGER NOT NULL,
      assistant_msg_id INTEGER NOT NULL,
      score INTEGER NOT NULL,           -- 0-100
      issues TEXT,                       -- JSON array of issue codes
      severity TEXT NOT NULL,            -- 'good' | 'warn' | 'bad'
      response_time_ms INTEGER,
      tools_used INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_quality_session ON quality_scores(session_id);
    CREATE INDEX IF NOT EXISTS idx_quality_severity ON quality_scores(severity);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_pair ON quality_scores(user_msg_id, assistant_msg_id);
  `);
}

// ─── Heuristic Scoring ──────────────────────────────────────────────────────

interface Score {
  score: number;
  issues: string[];
  severity: 'good' | 'warn' | 'bad';
}

export function scoreConversationTurn(
  userMsg: string,
  assistantMsg: string,
  responseTimeMs: number,
  toolsUsed: number,
): Score {
  let score = 100;
  const issues: string[] = [];

  // ── Check 1: Truly empty response ──
  if (!assistantMsg || assistantMsg.trim().length === 0) {
    score -= 60;
    issues.push('empty_response');
  }

  // ── Check 2: User asked complex question, got tiny response ──
  // Only flag if user asked a substantive question (not simple math/yes-no)
  const isSimpleQuery = /^(what is \d|is it|do you|are you|ok|yes|no|thanks?|how much|how many)/i.test(userMsg.trim());
  if (!isSimpleQuery && userMsg.length > 100 && assistantMsg.length < 30) {
    score -= 25;
    issues.push('disproportionate_response');
  }

  // ── Check 3: Response is just an error/refusal without alternative ──
  if (/^(i can'?t|i cannot|i don'?t (have|know)|sorry,? i)/i.test(assistantMsg.trim()) &&
      assistantMsg.length < 100) {
    score -= 30;
    issues.push('refusal_no_alternative');
  }

  // ── Check 4: Promised future work but never did it ──
  const promisedWork = /\b(i will|i'?ll|let me|next step|i need to|i'?m going to)/i.test(assistantMsg);
  const completedWork = /[✅❌]|\b(done|completed|finished|here'?s|i found|created|wrote|updated)\b/i.test(assistantMsg);
  if (promisedWork && !completedWork && assistantMsg.length < 500) {
    score -= 20;
    issues.push('promise_no_delivery');
  }

  // ── Check 5: Used tools but didn't summarize ──
  if (toolsUsed > 0 && !/[✅❌]/.test(assistantMsg)) {
    score -= 15;
    issues.push('no_completion_marker');
  }

  // ── Check 6: Slow response ──
  if (responseTimeMs > 60000) {
    score -= 10;
    issues.push('slow_response');
  }
  if (responseTimeMs > 180000) {
    score -= 15;
    issues.push('very_slow_response');
  }

  // ── Check 7: Hallucinated tool failure (says "doesn't exist" but response is too short/suspicious) ──
  // Only flag if response is short AND claims missing — likely didn't actually check
  if (/\b(does not exist|not found|file is missing|cannot find)\b/i.test(assistantMsg) &&
      toolsUsed === 0 && assistantMsg.length < 200) {
    score -= 20;
    issues.push('claimed_missing_without_checking');
  }

  // ── Check 8: Repetitive / stuck ──
  const lines = assistantMsg.split('\n');
  if (lines.length > 5) {
    const uniqueLines = new Set(lines.map(l => l.trim()).filter(l => l));
    if (uniqueLines.size < lines.length / 2) {
      score -= 15;
      issues.push('repetitive_output');
    }
  }

  // ── Check 9: Quality bonus — used tools + completion marker + reasonable length ──
  if (toolsUsed > 0 && /[✅❌]/.test(assistantMsg) && assistantMsg.length > 50) {
    score = Math.min(100, score + 5);
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));
  const severity: 'good' | 'warn' | 'bad' = score >= 75 ? 'good' : score >= 50 ? 'warn' : 'bad';

  return { score, issues, severity };
}

// ─── Background Judge Loop ──────────────────────────────────────────────────

let _judgeInterval: ReturnType<typeof setInterval> | null = null;

export function startQualityJudge(intervalMs = 60000): void {
  if (_judgeInterval) return;
  initQualityTable();

  const runJudge = async () => {
    try {
      const db = getDb();
      // Find user messages that don't have a quality score yet AND have an assistant response after them
      const userMsgs = db.prepare(`
        SELECT m.id, m.session_id, m.content, m.created_at
        FROM messages m
        WHERE m.role = 'user'
          AND NOT EXISTS (SELECT 1 FROM quality_scores qs WHERE qs.user_msg_id = m.id)
          AND EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.session_id = m.session_id
              AND m2.role = 'assistant'
              AND m2.id > m.id
          )
        ORDER BY m.id DESC LIMIT 50
      `).all() as { id: number; session_id: string; content: string; created_at: number }[];

      for (const userMsg of userMsgs) {
        // Find the next assistant message in the same session
        const assistantMsg = db.prepare(`
          SELECT id, content, created_at FROM messages
          WHERE session_id = ? AND role = 'assistant' AND id > ?
          ORDER BY id ASC LIMIT 1
        `).get(userMsg.session_id, userMsg.id) as { id: number; content: string; created_at: number } | undefined;

        if (!assistantMsg) continue;

        const responseTimeMs = (assistantMsg.created_at - userMsg.created_at) * 1000;
        // Tool usage estimate: count tool ribbons in response (🔧 emoji)
        const toolsUsed = (assistantMsg.content.match(/🔧/g) || []).length;

        const { score, issues, severity } = scoreConversationTurn(
          userMsg.content, assistantMsg.content, responseTimeMs, toolsUsed,
        );

        try {
          db.prepare(`
            INSERT INTO quality_scores (session_id, user_msg_id, assistant_msg_id, score, issues, severity, response_time_ms, tools_used)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(userMsg.session_id, userMsg.id, assistantMsg.id, score, JSON.stringify(issues), severity, responseTimeMs, toolsUsed);
        } catch { /* duplicate, skip */ }
      }
    } catch (err) {
      console.error('[quality-judge] Error:', (err as Error).message);
    }
  };

  // Run immediately, then on interval
  runJudge();
  _judgeInterval = setInterval(runJudge, intervalMs);
  console.log(`[ARIA] Quality judge started (interval: ${intervalMs / 1000}s)`);
}

// ─── Reporting ──────────────────────────────────────────────────────────────

export interface QualityReport {
  total: number;
  avgScore: number;
  good: number;
  warn: number;
  bad: number;
  topIssues: { code: string; count: number }[];
  recentBad: Array<{
    sessionId: string;
    score: number;
    issues: string[];
    userMsg: string;
    assistantMsg: string;
    createdAt: number;
  }>;
}

export function getQualityReport(sinceHours = 24): QualityReport {
  const since = Math.floor(Date.now() / 1000) - sinceHours * 3600;
  const db = getDb();

  const all = db.prepare(`
    SELECT score, issues, severity FROM quality_scores
    WHERE created_at > ?
  `).all(since) as { score: number; issues: string; severity: string }[];

  const total = all.length;
  if (total === 0) return { total: 0, avgScore: 0, good: 0, warn: 0, bad: 0, topIssues: [], recentBad: [] };

  const avgScore = Math.round(all.reduce((s, r) => s + r.score, 0) / total);
  const good = all.filter(r => r.severity === 'good').length;
  const warn = all.filter(r => r.severity === 'warn').length;
  const bad = all.filter(r => r.severity === 'bad').length;

  const issueCounts: Record<string, number> = {};
  for (const r of all) {
    try {
      const issues = JSON.parse(r.issues) as string[];
      for (const i of issues) issueCounts[i] = (issueCounts[i] || 0) + 1;
    } catch { /* ignore */ }
  }
  const topIssues = Object.entries(issueCounts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentBadRows = db.prepare(`
    SELECT qs.session_id, qs.score, qs.issues, qs.created_at,
           u.content as user_msg, a.content as assistant_msg
    FROM quality_scores qs
    JOIN messages u ON u.id = qs.user_msg_id
    JOIN messages a ON a.id = qs.assistant_msg_id
    WHERE qs.severity = 'bad' AND qs.created_at > ?
    ORDER BY qs.created_at DESC LIMIT 20
  `).all(since) as Array<{ session_id: string; score: number; issues: string; created_at: number; user_msg: string; assistant_msg: string }>;

  const recentBad = recentBadRows.map(r => ({
    sessionId: r.session_id,
    score: r.score,
    issues: (() => { try { return JSON.parse(r.issues); } catch { return []; } })(),
    userMsg: r.user_msg.slice(0, 200),
    assistantMsg: r.assistant_msg.slice(0, 300),
    createdAt: r.created_at,
  }));

  return { total, avgScore, good, warn, bad, topIssues, recentBad };
}
