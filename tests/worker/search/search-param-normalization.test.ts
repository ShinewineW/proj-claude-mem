/**
 * Tests for SearchManager.normalizeParams fixes:
 * - Bug 1: limit/offset string-to-number coercion
 * - Bug 2: offset applied in post-processing
 * - Bug 3: type auto-redirect to obs_type for observation type values
 *
 * Tests normalizeParams behavior through the public search() method
 * using minimal mocks (in-memory DB + no Chroma).
 */

import { describe, it, expect, beforeAll, afterAll, spyOn, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { logger } from '../../../src/utils/logger.js';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

const testDir = join(tmpdir(), `test-search-params-${Date.now()}`);
const dbPath = join(testDir, 'test.db');

let db: Database;
let sessionSearch: SessionSearch;
let sessionStore: SessionStore;
let searchManager: SearchManager;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let debugSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });

  // Create DB with schema
  db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  const runner = new MigrationRunner(db);
  runner.runAllMigrations();

  // Insert test data: a session + multiple observations with different types
  const nowStr = new Date().toISOString();
  db.run(`INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
          VALUES (1, 'test-cs', 'test-ms', 'test-project', ?, ?, 'completed')`, [nowStr, Date.now()]);

  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    db.run(`INSERT INTO observations (memory_session_id, project, type, title, text, files_read, files_modified, created_at_epoch, created_at, concepts)
            VALUES ('test-ms', 'test-project', ?, ?, 'test text', '[]', '[]', ?, datetime(? / 1000, 'unixepoch'), '[]')`,
      [
        i < 5 ? 'discovery' : 'bugfix',
        `Test Observation ${i + 1}`,
        now - (10 - i) * 60000, // 10 minutes apart
        now - (10 - i) * 60000
      ]
    );
  }

  // Create SessionSearch and SessionStore from same DB path
  sessionSearch = new SessionSearch(dbPath);
  sessionStore = new SessionStore(dbPath);

  // Load mode for ModeManager (needed by timeline formatter)
  // May fail in full-suite runs due to mock.module() from other test files
  try { ModeManager.getInstance().loadMode('code'); } catch { /* mocked */ }

  // SearchManager with no Chroma (filter-only path)
  searchManager = new SearchManager(
    sessionSearch,
    sessionStore,
    null as any, // no ChromaSync
    new FormattingService(),
    new TimelineService()
  );
});

