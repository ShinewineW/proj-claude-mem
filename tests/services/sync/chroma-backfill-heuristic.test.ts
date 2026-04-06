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

import { describe, it, expect, mock, beforeEach } from 'bun:test';
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

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async () => ({ metadatas: [] }),
    }),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChromaSync.backfillAllProjects uses direct path.join (not resolveProjectDbPath)', () => {
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
