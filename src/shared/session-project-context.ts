import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';
import type { ResolvedProject } from './project-allowlist.js';
import { getEnabledProjectsPath, isProjectEnabled } from './project-allowlist.js';
import { writeJsonFileAtomic } from '../utils/json-utils.js';
import { logger } from '../utils/logger.js';

interface SessionProjectContextEntry extends ResolvedProject {
  pinnedAt: string;
  lastSeenAt: string;
}

interface SessionProjectContextStore {
  version: 1;
  sessions: Record<string, SessionProjectContextEntry>;
}

const SESSION_CONTEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10_000;

export function getSessionProjectContextsPath(): string {
  return join(dirname(getEnabledProjectsPath()), 'session-project-contexts.json');
}

function emptyStore(): SessionProjectContextStore {
  return { version: 1, sessions: {} };
}

function readStore(): SessionProjectContextStore {
  const file = getSessionProjectContextsPath();
  if (!existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SessionProjectContextStore>;
    return {
      version: 1,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions as Record<string, SessionProjectContextEntry> : {},
    };
  } catch (err) {
    logger.warn('HOOK', 'Failed to read pinned session project contexts', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyStore();
  }
}

function writeStore(store: SessionProjectContextStore): void {
  writeJsonFileAtomic(getSessionProjectContextsPath(), store);
}

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

function acquireLock(lockPath: string, maxWaitMs = 1000): boolean {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeSync(fd, Buffer.from(String(process.pid)));
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        try {
          const ageMs = Date.now() - statSync(lockPath).mtimeMs;
          if (ageMs > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock disappeared or could not be inspected; retry.
        }
        sleepSync(25);
        continue;
      }
      throw err;
    }
  }
  return false;
}

function withLock<T>(fn: () => T): T {
  const lockPath = getSessionProjectContextsPath() + '.lock';
  const locked = acquireLock(lockPath);
  if (!locked) {
    logger.warn('HOOK', 'Could not lock pinned session project contexts; proceeding without lock');
  }
  try {
    return fn();
  } finally {
    if (locked) {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

function isFresh(entry: SessionProjectContextEntry): boolean {
  const ts = Date.parse(entry.lastSeenAt || entry.pinnedAt);
  return Number.isFinite(ts) && Date.now() - ts <= SESSION_CONTEXT_MAX_AGE_MS;
}

function pruneExpired(store: SessionProjectContextStore): boolean {
  let changed = false;
  for (const [sessionId, entry] of Object.entries(store.sessions)) {
    if (!isFresh(entry)) {
      delete store.sessions[sessionId];
      changed = true;
    }
  }
  return changed;
}

export function getPinnedSessionProjectContext(sessionId: string | undefined): ResolvedProject | null {
  if (!sessionId) return null;
  const store = readStore();
  const entry = store.sessions[sessionId];
  if (!entry) return null;

  if (!isFresh(entry) || !isProjectEnabled(entry.projectRoot)) {
    withLock(() => {
      const lockedStore = readStore();
      if (lockedStore.sessions[sessionId]?.projectRoot === entry.projectRoot) {
        delete lockedStore.sessions[sessionId];
        writeStore(lockedStore);
      }
    });
    return null;
  }

  return {
    projectRoot: entry.projectRoot,
    dbPath: entry.dbPath,
    projectName: entry.projectName,
  };
}

export function pinSessionProjectContext(sessionId: string | undefined, ctx: ResolvedProject): void {
  if (!sessionId) return;
  withLock(() => {
    const store = readStore();
    pruneExpired(store);

    const existing = store.sessions[sessionId];
    if (existing) {
      existing.lastSeenAt = new Date().toISOString();
      if (existing.projectRoot !== ctx.projectRoot) {
        logger.warn('HOOK', 'Ignoring cwd drift for already pinned session project context', {
          contentSessionId: sessionId,
          pinnedProjectRoot: existing.projectRoot,
          currentProjectRoot: ctx.projectRoot,
        });
      }
      writeStore(store);
      return;
    }

    const now = new Date().toISOString();
    store.sessions[sessionId] = {
      ...ctx,
      pinnedAt: now,
      lastSeenAt: now,
    };
    writeStore(store);
  });
}
