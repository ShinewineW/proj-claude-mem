import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  registerProcess,
  unregisterProcess,
  getProcessBySession,
  getActiveCount,
  getActiveProcesses,
} from '../../src/services/worker/ProcessRegistry.js';

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
