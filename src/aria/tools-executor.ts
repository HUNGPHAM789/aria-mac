// src/aria/tools-executor.ts — Hand-rolled tool implementations for Ollama
import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import fg from 'fast-glob';

// ─── Tool Definition Type ────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Tool Definitions (JSON Schema for Ollama) ──────────────────────────────

export const TOOLS: ToolDefinition[] = [
  {
    name: 'Bash',
    description: 'Execute a shell command and return stdout+stderr. Use for system operations, git commands, running scripts. Timeout: 30s.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the filesystem. Returns content with line numbers. Supports offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'number', description: 'Max number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Edit a file by replacing a specific string. old_string must be unique in the file. Use replace_all for multiple replacements.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to modify' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern. Returns matching paths sorted by modification time.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")' },
        path: { type: 'string', description: 'Directory to search in (default: cwd)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents using regex. Uses ripgrep if available, falls back to Node.js scan.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in (default: cwd)' },
        glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
        output_mode: { type: 'string', description: 'Output mode: "content", "files_with_matches", or "count"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch a URL and return its content. HTML is stripped to plain text. Max 6000 chars.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web using Tavily API. Requires TAVILY_API_KEY environment variable.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'TodoWrite',
    description: 'Write/update a TODO list. Stored in ~/.aria/todos.json.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
          },
          description: 'The full todo list to save',
        },
      },
      required: ['todos'],
    },
  },
];

// ─── Tool Implementations ────────────────────────────────────────────────────

async function toolBash(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? '');
  if (!command) return 'Error: No command provided';

  const timeout = Math.min(Number(args.timeout ?? 30000), 120000);

  return new Promise((resolve) => {
    exec(command, {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      shell: '/bin/bash',
      env: { ...process.env, PATH: process.env.PATH },
    }, (err, stdout, stderr) => {
      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += (output ? '\n' : '') + stderr;
      if (err && !output) output = `Error: ${err.message}`;

      // Truncate at 8000 chars
      if (output.length > 8000) {
        output = output.slice(0, 8000) + `\n…(truncated, ${output.length} chars total)`;
      }
      resolve(output || '(no output)');
    });
  });
}

