import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Shared workspace for multi-agent coordination.
 * All agents read/write here instead of isolation — enables handoff between phases.
 */

const WORKSPACE_ROOT = join(process.cwd(), 'data', 'workspace');

export function getWorkspaceRoot(): string {
  mkdirSync(WORKSPACE_ROOT, { recursive: true });
  return WORKSPACE_ROOT;
}

/** Get or create a task-specific workspace subdirectory */
export function getTaskWorkspace(taskId: string): string {
  const dir = join(WORKSPACE_ROOT, taskId.slice(0, 12));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** List files in the shared workspace (or a task subdirectory) */
export function listWorkspaceFiles(taskId?: string): string[] {
  const dir = taskId ? getTaskWorkspace(taskId) : WORKSPACE_ROOT;
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(WORKSPACE_ROOT, full));
    }
  };
  walk(dir);
  return files;
}

/** Read a file from the workspace */
export function readWorkspaceFile(relativePath: string): string | null {
  const full = join(WORKSPACE_ROOT, relativePath);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf-8');
}

/** Write a file to the workspace */
export function writeWorkspaceFile(relativePath: string, content: string): string {
  const full = join(WORKSPACE_ROOT, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

/** Get workspace summary — file count and total size */
export function workspaceSummary(taskId?: string): { fileCount: number; totalBytes: number } {
  const dir = taskId ? getTaskWorkspace(taskId) : WORKSPACE_ROOT;
  if (!existsSync(dir)) return { fileCount: 0, totalBytes: 0 };

  let fileCount = 0;
  let totalBytes = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        fileCount++;
        totalBytes += statSync(full).size;
      }
    }
  };
  walk(dir);
  return { fileCount, totalBytes };
}
