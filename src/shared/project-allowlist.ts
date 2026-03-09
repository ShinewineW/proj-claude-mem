/**
 * Project Allowlist - Per-project opt-in for claude-mem recording
 *
 * Allowlist stored at: ~/.claude-mem/enabled-projects.json
 * Key: absolute path to git root (or cwd for non-git dirs)
 * Value: { enabledAt: ISO timestamp }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

/**
 * Resolve the allowlist path at call time (not module load time).
 *
 * This avoids the ES-module hoisting problem: top-level `import` statements
 * execute before any inline `process.env` assignments, so a module-level
 * constant would always see the default value.  Reading process.env lazily
 * lets test files override CLAUDE_MEM_DATA_DIR before the first access.
 */
export function getEnabledProjectsPath(): string {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
  return join(dataDir, 'enabled-projects.json');
}

interface AllowlistEntry {
  enabledAt: string;
}

interface Allowlist {
  [projectRoot: string]: AllowlistEntry;
}

function readAllowlist(): Allowlist {
  const path = getEnabledProjectsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Allowlist;
  } catch {
    return {};
  }
}

function writeAllowlist(data: Allowlist): void {
  const path = getEnabledProjectsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function isProjectEnabled(projectRoot: string): boolean {
  const allowlist = readAllowlist();
  return Object.prototype.hasOwnProperty.call(allowlist, projectRoot);
}

export function enableProject(projectRoot: string): void {
  const allowlist = readAllowlist();
  allowlist[projectRoot] = { enabledAt: new Date().toISOString() };
  writeAllowlist(allowlist);
}

export function disableProject(projectRoot: string): void {
  const allowlist = readAllowlist();
  if (!Object.prototype.hasOwnProperty.call(allowlist, projectRoot)) return;
  delete allowlist[projectRoot];
  writeAllowlist(allowlist);
}

export function listEnabledProjects(): Allowlist {
  return readAllowlist();
}
