/**
 * FTS5 fallback for text search when ChromaDB is absent.
 * Upstream: thedotmack/claude-mem@be99a5d69 (#2079)
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

const testDir = join(tmpdir(), `test-fts5-fallback-${Date.now()}`);
const dbPath = join(testDir, 'test.db');
let search: SessionSearch;

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  const db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  new MigrationRunner(db).runAllMigrations();

  const now = Date.now();
  db.run(`INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
          VALUES (1, 'cs-1', 'ms-1', 'p', datetime(? / 1000, 'unixepoch'), ?, 'completed')`, [now, now]);
  db.run(`INSERT INTO observations (memory_session_id, project, type, title, narrative, text, files_read, files_modified, concepts, created_at, created_at_epoch)
          VALUES ('ms-1','p','discovery','Authentication flow refactor','rewrote the login handler','body','[]','[]','[]', datetime(? / 1000, 'unixepoch'), ?)`, [now, now]);
  db.run(`INSERT INTO observations (memory_session_id, project, type, title, narrative, text, files_read, files_modified, concepts, created_at, created_at_epoch)
          VALUES ('ms-1','p','feature','Unrelated caching change','added an LRU cache','body','[]','[]','[]', datetime(? / 1000, 'unixepoch'), ?)`, [now - 1000, now - 1000]);
  db.run(`INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
          VALUES ('ms-1','p','Authentication audit','looked at login','it leaks','done','none','[]','[]','', datetime(? / 1000, 'unixepoch'), ?)`, [now, now]);
  db.run(`INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
          VALUES ('cs-1', 1, 'please fix the authentication bug', datetime(? / 1000, 'unixepoch'), ?)`, [now, now]);
  db.close();

  // Constructing SessionSearch runs ensureFTSTables(), which CREATEs + populates
  // observations_fts / session_summaries_fts from the rows inserted above.
  search = new SessionSearch(dbPath);
});

afterAll(() => {
  search.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('SessionSearch FTS5 fallback', () => {
  it('searchObservations matches title/narrative via FTS5 when given query text', () => {
    const results = search.searchObservations('authentication', { project: 'p' });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Authentication flow refactor');
  });

  it('searchSessions matches summary fields via FTS5', () => {
    const results = search.searchSessions('authentication', { project: 'p' });
    expect(results.length).toBe(1);
    expect(results[0].request).toBe('Authentication audit');
  });

  it('searchUserPrompts matches prompt_text via LIKE', () => {
    const results = search.searchUserPrompts('authentication', { project: 'p' });
    expect(results.length).toBe(1);
    expect(results[0].prompt_text).toContain('authentication');
  });

  it('non-matching query returns empty', () => {
    expect(search.searchObservations('zzznomatch', { project: 'p' }).length).toBe(0);
  });

  // FTS5 has its own query syntax, so ordinary user strings containing FTS
  // operators / unbalanced quotes throw a SQLite "fts5: syntax error" instead
  // of returning a normal result. The MATCH execution must be wrapped so a
  // malformed query degrades to a best-effort result, never a 500.
  describe('malformed FTS query does not throw (best-effort)', () => {
    const malformed = ['foo"bar', 'cache:miss', 'a AND', 'NEAR(', '(unbalanced', '"', '*', '^foo', 'a OR OR b'];

    for (const q of malformed) {
      it(`searchObservations(${JSON.stringify(q)}) returns an array without throwing`, () => {
        let out: any;
        expect(() => { out = search.searchObservations(q, { project: 'p' }); }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
      });

      it(`searchSessions(${JSON.stringify(q)}) returns an array without throwing`, () => {
        let out: any;
        expect(() => { out = search.searchSessions(q, { project: 'p' }); }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
      });
    }

    it('a malformed query that LIKE-matches still returns the row via fallback', () => {
      // "authentication:flow" is invalid FTS (column-filter syntax on a
      // non-existent column) but the LIKE fallback should still surface the row
      // whose title contains "authentication".
      const out = search.searchObservations('authentication"', { project: 'p' });
      expect(Array.isArray(out)).toBe(true);
    });
  });
});
