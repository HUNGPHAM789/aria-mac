// src/aria/tools.ts — ARIA action tools (direct functions, no MCP)
import { spawnAgent, AGENT_TYPES, getActiveAgentInfo } from './agents.js';
import { getAgentMessages, insertAgentMessage, listAllProjects, upsertProject } from '../db/index.js';
import { listWorkspaceFiles, workspaceSummary } from './workspace.js';
import { getProjectContext, searchCodebase } from './codebase.js';
import { searchSummaries, loadRecentSessionContext } from './summarizer.js';
import { createSkill, editSkill, patchSkill, deleteSkill } from './skills.js';
import { updateIdentityTraits, appendEvolutionLog } from './identity.js';
import { sendToJarvis } from './jarvis.js';
import { log } from './logger.js';
import { clearThreadSessionId, insertSchedule, updateSchedule, deleteSchedule, listSchedules } from '../db/index.js';
import { nextCronRun, describeCron } from './scheduler.js';

let _lastRestartAt = 0;
const RESTART_COOLDOWN_MS = 60_000;

export interface AriaToolContext {
  corr: string;
  threadId: string;
  onRestart?: (reason: string) => void;
  onSkillCreated?: (filePath: string, name: string) => Promise<void> | void;
}

export interface AriaTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export function buildAriaTools(ctx: AriaToolContext): AriaTool[] {
  const agentTypeList = Object.keys(AGENT_TYPES).join(', ');

