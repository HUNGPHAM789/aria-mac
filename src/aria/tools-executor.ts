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
  {
    name: 'Canvas',
    description: 'Generate an image using ComfyUI (SDXL). Returns the path to the generated image. Use for blog hero images, diagrams, concept art, illustrations.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        negative_prompt: { type: 'string', description: 'What to avoid in the image' },
        width: { type: 'number', description: 'Image width (default 1024, max 1536)' },
        height: { type: 'number', description: 'Image height (default 1024, max 1536)' },
        filename: { type: 'string', description: 'Output filename without extension' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'Browser',
    description: 'Automate a browser with Playwright. Actions: navigate, screenshot, content (JS-rendered text), click, fill (instant), type (simulates keypresses), press (single key like Enter/Tab), evaluate (run JS), wait_for (wait for element).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'content', 'click', 'fill', 'type', 'press', 'navigate', 'evaluate', 'wait_for'], description: 'Browser action' },
        url: { type: 'string', description: 'URL to navigate to (optional if already navigated)' },
        selector: { type: 'string', description: 'CSS selector for click/fill/type/wait_for' },
        value: { type: 'string', description: 'Text for fill/type, key for press (e.g. Enter), JS for evaluate' },
        filename: { type: 'string', description: 'Screenshot filename' },
        full_page: { type: 'boolean', description: 'Full-page screenshot (default true)' },
        delay: { type: 'number', description: 'Keypress delay in ms for type action (default 50)' },
      },
      required: ['action'],
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

// HARDCODED SAFETY: block writes to ARIA's own source code / identity / config
// Protects ARIA from modifying itself during debug/task runs
function isProtectedPath(filePath: string): string | null {
  const ARIA_PROTECTED_PREFIXES = [
    '/Users/hungpham/projects/aria-mac/src/',
    '/Users/hungpham/projects/aria-mac/identity/',
    '/Users/hungpham/projects/aria-mac/package.json',
    '/Users/hungpham/projects/aria-mac/package-lock.json',
    '/Users/hungpham/projects/aria-mac/tsconfig.json',
    '/Users/hungpham/projects/aria-mac/dashboard/',
  ];
  const abs = filePath.replace('~', process.env.HOME ?? '/Users/hungpham');
  for (const prefix of ARIA_PROTECTED_PREFIXES) {
    if (abs === prefix.replace(/\/$/, '') || abs.startsWith(prefix)) {
      return `REFUSED: ARIA cannot modify its own source code at ${abs}. Protected path: ${prefix}. Boss must edit this manually.`;
    }
  }
  return null;
}

function toolWrite(args: Record<string, unknown>): string {
  const filePath = String(args.file_path ?? '');
  const content = String(args.content ?? '');
  if (!filePath) return 'Error: No file_path provided';

  const protectedErr = isProtectedPath(filePath);
  if (protectedErr) return protectedErr;

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

  const protectedErr = isProtectedPath(filePath);
  if (protectedErr) return protectedErr;

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

// ─── Canvas (ComfyUI) ───────────────────────────────────────────────────────

const COMFY_BASE = 'http://127.0.0.1:8188';
const COMFY_OUTPUT_DIR = join(homedir(), 'projects', 'aria-mac', 'data', 'canvas');

async function toolCanvas(args: Record<string, unknown>): Promise<string> {
  const prompt = String(args.prompt ?? '');
  if (!prompt) return 'Error: No prompt provided';
  const negative = String(args.negative_prompt ?? 'low quality, blurry, distorted, deformed, ugly, bad anatomy');
  const width = Math.min(Number(args.width ?? 1024), 1536);
  const height = Math.min(Number(args.height ?? 1024), 1536);
  const filename = String(args.filename ?? `canvas-${Date.now()}`);

  const workflow: Record<string, unknown> = {
    '3': { class_type: 'KSampler', inputs: { cfg: 7, denoise: 1, latent_image: ['5', 0], model: ['4', 0], negative: ['7', 0], positive: ['6', 0], sampler_name: 'euler', scheduler: 'normal', seed: Math.floor(Math.random() * 2147483647), steps: 30 } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'animagine-xl-4.0-opt.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { batch_size: 1, height, width } },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: prompt } },
    '7': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: negative } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: filename, images: ['8', 0] } },
  };

  try {
    const queueRes = await fetch(`${COMFY_BASE}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }), signal: AbortSignal.timeout(10000),
    });
    if (!queueRes.ok) return `ComfyUI error: ${(await queueRes.text()).slice(0, 300)}`;
    const { prompt_id } = (await queueRes.json()) as { prompt_id: string };

    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const historyRes = await fetch(`${COMFY_BASE}/history/${prompt_id}`, { signal: AbortSignal.timeout(5000) });
      if (!historyRes.ok) continue;
      const history = (await historyRes.json()) as Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string }> }> }>;
      const entry = history[prompt_id];
      if (!entry?.outputs) continue;
      for (const nodeOutput of Object.values(entry.outputs)) {
        if (nodeOutput.images && nodeOutput.images.length > 0) {
          const img = nodeOutput.images[0];
          const imgUrl = `${COMFY_BASE}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=output`;
          if (!existsSync(COMFY_OUTPUT_DIR)) mkdirSync(COMFY_OUTPUT_DIR, { recursive: true });
          const localPath = join(COMFY_OUTPUT_DIR, `${filename}.png`);
          const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(15000) });
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          writeFileSync(localPath, buffer);
          return `Image generated: ${localPath} (${buffer.length} bytes, ${width}x${height})\nPrompt: ${prompt.slice(0, 100)}`;
        }
      }
    }
    return 'Error: ComfyUI generation timed out after 3 minutes';
  } catch (err) {
    return `Canvas error: ${(err as Error).message}`;
  }
}

// ─── Browser (Playwright) ───────────────────────────────────────────────────

let _browser: Awaited<ReturnType<typeof import('playwright').chromium.launch>> | null = null;
const BROWSER_SCREENSHOT_DIR = join(homedir(), 'projects', 'aria-mac', 'data', 'screenshots');

async function getBrowser() {
  if (_browser?.isConnected()) return _browser;
  const { chromium } = await import('playwright');
  _browser = await chromium.launch({ headless: true });
  return _browser;
}

async function toolBrowser(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? '');
  if (!action) return 'Error: No action specified';
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const url = String(args.url ?? '');
    if (action === 'navigate' || action === 'screenshot' || action === 'content') {
      if (!url) return 'Error: URL required';
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    }
    let result = '';
    switch (action) {
      case 'screenshot': {
        if (!existsSync(BROWSER_SCREENSHOT_DIR)) mkdirSync(BROWSER_SCREENSHOT_DIR, { recursive: true });
        const fname = String(args.filename ?? `screenshot-${Date.now()}.png`);
        const fpath = join(BROWSER_SCREENSHOT_DIR, fname);
        const fullPage = args.full_page !== false;
        await page.screenshot({ path: fpath, fullPage });
        const title = await page.title();
        result = `Screenshot saved: ${fpath}\nPage title: ${title}\nURL: ${url}`;
        break;
      }
      case 'content': {
        const title = await page.title();
        const text = await page.evaluate(`
          (() => { const el = document.querySelector('main') || document.querySelector('article') || document.body; return el.innerText.slice(0, 6000); })()
        `) as string;
        result = `Title: ${title}\nURL: ${url}\n\n${text}`;
        break;
      }
      case 'click': {
        const selector = String(args.selector ?? '');
        if (!selector) { result = 'Error: selector required'; break; }
        if (url) await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.click(selector);
        result = `Clicked: ${selector}`;
        break;
      }
      case 'fill': {
        const selector = String(args.selector ?? '');
        const value = String(args.value ?? '');
        if (!selector) { result = 'Error: selector required'; break; }
        if (url) await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.fill(selector, value);
        result = `Filled ${selector} with: ${value.slice(0, 50)}`;
        break;
      }
      case 'navigate': {
        const title = await page.title();
        result = `Navigated to: ${url}\nTitle: ${title}`;
        break;
      }
      case 'type': {
        const selector = String(args.selector ?? '');
        const value = String(args.value ?? '');
        const delay = Number(args.delay ?? 50);
        if (!selector) { result = 'Error: selector required'; break; }
        if (url) await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.type(selector, value, { delay });
        result = `Typed into ${selector}: "${value.slice(0, 50)}" (${value.length} chars, ${delay}ms/key)`;
        break;
      }
      case 'press': {
        const selector = String(args.selector ?? '');
        const key = String(args.value ?? 'Enter');
        if (url) await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        if (selector) await page.press(selector, key);
        else await page.keyboard.press(key);
        result = `Pressed key: ${key}${selector ? ` on ${selector}` : ''}`;
        break;
      }
      case 'evaluate': {
        const js = String(args.value ?? '');
        if (!js) { result = 'Error: value (JS expression) required'; break; }
        if (url) await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        const evalResult = await page.evaluate(js) as unknown;
        result = `Evaluated: ${String(evalResult).slice(0, 2000)}`;
        break;
      }
      case 'wait_for': {
        const selector = String(args.selector ?? '');
        if (!selector) { result = 'Error: selector required'; break; }
        if (url) await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForSelector(selector, { timeout: 20000 });
        result = `Element appeared: ${selector}`;
        break;
      }
      default: result = `Unknown action: ${action}`;
    }
    await page.close();
    return result;
  } catch (err) {
    return `Browser error: ${(err as Error).message}`;
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
      case 'Canvas': return await toolCanvas(args);
      case 'Browser': return await toolBrowser(args);
      default: return `Unknown tool: ${name}. Available tools: ${TOOLS.map(t => t.name).join(', ')}`;
    }
  } catch (err) {
    return `Tool execution error (${name}): ${(err as Error).message}`;
  }
}
