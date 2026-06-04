/**
 * Tests for SearchManager.normalizeParams fixes:
 * - Bug 1: limit/offset string-to-number coercion
 * - Bug 2: offset applied in post-processing
 * - Bug 3: type auto-redirect to obs_type for observation type values
 *
 * Tests normalizeParams behavior through the public search() method
 * using minimal mocks (in-memory DB + no Chroma).
 */

import { describe, it, expect, beforeAll, afterAll, spyOn, beforeEach, afterEach, mock } from 'bun:test';

// ModeManager mock MUST be before imports — other test files mock it with incomplete stubs
// (missing getTypeIcon), and mock.module() is process-level. Providing a complete stub here
// ensures FormattingService/SearchManager don't crash on getTypeIcon() in full-suite runs.
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        observation_types: [
          { id: 'discovery' }, { id: 'bugfix' }, { id: 'feature' },
          { id: 'change' }, { id: 'refactor' }, { id: 'decision' }
        ],
      }),
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = {
          discovery: '🔵', bugfix: '🔴', feature: '🟣',
          change: '✅', refactor: '🔄', decision: '⚖️'
        };
        return icons[type] || '📌';
      },
      loadMode: () => {},
    }),
  },
}));

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

  db.run('PRAGMA foreign_keys = ON');

  // Insert matching sdk_sessions for summary FKs, then session summaries
  for (let i = 0; i < 5; i++) {
    const epoch = now - (10 - i) * 60000;
    db.run(`INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
            VALUES (?, ?, 'test-project', datetime(? / 1000, 'unixepoch'), ?, 'completed')`,
      [`test-cs-s${i}`, `test-ms-summary-${i}`, epoch, epoch]
    );
    db.run(`INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
            VALUES (?, 'test-project', ?, 'investigated text', 'learned text', 'completed text', 'next steps', '[]', '[]', '', datetime(? / 1000, 'unixepoch'), ?)`,
      [
        `test-ms-summary-${i}`,
        `Test Summary ${i + 1}`,
        epoch,
        epoch
      ]
    );
  }

  // Insert user prompts with different timestamps
  for (let i = 0; i < 5; i++) {
    const epoch = now - (10 - i) * 60000;
    db.run(`INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
            VALUES ('test-cs', ?, ?, datetime(? / 1000, 'unixepoch'), ?)`,
      [i + 1, `Test Prompt ${i + 1}`, epoch, epoch]
    );
  }

  // Create SessionSearch and SessionStore from same DB path
  sessionSearch = new SessionSearch(dbPath);
  sessionStore = new SessionStore(dbPath);

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

describe('P0: dateStart/dateEnd epoch coercion', () => {
  it('epoch string dateStart filters correctly', async () => {
    // Get all observations to find a valid epoch range
    const all = await searchManager.search({
      project: 'test-project',
      limit: '100',
      format: 'json'
    });
    expect(all.observations.length).toBeGreaterThan(0);

    // Use earliest observation epoch - 1ms as dateStart (should return all)
    const earliestEpoch = Math.min(...all.observations.map((o: any) => o.created_at_epoch));
    const result = await searchManager.search({
      project: 'test-project',
      dateStart: String(earliestEpoch - 1),
      limit: '100',
      format: 'json'
    });
    // Before fix: NaN comparison → 0 results. After fix: returns all.
    expect(result.observations.length).toBe(all.observations.length);
  });

  it('ISO string dateStart still works', async () => {
    // ISO string should NOT be converted to number (Number("2020-01-01") = NaN, keeps as string)
    const result = await searchManager.search({
      project: 'test-project',
      dateStart: '2020-01-01',
      limit: '100',
      format: 'json'
    });
    // Should return results (all test data is after 2020)
    expect(result.observations.length).toBeGreaterThan(0);
  });

  it('epoch string dateEnd filters correctly', async () => {
    const all = await searchManager.search({
      project: 'test-project',
      limit: '100',
      format: 'json'
    });
    const latestEpoch = Math.max(...all.observations.map((o: any) => o.created_at_epoch));

    // dateEnd = earliest epoch → should return only the earliest observation
    const earliestEpoch = Math.min(...all.observations.map((o: any) => o.created_at_epoch));
    const result = await searchManager.search({
      project: 'test-project',
      dateEnd: String(earliestEpoch),
      limit: '100',
      format: 'json'
    });
    expect(result.observations.length).toBeLessThan(all.observations.length);
    expect(result.observations.length).toBeGreaterThanOrEqual(1);
  });
});

