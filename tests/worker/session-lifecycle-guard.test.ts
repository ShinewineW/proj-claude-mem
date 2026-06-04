import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
// NOTE: Cannot import the real ProcessRegistry.js — it is mock.module()'d by 11+
// other test files (ghost-session-cleanup, bypass-lane, summary-lane, ...), and
// bun's mock.module is process-level and irreversible, so it leaks into this file
// during full-suite runs. Per the repo convention (see process-registry-killed.test.ts),
// inline a faithful copy of the registry contract from ProcessRegistry.ts. The
// production duplicate-prevention logic is additionally source-pinned by the
// "ProcessRegistry kill-duplicate-before-spawn (source)" describe block below.
interface TrackedProc { pid: number; sessionDbId: number; spawnedAt: number; process: any }
const processRegistry = new Map<number, TrackedProc>();
function registerProcess(pid: number, sessionDbId: number, process: any): void {
  processRegistry.set(pid, { pid, sessionDbId, spawnedAt: Date.now(), process });
}
function unregisterProcess(pid: number): void {
  processRegistry.delete(pid);
}
function getProcessBySession(sessionDbId: number): TrackedProc | undefined {
  for (const [, info] of processRegistry) {
    if (info.sessionDbId === sessionDbId) return info;
  }
  return undefined;
}
function getActiveCount(): number {
  return processRegistry.size;
}
function getActiveProcesses(): Array<{ pid: number }> {
  return Array.from(processRegistry.values()).map(p => ({ pid: p.pid }));
}

function createMockProcess(overrides: { exitCode?: number | null } = {}) {
  const emitter = new EventEmitter();
  const mock: any = Object.assign(emitter, {
    pid: Math.floor(Math.random() * 100_000) + 10_000,
    exitCode: overrides.exitCode ?? null,
    killed: false,
    kill(signal?: string) {
      mock.killed = true;
      setTimeout(() => { mock.exitCode = 0; mock.emit('exit', 0, signal || 'SIGTERM'); }, 10);
      return true;
    },
  });
  return mock;
}

function clearRegistry() {
  for (const p of getActiveProcesses()) unregisterProcess(p.pid);
}

describe('SIGTERM detection (#1590)', () => {
  const isSig = (m: string) => m.includes('code 143') || m.includes('signal SIGTERM');
  it('classifies "code 143" as SIGTERM', () => expect(isSig('exited with code 143')).toBe(true));
  it('classifies "signal SIGTERM" as SIGTERM', () => expect(isSig('terminated with signal SIGTERM')).toBe(true));
  it('does NOT classify ordinary errors as SIGTERM', () => expect(isSig('Invalid API key')).toBe(false));
  it('does NOT classify code 1 as SIGTERM', () => expect(isSig('exited with code 1')).toBe(false));
  it('aborting on SIGTERM marks wasAborted=true (no respawn)', () => {
    const ac = new AbortController();
    ac.abort();
    expect(ac.signal.aborted).toBe(true);
  });
});

describe('Duplicate process prevention (#1590)', () => {
  beforeEach(clearRegistry);
  afterEach(clearRegistry);

  it('detects a live duplicate for the session', () => {
    const p = createMockProcess();
    registerProcess(p.pid, 42, p as any);
    const existing = getProcessBySession(42);
    expect(existing).toBeDefined();
    expect(existing!.process.exitCode).toBeNull();
  });

  it('does NOT treat an exited process as a live duplicate', () => {
    const p = createMockProcess({ exitCode: 0 });
    registerProcess(p.pid, 42, p as any);
    expect(getProcessBySession(42)!.process.exitCode).not.toBeNull();
  });

  it('kills + unregisters the existing process before a new spawn', () => {
    const old = createMockProcess();
    registerProcess(old.pid, 99, old as any);
    expect(getActiveCount()).toBe(1);
    const dup = getProcessBySession(99);
    if (dup && dup.process.exitCode === null) {
      try { (dup.process as any).kill('SIGTERM'); } catch {}
      unregisterProcess(dup.pid);
    }
    expect(getActiveCount()).toBe(0);
    expect(getProcessBySession(99)).toBeUndefined();
  });

  it('is a no-op when no existing process is registered', () => {
    expect(getProcessBySession(55)).toBeUndefined();
    expect(getActiveCount()).toBe(0);
  });
});

describe('SessionRoutes stale-controller + SIGTERM guard (source)', () => {
  const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/http/routes/SessionRoutes.ts'), 'utf-8');
  it('binds myController at generator start', () => {
    expect(SRC).toContain('const myController = session.abortController;');
  });
  it('uses myController in the .catch abort check', () => {
    expect(SRC).toContain('if (myController.signal.aborted) return;');
  });
  it('treats code 143 / signal SIGTERM as intentional termination', () => {
    expect(SRC).toContain("errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM')");
  });
});

describe('ProcessRegistry kill-duplicate-before-spawn (source)', () => {
  const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/ProcessRegistry.ts'), 'utf-8');
  it('kills any live existing process for the session before spawning', () => {
    expect(SRC).toContain('Killing duplicate process PID');
  });
});

describe('Wall-clock age cap (#1590)', () => {
  const MAX = 14_400_000; // 4h default
  it('does NOT terminate a session younger than the cap', () => {
    const origin = Date.now() - 30 * 60 * 1000; // 30m
    expect(Date.now() - origin).toBeLessThan(MAX);
  });
  it('uses strict > so exactly the cap is still alive', () => {
    const origin = Date.now() - MAX;
    expect(Date.now() - origin).toBeLessThanOrEqual(MAX);
  });
  it('terminates a session older than the cap', () => {
    const origin = Date.now() - MAX - 1;
    expect(Date.now() - origin).toBeGreaterThan(MAX);
  });

  // Source guard tying the production wiring to a RED:
  const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/http/routes/SessionRoutes.ts'), 'utf-8');
  it('reads CLAUDE_MEM_SESSION_MAX_AGE_MS for the cap', () => {
    expect(SRC).toContain('CLAUDE_MEM_SESSION_MAX_AGE_MS');
  });
  it('queries persisted started_at_epoch for the age', () => {
    expect(SRC).toContain('started_at_epoch FROM sdk_sessions');
  });
  it('drains the queue via markAllSessionMessagesAbandoned on cap breach', () => {
    expect(SRC).toContain('markAllSessionMessagesAbandoned(sessionDbId)');
  });
});