  return [
    {
      name: 'spawn_agent',
      description: `Dispatch a background agent. Types: ${agentTypeList}. Returns task_id.`,
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'One-line summary of the task' },
          prompt: { type: 'string', description: 'Full task prompt for the agent' },
          agent_type: { type: 'string', description: `Agent type: ${agentTypeList}` },
        },
        required: ['description', 'prompt'],
      },
      execute: async (args) => {
        const result = spawnAgent(
          String(args.description ?? ''),
          String(args.prompt ?? ''),
          String(args.agent_type ?? 'general-purpose'),
          ctx.corr,
        );
        if ('error' in result) return `Cannot spawn agent — ${result.error}`;
        return `Agent dispatched [${result.agentType}]. task_id=${result.taskId}. Boss will see progress on Telegram.`;
      },
    },
    {
      name: 'create_skill',
      description: 'Create a new reusable skill in ~/.claude/skills/.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string' },
          description: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['skill_name', 'description', 'content'],
      },
      execute: async (args) => {
        try {
          const result = createSkill({
            skill_name: String(args.skill_name ?? ''),
            description: String(args.description ?? ''),
            content: String(args.content ?? ''),
          });
          if (ctx.onSkillCreated) await ctx.onSkillCreated(result.filePath, result.name);
          const note = result.scan.verdict === 'caution' ? ` Note: security scan flagged (${result.scan.summary}) — allowed but review.` : '';
          return `Skill created at ${result.filePath}.${note}`;
        } catch (err) {
          return `REFUSED: create_skill failed — ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'edit_skill',
      description: 'Replace the entire SKILL.md of an existing skill with new content. New content must pass all validation (frontmatter + security scan).',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string' },
          content: { type: 'string', description: 'Full replacement SKILL.md including frontmatter' },
        },
        required: ['skill_name', 'content'],
      },
      execute: async (args) => {
        try {
          const result = editSkill({
            skill_name: String(args.skill_name ?? ''),
            content: String(args.content ?? ''),
          });
          const note = result.scan.verdict === 'caution' ? ` Note: security scan flagged (${result.scan.summary}).` : '';
          return `Skill '${result.name}' edited.${note}`;
        } catch (err) {
          return `REFUSED: edit_skill failed — ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'patch_skill',
      description: 'Exact-string find-and-replace inside a skill file. Use file_path for references/*.md inside a subdir skill; omit to target SKILL.md itself.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to find. Include enough context to be unique, or set replace_all.' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence; otherwise old_string must match exactly once.' },
          file_path: { type: 'string', description: 'Optional: relative path inside the skill subdir (e.g. references/foo.md).' },
        },
        required: ['skill_name', 'old_string', 'new_string'],
      },
      execute: async (args) => {
        try {
          const result = patchSkill({
            skill_name: String(args.skill_name ?? ''),
            old_string: String(args.old_string ?? ''),
            new_string: String(args.new_string ?? ''),
            replace_all: Boolean(args.replace_all ?? false),
            file_path: args.file_path ? String(args.file_path) : undefined,
          });
          const note = result.scan.verdict === 'caution' ? ` Note: security scan flagged (${result.scan.summary}).` : '';
          return `Skill '${result.name}' patched (${result.replacements} replacement${result.replacements === 1 ? '' : 's'}).${note}`;
        } catch (err) {
          return `REFUSED: patch_skill failed — ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'delete_skill',
      description: 'Permanently delete a skill from ~/.claude/skills/. Use carefully — not reversible without git.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string' },
        },
        required: ['skill_name'],
      },
      execute: async (args) => {
        try {
          const result = deleteSkill(String(args.skill_name ?? ''));
          return `Skill '${result.name}' deleted (${result.removed}).`;
        } catch (err) {
          return `REFUSED: delete_skill failed — ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'update_traits',
      description: 'Update ARIA identity traits (learned about Boss).',
      parameters: {
        type: 'object',
        properties: {
          traits: { type: 'object', description: 'Map of trait_key -> trait_value' },
        },
        required: ['traits'],
      },
      execute: async (args) => {
        const traits = (args.traits ?? {}) as Record<string, string>;
        updateIdentityTraits(traits);
        appendEvolutionLog(`Traits updated: ${Object.keys(traits).join(', ')}`);
        return `Traits updated: ${Object.keys(traits).join(', ')}`;
      },
    },
    {
      name: 'restart',
      description: 'Restart ARIA (exit 42, supervisor respawns).',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
      execute: async (args) => {
        const r = String(args.reason ?? 'self-initiated');
        const now = Date.now();
        if (now - _lastRestartAt < RESTART_COOLDOWN_MS) {
          const waitSec = Math.ceil((RESTART_COOLDOWN_MS - (now - _lastRestartAt)) / 1000);
          return `Restart blocked — cooldown active (${waitSec}s remaining).`;
        }
        _lastRestartAt = now;
        clearThreadSessionId(ctx.threadId);
        if (ctx.onRestart) ctx.onRestart(r);
        setTimeout(() => process.exit(42), 750);
        return `Restart scheduled. Reason: ${r}`;
      },
    },
    {
      name: 'message_jarvis',
      description: 'Send a message to Jarvis via MC group chat.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      execute: async (args) => {
        const result = await sendToJarvis(String(args.message ?? ''));
        if (result.success) return `Sent. Jarvis replied: ${result.reply ?? '(no reply)'}`;
        return `Jarvis unreachable: ${result.error ?? 'unknown error'}`;
      },
    },
    // Schedule tools
    {
      name: 'create_schedule',
      description: 'Create a cron-scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          cron: { type: 'string', description: '5-field cron: min hour dom month dow' },
          prompt: { type: 'string' },
        },
        required: ['name', 'cron', 'prompt'],
      },
      execute: async (args) => {
        const cron = String(args.cron ?? '');
        const nextRun = nextCronRun(cron);
        const id = insertSchedule(String(args.name), cron, String(args.prompt), nextRun);
        return `Schedule #${id} created: "${args.name}" — ${describeCron(cron)}. Next: ${new Date(nextRun * 1000).toLocaleString()}`;
      },
    },
    {
      name: 'update_schedule',
      description: 'Update an existing schedule.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          cron: { type: 'string' },
          prompt: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['id'],
      },
      execute: async (args) => {
        const fields: Record<string, unknown> = {};
        if (args.name !== undefined) fields.name = args.name;
        if (args.prompt !== undefined) fields.prompt = args.prompt;
        if (args.enabled !== undefined) fields.enabled = args.enabled ? 1 : 0;
        if (args.cron !== undefined) {
          fields.cron = args.cron;
          fields.next_run_at = nextCronRun(String(args.cron));
        }
        updateSchedule(Number(args.id), fields as any);
        return `Schedule #${args.id} updated.`;
      },
    },
    {
      name: 'delete_schedule',
      description: 'Delete a scheduled task.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
      execute: async (args) => {
        deleteSchedule(Number(args.id));
        return `Schedule #${args.id} deleted.`;
      },
    },
    {
      name: 'list_schedules',
      description: 'List all scheduled tasks.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const scheds = listSchedules();
        if (scheds.length === 0) return 'No schedules configured.';
        return scheds.map(s => {
          const status = s.enabled ? '🟢' : '⏸️';
          const next = s.next_run_at ? new Date(s.next_run_at * 1000).toLocaleString() : 'N/A';
          return `${status} #${s.id} ${s.name} — ${describeCron(s.cron)} (next: ${next})`;
        }).join('\n');
      },
    },
    // Agent coordination
    {
      name: 'agent_status',
      description: 'Get status of all running agents.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const active = getActiveAgentInfo();
        if (active.length === 0) return 'No agents running.';
        return active.map(a => {
          const elapsed = `${Math.floor(a.elapsedMs / 60000)}m ${Math.floor((a.elapsedMs % 60000) / 1000)}s`;
          return `🔄 ${a.taskId.slice(0, 8)} [${a.agentType}] ${a.description.slice(0, 50)} — ${elapsed}`;
        }).join('\n');
      },
    },
    {
      name: 'agent_messages',
      description: 'Read messages from an agent task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          since_id: { type: 'number' },
        },
        required: ['task_id'],
      },
      execute: async (args) => {
        const messages = getAgentMessages(String(args.task_id), Number(args.since_id ?? 0));
        if (messages.length === 0) return 'No messages for this task.';
        return messages.map(m => `[${new Date(m.created_at * 1000).toLocaleTimeString()}] ${m.msg_type.toUpperCase()}: ${m.content.slice(0, 200)}`).join('\n');
      },
    },
    {
      name: 'send_agent_message',
      description: 'Send a message to a running agent task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          content: { type: 'string' },
          msg_type: { type: 'string' },
        },
        required: ['task_id', 'content'],
      },
      execute: async (args) => {
        const id = insertAgentMessage(String(args.task_id), 'aria', String(args.content), (args.msg_type as any) ?? 'info');
        return `Message #${id} sent.`;
      },
    },
    {
      name: 'workspace_status',
      description: 'Check shared workspace files.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
      },
      execute: async (args) => {
        const tid = args.task_id ? String(args.task_id) : undefined;
        const summary = workspaceSummary(tid);
        const files = listWorkspaceFiles(tid);
        if (files.length === 0) return 'Workspace is empty.';
        return `${summary.fileCount} files, ${(summary.totalBytes / 1024).toFixed(1)}KB\n${files.slice(0, 30).join('\n')}`;
      },
    },
    // Smart context
    {
      name: 'switch_project',
      description: 'Switch context to a project.',
      parameters: {
        type: 'object',
        properties: { project_name: { type: 'string' } },
        required: ['project_name'],
      },
      execute: async (args) => {
        const context = getProjectContext(String(args.project_name).toLowerCase());
        if (!context) {
          const projects = listAllProjects();
          return `Project not found. Available: ${projects.map(p => p.name).join(', ')}`;
        }
        return context;
      },
    },
    {
      name: 'register_project',
      description: 'Register a new project for indexing.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          stack: { type: 'string' },
          description: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['name', 'path'],
      },
      execute: async (args) => {
        const id = upsertProject(String(args.name).toLowerCase(), String(args.path), {
          stack: args.stack ? String(args.stack) : undefined,
          description: args.description ? String(args.description) : undefined,
          repo: args.repo ? String(args.repo) : undefined,
        });
        return `Project "${args.name}" registered (id=${id}).`;
      },
    },
    {
      name: 'list_projects',
      description: 'List all registered projects.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const projects = listAllProjects();
        if (projects.length === 0) return 'No projects registered.';
        return projects.map(p => `${p.active ? '🟢' : '⏸️'} ${p.name} — ${p.path} | ${p.stack ?? ''}`).join('\n');
      },
    },
    {
      name: 'recall',
      description: 'Semantic search across conversations, memory, and codebase.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: async (args) => {
        const query = String(args.query ?? '');
        const results: string[] = [];
        const summaries = await searchSummaries(query);
        if (summaries.length > 0) {
          results.push('**Conversations:**');
          for (const s of summaries.slice(0, 3)) {
            results.push(`  [${new Date(s.created_at * 1000).toLocaleDateString()}] ${s.summary.slice(0, 200)}`);
          }
        }
        const codeHits = await searchCodebase(query, 5);
        if (codeHits.length > 0) {
          results.push('\n**Codebase:**');
          for (const f of codeHits) {
            results.push(`  ${f.projectName ?? '?'}/${f.relative_path}`);
          }
        }
        const sessionCtx = loadRecentSessionContext(ctx.threadId);
        if (sessionCtx) {
          results.push('\n**Recent:**');
          results.push(sessionCtx.slice(0, 500));
        }
        return results.length > 0 ? results.join('\n') : `No results for "${query}".`;
      },
    },
  ];
}
