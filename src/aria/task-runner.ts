// src/aria/task-runner.ts — External task orchestrator
// Controls the model instead of trusting it to self-manage multi-step tasks.
// The model never decides when to stop — the runner does.

import { runClaude, type RunClaudeOptions, type ClaudeResponse, type StreamEvent } from './core.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TaskStep {
  index: number;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
}

interface TaskRunnerOptions {
  systemPrompt: string;
  onStream?: (event: StreamEvent) => void;
  model?: string;
  corr?: string;
  threadId?: string;
  extraTools?: RunClaudeOptions['extraTools'];
  maxSteps?: number;       // max steps to execute (default 8)
  maxRetries?: number;     // retries per step (default 2)
}

// ─── Task Classification ───────────────────────────────────────────────────

export type TaskType = 'chat' | 'simple-task' | 'complex-task' | 'debug-task';

const SIMPLE_PATTERNS = [
  /^(hi|hey|hello|yo|sup|thanks|ok|yes|no|cool|nice)\b/i,
  /^(what|who|where|when|why|how)\s+(is|are|was|were|do|does|did|can|will)\b/i,
  /\?$/,
];

const DEBUG_PATTERNS = [
  /\b(fix|debug|broken|not working|doesn't work|failed|error|issue|wrong|missing|blank|empty)\b/i,
  /\b(why (is|does|did|isn't|doesn't)|what happened|check (why|if|the))\b/i,
  /\b(still|again|yet|anymore)\b.*\b(not|broken|fail|wrong|missing)\b/i,
  /\b(might be (down|broken|failing|stuck))\b/i,
  /\b(can you (debug|fix|check|verify|investigate|troubleshoot))/i,
];

const TASK_PATTERNS = [
  /\b(write|create|build|deploy|publish|set up|install|make|generate|add)\b/i,
  /\b(blog post|app|script|page|feature|component|project|skill)\b/i,
];

// Complex = involves multiple domains, files, or has explicit multi-step language
const COMPLEX_SIGNALS = [
  /\b(and then|after that|also|then|step \d|phase \d|first.*then|multi)/i,
  /\b(refactor|migrate|redesign|overhaul|set up.*from scratch|full)\b/i,
  /\b(blog post|project|app|pipeline|workflow|system)\b/i, // creating whole things
];

export function classifyTask(message: string): TaskType {
  const trimmed = message.trim();

  // 1. Check for Debug patterns first (highest priority, can be short)
  const debugScore = DEBUG_PATTERNS.filter(p => p.test(trimmed)).length;
  if (debugScore >= 1) return 'debug-task';

  // 2. Check for Task patterns (can be short, e.g., "Fix it")
  const taskScore = TASK_PATTERNS.filter(p => p.test(trimmed)).length;
  if (taskScore >= 1) {
    if (COMPLEX_SIGNALS.some(p => p.test(trimmed)) || message.length > 100) return 'complex-task';
    return 'simple-task';
  }

  // 3. Check for Chat patterns (simple greetings or questions)
  if (SIMPLE_PATTERNS.some(p => p.test(trimmed))) return 'chat';

  // 4. Fallback for very short messages: if it doesn't match anything specific and is tiny, it's just chat
  if (message.length < 10) return 'chat';

  // 5. Default fallback
  return 'chat';
}

// Backward compat
export function isMultiStepTask(message: string): boolean {
  return classifyTask(message) !== 'chat';
}

// ─── Plan Extraction ───────────────────────────────────────────────────────

async function extractPlan(
  task: string,
  systemPrompt: string,
  opts: TaskRunnerOptions,
): Promise<TaskStep[]> {
  const planPrompt = `Break this task into 2-6 concrete steps. Each step should be one tool action (Read, Write, Bash, Edit, etc).
Return ONLY a numbered list, nothing else. Example:
1. Read ~/projects/blog/posts/ to check existing post format
2. Write the new blog post HTML to ~/projects/blog/posts/new-post.html
3. Update index.html with the new post card
4. Run git add, commit, push

Task: ${task}`;

  const planResponse = await runClaude(planPrompt, systemPrompt, {
    model: opts.model,
    corr: opts.corr,
    threadId: opts.threadId,
    maxTurns: 3,

  // Parse numbered list from response
  const lines = planResponse.text.split('\n').filter(l => /^\d+[\.\)]\s/.test(l.trim()));
  if (lines.length === 0) {
    // Model didn't return a list — treat entire task as one step
    return [{ index: 1, description: task, status: 'pending' }];
  }

  return lines.slice(0, opts.maxSteps ?? 8).map((line, i) => ({
    index: i + 1,
    description: line.replace(/^\d+[\.\)]\s*/, '').trim(),
    status: 'pending' as const,
  }));
}

// ─── Plan Validation ──────────────────────────────────────────────────────

function validatePlan(steps: TaskStep[]): TaskStep[] {
  if (steps.length < 2) return steps;

  // Check: deploy/push before create/write = wrong order
  const createIdx = steps.findIndex(s => /\b(write|create|build|edit|read.*template)\b/i.test(s.description));
  const deployIdx = steps.findIndex(s => /\b(deploy|push|publish|commit|git)\b/i.test(s.description));

  if (deployIdx >= 0 && createIdx >= 0 && deployIdx < createIdx) {
    console.log(`[task-runner] Plan validation: reordering deploy (step ${deployIdx + 1}) after create (step ${createIdx + 1})`);
    const deployStep = steps.splice(deployIdx, 1)[0];
    steps.push(deployStep);
    steps.forEach((s, i) => s.index = i + 1);
  }

  // Deduplicate steps with very similar descriptions
  const seen = new Set<string>();
  const deduped = steps.filter(s => {
    const key = s.description.toLowerCase().replace(/[^a-z]/g, '').slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.forEach((s, i) => s.index = i + 1);

  return deduped;
}

// ─── Step Execution ────────────────────────────────────────────────────────

async function executeStep(
  step: TaskStep,
  totalSteps: number,
  context: string,
  systemPrompt: string,
  opts: TaskRunnerOptions,
): Promise<{ text: string; usedTools: boolean }> {
  const stepPrompt = `You are on step ${step.index} of ${totalSteps}.

TASK FOR THIS STEP: ${step.description}

${context ? `CONTEXT FROM PREVIOUS STEPS:\n${context}\n` : ''}

DO THIS STEP NOW. Use tools (Bash, Read, Write, Edit, Glob, Grep) to complete it.
After using tools, tell me the result in one short paragraph.
Do NOT plan future steps — just do THIS step.`;

  const response = await runClaude(stepPrompt, systemPrompt, {
    onStream: opts.onStream,
    model: opts.model,
    corr: opts.corr,
    threadId: opts.threadId,
    extraTools: opts.extraTools,
    maxTurns: 15, ephemeral: true,

  // Check if tools were actually used (response should mention tool results)
  const usedTools = response.text.includes('✅') ||
    response.text.includes('✔') ||
    response.text.includes('Done') ||
    response.text.includes('Created') ||
    response.text.includes('Updated') ||
    response.text.includes('Wrote') ||
    response.text.length > 50; // If substantial response, likely did something

  return { text: response.text, usedTools };
}

// ─── Completion Judge ──────────────────────────────────────────────────────

function judgeStepCompletion(text: string): 'done' | 'failed' | 'unclear' {
  if (/\b(error|failed|couldn't|cannot|unable|blocked|permission denied)\b/i.test(text) &&
      !/\b(fixed|resolved|workaround|alternative|instead)\b/i.test(text)) {
    return 'failed';
  }
  if (/\b(done|complete|created|wrote|updated|pushed|deployed|published|success)\b/i.test(text) ||
      /✅/.test(text)) {
    return 'done';
  }
  return 'unclear';
}

// ─── Debug Task Runner ─────────────────────────────────────────────────────

async function runDebugTask(
  task: string,
  opts: TaskRunnerOptions,
): Promise<ClaudeResponse> {
  const startedAt = Date.now();
  console.log(`[task-runner] DEBUG mode: ${task.slice(0, 80)}`);

  // Debug loop: diagnose → fix → verify, up to 3 cycles
  let context = '';
  let finalText = '';
  const maxCycles = 3;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    // Phase 1: Diagnose
    console.log(`[task-runner] Debug cycle ${cycle + 1}/${maxCycles}: diagnosing`);
    opts.onStream?.({ type: 'text', text: `\n🔍 Debug cycle ${cycle + 1}: Investigating...\n` });

    const diagnosePrompt = cycle === 0
      ? `You are in debug mode. Your goal is to investigate the following issue: "${task}"\n\nSteps to follow:\n1. Use tools to check the current state (read files, check git status, test URLs, check logs).\n2. Analyze the findings.\n3. Report what is wrong or confirm if everything looks correct.\n\nContext:\n${context}`
      : `The previous fix for "${task}" didn't work. Here's what happened:\n${context}\n\nDig deeper. Check something different. Use tools to investigate.`;

    const diagnosis = await runClaude(diagnosePrompt, opts.systemPrompt, {
      onStream: opts.onStream,
      model: opts.model,
      corr: opts.corr,
      threadId: opts.threadId,
      extraTools: opts.extraTools,
      maxTurns: 10,
    });

    context += `\nDiagnosis ${cycle + 1}: ${diagnosis.text.slice(0, 500)}\n`;

    // Phase 2: Fix
    console.log(`[task-runner] Debug cycle ${cycle + 1}/${maxCycles}: fixing`);
    opts.onStream?.({ type: 'text', text: `\n🔧 Applying fix...\n` });

    const fixPrompt = `Based on this diagnosis:\n${diagnosis.text.slice(0, 1000)}\n\nFix the problem. First, explain your intended approach (what files you will modify and why), then use tools to execute it. This ensures the fix can be audited.`;

    const fix = await runClaude(fixPrompt, opts.systemPrompt, {
      onStream: opts.onStream,
      model: opts.model,
      corr: opts.corr,
      threadId: opts.threadId,
      extraTools: opts.extraTools,
      maxTurns: 15,
    });

    context += `\nFix ${cycle + 1}: ${fix.text.slice(0, 500)}\n`;

    // Phase 3: Verify
    console.log(`[task-runner] Debug cycle ${cycle + 1}/${maxCycles}: verifying`);
    opts.onStream?.({ type: 'text', text: `\n✅ Verifying fix...\n` });

    const verifyPrompt = `You just applied a fix. Now VERIFY it works:\n- If it's a URL: curl it and check the HTTP status\n- If it's a file: read it and confirm the content is correct\n- If it's a deploy: check the live site\n\nOriginal issue: ${task}\nFix applied: ${fix.text.slice(0, 500)}\n\nDoes it work now? Answer YES or NO with evidence.`;

    const verify = await runClaude(verifyPrompt, opts.systemPrompt, {
      onStream: opts.onStream,
      model: opts.model,
      corr: opts.corr,
      threadId: opts.threadId,
      extraTools: opts.extraTools,
      maxTurns: 8,
    });

    context += `\nVerification ${cycle + 1}: ${verify.text.slice(0, 500)}\n`;

    // Judge: is it fixed?
    const isFixed = /\b(yes|works|working|fixed|resolved|success|200|live)\b/i.test(verify.text) &&
                    !/\b(no|not|still|broken|failed|404|500|error)\b/i.test(verify.text);

    if (isFixed) {
      finalText = `✅ Fixed: ${fix.text.slice(0, 300)}`;
      break;
    }

    if (cycle === maxCycles - 1) {
      finalText = `❌ Could not fully fix after ${maxCycles} attempts. Last state:\n${verify.text.slice(0, 300)}`;
    }
  }

  console.log(`[task-runner] Debug done in ${Date.now() - startedAt}ms`);

  return {
    text: finalText || '❌ Debug completed but no clear resolution.',
    sessionId: null,
    actions: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ─── Plan Mode (Complex Tasks) ────────────────────────────────────────────

export interface PlanModeResult {
  plan: TaskStep[];
  exploration: string;   // what the model found during explore phase
  design: string;        // the model's reasoning about approach
  task: string;
  opts: TaskRunnerOptions;
}

// Pending plans waiting for Boss approval (keyed by chatId)
const _pendingPlans = new Map<string, PlanModeResult>();

export function getPendingPlan(chatId: string): PlanModeResult | undefined {
  return _pendingPlans.get(chatId);
}

export function clearPendingPlan(chatId: string): void {
  _pendingPlans.delete(chatId);
}

async function runPlanMode(
  task: string,
  opts: TaskRunnerOptions,
): Promise<ClaudeResponse> {
  const startedAt = Date.now();
  console.log(`[task-runner] PLAN MODE: ${task.slice(0, 80)}`);

  // ── Phase 1: EXPLORE ──
  // Model reads files, checks state, understands what exists
  opts.onStream?.({ type: 'text', text: '🔍 *Phase 1: Exploring...*\n' });

  const explorePrompt = `Boss wants you to: "${task}"

BEFORE planning anything, EXPLORE the current state:
- Use Read/Glob/Grep to check relevant files and directories
- Use recall to search memory for related past decisions
- Check if similar work exists that you can build on
- Identify what tools, templates, or resources are available

Report what you found. Be specific — file paths, current state, what exists vs what's missing.
Do NOT plan yet — just investigate.`;

  const exploration = await runClaude(explorePrompt, opts.systemPrompt, {
    onStream: opts.onStream,
    model: opts.model,
    corr: opts.corr,
    threadId: opts.threadId,
    extraTools: opts.extraTools,
    maxTurns: 12,
  });

  console.log(`[task-runner] Explore done: ${exploration.text.length} chars`);

  // ── Phase 2: DESIGN ──
  // Model reasons about approach based on what it found
  opts.onStream?.({ type: 'text', text: '\n📐 *Phase 2: Designing approach...*\n' });

  const designPrompt = `Based on your exploration:

${exploration.text.slice(0, 3000)}

Now DESIGN the implementation approach for: "${task}"

Consider:
1. What's the best approach given what exists?
2. What are the risks? What could go wrong?
3. What's the exact sequence of steps?

Return a numbered plan (2-8 steps). Each step must be a concrete action with specific file paths.
Also note any risks or things to verify after.`;

  const design = await runClaude(designPrompt, opts.systemPrompt, {
    model: opts.model,
    corr: opts.corr,
    threadId: opts.threadId,
    maxTurns: 3,

  console.log(`[task-runner] Design done: ${design.text.length} chars`);

  // Parse steps from design
  const lines = design.text.split('\n').filter(l => /^\d+[\.\)]\s/.test(l.trim()));
  const steps: TaskStep[] = lines.length > 0
    ? validatePlan(lines.slice(0, 8).map((line, i) => ({
        index: i + 1,
        description: line.replace(/^\d+[\.\)]\s*/, '').trim(),
        status: 'pending' as const,
      })))
    : [{ index: 1, description: task, status: 'pending' }];

  // ── Phase 3: AUTO-EXECUTE (bypass approval) ──
  // Plan is shown to Boss for visibility, then executed immediately
  const planText = steps.map(s => `${s.index}. ${s.description}`).join('\n');
  opts.onStream?.({ type: 'text', text: `\n📐 *Plan:*\n${planText}\n\n⚡ Executing...\n` });

  console.log(`[task-runner] Plan mode complete in ${Date.now() - startedAt}ms — auto-executing`);

  const planResult: PlanModeResult = {
    plan: steps,
    exploration: exploration.text.slice(0, 1000),
    design: design.text.slice(0, 1500),
    task,
    opts,
  };

  return executePlan(planResult);
}

/** Execute an approved plan (called from Telegram callback handler) */
export async function executePlan(planResult: PlanModeResult): Promise<ClaudeResponse> {
  const { plan, exploration, task, opts } = planResult;
  const startedAt = Date.now();
  console.log(`[task-runner] Executing approved plan: ${plan.length} steps`);

  opts.onStream?.({ type: 'text', text: '⚡ *Plan approved — executing...*\n' });

  // Execute with full context from exploration
  let context = `EXPLORATION CONTEXT:\n${exploration.slice(0, 2000)}\n`;
  const maxRetries = opts.maxRetries ?? 2;
  const STEP_TIMEOUT_MS = 2 * 60 * 1000;

  const stepTimeout = (ms: number) => new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Step timeout')), ms));

  for (const step of plan) {
    step.status = 'running';
    console.log(`[task-runner] Step ${step.index}/${plan.length}: ${step.description.slice(0, 60)}`);
    opts.onStream?.({ type: 'text', text: `\n🔧 Step ${step.index}: ${step.description}\n` });

    let attempts = 0;
    while (attempts < maxRetries) {
      attempts++;
      let result: { text: string; usedTools: boolean };
      try {
        result = await Promise.race([
          executeStep(step, plan.length, context, opts.systemPrompt, opts),
          stepTimeout(STEP_TIMEOUT_MS),
        ]);
      } catch {
        step.status = 'failed';
        step.result = 'Step timed out after 2 minutes';
        context += `\nStep ${step.index} TIMED OUT\n`;
        break;
      }

      const judgment = judgeStepCompletion(result.text);
      if (judgment === 'done' || (judgment === 'unclear' && result.usedTools)) {
        step.status = 'done';
        step.result = result.text;
        context += `\nStep ${step.index}:\n${result.text.slice(0, 2000)}\n`;
        break;
      } else if (judgment === 'failed' && attempts < maxRetries) {
        opts.onStream?.({ type: 'text', text: `⚠️ Step ${step.index} issue, retrying...\n` });
        continue;
      } else {
        step.status = 'failed';
        step.result = result.text;
        context += `\nStep ${step.index} FAILED: ${result.text.slice(0, 300)}\n`;
        break;
      }
    }
  }

  // Summary
  const doneSteps = plan.filter(s => s.status === 'done').length;
  const failedSteps = plan.filter(s => s.status === 'failed').length;

  const summaryPrompt = `Task: ${task}\n\nResults:\n${plan.map(s =>
    `Step ${s.index} [${s.status.toUpperCase()}]: ${s.description}\n  → ${(s.result ?? 'no result').slice(0, 200)}`
  ).join('\n')}\n\nWrite a SHORT summary for Boss. Start with ✅ or ❌.`;

  const summary = await runClaude(summaryPrompt, opts.systemPrompt, {
    model: opts.model,
    corr: opts.corr,
    threadId: opts.threadId,
    maxTurns: 3,

  const finalText = summary.text || `${failedSteps > 0 ? '❌' : '✅'} ${doneSteps}/${plan.length} steps done (${Date.now() - startedAt}ms)`;
  console.log(`[task-runner] Plan executed in ${Date.now() - startedAt}ms`);

  return {
    text: finalText,
    sessionId: null,
    actions: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ─── Main Task Runner ──────────────────────────────────────────────────────

export async function runTask(
  task: string,
  opts: TaskRunnerOptions,
): Promise<ClaudeResponse> {
  // Route to the right runner based on task type
  const taskType = classifyTask(task);
  console.log(`[task-runner] Classified as: ${taskType}`);

  if (taskType === 'debug-task') {
    return runDebugTask(task, opts);
  }
  if (taskType === 'complex-task') {
    return runPlanMode(task, opts);
  }

  // simple-task: direct plan → execute (no approval gate)
  const startedAt = Date.now();
  console.log(`[task-runner] Starting simple task: ${task.slice(0, 80)}`);

  // Step 1: Extract plan
  opts.onStream?.({ type: 'text', text: '📋 Planning steps...\n' });
  const rawSteps = await extractPlan(task, opts.systemPrompt, opts);
  const steps = validatePlan(rawSteps);
  console.log(`[task-runner] Plan: ${steps.length} steps (${rawSteps.length} raw)`);

  // Send plan to user
  const planText = steps.map(s => `${s.index}. ${s.description}`).join('\n');
  opts.onStream?.({ type: 'text', text: `\n${planText}\n\n⚡ Executing...\n` });

  // Step 2: Execute each step
  let context = '';
  const maxRetries = opts.maxRetries ?? 2;
  const STEP_TIMEOUT_MS = 2 * 60 * 1000; // 2 min per step

  const stepTimeout = (ms: number) => new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Step timeout')), ms));

  for (const step of steps) {
    step.status = 'running';
    console.log(`[task-runner] Step ${step.index}/${steps.length}: ${step.description.slice(0, 60)}`);
    opts.onStream?.({ type: 'text', text: `\n🔧 Step ${step.index}: ${step.description}\n` });

    let attempts = 0;
    while (attempts < maxRetries) {
      attempts++;

      let result: { text: string; usedTools: boolean };
      try {
        result = await Promise.race([
          executeStep(step, steps.length, context, opts.systemPrompt, opts),
          stepTimeout(STEP_TIMEOUT_MS),
        ]);
      } catch (err) {
        console.log(`[task-runner] Step ${step.index} timed out (${STEP_TIMEOUT_MS / 1000}s)`);
        opts.onStream?.({ type: 'text', text: `⏱️ Step ${step.index} timed out, moving on...\n` });
        step.status = 'failed';
        step.result = 'Step timed out after 2 minutes';
        context += `\nStep ${step.index} TIMED OUT: ${step.description}\n`;
        break;
      }

      const judgment = judgeStepCompletion(result.text);

      if (judgment === 'done' || (judgment === 'unclear' && result.usedTools)) {
        step.status = 'done';
        step.result = result.text;
        // Pass full result (up to 2KB) so next step has tool output context
        context += `\nStep ${step.index} (${step.description}):\n${result.text.slice(0, 2000)}\n`;
        break;
      } else if (judgment === 'failed' && attempts < maxRetries) {
        console.log(`[task-runner] Step ${step.index} failed (attempt ${attempts}/${maxRetries}), retrying...`);
        opts.onStream?.({ type: 'text', text: `⚠️ Step ${step.index} had an issue, retrying...\n` });
        continue;
      } else {
        step.status = 'failed';
        step.result = result.text;
        context += `\nStep ${step.index} FAILED: ${result.text.slice(0, 300)}\n`;
        break;
      }
    }
  }

  // Step 3: Final summary
  console.log(`[task-runner] All steps done. Generating summary...`);
  const doneSteps = steps.filter(s => s.status === 'done').length;
  const failedSteps = steps.filter(s => s.status === 'failed').length;

  const summaryPrompt = `You just completed a task for Boss. Here's what happened:

Original task: ${task}

Results:
${steps.map(s => `Step ${s.index} [${s.status.toUpperCase()}]: ${s.description}\n  → ${(s.result ?? 'no result').slice(0, 200)}`).join('\n')}

Write a SHORT summary for Boss (2-3 sentences max). Start with ✅ if all succeeded, or ❌ if any failed. Include any links or key outputs.`;

  const summary = await runClaude(summaryPrompt, opts.systemPrompt, {
    model: opts.model,
    corr: opts.corr,
    threadId: opts.threadId,
    maxTurns: 3,

  const finalText = summary.text || `${failedSteps > 0 ? '❌' : '✅'} Task ${failedSteps > 0 ? 'partially ' : ''}complete: ${doneSteps}/${steps.length} steps done (${Date.now() - startedAt}ms)`;

  console.log(`[task-runner] Done in ${Date.now() - startedAt}ms — ${doneSteps}/${steps.length} steps`);

  return {
    text: finalText,
    sessionId: null,
    actions: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
