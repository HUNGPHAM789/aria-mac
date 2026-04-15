import { bot } from './bot.js';
import { runClaude, buildSystemPrompt, stripActionBlocks, type StreamEvent } from '../aria/core.js';
import { runTask, classifyTask } from '../aria/task-runner.js';
import { loadIdentity, loadTraitsFromDb } from '../aria/identity.js';
import { loadHenryMemoryAsync, loadAvailableSkills, detectSkillContext } from '../aria/memory.js';
import { cancelAgent, getActiveAgentIds, getActiveAgentInfo, AGENT_TYPES, setAgentProgressHandler, type AgentProgressEvent } from '../aria/agents.js';
import { agenticSearch } from '../aria/search.js';
import { searchSummaries, loadRecentSessionContext, maybeGenerateSummary } from '../aria/summarizer.js';
import { searchCodebase, getProjectContext } from '../aria/codebase.js';
import { listAllProjects } from '../db/index.js';
import { describeCron } from '../aria/scheduler.js';
import { verifyResponseUrls } from '../aria/verify.js';
import { buildAriaTools } from '../aria/tools.js';
import { log, logError, newCorrelationId } from '../aria/logger.js';
import {
  insertMessage,
  getMessageCount,
  getRecentTasks,
  getRunningTasks,
  cancelAgentTask,
  getAllSkills,
  listSchedules,
  getThreadSessionId,
  saveThreadSessionId,
  clearThreadSessionId,
  getModel,
  setModel,
} from '../db/index.js';
import type { Context } from 'telegraf';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import https from 'https';
import http from 'http';

// Skills loaded once at startup (refresh every 5 min)
let availableSkills = loadAvailableSkills();
setInterval(() => {
  availableSkills = loadAvailableSkills();
}, 5 * 60 * 1000);

// Session is shared across Telegram + web UI, persisted in SQLite preferences

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunkMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

async function sendChunked(ctx: Context, text: string): Promise<void> {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: 'Markdown' });
    } catch {
      // Fallback: send without markdown if parse error
      await ctx.reply(chunk);
    }
  }
}

// ─── Thread ID Helper ────────────────────────────────────────────────────────

function threadIdFor(ctx: Context): string {
  const chatId = ctx.chat?.id;
  return chatId ? `telegram:${chatId}` : 'telegram:unknown';
}

// ─── Identity Reflection (async, fire-and-forget) ────────────────────────────
// Cooldown: only run once per 30 minutes, and only for substantial messages.

let _lastReflectionAt = 0;
const REFLECTION_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
const REFLECTION_MIN_MSG_LEN = 50;              // skip short messages like "ok" / "thanks"

async function scheduleIdentityReflection(
  userMsg: string,
  ariaResponse: string,
  sessionId: string | null,
  threadId: string,
): Promise<void> {
  try {
    const prompt = `Based on this exchange, should any of my identity traits be updated?
User said: "${userMsg.slice(0, 300)}"
I responded: "${ariaResponse.slice(0, 300)}"

If yes, call the update_traits tool with the new trait(s).
If no update needed, reply exactly: NO_UPDATE`.trim();

    const corr = newCorrelationId();
    const identityMd = loadIdentity();
    const traits = loadTraitsFromDb();
    const reflectionMemory = await loadHenryMemoryAsync(userMsg, corr);
    const sysPrompt = buildSystemPrompt(identityMd, traits, reflectionMemory, availableSkills);
    const extraTools = buildAriaTools({ corr, threadId });
    await runClaude(prompt, sysPrompt, {
      sessionId: sessionId ?? undefined,
      extraTools,
      corr,
      threadId,
      effort: 'low', // reflection is lightweight — no deep reasoning needed
    });
  } catch (err) {
    console.error('[ARIA] Identity reflection error:', err);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  await ctx.reply(
    '*ARIA online.*\n\nAdaptive Reasoning \\& Intelligence Assistant, at your service\\. What do you need?',
    { parse_mode: 'MarkdownV2' },
  );
});

