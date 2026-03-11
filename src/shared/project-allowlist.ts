/**
 * Project Allowlist - Per-project opt-in for claude-mem recording
 *
 * Allowlist stored at: ~/.claude-mem/enabled-projects.json
 * Key: absolute path to git root (or cwd for non-git dirs)
 * Value: { enabledAt: ISO timestamp }
 */

import { existsSync, readFileSync, writeFileSync, writeSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, constants } from 'fs';
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

// --- File lock for atomic read-modify-write ---

const LOCK_STALE_MS = 10_000;

function acquireLock(lockPath: string, maxWaitMs: number = 3000): boolean {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      const pidBuf = Buffer.from(String(process.pid));
      writeSync(fd, pidBuf);
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Check if lock is stale
        try {
          if (existsSync(lockPath)) {
            const content = readFileSync(lockPath, 'utf-8');
            const lockAge = Date.now() - (Bun.file(lockPath).lastModified || 0);
            if (lockAge > LOCK_STALE_MS) {
              logger.warn('ALLOWLIST', `Removing stale lock (age=${lockAge}ms, pid=${content})`);
              try { unlinkSync(lockPath); } catch { /* ignore */ }
              continue;
            }
          }
        } catch { /* ignore stat errors */ }
        Bun.sleepSync(50);
        continue;
      }
      throw err;
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already removed — safe to ignore
  }
}

function withLock<T>(fn: () => T): T {
  const lockPath = getEnabledProjectsPath() + '.lock';
  const acquired = acquireLock(lockPath);
  if (!acquired) {
    logger.warn('ALLOWLIST', 'Could not acquire lock, proceeding without lock');
  }
  try {
    return fn();
  } finally {
    if (acquired) releaseLock(lockPath);
  }
}

export function isProjectEnabled(projectRoot: string): boolean {
  const allowlist = readAllowlist();
  return Object.prototype.hasOwnProperty.call(allowlist, projectRoot);
}

export function enableProject(projectRoot: string): void {
  withLock(() => {
    const allowlist = readAllowlist();
    if (Object.prototype.hasOwnProperty.call(allowlist, projectRoot)) return;
    allowlist[projectRoot] = { enabledAt: new Date().toISOString() };
    writeAllowlist(allowlist);
  });
}

export function disableProject(projectRoot: string): void {
  withLock(() => {
    const allowlist = readAllowlist();
    if (!Object.prototype.hasOwnProperty.call(allowlist, projectRoot)) return;
    delete allowlist[projectRoot];
    writeAllowlist(allowlist);
  });
}

export function listEnabledProjects(): Allowlist {
  return readAllowlist();
}
