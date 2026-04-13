import {
  getDueSchedules,
  markScheduleRun,
  listSchedules,
  type Schedule,
} from '../db/index.js';
import { runClaude, buildSystemPrompt, stripActionBlocks } from './core.js';
import { loadIdentity, loadTraitsFromDb } from './identity.js';
import { loadHenryMemoryAsync, loadAvailableSkills } from './memory.js';
import { buildAriaTools } from './tools.js';
import { log, newCorrelationId } from './logger.js';
import { verifyResponseUrls } from './verify.js';
import { getModel } from '../db/index.js';

// ─── Cron Parser (5-field: min hour dom month dow) ───────────────────────────

function matchesCronField(field: string, value: number, max: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    // Step: */5 or 1-10/2
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const [start, end] = range === '*' ? [0, max] : range.split('-').map(Number);
      for (let i = start; i <= (end ?? max); i += step) {
        if (i === value) return true;
      }
      continue;
    }

    // Range: 1-5
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (value >= start && value <= end) return true;
      continue;
    }

    // Exact: 5
    if (parseInt(part, 10) === value) return true;
  }

  return false;
}

export function nextCronRun(cron: string, afterEpoch?: number): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron: ${cron} (need 5 fields)`);

  const [minF, hourF, domF, monF, dowF] = fields;
  const start = new Date((afterEpoch ?? Math.floor(Date.now() / 1000)) * 1000);
  // Start checking from the next minute
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Scan up to 366 days ahead
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    if (
      matchesCronField(minF, t.getMinutes(), 59) &&
      matchesCronField(hourF, t.getHours(), 23) &&
      matchesCronField(domF, t.getDate(), 31) &&
      matchesCronField(monF, t.getMonth() + 1, 12) &&
      matchesCronField(dowF, t.getDay(), 6)
    ) {
      return Math.floor(t.getTime() / 1000);
    }
  }

  throw new Error(`No next run found for cron: ${cron}`);
}

// ─── Scheduler Loop ──────────────────────────────────────────────────────────

export function startScheduler(
  telegramUserId: number,
  sendMessage: (userId: number, text: string) => Promise<void>,
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  console.log('[ARIA] Scheduler started (checking every 30s)');

  return setInterval(async () => {
    let due: Schedule[];
    try {
      due = getDueSchedules();
    } catch (err) {
      console.error('[ARIA] Scheduler DB error:', err);
      return;
    }

    for (const sched of due) {
      const corr = newCorrelationId();
      const threadId = `schedule:${sched.id}`;
      console.log(`[ARIA] Schedule firing: #${sched.id} "${sched.name}" (cron: ${sched.cron})`);
      log('schedule_fire', corr, { scheduleId: sched.id, name: sched.name, cron: sched.cron });

      try {
        // Calculate next run BEFORE executing (so even if execution is slow, we don't skip)
        const nextRun = nextCronRun(sched.cron);
        markScheduleRun(sched.id, nextRun);

        // Build context + run
        const identityMd = loadIdentity();
        const traits = loadTraitsFromDb();
        const memory = await loadHenryMemoryAsync(sched.prompt, corr);
        const skills = loadAvailableSkills();
        const systemPrompt = buildSystemPrompt(identityMd, traits, memory, skills);
        const extraTools = buildAriaTools({ corr, threadId });
        const currentModel = getModel();

        const result = await runClaude(
          `[Scheduled Task: "${sched.name}"]\n\n${sched.prompt}`,
          systemPrompt,
          {
            extraTools,
            corr,
            threadId,
            model: currentModel,
          },
        );

        const rawText = stripActionBlocks(result.text);
        const { text: verifiedText } = await verifyResponseUrls(rawText, corr);
        const output = verifiedText.length > 3800
          ? verifiedText.slice(0, 3800) + '\n…(truncated)'
          : verifiedText;

        // Send result to Boss
        const header = `🕐 *Scheduled: ${sched.name}*\n\n`;
        await sendMessage(telegramUserId, header + output);
        log('schedule_done', corr, { scheduleId: sched.id, name: sched.name, textLen: verifiedText.length });
      } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        console.error(`[ARIA] Schedule #${sched.id} failed:`, msg);
        log('schedule_error', corr, { scheduleId: sched.id, name: sched.name, error: msg });
        try {
          await sendMessage(telegramUserId, `⚠️ Schedule "${sched.name}" failed: ${msg.slice(0, 200)}`);
        } catch { /* don't crash on notification failure */ }
      }
    }
  }, intervalMs);
}

// ─── Human-readable schedule description ─────────────────────────────────────

export function describeCron(cron: string): string {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);

  if (cron === '* * * * *') return 'every minute';
  if (min.startsWith('*/')) return `every ${min.slice(2)} minutes`;
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') return `every hour at :${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '*') return `daily at ${hour}:${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayNames = dow.split(',').map(d => days[parseInt(d, 10)] ?? d).join(', ');
    return `${dayNames} at ${hour}:${min.padStart(2, '0')}`;
  }
  return cron;
}