bot.command('status', async (ctx) => {
  const tasks = getRecentTasks(10);
  if (tasks.length === 0) {
    await ctx.reply('No agent tasks on record yet.');
    return;
  }
  const lines = tasks.map(t => {
    const emoji = t.status === 'completed' ? '✅' :
                  t.status === 'failed'    ? '❌' :
                  t.status === 'running'   ? '⏳' : '🕐';
    return `${emoji} ${t.description.slice(0, 60)}`;
  });
  await ctx.reply('*Recent agent tasks:*\n\n' + lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.command('skills', async (ctx) => {
  const skills = getAllSkills();
  if (skills.length === 0) {
    await ctx.reply('No skills created yet. Ask me to create one!');
    return;
  }
  const lines = skills.map(s => `• *${s.skill_name}*: ${s.description}`);
  await ctx.reply('*My skills:*\n\n' + lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.command('newchat', async (ctx) => {
  clearThreadSessionId(threadIdFor(ctx));
  await ctx.reply('🔄 New conversation started. Previous context cleared for this chat.');
});

bot.command('reindex', async (ctx) => {
  await ctx.reply('🔄 Re-indexing memory files...');
  try {
    const { indexAllMemoryFiles } = await import('../aria/memory.js');
    await indexAllMemoryFiles();
    const { listMemoryFiles } = await import('../db/index.js');
    const files = listMemoryFiles();
    await ctx.reply(`✅ Memory indexed: ${files.length} files ready for semantic search.`);
  } catch (err) {
    await ctx.reply(`⚠️ Reindex failed: ${(err as Error).message.slice(0, 200)}`);
  }
});

bot.command('schedules', async (ctx) => {
  const scheds = listSchedules();
  if (scheds.length === 0) {
    await ctx.reply('No schedules configured yet. Ask me to create one!');
    return;
  }
  const lines = scheds.map(s => {
    const status = s.enabled ? '🟢' : '⏸️';
    const next = s.next_run_at ? new Date(s.next_run_at * 1000).toLocaleString() : 'N/A';
    const desc = describeCron(s.cron);
    return `${status} *#${s.id}* ${s.name}\n   ${desc} — next: ${next}\n   _${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? '…' : ''}_`;
  });
  await ctx.reply('*Scheduled Tasks:*\n\n' + lines.join('\n\n'), { parse_mode: 'Markdown' });
});

bot.command('whoami', async (ctx) => {
  await ctx.reply(`Your Telegram ID: \`${ctx.from?.id}\``, { parse_mode: 'Markdown' });
});

bot.command('restart', async (ctx) => {
  // Clear thread session so ARIA boots fresh (prevents restart loop)
  clearThreadSessionId(threadIdFor(ctx));
  await ctx.reply('🔄 Restarting ARIA... Session cleared, back in a moment.');
  console.log('[ARIA] Restart requested via /restart command');
  bot.stop('restart');
  setTimeout(() => process.exit(42), 500);
});

bot.command('model', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const newModel = parts[1];

  if (!newModel) {
    const current = getModel();
    await ctx.reply(
      `Current model: \`${current}\`\n\nUsage: /model <name>\nOptions: \`sonnet\`, \`opus\`, \`claude-sonnet-4-6\`, \`claude-opus-4-6\`, \`ollama:<model>\``,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // Allow Claude models and ollama:<model> format
  const allowedPrefixes = ['sonnet', 'opus', 'claude-sonnet-4-6', 'claude-opus-4-6'];
  const isOllama = newModel.startsWith('ollama:');
  if (!allowedPrefixes.includes(newModel) && !isOllama) {
    await ctx.reply(`Unknown model: ${newModel}\nAllowed: ${allowedPrefixes.join(', ')}, or ollama:<model_name>`);
    return;
  }

  setModel(newModel);
  await ctx.reply(`✅ Model switched to \`${newModel}\`. Takes effect on next message.`, { parse_mode: 'Markdown' });
});

bot.command('search', async (ctx) => {
  const query = ctx.message.text.replace('/search', '').trim();
  if (!query) {
    await ctx.reply('Usage: /search <your question>');
    return;
  }
  await ctx.sendChatAction('typing');
  const result = await agenticSearch(query, { maxIterations: 2 });
  if (result.results.length === 0) {
    await ctx.reply('No results found. Is TAVILY_API_KEY set in .env.local?');
    return;
  }
  const lines = [
    `*Search:* ${query}`,
    result.answer ? `\n*Answer:* ${result.answer.slice(0, 300)}` : '',
    `\n*Sources (${result.results.length}):*`,
    ...result.results.slice(0, 5).map((r, i) => `${i + 1}. [${r.title.slice(0, 60)}](${r.url}) _(score: ${r.score.toFixed(2)})_`),
    `\n_Subqueries: ${result.subqueries.join(' | ')} — ${result.iterations} iteration(s)_`,
  ].filter(Boolean).join('\n');
  await ctx.reply(lines, { parse_mode: 'Markdown' });
});

bot.command('recall', async (ctx) => {
  const query = ctx.message.text.replace('/recall', '').trim();
  if (!query) {
    await ctx.reply('Usage: /recall <your query>\n\nSearches conversation history, codebase, and memory.');
    return;
  }
  await ctx.sendChatAction('typing');

  const results: string[] = [`🔍 *Recall:* ${query}\n`];

  // Conversation summaries
  const summaries = await searchSummaries(query);
  if (summaries.length > 0) {
    results.push('*Conversation History:*');
    for (const s of summaries.slice(0, 3)) {
      const date = new Date(s.created_at * 1000).toLocaleDateString();
      results.push(`  📝 [${date}] ${s.summary.slice(0, 200)}`);
    }
  }

  // Codebase files
  const codeHits = await searchCodebase(query, 5);
  if (codeHits.length > 0) {
    results.push('\n*Codebase:*');
    for (const f of codeHits) {
      results.push(`  📄 ${f.projectName ?? '?'}/${f.relative_path} [${f.file_type}]`);
    }
  }

  if (results.length <= 1) {
    await ctx.reply(`No results for "${query}". Try different keywords.`);
    return;
  }
  await sendChunked(ctx, results.join('\n'));
});

bot.command('project', async (ctx) => {
  const args = ctx.message.text.replace('/project', '').trim();

  if (!args) {
    // List all projects
    const projects = listAllProjects();
    if (projects.length === 0) {
      await ctx.reply('No projects registered. Ask ARIA to register one.');
      return;
    }
    const lines = projects.map(p => {
      const status = p.active ? '🟢' : '⏸️';
      return `${status} *${p.name}* — \`${p.path}\`\n   ${p.stack ?? '(no stack)'}${p.repo ? ` | ${p.repo}` : ''}`;
    });
    await ctx.reply('*Registered Projects:*\n\n' + lines.join('\n\n'), { parse_mode: 'Markdown' });
    return;
  }

  // Switch to project
  await ctx.sendChatAction('typing');
  const context = getProjectContext(args.toLowerCase());
  if (!context) {
    const projects = listAllProjects();
    const names = projects.map(p => p.name).join(', ');
    await ctx.reply(`Project "${args}" not found. Available: ${names}`);
    return;
  }

  // Send project context and also feed it to ARIA
  await sendChunked(ctx, `📂 *Switched to ${args}*\n\n${context.slice(0, 3500)}`);
});

bot.command('agents', async (ctx) => {
  const activeIds = getActiveAgentIds();
  const tasks = getRecentTasks(15);

  if (tasks.length === 0) {
    await ctx.reply('No agent tasks on record.');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const lines = tasks.map(t => {
    const isActive = activeIds.includes(t.task_id);
    const emoji = t.status === 'completed' ? '✅' :
                  t.status === 'failed'    ? '❌' :
                  isActive                 ? '🔄' : '⏳';
    const elapsed = t.completed_at
      ? `${Math.floor((t.completed_at - t.spawned_at) / 60)}m`
      : `${Math.floor((now - t.spawned_at) / 60)}m ago`;
    return `${emoji} \`${t.task_id.slice(0, 8)}\` ${t.description.slice(0, 45)} (${elapsed})`;
  });

  await sendChunked(ctx, '*Agent Dashboard:*\n\n' + lines.join('\n'));
});

bot.command('cancel', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const prefix = parts[1];

  if (!prefix) {
    const running = getRunningTasks();
    if (running.length === 0) {
      await ctx.reply('No agents currently running.');
      return;
    }
    const lines = running.map(t => `\`${t.task_id.slice(0, 8)}\` — ${t.description.slice(0, 50)}`);
    await ctx.reply('*Running agents:*\n\n' + lines.join('\n') + '\n\nUsage: /cancel <id\\_prefix>', { parse_mode: 'Markdown' });
    return;
  }

  const running = getRunningTasks();
  const match = running.find(t => t.task_id.startsWith(prefix));
  if (!match) {
    await ctx.reply(`No running agent found matching "${prefix}".`);
    return;
  }

  const killed = cancelAgent(match.task_id);
  if (killed) {
    await ctx.reply(`✅ Cancelled agent: ${match.description}`);
  } else {
    cancelAgentTask(match.task_id);
    await ctx.reply(`✅ Marked as cancelled: ${match.description} (process may have already ended)`);
  }
});

// ─── Group Chat Helpers ───────────────────────────────────────────────────────

const ARIA_BOT_USERNAME = 'aria_henrypham_bot';

function isGroupChat(ctx: Context): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

function isMentioned(ctx: Context): boolean {
  const text = (ctx.message as { text?: string })?.text ?? '';
  // Check for @mention
  if (text.toLowerCase().includes(`@${ARIA_BOT_USERNAME}`)) return true;
  // Check for reply to bot's own message
  const reply = (ctx.message as { reply_to_message?: { from?: { username?: string } } })?.reply_to_message;
  if (reply?.from?.username === ARIA_BOT_USERNAME) return true;
  // Check for "aria" at start of message (casual mention)
  if (text.toLowerCase().startsWith('aria')) return true;
  return false;
}

// ─── File Download Helper ─────────────────────────────────────────────────────

const UPLOADS_DIR = join(process.cwd(), 'data', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

async function downloadTelegramFile(fileId: string, ext: string): Promise<string> {
  const file = await bot.telegram.getFile(fileId);
  const filePath = file.file_path!;
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const localName = `${Date.now()}-${fileId.slice(-8)}${ext}`;
  const localPath = join(UPLOADS_DIR, localName);

  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        writeFileSync(localPath, Buffer.concat(chunks));
        resolve(localPath);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Shared handler logic ─────────────────────────────────────────────────────

async function handleAriaMessage(ctx: Context, userMessage: string): Promise<void> {
  await ctx.sendChatAction('typing');

  const threadId = threadIdFor(ctx);
  const corr = newCorrelationId();
  log('request_in', corr, {
    thread: threadId,
    source: 'telegram',
    msgLen: userMessage.length,
    userId: ctx.from?.id,
    chatType: ctx.chat?.type,
  });

  try {
    const identityMd = loadIdentity();
    const traits = loadTraitsFromDb();
    const henryMemory = await loadHenryMemoryAsync(userMessage, corr);
    const recentContext = loadRecentSessionContext(threadId);
    const skillContext = detectSkillContext(userMessage);
    const systemPrompt = buildSystemPrompt(identityMd, traits, henryMemory + skillContext, availableSkills, recentContext || undefined);
    const sessionId = getThreadSessionId(threadId) ?? undefined;
    const extraTools = buildAriaTools({
      corr,
      threadId,
      onRestart: (reason) => {
        ctx.reply(`🔄 Restarting... Reason: ${reason}`).catch(() => {});
        bot.stop('restart');
      },
      onSkillCreated: async (filePath, name) => {
        await ctx.reply(`✅ Skill *${name}* created\n\`${filePath}\``, { parse_mode: 'Markdown' }).catch(() => {});
      },
    });

    if (sessionId) {
      insertMessage(sessionId, 'user', userMessage);
    }

    // Keep typing indicator alive while Claude processes
    let typingInterval: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);

    // Stream: accumulate text and send tool indicators in real-time
    // All Telegram sends go through sendQueue to prevent race conditions
    let streamBuffer = '';
    let lastSendTime = 0;
    let streamMsgId: number | null = null;
    let messageSent = false; // tracks if ANY message was successfully sent

    // Tool ribbon entries — index in `toolsUsed` is keyed by toolUseId so we can fill in args later
    interface ToolRibbonEntry { name: string; preview: string; toolUseId: string }
    const toolEntries: ToolRibbonEntry[] = [];
    const toolEntryByUseId = new Map<string, ToolRibbonEntry>();

    function escapeMd(s: string): string {
      // Telegram Markdown (legacy) — escape backticks and underscores in tool args
      return s.replace(/[`_*[\]]/g, m => '\\' + m);
    }

    function renderToolRibbon(): string {
      if (toolEntries.length === 0) return '';
      return toolEntries
        .map(t => t.preview ? `🔧 _${t.name}_: \`${escapeMd(t.preview)}\`` : `🔧 _${t.name}_`)
        .join(' → ');
    }

    // Promise chain serializes all Telegram API calls — prevents double replies
    let sendQueue = Promise.resolve();
    const enqueue = (fn: () => Promise<void>) => {
      sendQueue = sendQueue.then(fn).catch((err) => {
        console.error('[ARIA] Stream send error:', (err as Error).message);
      });
    };

    const flushStream = (force = false): void => {
      const now = Date.now();
      const cleanBuf = stripActionBlocks(streamBuffer).trim();
      const ribbon = renderToolRibbon();
      // thinking is internal — never shown to Boss in Telegram

      // Need at least one piece of content to render
      if (!cleanBuf && !ribbon) return;
      if (!force && now - lastSendTime < 2000) return;
      lastSendTime = now;

      const parts: string[] = [];
      if (ribbon) parts.push(ribbon);
      if (cleanBuf) parts.push(cleanBuf + (force ? '' : ' ▍'));
      else if (force === false && ribbon) parts.push('▍');
      const text = parts.join('\n\n');

      enqueue(async () => {
        try {
          if (streamMsgId) {
            await ctx.telegram.editMessageText(ctx.chat!.id, streamMsgId, undefined, text, { parse_mode: 'Markdown' });
          } else {
            const sent = await ctx.reply(text, { parse_mode: 'Markdown' });
            streamMsgId = sent.message_id;
          }
          messageSent = true;
        } catch {
          // Markdown parse errors — try plain text fallback
          try {
            const plain = parts.map(p => p.replace(/[`_*>]/g, '')).join('\n\n');
            if (streamMsgId) {
              await ctx.telegram.editMessageText(ctx.chat!.id, streamMsgId, undefined, plain);
            } else {
              const sent = await ctx.reply(plain);
              streamMsgId = sent.message_id;
            }
            messageSent = true;
          } catch (e) {
            console.error('[ARIA] Flush error:', (e as Error).message);
          }
        }
      });
    };

    const onStream = (event: StreamEvent): void => {
      switch (event.type) {
        case 'text':
          if (event.text) {
            streamBuffer += event.text;
            flushStream();
          }
          break;

        case 'thinking':
          // Thinking is internal — silently discarded, never shown in Telegram
          break;

        case 'tool_use':
          if (event.toolName && event.toolUseId) {
            const entry: ToolRibbonEntry = { name: event.toolName, preview: '', toolUseId: event.toolUseId };
            toolEntries.push(entry);
            toolEntryByUseId.set(event.toolUseId, entry);
            flushStream();
          }
          break;

        case 'tool_use_complete':
          if (event.toolUseId) {
            const entry = toolEntryByUseId.get(event.toolUseId);
            if (entry && event.inputPreview) {
              entry.preview = event.inputPreview;
              flushStream();
            }
          }
          break;

        case 'tool_result':
          // We don't render results inline (too noisy) — they're in the JSONL log.
          break;

        case 'segment_break': {
          // Tool batch done — finalize the current Telegram message and reset
          // state so the next text/tool_use creates a NEW message instead of
          // editing the old one. Port of Hermes stream_consumer segment model.
          const snapBuf = stripActionBlocks(streamBuffer).trim();
          const snapRibbon = renderToolRibbon();
          const snapMsgId = streamMsgId;
          // Reset synchronously so later events start a fresh segment
          streamBuffer = '';
          toolEntries.length = 0;
          toolEntryByUseId.clear();
          streamMsgId = null;
          lastSendTime = 0;
          // Queue the final edit (no trailing ▍ cursor) against the captured msgId
          if (snapMsgId && (snapBuf || snapRibbon)) {
            const parts: string[] = [];
            if (snapRibbon) parts.push(snapRibbon);
            if (snapBuf) parts.push(snapBuf);
            const finalText = parts.join('\n\n');
            enqueue(async () => {
              try {
                await ctx.telegram.editMessageText(ctx.chat!.id, snapMsgId, undefined, finalText, { parse_mode: 'Markdown' });
              } catch {
                try {
                  await ctx.telegram.editMessageText(ctx.chat!.id, snapMsgId, undefined, finalText.replace(/[`_*>]/g, ''));
                } catch {}
              }
            });
          }
          break;
        }

        case 'agent_started':
          if (event.agentType || event.summary) {
            const label = event.agentType ?? 'agent';
            const entry: ToolRibbonEntry = { name: `🤖 ${label}`, preview: event.summary ?? 'starting...', toolUseId: event.taskId ?? '' };
            toolEntries.push(entry);
            if (event.taskId) toolEntryByUseId.set(event.taskId, entry);
            flushStream();
          }
          break;

        case 'agent_progress':
          // Update the agent's ribbon entry with latest progress
          if (event.taskId && toolEntryByUseId.has(event.taskId)) {
            const entry = toolEntryByUseId.get(event.taskId)!;
            entry.preview = (event.summary ?? '').slice(0, 60);
            flushStream();
          }
          break;

        case 'agent_stopped':
          // Mark agent as done in the ribbon
          if (event.agentId && toolEntryByUseId.has(event.agentId)) {
            const entry = toolEntryByUseId.get(event.agentId)!;
            entry.name = `✅ ${event.agentType ?? 'agent'}`;
            entry.preview = (event.summary ?? 'done').slice(0, 60);
            flushStream();
          }
          break;
      }
    };

    let response;
    try {
      const currentModel = getModel();
      const bossId = ctx.from?.id;
      const taskType = classifyTask(userMessage);
      if (taskType !== 'chat') {
        console.log(`[ARIA] Task detected (${taskType}) — using task runner`);
        response = await runTask(userMessage, {
          systemPrompt,
          onStream,
          model: currentModel,
          extraTools,
          corr,
          threadId,
        });
      } else {
        response = await runClaude(userMessage, systemPrompt, {
          sessionId,
          onStream,
          model: currentModel,
          extraTools,
          corr,
          threadId,
        });
      }
    } finally {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }

    // Verify URLs in response before sending to Boss
    const cleanResponse = stripActionBlocks(response.text);
    const { text: verifiedText, badUrls } = await verifyResponseUrls(cleanResponse, corr);
    if (badUrls.length > 0) {
      console.warn(`[ARIA] URL verification: ${badUrls.length} bad URL(s) in response`);
    }

    // Final flush — send complete response, then wait for all sends to finish
    streamBuffer = verifiedText;
    flushStream(true);
    await sendQueue;

    if (response.sessionId) {
      saveThreadSessionId(threadId, response.sessionId);
      if (!sessionId) {
        insertMessage(response.sessionId, 'user', userMessage);
      }
      insertMessage(response.sessionId, 'assistant', response.text);
    }

    // Fallback: only if absolutely nothing was sent (e.g., empty stream)
    if (!messageSent) {
      if (verifiedText.trim()) {
        await sendChunked(ctx, verifiedText);
      }
    }

    const msgCount = response.sessionId ? getMessageCount(response.sessionId) : 0;
    const now = Date.now();
    const shouldReflect =
      msgCount > 0 &&
      msgCount % 10 === 0 &&
      userMessage.length >= REFLECTION_MIN_MSG_LEN &&
      now - _lastReflectionAt > REFLECTION_COOLDOWN_MS;

    if (shouldReflect) {
      _lastReflectionAt = now;
      scheduleIdentityReflection(userMessage, response.text, response.sessionId, threadId).catch(() => {});
    }

    // Auto-generate conversation summary (fire-and-forget, every 10 min)
    maybeGenerateSummary(threadId, response.sessionId, corr).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ARIA] Handler error:', err);
    logError(corr, err, { thread: threadId });
    await ctx.reply(`⚠️ Error: ${msg.slice(0, 500)}`);
  }
}

// ─── Photo Handler ────────────────────────────────────────────────────────────

bot.on('photo', async (ctx) => {
  if (isGroupChat(ctx) && !isMentioned(ctx)) return;

  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1]; // highest resolution
  const caption = ctx.message.caption ?? '';

  try {
    const localPath = await downloadTelegramFile(largest.file_id, '.jpg');
    console.log(`[ARIA] Photo received → ${localPath}`);

    const message = caption
      ? `I'm sending you a photo. The image is saved at: ${localPath}\nPlease analyze this image using the Read tool to view it. My message: ${caption}`
      : `I'm sending you a photo. The image is saved at: ${localPath}\nPlease analyze this image using the Read tool to view it. Describe what you see and ask if I need anything specific.`;

    await handleAriaMessage(ctx, message);
  } catch (err) {
    console.error('[ARIA] Photo handler error:', err);
    await ctx.reply('⚠️ Failed to process photo.');
  }
});

// ─── Document Handler ─────────────────────────────────────────────────────────

bot.on('document', async (ctx) => {
  if (isGroupChat(ctx) && !isMentioned(ctx)) return;

  const doc = ctx.message.document;
  const fileName = doc.file_name ?? 'unknown';
  const ext = fileName.includes('.') ? `.${fileName.split('.').pop()}` : '';
  const caption = ctx.message.caption ?? '';

  try {
    const localPath = await downloadTelegramFile(doc.file_id, ext);
    console.log(`[ARIA] Document received: ${fileName} → ${localPath}`);

    const message = caption
      ? `I'm sending you a file: "${fileName}". It's saved at: ${localPath}\nPlease read and analyze this file. My message: ${caption}`
      : `I'm sending you a file: "${fileName}". It's saved at: ${localPath}\nPlease read and analyze this file. Tell me what's in it and ask if I need anything.`;

    await handleAriaMessage(ctx, message);
  } catch (err) {
    console.error('[ARIA] Document handler error:', err);
    await ctx.reply('⚠️ Failed to process document.');
  }
});

// ─── Voice Message Handler ────────────────────────────────────────────────────

bot.on('voice', async (ctx) => {
  if (isGroupChat(ctx) && !isMentioned(ctx)) return;

  try {
    const localPath = await downloadTelegramFile(ctx.message.voice.file_id, '.ogg');
    console.log(`[ARIA] Voice message received → ${localPath}`);

    const message = `I sent you a voice message. The audio file is saved at: ${localPath}\nPlease use a Bash command to transcribe it (e.g., using macOS say/afplay for playback, or whisper CLI if available). Then respond to what I said.`;

    await handleAriaMessage(ctx, message);
  } catch (err) {
    console.error('[ARIA] Voice handler error:', err);
    await ctx.reply('⚠️ Failed to process voice message.');
  }
});

// ─── Sticker Handler ──────────────────────────────────────────────────────────

bot.on('sticker', async (ctx) => {
  if (isGroupChat(ctx) && !isMentioned(ctx)) return;
  const emoji = ctx.message.sticker.emoji ?? '🙂';
  await handleAriaMessage(ctx, `I sent you a sticker with emoji: ${emoji}. React naturally.`);
});

// ─── Main Message Handler ─────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  // Skip commands — they're handled by bot.command() above
  // In Telegraf v4, commands also trigger bot.on('text'), causing double replies
  if (ctx.message.text.startsWith('/')) return;
  if (isGroupChat(ctx) && !isMentioned(ctx)) return;
  await handleAriaMessage(ctx, ctx.message.text);
});
