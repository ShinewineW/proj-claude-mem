/**
 * SessionManager.cleanupOrphanedSummarizes() — periodic orphan cleanup scheduler
 * for summarize rows whose owning session is missing or failed.
 *
 * Wiring target: called every 2 minutes from worker-service's ghost-cleanup
 * interval. Iterates enabled dbPaths, delegates to
 * PendingMessageStore.markTrulyOrphanedSummarizesFailed on each. Surfaces
 * total affected row count for telemetry.
 */

import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { logger } from '../../src/utils/logger.js';

interface ProjectFixture {
  dbPath: string;
  cmDb: ClaudeMemDatabase;
  pending: PendingMessageStore;
}

function makeProject(dbPath: string): ProjectFixture {
  const cmDb = new ClaudeMemDatabase(':memory:');
  const pending = new PendingMessageStore(cmDb.db, 3);
  return { dbPath, cmDb, pending };
}

function makeStubDbManager(projects: Map<string, ProjectFixture>): DatabaseManager {
  return {
    getSessionStore: (dbPath?: string) => {
      const proj = projects.get(dbPath ?? '');
      if (!proj) throw new Error(`No project for dbPath: ${dbPath ?? '(default)'}`);
      return proj.cmDb.sessionStore ?? ({
        db: proj.cmDb.db,
      } as any);
    },
    getPendingMessageStore: (dbPath?: string) => {
      const proj = projects.get(dbPath ?? '');
      if (!proj) throw new Error(`No project for dbPath: ${dbPath ?? '(default)'}`);
      return proj.pending;
    },
  } as unknown as DatabaseManager;
}

describe('SessionManager.cleanupOrphanedSummarizes', () => {
  let spies: Array<ReturnType<typeof spyOn>>;
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  it('returns 0 when dbPaths set is empty', () => {
    const mgr = new SessionManager(makeStubDbManager(new Map()));
    const affected = mgr.cleanupOrphanedSummarizes(new Set<string>());
    expect(affected).toBe(0);
  });

  it('marks orphan summarize rows across all supplied dbPaths', () => {
    const projA = makeProject('/tmp/a.db');
    const projB = makeProject('/tmp/b.db');

    // Project A: one orphan (session row missing + row older than threshold)
    const sessA = createSDKSession(projA.cmDb.db, 'cs-a', 'proj-a', 'p');
    const msgA = projA.pending.enqueue(sessA, 'cs-a', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    projA.cmDb.db.prepare(`UPDATE pending_messages SET created_at_epoch=? WHERE id=?`).run(Date.now() - 10 * 60_000, msgA);
    projA.cmDb.db.run('PRAGMA foreign_keys = OFF');
    projA.cmDb.db.prepare(`DELETE FROM sdk_sessions WHERE id=?`).run(sessA);
    projA.cmDb.db.run('PRAGMA foreign_keys = ON');

    // Project B: one orphan (session marked failed)
    const sessB = createSDKSession(projB.cmDb.db, 'cs-b', 'proj-b', 'p');
    projB.cmDb.db.prepare(`UPDATE sdk_sessions SET status='failed' WHERE id=?`).run(sessB);
    const msgB = projB.pending.enqueue(sessB, 'cs-b', {
      type: 'summarize', last_assistant_message: 'y', prompt_number: 1,
    });
    projB.cmDb.db.prepare(`UPDATE pending_messages SET created_at_epoch=? WHERE id=?`).run(Date.now() - 10 * 60_000, msgB);

    const projects = new Map([
      [projA.dbPath, projA],
      [projB.dbPath, projB],
    ]);
    const mgr = new SessionManager(makeStubDbManager(projects));

    const affected = mgr.cleanupOrphanedSummarizes(new Set(projects.keys()));

    expect(affected).toBe(2);
    const rowA = projA.cmDb.db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(msgA) as { status: string };
    const rowB = projB.cmDb.db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(msgB) as { status: string };
    expect(rowA.status).toBe('failed');
    expect(rowB.status).toBe('failed');
  });

  it('preserves legitimate backlog: completed sessions keep their pending summarize', () => {
    const projA = makeProject('/tmp/a.db');
    const sessA = createSDKSession(projA.cmDb.db, 'cs-a', 'proj-a', 'p');
    projA.cmDb.db.prepare(`UPDATE sdk_sessions SET status='completed' WHERE id=?`).run(sessA);
    const msg = projA.pending.enqueue(sessA, 'cs-a', {
      type: 'summarize', last_assistant_message: 'x', prompt_number: 1,
    });
    projA.cmDb.db.prepare(`UPDATE pending_messages SET created_at_epoch=? WHERE id=?`).run(Date.now() - 10 * 60_000, msg);

    const mgr = new SessionManager(makeStubDbManager(new Map([[projA.dbPath, projA]])));
    const affected = mgr.cleanupOrphanedSummarizes(new Set([projA.dbPath]));

    expect(affected).toBe(0);
    const row = projA.cmDb.db.prepare(`SELECT status FROM pending_messages WHERE id=?`).get(msg) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('swallows per-DB errors without aborting the loop', () => {
    const projA = makeProject('/tmp/a.db');
    const projB = makeProject('/tmp/b.db');
    // Project A will throw when accessed (simulate DB unreachable).
    // Project B is healthy and should still get cleaned up.
    const sessB = createSDKSession(projB.cmDb.db, 'cs-b', 'proj-b', 'p');
    projB.cmDb.db.prepare(`UPDATE sdk_sessions SET status='failed' WHERE id=?`).run(sessB);
    const msgB = projB.pending.enqueue(sessB, 'cs-b', {
      type: 'summarize', last_assistant_message: 'y', prompt_number: 1,
    });
    projB.cmDb.db.prepare(`UPDATE pending_messages SET created_at_epoch=? WHERE id=?`).run(Date.now() - 10 * 60_000, msgB);

    const stubDbManager = {
      getSessionStore: (dbPath?: string) => {
        if (dbPath === projA.dbPath) throw new Error('boom (proj-a unreachable)');
        if (dbPath === projB.dbPath) {
          return projB.cmDb.sessionStore ?? ({ db: projB.cmDb.db } as any);
        }
        throw new Error('unknown dbPath');
      },
    } as unknown as DatabaseManager;

    const mgr = new SessionManager(stubDbManager);
    const affected = mgr.cleanupOrphanedSummarizes(new Set([projA.dbPath, projB.dbPath]));

    expect(affected).toBe(1);
  });
});
