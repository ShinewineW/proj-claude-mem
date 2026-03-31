import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

// Module-level mocks (must be before production code imports)
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

// Ghost cleanup pre-check uses existsFn parameter injection (no process-level fs mock needed)
const testExistsFn = () => true; // All test DB paths are in-memory, always "exist"

import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';

/** Create in-memory DB with schema matching migrations */
function createTestDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE sdk_sessions (
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
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
      tool_name TEXT, tool_input TEXT, tool_response TEXT, cwd TEXT,
      last_user_message TEXT, last_assistant_message TEXT, prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at_epoch INTEGER NOT NULL,
      started_processing_at_epoch INTEGER,
      completed_at_epoch INTEGER,
      failed_at_epoch INTEGER,
      FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
    )
  `);
  db.run('CREATE INDEX idx_pending_status ON pending_messages(status)');
  db.run('CREATE INDEX idx_pending_session ON pending_messages(session_db_id)');

  return db;
}

function createFakeStore(db: Database) {
  return {
    db,
    close: () => db.close(),
    getSessionById: (id: number) => db.prepare(
      'SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title FROM sdk_sessions WHERE id = ?'
    ).get(id) || null,
    getPromptNumberFromUserPrompts: () => 0,
    updateMemorySessionId: () => {},
    updateSessionStatus: () => {},
  };
}

function insertSession(db: Database, contentSessionId: string, project: string, startedAtEpoch?: number): number {
  const epoch = startedAtEpoch ?? Date.now();
  const result = db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, ?, 'test', ?, ?, 'active')
  `).run(contentSessionId, project, new Date(epoch).toISOString(), epoch);
  return Number(result.lastInsertRowid);
}

function insertPendingMessage(db: Database, sessionDbId: number, contentSessionId: string, type: string, status: string, processingEpoch?: number) {
  db.prepare(`
    INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch, started_processing_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionDbId, contentSessionId, type, status, Date.now(), processingEpoch ?? null);
}

const dbPath = '/tmp/test-project/.claude/mem.db';

describe('D3: reapStaleSessions pendingCount short-circuit fix', () => {
  let db: Database;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    db = createTestDb();
    const store = createFakeStore(db);
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

  it('reaps session with pending messages when no generator is running', async () => {
    const sessionDbId = insertSession(db, 'test-d3-no-gen', 'TestProject');
    insertPendingMessage(db, sessionDbId, 'test-d3-no-gen', 'observation', 'pending');

    // Initialize in-memory session and make it idle (>15min)
    const session = sessionManager.initializeSession(sessionDbId, 'test prompt', 1, dbPath);
    session.lastGeneratorActivity = Date.now() - 20 * 60 * 1000; // 20 min ago
    session.lastExitWasIdleTimeout = true; // Direct reap path
    // generatorPromise is null by default → no active generator

    const reaped = await sessionManager.reapStaleSessions();
    expect(reaped).toBeGreaterThanOrEqual(1);
  });

  it('still skips session with pending messages when generator IS running', async () => {
    const sessionDbId = insertSession(db, 'test-d3-with-gen', 'TestProject');
    insertPendingMessage(db, sessionDbId, 'test-d3-with-gen', 'observation', 'pending');

    const session = sessionManager.initializeSession(sessionDbId, 'test prompt', 1, dbPath);
    session.lastGeneratorActivity = Date.now() - 20 * 60 * 1000;
    session.generatorPromise = new Promise(() => {}); // Active generator

    const reaped = await sessionManager.reapStaleSessions();
    expect(reaped).toBe(0);
  });
});

describe('D1+D2: cleanupGhostSessionsInDb', () => {
  let db: Database;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    db = createTestDb();
    const store = createFakeStore(db);
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

  it('marks ghost sessions (DB-only, >30min) as failed', () => {
    const oldEpoch = Date.now() - 60 * 60 * 1000; // 1 hour ago
    insertSession(db, 'ghost-1', 'TestProject', oldEpoch);
    // Do NOT initialize in memory — this is a ghost

    sessionManager.cleanupGhostSessionsInDb(new Set([dbPath]), testExistsFn);

    const row = db.prepare('SELECT status FROM sdk_sessions WHERE content_session_id = ?').get('ghost-1') as any;
    expect(row.status).toBe('failed');
  });

  it('does NOT mark in-memory sessions as failed', () => {
    const oldEpoch = Date.now() - 60 * 60 * 1000;
    const sessionDbId = insertSession(db, 'in-memory-1', 'TestProject', oldEpoch);
    sessionManager.initializeSession(sessionDbId, 'prompt', 1, dbPath);

    sessionManager.cleanupGhostSessionsInDb(new Set([dbPath]), testExistsFn);

    const row = db.prepare('SELECT status FROM sdk_sessions WHERE content_session_id = ?').get('in-memory-1') as any;
    expect(row.status).toBe('active');
  });

  it('respects 30-minute threshold (young sessions not touched)', () => {
    const recentEpoch = Date.now() - 10 * 60 * 1000; // 10 min ago
    insertSession(db, 'young-1', 'TestProject', recentEpoch);

    sessionManager.cleanupGhostSessionsInDb(new Set([dbPath]), testExistsFn);

    const row = db.prepare('SELECT status FROM sdk_sessions WHERE content_session_id = ?').get('young-1') as any;
    expect(row.status).toBe('active');
  });

  it('cleans both pending AND processing messages for ghost sessions (SE-5)', () => {
    const oldEpoch = Date.now() - 60 * 60 * 1000;
    const sessionDbId = insertSession(db, 'ghost-msgs', 'TestProject', oldEpoch);
    insertPendingMessage(db, sessionDbId, 'ghost-msgs', 'observation', 'pending');
    insertPendingMessage(db, sessionDbId, 'ghost-msgs', 'summarize', 'processing', Date.now() - 600000);

    sessionManager.cleanupGhostSessionsInDb(new Set([dbPath]), testExistsFn);

    const msgs = db.prepare('SELECT status FROM pending_messages WHERE session_db_id = ?').all(sessionDbId) as any[];
    expect(msgs.every((m: any) => m.status === 'failed')).toBe(true);
  });

  it('resets stuck processing messages across all sessions (D2)', () => {
    const sessionDbId = insertSession(db, 'completed-1', 'TestProject');
    db.prepare('UPDATE sdk_sessions SET status = ? WHERE id = ?').run('completed', sessionDbId);
    const oldProcessingEpoch = Date.now() - 10 * 60 * 1000; // 10 min ago
    insertPendingMessage(db, sessionDbId, 'completed-1', 'summarize', 'processing', oldProcessingEpoch);

    sessionManager.cleanupGhostSessionsInDb(new Set([dbPath]), testExistsFn);

    const msg = db.prepare('SELECT status FROM pending_messages WHERE session_db_id = ?').get(sessionDbId) as any;
    expect(msg.status).toBe('pending');
  });
});
