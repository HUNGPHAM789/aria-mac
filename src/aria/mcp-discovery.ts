// MCP server discovery — reads ~/.aria/mcp-servers.json and returns
// server configs that the Claude Agent SDK can connect to natively.
//
// Config format (follows Claude Code convention):
// {
//   "servers": {
//     "github": {
//       "command": "npx",
//       "args": ["-y", "@modelcontextprotocol/server-github"],
//       "env": { "GITHUB_TOKEN": "ghp_..." }
//     },
//     "filesystem": {
//       "command": "npx",
//       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
//     }
//   }
// }
//
// Each server is a stdio subprocess. The SDK launches the command,
// speaks MCP protocol over stdin/stdout, and exposes discovered tools
// to the model automatically. No ARIA-side tool mapping needed.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  servers?: Record<string, McpServerConfig>;
}

const CONFIG_PATH = join(homedir(), '.aria', 'mcp-servers.json');
let _cached: Record<string, McpServerConfig> | null = null;
let _lastLoadMs = 0;
const CACHE_TTL_MS = 60_000; // re-read every 60s

export function loadMcpServers(): Record<string, McpServerConfig> {
  const now = Date.now();
  if (_cached && now - _lastLoadMs < CACHE_TTL_MS) return _cached;

  if (!existsSync(CONFIG_PATH)) {
    _cached = {};
    _lastLoadMs = now;
    return _cached;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed: McpConfigFile = JSON.parse(raw);
    const servers = parsed.servers ?? {};
    // Validate: each entry must have a command string
    const valid: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg.command === 'string' && cfg.command.trim()) {
        valid[name] = {
          command: cfg.command,
          args: Array.isArray(cfg.args) ? cfg.args : [],
          ...(cfg.env && typeof cfg.env === 'object' ? { env: cfg.env } : {}),
        };
      } else {
        console.warn(`[aria] MCP server "${name}" skipped — missing or invalid "command" field`);
      }
    }
    _cached = valid;
    _lastLoadMs = now;
    const count = Object.keys(valid).length;
    if (count > 0) console.log(`[aria] MCP: loaded ${count} server(s) from ${CONFIG_PATH}`);
    return valid;
  } catch (err) {
    console.warn(`[aria] MCP config error (${CONFIG_PATH}): ${(err as Error).message}`);
    _cached = {};
    _lastLoadMs = now;
    return _cached;
  }
}

/** Invalidate the cache so the next call re-reads from disk. */
export function reloadMcpServers(): void {
  _cached = null;
  _lastLoadMs = 0;
}