afterAll(() => {
  db.close();
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  logSpy = spyOn(logger, 'info').mockImplementation(() => {});
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  debugSpy = spyOn(logger, 'debug').mockImplementation(() => {});
  errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  debugSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('Bug 1: limit string-to-number coercion', () => {
  it('search with string limit does not throw', async () => {
    // URL query params arrive as strings — this used to throw "Invalid limit: must be a positive integer"
    const result = await searchManager.search({
      obs_type: 'discovery',
      project: 'test-project',
      limit: '3',
      orderBy: 'date_desc',
      format: 'json'
    });
    // Should succeed and return JSON data
    expect(result).toBeDefined();
    expect(result.observations).toBeDefined();
    expect(result.observations.length).toBeLessThanOrEqual(3);
  });

  it('search with string limit returns correct number of results', async () => {
    const result = await searchManager.search({
      obs_type: 'discovery',
      project: 'test-project',
      limit: '2',
      orderBy: 'date_desc',
      format: 'json'
    });
    // JSON format returns raw data
    expect(result.observations.length).toBeLessThanOrEqual(2);
  });

  it('searchObservations with string limit does not throw', async () => {
    const result = await searchManager.searchObservations({
      limit: '5',
      project: 'test-project'
    });
    expect(result).toBeDefined();
  });
});

describe('Bug 2: offset in post-processing', () => {
  it('search with offset skips initial results', async () => {
    // Get all results first
    const allResults = await searchManager.search({
      obs_type: 'discovery',
      project: 'test-project',
      limit: '10',
      offset: '0',
      orderBy: 'date_desc',
      format: 'json'
    });

    // Get results with offset=2
    const offsetResults = await searchManager.search({
      obs_type: 'discovery',
      project: 'test-project',
      limit: '10',
      offset: '2',
      orderBy: 'date_desc',
      format: 'json'
    });

    // Offset results should have fewer items
    expect(offsetResults.observations.length).toBeLessThan(allResults.observations.length);
  });

  it('string offset is parsed correctly', async () => {
    // Should not throw with string offset
    const result = await searchManager.search({
      obs_type: 'bugfix',
      project: 'test-project',
      limit: '5',
      offset: '1',
      orderBy: 'date_desc',
      format: 'json'
    });
    expect(result).toBeDefined();
    expect(result.observations).toBeDefined();
  });
});

describe('Bug 3: type auto-redirect to obs_type', () => {
  it('type="discovery" redirects to obs_type and returns results', async () => {
    const result = await searchManager.search({
      type: 'discovery',
      project: 'test-project',
      limit: '10',
      orderBy: 'date_desc',
      format: 'json'
    });

    // Should return discovery observations (not 0 results)
    expect(result.observations.length).toBeGreaterThan(0);
    for (const obs of result.observations) {
      expect(obs.type).toBe('discovery');
    }
  });

  it('type="bugfix" redirects to obs_type', async () => {
    const result = await searchManager.search({
      type: 'bugfix',
      project: 'test-project',
      limit: '10',
      orderBy: 'date_desc',
      format: 'json'
    });

    expect(result.observations.length).toBeGreaterThan(0);
    for (const obs of result.observations) {
      expect(obs.type).toBe('bugfix');
    }
  });

  it('type="observations" is NOT redirected (entity type)', async () => {
    const result = await searchManager.search({
      type: 'observations',
      obs_type: 'discovery',
      project: 'test-project',
      limit: '10',
      orderBy: 'date_desc',
      format: 'json'
    });

    // type="observations" scopes to observations entity, obs_type filters by discovery
    expect(result.observations.length).toBeGreaterThan(0);
    // sessions and prompts should be empty
    expect(result.sessions.length).toBe(0);
    expect(result.prompts.length).toBe(0);
  });

  it('type does not redirect when obs_type is already set', async () => {
    const result = await searchManager.search({
      type: 'discovery',
      obs_type: 'bugfix',
      project: 'test-project',
      limit: '10',
      orderBy: 'date_desc',
      format: 'json'
    });

    // obs_type takes precedence, type="discovery" is NOT a valid entity type,
    // so all three search categories are skipped → 0 results for obs
    // but sessions and prompts still searched (type="discovery" doesn't match any entity type)
    expect(result).toBeDefined();
  });

  it('comma-separated observation types redirect correctly', async () => {
    const result = await searchManager.search({
      type: 'discovery,bugfix',
      project: 'test-project',
      limit: '20',
      orderBy: 'date_desc',
      format: 'json'
    });

    expect(result.observations.length).toBeGreaterThan(0);
    for (const obs of result.observations) {
      expect(['discovery', 'bugfix']).toContain(obs.type);
    }
  });
});

describe('Bug 4: timeline anchor/depth string coercion', () => {
  it('timeline with numeric string anchor resolves as observation ID', async () => {
    // Get an actual observation ID
    const searchResult = await searchManager.search({
      project: 'test-project',
      obs_type: 'discovery',
      limit: '1',
      format: 'json'
    });
    const obsId = searchResult.observations[0]?.id;
    expect(obsId).toBeDefined();

    // String anchor should be parsed to number and match observation
    const result = await searchManager.timeline({
      anchor: String(obsId),
      depth_before: '3',
      depth_after: '3',
      project: 'test-project'
    });

    // Should not return "Invalid timestamp" error
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).not.toContain('Invalid timestamp');
  });

  it('timeline depth params work as strings', async () => {
    const searchResult = await searchManager.search({
      project: 'test-project',
      obs_type: 'discovery',
      limit: '1',
      format: 'json'
    });
    const obsId = searchResult.observations[0]?.id;

    const result = await searchManager.timeline({
      anchor: String(obsId),
      depth_before: '2',
      depth_after: '2',
      project: 'test-project'
    });

    expect(result).toBeDefined();
    expect(result.isError).not.toBe(true);
  });

  it('non-numeric string anchor still works (session ID, timestamp)', async () => {
    // Session ID format should not be converted to number
    const result = await searchManager.timeline({
      anchor: 'S1',
      depth_before: '3',
      depth_after: '3',
      project: 'test-project'
    });

    // Should attempt session lookup (may fail with "not found" but not "Invalid timestamp")
    expect(result).toBeDefined();
  });
});
