/**
 * Tests for SessionManager.reapStaleSessions() idle timeout optimization.
 *
 * When a session's generator exits due to idle timeout (CC is gone), the reaper
 * should reap it directly instead of queuing a futile proactive summarize that
 * would spawn an SDK subprocess waiting ~16 min for a dead CC.
 *
 * The `lastExitWasIdleTimeout` flag tracks this state:
 * - Set true when generator exits due to idle timeout
 * - Cleared when new hook observation arrives (CC is alive)
 * - Checked by reaper: if true → reap directly, skip proactive summarize
 */
import { describe, it, expect, beforeEach, afterEach, mock, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Module-level mocks (must be before any import of production code)
// ---------------------------------------------------------------------------

// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../src/shared/paths.js';
import * as __real1 from '../../src/shared/SettingsDefaultsManager.js';
import * as __real2 from '../../src/services/worker/ProcessRegistry.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../src/shared/paths.js', { ...__real0 }],
  ['../../src/shared/SettingsDefaultsManager.js', { ...__real1 }],
  ['../../src/services/worker/ProcessRegistry.js', { ...__real2 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

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

/** Create in-memory DB with real pending_messages schema (matches migration 16 + 20) */
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
      message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      last_user_message TEXT,
      last_assistant_message TEXT,
      prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at_epoch INTEGER NOT NULL,
      started_processing_at_epoch INTEGER,
      completed_at_epoch INTEGER,
      failed_at_epoch INTEGER,
      FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');

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
    updateMemorySessionId: () => {},
    updateSessionStatus: () => {},
  };
}

function insertSession(db: Database, contentSessionId: string, project: string): number {
  const now = new Date();
  const result = db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, ?, 'test prompt', ?, ?, 'active')
  `).run(contentSessionId, project, now.toISOString(), now.getTime());
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager reaper: lastExitWasIdleTimeout', () => {
  const dbPath = '/tmp/test-project/.claude/mem.db';

  let db: Database;
  let store: ReturnType<typeof createFakeStore>;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    db = createTestDb();
    store = createFakeStore(db);

    const mockPool = {
      getStore: () => store,
      getSearch: () => ({ close: () => {} }),
      getLastActiveStore: () => store,
      getLastActiveSearch: () => null,
      closeAll: () => {},
    } as any;

    dbManager = new DatabaseManager(mockPool);
    await dbManager.initialize(dbPath);

    sessionManager = new SessionManager(dbManager);
  });

  afterEach(() => {
    try { db.close(); } catch { /* may already be closed */ }
  });

  it('reaps session with lastExitWasIdleTimeout=true directly (no proactive summarize)', async () => {
    insertSession(db, 'session-idle', 'test-project');
    const session = sessionManager.initializeSession(1, 'test', 1, dbPath);

    // Simulate: generator exited due to idle timeout, CC is gone
    session.generatorPromise = null;
    session.lastExitWasIdleTimeout = true;
    // Make session idle long enough (>15 min)
    session.lastGeneratorActivity = Date.now() - 20 * 60 * 1000;

    // Track if onStartGeneratorCallback is called (should NOT be for direct reap)
    let generatorStarted = false;
    sessionManager.setOnStartGenerator(() => { generatorStarted = true; });

    const reaped = await sessionManager.reapStaleSessions();

    expect(reaped).toBe(1);
    expect(generatorStarted).toBe(false); // No proactive summarize
    expect(sessionManager.getActiveSessionCount()).toBe(0);
  });

  it('queues proactive summarize for idle session WITHOUT lastExitWasIdleTimeout', async () => {
    insertSession(db, 'session-normal', 'test-project');
    const session = sessionManager.initializeSession(1, 'test', 1, dbPath);

    session.generatorPromise = null;
    session.lastExitWasIdleTimeout = false;
    session.lastGeneratorActivity = Date.now() - 20 * 60 * 1000;

    let generatorStarted = false;
    sessionManager.setOnStartGenerator(() => { generatorStarted = true; });

    const reaped = await sessionManager.reapStaleSessions();

    // Post-SummaryLane: reaper enqueues a summarize row for SummaryLane to
    // consume instead of waking the observer generator. session.closing=true
    // so the next reaper cycle routes through finalizeSession.
    expect(generatorStarted).toBe(false);
    expect(session.proactiveSummarizeQueued).toBe(true);
    expect(session.closing).toBe(true);
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM pending_messages WHERE message_type = 'summarize' AND session_db_id = 1`,
    ).get() as { c: number };
    expect(row.c).toBe(1);
    // Session still in memory — final reap happens next cycle via finalizeSession.
    expect(sessionManager.getActiveSessionCount()).toBe(1);
    expect(reaped).toBe(0);
  });

  it('queueObservation clears lastExitWasIdleTimeout flag', () => {
    insertSession(db, 'session-revived', 'test-project');
    const session = sessionManager.initializeSession(1, 'test', 1, dbPath);

    session.lastExitWasIdleTimeout = true;

    // New hook observation arrives — CC is back
    sessionManager.queueObservation(1, {
      tool_name: 'Read',
      tool_input: '/test/file.ts',
      tool_response: 'contents',
      prompt_number: 1,
      cwd: '/test',
    }, dbPath);

    expect(session.lastExitWasIdleTimeout).toBe(false);
  });

  it('queueSummarize clears lastExitWasIdleTimeout flag', () => {
    insertSession(db, 'session-summarize', 'test-project');
    const session = sessionManager.initializeSession(1, 'test', 1, dbPath);

    session.lastExitWasIdleTimeout = true;

    // Stop hook fires summarize
    sessionManager.queueSummarize(
      1,
      { lastAssistantMessage: 'last message', promptNumber: 1, queuedAtEpoch: Date.now() },
      dbPath,
    );

    expect(session.lastExitWasIdleTimeout).toBe(false);
  });

  it('cleared flag allows proactive summarize on next reaper cycle', async () => {
    insertSession(db, 'session-comeback', 'test-project');
    const session = sessionManager.initializeSession(1, 'test', 1, dbPath);

    // Was idle-timed-out, but CC came back with a new observation
    session.lastExitWasIdleTimeout = true;
    sessionManager.queueObservation(1, {
      tool_name: 'Bash',
      tool_input: 'ls',
      tool_response: 'output',
      prompt_number: 1,
      cwd: '/test',
    }, dbPath);

    // Flag cleared
    expect(session.lastExitWasIdleTimeout).toBe(false);

    // Drain pending message so reaper can evaluate the session
    db.run("DELETE FROM pending_messages WHERE session_db_id = 1");

    // Now CC exits again, generator idle-times-out
    session.generatorPromise = null;
    session.lastGeneratorActivity = Date.now() - 20 * 60 * 1000;
    // Flag is NOT set here (would be set by worker-service.ts finally block in production)

    let generatorStarted = false;
    sessionManager.setOnStartGenerator(() => { generatorStarted = true; });

    const reaped = await sessionManager.reapStaleSessions();

    // Should get proactive summarize (flag is false → normal path).
    // SummaryLane consumes the row; the observer generator stays asleep.
    expect(reaped).toBe(0);
    expect(generatorStarted).toBe(false);
    expect(session.proactiveSummarizeQueued).toBe(true);
    expect(session.closing).toBe(true);
  });
});
