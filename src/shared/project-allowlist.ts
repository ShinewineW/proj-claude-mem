/**
 * Project Allowlist - Per-project opt-in for claude-mem recording
 *
 * Allowlist stored at: ~/.claude-mem/enabled-projects.json
 * Key: absolute path to git root (or cwd for non-git dirs)
 * Value: { enabledAt: ISO timestamp }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

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
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    // I/O error (permissions, encoding) — warn and return empty
    logger.warn('ALLOWLIST', `Failed to read allowlist file: ${err instanceof Error ? err.message : err}`);
    return {};
  }
  try {
    return JSON.parse(raw) as Allowlist;
  } catch {
    // Corrupt JSON — recoverable, return empty
    return {};
  }
}

function writeAllowlist(data: Allowlist): void {
  const path = getEnabledProjectsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, path);
}

export function isProjectEnabled(projectRoot: string): boolean {
  const allowlist = readAllowlist();
  return Object.prototype.hasOwnProperty.call(allowlist, projectRoot);
}

export function enableProject(projectRoot: string): void {
  const allowlist = readAllowlist();
  if (Object.prototype.hasOwnProperty.call(allowlist, projectRoot)) return;
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
