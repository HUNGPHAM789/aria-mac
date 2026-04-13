import { existsSync } from 'fs';
import { log } from './logger.js';

// ─── Post-Tool Verification ─────────────────────────────────────────────────
// Inspects tool results and returns warnings if something looks wrong.
// Called from the PostToolUse hook — warnings get injected back into Claude's
// context so it can self-correct before replying to Boss.

export interface VerifyResult {
  ok: boolean;
  warning?: string;
}

export function verifyToolResult(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  corr?: string,
): VerifyResult {
  switch (toolName) {
    case 'Write':
    case 'Edit': {
      const filePath = String(input.file_path ?? input.path ?? '');
      if (filePath && !existsSync(filePath)) {
        if (corr) log('tool_result', corr, { tool: toolName, verify: 'file_missing', path: filePath });
        return {
          ok: false,
          warning: `VERIFICATION FAILED: File "${filePath}" does not exist after ${toolName}. The operation may have failed silently. Check the path and try again.`,
        };
      }
      return { ok: true };
    }

    case 'Bash': {
      // Check for common error patterns in output
      const lower = output.toLowerCase();
      const errorPatterns = [
        { pattern: 'command not found', msg: 'Command not found' },
        { pattern: 'permission denied', msg: 'Permission denied' },
        { pattern: 'enoent', msg: 'File/directory not found' },
        { pattern: 'fatal: ', msg: 'Git fatal error' },
        { pattern: 'error: failed to push', msg: 'Git push failed' },
        { pattern: 'npm err!', msg: 'npm error' },
        { pattern: 'errno', msg: 'System error' },
      ];
      for (const { pattern, msg } of errorPatterns) {
        if (lower.includes(pattern)) {
          if (corr) log('tool_result', corr, { tool: toolName, verify: 'error_detected', pattern });
          return {
            ok: false,
            warning: `VERIFICATION WARNING: Bash output contains "${msg}". Review the output carefully before telling Boss the task succeeded. If this was expected, proceed. If not, fix the issue.`,
          };
        }
      }
      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

// ─── Response URL Verification ───────────────────────────────────────────────
// Scans ARIA's response text for URLs and verifies they resolve.
// Returns the text with warnings appended for bad URLs.

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

// Known-good prefixes that don't need verification
const TRUSTED_PREFIXES = [
  'https://api.telegram.org',
  'https://api.github.com',
  'http://localhost',
  'http://127.0.0.1',
  'https://generativelanguage.googleapis.com',
];

export async function verifyResponseUrls(
  text: string,
  corr?: string,
): Promise<{ text: string; badUrls: string[] }> {
  const urls = text.match(URL_REGEX) ?? [];
  const uniqueUrls = [...new Set(urls)];
  const badUrls: string[] = [];

  for (const url of uniqueUrls) {
    // Skip trusted/internal URLs
    if (TRUSTED_PREFIXES.some(p => url.startsWith(p))) continue;
    // Skip very long URLs (likely data or encoded)
    if (url.length > 300) continue;

    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      if (res.status === 404 || res.status === 410) {
        badUrls.push(url);
        if (corr) log('tool_result', corr, { verify: 'url_404', url, status: res.status });
      }
    } catch {
      // Network error / timeout — URL might not exist
      badUrls.push(url);
      if (corr) log('tool_result', corr, { verify: 'url_unreachable', url });
    }
  }

  if (badUrls.length > 0) {
    const warning = `\n\n⚠️ _Verification: ${badUrls.length} URL(s) could not be reached:_\n${badUrls.map(u => `• \`${u}\``).join('\n')}`;
    return { text: text + warning, badUrls };
  }

  return { text, badUrls: [] };
}
