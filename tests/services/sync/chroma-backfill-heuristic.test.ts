/**
 * TDD RED: ChromaSync.backfillAllProjects should use direct path.join
 * for allowlist entries, NOT resolveProjectDbPath() which has a
 * workspace parent heuristic.
 *
 * Same bug pattern as DataRoutes: iterates listEnabledProjects(),
 * calls resolveProjectDbPath(projectRoot), but allowlist entries
 * are already canonical roots.
 *
 * The existing chroma-backfill.test.ts masks this by manually configuring
 * mockDbPaths to return the "correct" answer — the mock acts as the fix.
 * This test exposes the real behavior by making resolveProjectDbPath
 * return a DIFFERENT path (simulating the workspace parent heuristic).
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn, afterAll } from 'bun:test';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_PROJECT_ROOT = '/workspace/my-project';
const CORRECT_DB_PATH = join(TEST_PROJECT_ROOT, '.claude', 'mem.db');
// Simulates resolveWorkspaceRoot redirecting to parent
const HEURISTIC_DB_PATH = '/workspace/.claude/mem.db';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../../src/shared/paths.js';
import * as __real1 from '../../../src/shared/project-allowlist.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../../src/shared/paths.js', { ...__real0 }],
  ['../../../src/shared/project-allowlist.js', { ...__real1 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    success: () => {},
  },
}));

mock.module('../../../src/services/sqlite/SessionStore.js', () => ({
  SessionStore: class MockSessionStore {
    db = { prepare: () => ({ all: () => [], get: () => ({ count: 0 }) }) };
    close() {}
  },
}));

// KEY: resolveProjectDbPath returns WRONG path (heuristic redirects to parent)
mock.module('../../../src/shared/paths.js', () => ({
  resolveProjectDbPath: (_cwd?: string) => HEURISTIC_DB_PATH,
  USER_SETTINGS_PATH: '/tmp/test-settings.json',
  DATA_DIR: '/tmp/test-claude-mem',
}));

mock.module('../../../src/shared/project-allowlist.js', () => ({
  listEnabledProjects: () => ({ [TEST_PROJECT_ROOT]: { enabledAt: '2026-01-01T00:00:00Z' } }),
}));

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChromaSync.backfillAllProjects uses direct path.join (not resolveProjectDbPath)', () => {
  beforeEach(() => {
    spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({ callTool: async () => ({ metadatas: [] }) } as any);
  });

  afterEach(() => {
    mock.restore();
  });

  it('passes path.join(projectRoot, .claude, mem.db) to dbManager, not resolveProjectDbPath result', async () => {
    const { ChromaSync } = await import('../../../src/services/sync/ChromaSync.js');

    const chromaSyncCalls: string[] = [];
    const sessionStoreCalls: string[] = [];

    const mockDbManager = {
      getChromaSync: (dbPath: string) => {
        chromaSyncCalls.push(dbPath);
        return new ChromaSync(`cm__mock_test`);
      },
      getSessionStore: (dbPath: string) => {
        sessionStoreCalls.push(dbPath);
        return {
          db: { prepare: () => ({ all: () => [], get: () => ({ count: 0 }) }) },
        };
      },
    } as any;

    await ChromaSync.backfillAllProjects(mockDbManager);

    // Both should receive the CORRECT direct path, not the heuristic-resolved one
    expect(chromaSyncCalls.length).toBe(1);
    expect(chromaSyncCalls[0]).toBe(CORRECT_DB_PATH);

    expect(sessionStoreCalls.length).toBe(1);
    expect(sessionStoreCalls[0]).toBe(CORRECT_DB_PATH);
  });
});
