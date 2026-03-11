/**
 * Tests for SessionManager per-project isolation (B6 fix).
 *
 * Problem: SessionManager.sessions was Map<number, ActiveSession> keyed by
 * sessionDbId (SQLite auto-increment). Two different project databases can
 * produce the same integer ID. When a user runs two terminals in different
 * projects simultaneously, the second project's session would hit the first
 * project's cached session.
 *
 * Fix: Changed to Map<string, ActiveSession> with composite key
 * "${dbPath || '_default'}::${sessionDbId}" to prevent cross-project collisions.
 *
 * Mock Justification: Partial (mock module for paths/logger/ProcessRegistry only)
 * - Uses real SQLite with ':memory:' via bun:sqlite Database
 * - Each "project" gets its own in-memory database
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Module-level mocks (must be before any import of production code)
// ---------------------------------------------------------------------------

mock.module('../../src/shared/paths.js', () => ({
  DATA_DIR: '/tmp/test-claude-mem',
  DB_PATH: '/tmp/test-claude-mem/claude-mem.db',
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  resolveProjectDbPath: () => '/tmp/test-project/.claude/mem.db',
  resolveProjectRoot: () => '/tmp/test-project',
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    success: () => {},
    formatTool: () => 'mock-tool',
  },
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({ CLAUDE_MEM_CHROMA_ENABLED: 'false' }),
    get: () => '/tmp/test-claude-mem',
  },
}));

// Mock ProcessRegistry to avoid subprocess management
mock.module('../../src/services/worker/ProcessRegistry.js', () => ({
  getProcessBySession: () => undefined,
  ensureProcessExit: async () => {},
  registerProcess: () => {},
  unregisterProcess: () => {},
}));

import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT UNIQUE NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active',
      prompt_counter INTEGER DEFAULT 0,
      custom_title TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
      created_at_epoch INTEGER NOT NULL,
      started_processing_at_epoch INTEGER,
      completed_at_epoch INTEGER,
      failed_at_epoch INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
    )
  `);

  return db;
}

function createFakeStore(db: Database) {
  return {
    db,
    close: () => db.close(),
    getSessionById: (id: number) => {
      return db.prepare(
        'SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title FROM sdk_sessions WHERE id = ?'
      ).get(id) || null;
    },
    getPromptNumberFromUserPrompts: (_contentSessionId: string) => 0,
  };
}

function insertSession(db: Database, contentSessionId: string, project: string, userPrompt: string): number {
  const now = new Date();
  const result = db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, userPrompt, now.toISOString(), now.getTime());
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager per-project isolation (B6)', () => {
  const dbPathA = '/tmp/projA/.claude/mem.db';
  const dbPathB = '/tmp/projB/.claude/mem.db';

  let dbA: Database;
  let dbB: Database;
  let storeA: ReturnType<typeof createFakeStore>;
  let storeB: ReturnType<typeof createFakeStore>;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    dbA = createTestDb();
    dbB = createTestDb();
    storeA = createFakeStore(dbA);
    storeB = createFakeStore(dbB);

    // Create a mock pool that routes by dbPath
    const storeMap: Record<string, ReturnType<typeof createFakeStore>> = {
      [dbPathA]: storeA,
      [dbPathB]: storeB,
    };

    const mockPool = {
      getStore: (path: string) => storeMap[path] || storeA,
      getSearch: () => ({ close: () => {} }),
      getLastActiveStore: () => storeA,
      getLastActiveSearch: () => null,
      closeAll: () => {},
    } as any;

    dbManager = new DatabaseManager(mockPool);
    await dbManager.initialize(dbPathA);

    sessionManager = new SessionManager(dbManager);

    // Insert sessions in both databases — both get id=1 (auto-increment starts at 1)
    insertSession(dbA, 'claude-session-A', 'projectA', 'prompt A');
    insertSession(dbB, 'claude-session-B', 'projectB', 'prompt B');
  });

  afterEach(() => {
    try { dbA.close(); } catch { /* may already be closed */ }
    try { dbB.close(); } catch { /* may already be closed */ }
  });

  it('same sessionDbId from different projects creates separate sessions', () => {
    const sessionA = sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);
    const sessionB = sessionManager.initializeSession(1, 'prompt B', 1, dbPathB);

    // Must be distinct objects
    expect(sessionA).not.toBe(sessionB);

    // Each session points to its own project
    expect(sessionA.dbPath).toBe(dbPathA);
    expect(sessionB.dbPath).toBe(dbPathB);
    expect(sessionA.project).toBe('projectA');
    expect(sessionB.project).toBe('projectB');
    expect(sessionA.contentSessionId).toBe('claude-session-A');
    expect(sessionB.contentSessionId).toBe('claude-session-B');

    // Both tracked — count is 2, not 1
    expect(sessionManager.getActiveSessionCount()).toBe(2);
  });

  it('getSession with dbPath returns correct project session', () => {
    sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);
    sessionManager.initializeSession(1, 'prompt B', 1, dbPathB);

    const retrievedA = sessionManager.getSession(1, dbPathA);
    expect(retrievedA).toBeDefined();
    expect(retrievedA!.project).toBe('projectA');
    expect(retrievedA!.dbPath).toBe(dbPathA);

    const retrievedB = sessionManager.getSession(1, dbPathB);
    expect(retrievedB).toBeDefined();
    expect(retrievedB!.project).toBe('projectB');
    expect(retrievedB!.dbPath).toBe(dbPathB);
  });

  it('getSession without dbPath falls back to linear scan (returns first match)', () => {
    sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);
    sessionManager.initializeSession(1, 'prompt B', 1, dbPathB);

    // Without dbPath, linear scan returns the first matching sessionDbId=1
    const retrieved = sessionManager.getSession(1);
    expect(retrieved).toBeDefined();
    expect(retrieved!.sessionDbId).toBe(1);
  });

  it('deleteSession with dbPath only removes the correct project session', async () => {
    sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);
    sessionManager.initializeSession(1, 'prompt B', 1, dbPathB);

    await sessionManager.deleteSession(1, dbPathA);

    // Project A's session is gone
    expect(sessionManager.getSession(1, dbPathA)).toBeUndefined();

    // Project B's session is still there
    const remaining = sessionManager.getSession(1, dbPathB);
    expect(remaining).toBeDefined();
    expect(remaining!.project).toBe('projectB');

    expect(sessionManager.getActiveSessionCount()).toBe(1);
  });

  it('deleteSession without dbPath uses fallback scan and still works', async () => {
    sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);

    await sessionManager.deleteSession(1);

    expect(sessionManager.getSession(1, dbPathA)).toBeUndefined();
    expect(sessionManager.getActiveSessionCount()).toBe(0);
  });

  it('removeSessionImmediate with dbPath only removes the correct project', () => {
    sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);
    sessionManager.initializeSession(1, 'prompt B', 1, dbPathB);

    sessionManager.removeSessionImmediate(1, dbPathA);

    expect(sessionManager.getSession(1, dbPathA)).toBeUndefined();

    const remaining = sessionManager.getSession(1, dbPathB);
    expect(remaining).toBeDefined();
    expect(remaining!.project).toBe('projectB');
  });

  it('initializeSession returns cached session for same project (idempotent)', () => {
    const first = sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);
    const second = sessionManager.initializeSession(1, 'updated prompt', 2, dbPathA);

    // Same object reference
    expect(first).toBe(second);
    // Prompt was updated
    expect(second.userPrompt).toBe('updated prompt');
    expect(second.lastPromptNumber).toBe(2);
    // Only one entry in the map
    expect(sessionManager.getActiveSessionCount()).toBe(1);
  });

  it('deleteSession marks correct DB row as completed', async () => {
    sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);
    sessionManager.initializeSession(1, 'prompt B', 1, dbPathB);

    await sessionManager.deleteSession(1, dbPathA);

    // Project A's DB row should be completed
    const rowA = dbA.prepare('SELECT status FROM sdk_sessions WHERE id = 1').get() as any;
    expect(rowA.status).toBe('completed');

    // Project B's DB row should still be active
    const rowB = dbB.prepare('SELECT status FROM sdk_sessions WHERE id = 1').get() as any;
    expect(rowB.status).toBe('active');
  });

  it('shutdownAll cleans up all sessions from all projects', async () => {
    sessionManager.initializeSession(1, 'prompt A', 1, dbPathA);
    sessionManager.initializeSession(1, 'prompt B', 1, dbPathB);

    expect(sessionManager.getActiveSessionCount()).toBe(2);

    await sessionManager.shutdownAll();

    expect(sessionManager.getActiveSessionCount()).toBe(0);
    expect(sessionManager.getSession(1, dbPathA)).toBeUndefined();
    expect(sessionManager.getSession(1, dbPathB)).toBeUndefined();
  });
});
