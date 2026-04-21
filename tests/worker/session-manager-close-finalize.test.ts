import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionEventBroadcaster } from '../../src/services/worker/events/SessionEventBroadcaster.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { logger } from '../../src/utils/logger.js';

function setup() {
  const sessionStore = new SessionStore(':memory:');
  const pendingStore = new PendingMessageStore(sessionStore.db, 3);
  const dbManager = {
    getSessionStore: () => sessionStore,
    getPendingMessageStore: () => pendingStore,
    getSessionById: (id: number) => sessionStore.getSessionById(id),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;

  const broadcaster = {
    broadcastSessionCompleted: mock(() => {}),
  } as unknown as SessionEventBroadcaster;

  const mgr = new SessionManager(dbManager, broadcaster);
  const sessionDbId = sessionStore.createSDKSession('cs', 'proj', 'hello');
  const session = mgr.initializeSession(sessionDbId, 'hello', 1);
  return { mgr, sessionStore, broadcaster, sessionDbId, session };
}

describe('SessionManager.closeSession', () => {
  let spies: Array<ReturnType<typeof spyOn>>;
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
  });
  afterEach(() => { for (const s of spies) s.mockRestore(); });

  it('marks sdk_sessions row as completed', async () => {
    const { mgr, sessionStore, sessionDbId } = setup();
    await mgr.closeSession(sessionDbId);
    const row = sessionStore.db.prepare('SELECT status FROM sdk_sessions WHERE id=?').get(sessionDbId) as { status: string };
    expect(row.status).toBe('completed');
  });

  it('broadcasts session_completed exactly once', async () => {
    const { mgr, broadcaster, sessionDbId } = setup();
    await mgr.closeSession(sessionDbId);
    expect((broadcaster.broadcastSessionCompleted as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it('sets session.closing = true', async () => {
    const { mgr, session, sessionDbId } = setup();
    expect(session.closing).toBeFalsy();
    await mgr.closeSession(sessionDbId);
    expect(session.closing).toBe(true);
  });

  it('returns within 50ms (no drain wait)', async () => {
    const { mgr, sessionDbId } = setup();
    const t0 = Date.now();
    await mgr.closeSession(sessionDbId);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('does NOT remove session from in-memory map', async () => {
    const { mgr, sessionDbId } = setup();
    await mgr.closeSession(sessionDbId);
    expect(mgr.getSession(sessionDbId)).not.toBeUndefined();
  });

  it('is idempotent — repeat calls do NOT double-broadcast (retry-safe)', async () => {
    const { mgr, broadcaster, sessionDbId } = setup();
    await mgr.closeSession(sessionDbId);
    await mgr.closeSession(sessionDbId);
    await mgr.closeSession(sessionDbId);
    expect((broadcaster.broadcastSessionCompleted as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});

describe('SessionManager.finalizeSession', () => {
  let spies: Array<ReturnType<typeof spyOn>>;
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
  });
  afterEach(() => { for (const s of spies) s.mockRestore(); });

  it('aborts the abortController', async () => {
    const { mgr, session, sessionDbId } = setup();
    await mgr.finalizeSession(sessionDbId);
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('removes session from in-memory map', async () => {
    const { mgr, sessionDbId } = setup();
    await mgr.finalizeSession(sessionDbId);
    expect(mgr.getSession(sessionDbId)).toBeUndefined();
  });

  it('is idempotent — second call is a no-op', async () => {
    const { mgr, sessionDbId } = setup();
    await mgr.finalizeSession(sessionDbId);
    await expect(mgr.finalizeSession(sessionDbId)).resolves.toBeUndefined();
  });
});

describe('SessionManager.deleteSession (legacy composition)', () => {
  let spies: Array<ReturnType<typeof spyOn>>;
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
  });
  afterEach(() => { for (const s of spies) s.mockRestore(); });

  it('marks DB completed + removes from map', async () => {
    const { mgr, sessionStore, sessionDbId } = setup();
    await mgr.deleteSession(sessionDbId);
    const row = sessionStore.db.prepare('SELECT status FROM sdk_sessions WHERE id=?').get(sessionDbId) as { status: string };
    expect(row.status).toBe('completed');
    expect(mgr.getSession(sessionDbId)).toBeUndefined();
  });
});

describe('SessionManager.initializeSession closing flag reset', () => {
  let spies: Array<ReturnType<typeof spyOn>>;
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
  });
  afterEach(() => { for (const s of spies) s.mockRestore(); });

  it('clears session.closing when a new prompt arrives', async () => {
    const { mgr, session, sessionDbId } = setup();
    await mgr.closeSession(sessionDbId);
    expect(session.closing).toBe(true);

    const refreshed = mgr.initializeSession(sessionDbId, 'next prompt', 2);
    expect(refreshed.closing).toBe(false);
  });

  it('also resets proactiveSummarizeQueued on new prompt', async () => {
    const { mgr, session, sessionDbId } = setup();
    session.proactiveSummarizeQueued = true;
    mgr.initializeSession(sessionDbId, 'next prompt', 2);
    expect(session.proactiveSummarizeQueued).toBe(false);
  });
});