describe('P3: unified pagination — no double-offset', () => {
  it('filter-only offset does not double-apply', async () => {
    // Get all results (no offset)
    const all = await searchManager.search({
      project: 'test-project',
      limit: '100',
      offset: '0',
      orderBy: 'date_desc',
      format: 'json'
    });
    const totalCount = all.observations.length;
    expect(totalCount).toBeGreaterThanOrEqual(5); // We have 10 test observations

    // Offset=2 should skip exactly 2
    const offset2 = await searchManager.search({
      project: 'test-project',
      limit: '100',
      offset: '2',
      orderBy: 'date_desc',
      format: 'json'
    });
    expect(offset2.observations.length).toBe(totalCount - 2);

    // Offset=5 should skip exactly 5
    const offset5 = await searchManager.search({
      project: 'test-project',
      limit: '100',
      offset: '5',
      orderBy: 'date_desc',
      format: 'json'
    });
    expect(offset5.observations.length).toBe(totalCount - 5);
  });

  it('json and text format return same data for same offset+limit', async () => {
    const jsonResult = await searchManager.search({
      project: 'test-project',
      limit: '3',
      offset: '2',
      orderBy: 'date_desc',
      format: 'json'
    });

    const textResult = await searchManager.search({
      project: 'test-project',
      limit: '3',
      offset: '2',
      orderBy: 'date_desc'
      // no format → text
    });

    // json should have 3 observations (offset=2, limit=3 from 10 total)
    expect(jsonResult.observations.length).toBe(3);

    // text result should mention the same observation titles
    const textContent = textResult.content?.[0]?.text || '';
    for (const obs of jsonResult.observations) {
      expect(textContent).toContain(obs.title);
    }
  });

  it('offset+limit pagination returns correct window', async () => {
    // Get observations sorted by date_desc, check offset=0 limit=3 vs offset=3 limit=3
    const page1 = await searchManager.search({
      project: 'test-project',
      limit: '3',
      offset: '0',
      orderBy: 'date_desc',
      format: 'json'
    });
    const page2 = await searchManager.search({
      project: 'test-project',
      limit: '3',
      offset: '3',
      orderBy: 'date_desc',
      format: 'json'
    });

    expect(page1.observations.length).toBe(3);
    expect(page2.observations.length).toBe(3);

    // No overlap between pages
    const page1Ids = page1.observations.map((o: any) => o.id);
    const page2Ids = page2.observations.map((o: any) => o.id);
    for (const id of page1Ids) {
      expect(page2Ids).not.toContain(id);
    }
  });

  it('json format returns structured empty response on zero results', async () => {
    // Query with impossible filter — should return structured json, not text "No results found"
    const result = await searchManager.search({
      project: 'nonexistent-project-xyz',
      limit: '10',
      format: 'json'
    });
    expect(result).toEqual({
      observations: [],
      sessions: [],
      prompts: [],
      totalResults: 0,
      query: ''
    });
  });

  it('multi-type pagination returns all entity types with correct offset', async () => {
    // Query all types (no type filter) — should return observations + sessions + prompts
    const all = await searchManager.search({
      project: 'test-project',
      limit: '100',
      offset: '0',
      orderBy: 'date_desc',
      format: 'json'
    });

    // Verify all three entity types are present (from Step 0 test data)
    expect(all.observations.length).toBeGreaterThan(0);
    expect(all.sessions.length).toBeGreaterThan(0);
    expect(all.prompts.length).toBeGreaterThan(0);
    const totalAll = all.observations.length + all.sessions.length + all.prompts.length;
    expect(all.totalResults).toBe(totalAll);

    // With offset, total count should be consistent but returned items fewer
    const withOffset = await searchManager.search({
      project: 'test-project',
      limit: '100',
      offset: '5',
      orderBy: 'date_desc',
      format: 'json'
    });
    const returnedWithOffset = withOffset.observations.length + withOffset.sessions.length + withOffset.prompts.length;
    expect(returnedWithOffset).toBe(totalAll - 5);
    // totalResults should still reflect the unsliced count
    expect(withOffset.totalResults).toBe(totalAll);
  });

  it('Chroma query path applies unified offset+limit for json results', async () => {
    // Build expected ordering from real observation data
    const all = await searchManager.search({
      project: 'test-project',
      limit: '100',
      orderBy: 'date_desc',
      format: 'json'
    });
    const seed = all.observations.slice(0, 6);
    expect(seed.length).toBe(6);

    // Mock Chroma to return those 6 observation IDs in ranked order
    const chromaManager = new SearchManager(
      sessionSearch,
      sessionStore,
      {
        queryChroma: async () => ({
          ids: seed.map((o: any) => o.id),
          distances: seed.map((_o: any, i: number) => i / 100),
          metadatas: seed.map((o: any) => ({
            doc_type: 'observation',
            created_at_epoch: o.created_at_epoch
          }))
        })
      } as any,
      new FormattingService(),
      new TimelineService()
    );

    const result = await chromaManager.search({
      query: 'semantic test query',
      project: 'test-project',
      limit: '3',
      offset: '2',
      orderBy: 'date_desc',
      format: 'json'
    });

    expect(result.observations.length).toBe(3);
    expect(result.sessions.length).toBe(0);
    expect(result.prompts.length).toBe(0);
    expect(result.observations.map((o: any) => o.title)).toEqual(
      seed.slice(2, 5).map((o: any) => o.title)
    );
  });

  it('Chroma path preserves semantic rank order when orderBy is default (relevance)', async () => {
    // Build date_desc baseline to obtain real observation IDs
    const all = await searchManager.search({
      project: 'test-project',
      limit: '100',
      orderBy: 'date_desc',
      format: 'json'
    });
    const seed = all.observations.slice(0, 5);
    expect(seed.length).toBe(5);

    // Chroma returns IDs in REVERSED date order — i.e. relevance != date order.
    const rankedSeed = [...seed].reverse();

    const relevanceManager = new SearchManager(
      sessionSearch,
      sessionStore,
      {
        queryChroma: async () => ({
          ids: rankedSeed.map((o: any) => o.id),
          distances: rankedSeed.map((_o: any, i: number) => i / 100),
          metadatas: rankedSeed.map((o: any) => ({
            doc_type: 'observation',
            created_at_epoch: o.created_at_epoch
          }))
        })
      } as any,
      new FormattingService(),
      new TimelineService()
    );

    // No orderBy → default relevance: output must echo Chroma rank order, NOT date order.
    const result = await relevanceManager.search({
      query: 'semantic test query',
      project: 'test-project',
      limit: '10',
      format: 'json'
    });

    expect(result.observations.map((o: any) => o.id)).toEqual(
      rankedSeed.map((o: any) => o.id)
    );
  });
});
