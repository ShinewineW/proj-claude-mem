/**
 * Tests for session completion status being written to DB on deleteSession/removeSessionImmediate.
 *
 * Problem: SessionManager.deleteSession() and removeSessionImmediate() remove sessions from
 * in-memory maps but never write UPDATE sdk_sessions SET status = 'completed' to the database.
 * All sessions end up as 'active' (eventually reaped to 'failed'). The 'completed' value in
 * the CHECK constraint is dead code.
 *
 * Mock Justification: Partial (mock module for paths/logger/ProcessRegistry/project-db only)
 * - Uses real SQLite with ':memory:' via bun:sqlite Database (not SessionStore import)
 * - Avoids mock pollution: SessionStore is constructed from real Database, not from mock-polluted
 *   module import (bun:test mock.module is process-level and bleeds between files)
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Module-level mocks (must be before any import of production code)
// ---------------------------------------------------------------------------

mock.module('../../../src/shared/paths.js', () => ({
  DATA_DIR: '/tmp/test-claude-mem',
  DB_PATH: '/tmp/test-claude-mem/claude-mem.db',
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  resolveProjectDbPath: () => '/tmp/test-project/.claude/mem.db',
  resolveProjectRoot: () => '/tmp/test-project',
}));

mock.module('../../../src/utils/logger.js', () => ({
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

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({ CLAUDE_MEM_CHROMA_ENABLED: 'false' }),
    get: () => '/tmp/test-claude-mem',
  },
}));

// Mock ProcessRegistry to avoid subprocess management
mock.module('../../../src/services/worker/ProcessRegistry.js', () => ({
  getProcessBySession: () => undefined,
  ensureProcessExit: async () => {},
  registerProcess: () => {},
  unregisterProcess: () => {},
}));

import { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';

/**
 * Create a minimal in-memory SQLite database with the sdk_sessions schema.
 * Uses bun:sqlite Database directly to avoid mock pollution from other test files
 * that mock SessionStore.js at the module level.
 */
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

  // user_prompts table needed by getPromptNumberFromUserPrompts
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

  // pending_messages table needed by PendingMessageStore
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

/**
 * Insert a session row and return the generated id.
 */
function insertSession(db: Database, contentSessionId: string, project: string, userPrompt: string): number {
  const now = new Date();
  const result = db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, userPrompt, now.toISOString(), now.getTime());
  return Number(result.lastInsertRowid);
}

/**
 * Build a fake store-like object with just the fields that SessionManager and DatabaseManager need.
 * This avoids importing SessionStore which can be mock-polluted.
 */
function createFakeStore(db: Database) {
  return {
    db,
    close: () => db.close(),
    getSessionById: (id: number) => {
      return db.prepare('SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title FROM sdk_sessions WHERE id = ?').get(id) || null;
    },
    getPromptNumberFromUserPrompts: (_contentSessionId: string) => 0,
  };
}

describe('session completion status in DB', () => {
  let db: Database;
  let fakeStore: ReturnType<typeof createFakeStore>;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    db = createTestDb();
    fakeStore = createFakeStore(db);

    // Create a mock pool that always returns our fake store
    const mockPool = {
      getStore: () => fakeStore,
      getSearch: () => ({ close: () => {} }),
      getLastActiveStore: () => fakeStore,
      getLastActiveSearch: () => null,
      closeAll: () => {},
    } as any;

    dbManager = new DatabaseManager(mockPool);
    await dbManager.initialize();

    sessionManager = new SessionManager(dbManager);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // May already be closed by test
    }
  });

  /**
   * Helper: create a session in the DB and initialize it in SessionManager.
   */
  function createTestSession(contentSessionId: string = 'test-content-id'): number {
    const sessionDbId = insertSession(db, contentSessionId, 'test-project', 'test prompt');
    // Initialize in SessionManager (no dbPath — pool fallback returns our fake store)
    sessionManager.initializeSession(sessionDbId, 'test prompt', 1);
    return sessionDbId;
  }

  it('deleteSession should mark session as completed in DB', async () => {
    const sessionDbId = createTestSession('sess-complete-1');

    // Verify initial status is 'active'
    const before = db.prepare('SELECT status, completed_at_epoch FROM sdk_sessions WHERE id = ?').get(sessionDbId) as any;
    expect(before.status).toBe('active');
    expect(before.completed_at_epoch).toBeNull();

    // Delete session
    await sessionManager.deleteSession(sessionDbId);

    // Assert: DB row has status = 'completed' and completed_at_epoch is set
    const after = db.prepare('SELECT status, completed_at_epoch FROM sdk_sessions WHERE id = ?').get(sessionDbId) as any;
    expect(after.status).toBe('completed');
    expect(after.completed_at_epoch).toBeGreaterThan(0);
  });

  it('deleteSession should not overwrite failed status', async () => {
    const sessionDbId = createTestSession('sess-failed-1');

    // Manually set status to 'failed' in DB (simulating reaper)
    db.prepare('UPDATE sdk_sessions SET status = ?, completed_at_epoch = ? WHERE id = ?')
      .run('failed', 1700000000000, sessionDbId);

    // Verify it's failed
    const before = db.prepare('SELECT status FROM sdk_sessions WHERE id = ?').get(sessionDbId) as any;
    expect(before.status).toBe('failed');

    // Delete session
    await sessionManager.deleteSession(sessionDbId);

    // Assert: DB row still has status = 'failed' (WHERE status = 'active' guard prevents overwrite)
    const after = db.prepare('SELECT status, completed_at_epoch FROM sdk_sessions WHERE id = ?').get(sessionDbId) as any;
    expect(after.status).toBe('failed');
    expect(after.completed_at_epoch).toBe(1700000000000);
  });

  it('removeSessionImmediate should mark session as completed in DB', () => {
    const sessionDbId = createTestSession('sess-immediate-1');

    // Verify initial status is 'active'
    const before = db.prepare('SELECT status, completed_at_epoch FROM sdk_sessions WHERE id = ?').get(sessionDbId) as any;
    expect(before.status).toBe('active');

    // Remove session immediately
    sessionManager.removeSessionImmediate(sessionDbId);

    // Assert: DB row has status = 'completed' and completed_at_epoch is set
    const after = db.prepare('SELECT status, completed_at_epoch FROM sdk_sessions WHERE id = ?').get(sessionDbId) as any;
    expect(after.status).toBe('completed');
    expect(after.completed_at_epoch).toBeGreaterThan(0);
  });

  it('deleteSession handles DB error gracefully', async () => {
    const sessionDbId = createTestSession('sess-db-error-1');

    // Verify session is in memory
    expect(sessionManager.getSession(sessionDbId)).toBeDefined();

    // Close the DB to force errors on subsequent writes
    db.close();

    // deleteSession should NOT throw — DB error is caught, in-memory cleanup still happens
    await sessionManager.deleteSession(sessionDbId);

    // Assert: session is cleaned up from in-memory maps despite DB error
    expect(sessionManager.getSession(sessionDbId)).toBeUndefined();
    expect(sessionManager.getActiveSessionCount()).toBe(0);
  });
});