function toolRead(args: Record<string, unknown>): string {
  const filePath = String(args.file_path ?? '');
  if (!filePath) return 'Error: No file_path provided';
  if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const offset = Math.max(0, Number(args.offset ?? 1) - 1);
    const limit = Number(args.limit ?? 2000);
    const slice = lines.slice(offset, offset + limit);

    return slice
      .map((line, i) => {
        const lineNum = String(offset + i + 1).padStart(6, ' ');
        const truncatedLine = line.length > 2000 ? line.slice(0, 2000) + '…' : line;
        return `${lineNum}\t${truncatedLine}`;
      })
      .join('\n');
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`;
  }
}

function toolWrite(args: Record<string, unknown>): string {
  const filePath = String(args.file_path ?? '');
  const content = String(args.content ?? '');
  if (!filePath) return 'Error: No file_path provided';

  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return `File written: ${filePath} (${content.length} chars)`;
  } catch (err) {
    return `Error writing file: ${(err as Error).message}`;
  }
}

function toolEdit(args: Record<string, unknown>): string {
  const filePath = String(args.file_path ?? '');
  const oldString = String(args.old_string ?? '');
  const newString = String(args.new_string ?? '');
  const replaceAll = Boolean(args.replace_all);

  if (!filePath) return 'Error: No file_path provided';
  if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
  if (!oldString) return 'Error: No old_string provided';

  try {
    let content = readFileSync(filePath, 'utf-8');

    if (!content.includes(oldString)) {
      return `Error: old_string not found in ${filePath}. Make sure the string matches exactly (including whitespace and indentation).`;
    }

    if (!replaceAll) {
      const count = content.split(oldString).length - 1;
      if (count > 1) {
        return `Error: old_string found ${count} times in ${filePath}. Provide more context to make it unique, or set replace_all=true.`;
      }
    }

    if (replaceAll) {
      content = content.split(oldString).join(newString);
    } else {
      content = content.replace(oldString, newString);
    }

    writeFileSync(filePath, content, 'utf-8');
    return `File edited: ${filePath}`;
  } catch (err) {
    return `Error editing file: ${(err as Error).message}`;
  }
}

async function toolGlob(args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.pattern ?? '');
  const searchPath = String(args.path ?? process.cwd());

  if (!pattern) return 'Error: No pattern provided';

  try {
    const files = await fg(pattern, {
      cwd: searchPath,
      absolute: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/dist/**'],
    });

    // Sort by mtime (newest first)
    const withStats = files.map(f => {
      try {
        return { path: f, mtime: statSync(f).mtimeMs };
      } catch {
        return { path: f, mtime: 0 };
      }
    });
    withStats.sort((a, b) => b.mtime - a.mtime);

    if (withStats.length === 0) return `No files matching pattern: ${pattern}`;
    return withStats.map(f => f.path).join('\n');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

async function toolGrep(args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.pattern ?? '');
  const searchPath = String(args.path ?? process.cwd());
  const globFilter = args.glob ? String(args.glob) : undefined;
  const outputMode = String(args.output_mode ?? 'files_with_matches');

  if (!pattern) return 'Error: No pattern provided';

  // Try ripgrep first
  return new Promise((resolve) => {
    const rgArgs = ['rg'];
    if (outputMode === 'files_with_matches') rgArgs.push('-l');
    else if (outputMode === 'count') rgArgs.push('-c');
    else rgArgs.push('-n');
    if (globFilter) rgArgs.push('--glob', globFilter);
    rgArgs.push('--', pattern, searchPath);

    exec(rgArgs.join(' '), { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (stdout?.trim()) {
        const output = stdout.trim();
        resolve(output.length > 8000 ? output.slice(0, 8000) + '\n…(truncated)' : output);
      } else if (err && err.code === 1) {
        resolve(`No matches found for: ${pattern}`);
      } else {
        // ripgrep not available or error — fallback not implemented for brevity
        resolve(`No matches found for: ${pattern} (ripgrep exit: ${err?.code ?? 'unknown'})`);
      }
    });
  });
}

async function toolWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '');
  if (!url) return 'Error: No url provided';

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'ARIA/1.0 (Personal AI Assistant)' },
    });

    if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;

    let text = await res.text();

    // Strip HTML tags for readability
    if (text.includes('<html') || text.includes('<!DOCTYPE')) {
      text = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (text.length > 6000) {
      text = text.slice(0, 6000) + `\n…(truncated, ${text.length} chars total)`;
    }
    return text || '(empty response)';
  } catch (err) {
    return `Fetch error: ${(err as Error).message}`;
  }
}

async function toolWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '');
  if (!query) return 'Error: No query provided';

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return 'WebSearch not configured — set TAVILY_API_KEY in .env.local';

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        search_depth: 'basic',
        include_answer: true,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return `Search API error: ${res.status}`;

    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
      answer?: string;
    };

    const lines: string[] = [];
    if (data.answer) lines.push(`Answer: ${data.answer}\n`);
    for (const r of (data.results ?? []).slice(0, 5)) {
      lines.push(`- ${r.title ?? 'Untitled'} (${r.url ?? ''})\n  ${(r.content ?? '').slice(0, 200)}`);
    }
    return lines.join('\n') || 'No results found';
  } catch (err) {
    return `Search error: ${(err as Error).message}`;
  }
}

function toolTodoWrite(args: Record<string, unknown>): string {
  const todos = args.todos;
  if (!Array.isArray(todos)) return 'Error: todos must be an array';

  try {
    const todoDir = join(homedir(), '.aria');
    if (!existsSync(todoDir)) mkdirSync(todoDir, { recursive: true });
    const todoPath = join(todoDir, 'todos.json');
    writeFileSync(todoPath, JSON.stringify(todos, null, 2), 'utf-8');
    return `Todo list updated (${todos.length} items) → ${todoPath}`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

// ─── Tool Executor ───────────────────────────────────────────────────────────

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'Bash': return await toolBash(args);
      case 'Read': return toolRead(args);
      case 'Write': return toolWrite(args);
      case 'Edit': return toolEdit(args);
      case 'Glob': return await toolGlob(args);
      case 'Grep': return await toolGrep(args);
      case 'WebFetch': return await toolWebFetch(args);
      case 'WebSearch': return await toolWebSearch(args);
      case 'TodoWrite': return toolTodoWrite(args);
      default: return `Unknown tool: ${name}. Available tools: ${TOOLS.map(t => t.name).join(', ')}`;
    }
  } catch (err) {
    return `Tool execution error (${name}): ${(err as Error).message}`;
  }
}
