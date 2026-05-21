/**
 * TDD RED: DataRoutes allowlist iteration should use direct path.join,
 * NOT resolveProjectDbPath() which has a workspace parent heuristic.
 *
 * Bug: handleGetProjects, handleGetRecent, handleGetStatsTrend call
 * resolveProjectDbPath(projectRoot) when iterating allowlist entries.
 * resolveWorkspaceRoot() in paths.ts redirects DB path to parent when
 * parent has `.claude/` — but allowlist entries are already canonical
 * roots (project-allowlist.ts functions use direct path.join).
 *
 * Expected: getSessionStore called with path.join(projectRoot, '.claude', 'mem.db')
 * Actual (bug): getSessionStore called with resolveProjectDbPath result (may differ)
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_PROJECT_ROOT = '/projects/myapp';
// The CORRECT path: direct join from allowlist entry
const CORRECT_DB_PATH = join(TEST_PROJECT_ROOT, '.claude', 'mem.db');
// The WRONG path: what resolveProjectDbPath returns when workspace heuristic fires
const HEURISTIC_DB_PATH = '/projects/.claude/mem.db';

// ---------------------------------------------------------------------------
// Module-level mocks (must be before any import of production code)
// ---------------------------------------------------------------------------

// Mock paths.js — resolveProjectDbPath returns WRONG path to expose the bug
mock.module('../../src/shared/paths.js', () => ({
  DATA_DIR: '/tmp/test-claude-mem',
  CLAUDE_CONFIG_DIR: '/tmp/test-claude',
  MARKETPLACE_ROOT: '/tmp/test-marketplace',
  ARCHIVES_DIR: '/tmp/test-claude-mem/archives',
  LOGS_DIR: '/tmp/test-claude-mem/logs',
  TRASH_DIR: '/tmp/test-claude-mem/trash',
  BACKUPS_DIR: '/tmp/test-claude-mem/backups',
  MODES_DIR: '/tmp/test-claude-mem/modes',
  USER_SETTINGS_PATH: '/tmp/test-claude-mem/settings.json',
  DB_PATH: '/tmp/test-claude-mem/claude-mem.db',
  VECTOR_DB_DIR: '/tmp/test-claude-mem/vector-db',
  OBSERVER_SESSIONS_DIR: '/tmp/test-claude-mem/observer-sessions',
  CLAUDE_SETTINGS_PATH: '/tmp/test-claude/settings.json',
  CLAUDE_COMMANDS_DIR: '/tmp/test-claude/commands',
  CLAUDE_MD_PATH: '/tmp/test-claude/CLAUDE.md',
  getProjectArchiveDir: (name: string) => `/tmp/test-claude-mem/archives/${name}`,
  getWorkerSocketPath: (id: number) => `/tmp/test-claude-mem/worker-${id}.sock`,
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  ensureModesDir: () => {},
  ensureAllClaudeDirs: () => {},
  getCurrentProjectName: () => 'test-project',
  getPackageRoot: () => '/tmp/test-package',
  getPackageCommandsDir: () => '/tmp/test-package/commands',
  createBackupFilename: (p: string) => `${p}.backup`,
  // KEY: returns a DIFFERENT path than path.join(projectRoot, '.claude', 'mem.db')
  // This simulates resolveWorkspaceRoot redirecting to parent directory
  resolveProjectDbPath: (_cwd?: string) => HEURISTIC_DB_PATH,
  resolveProjectRoot: () => '/tmp/test-project',
  getPackageRoot: () => '/tmp/test-package',
}));

// Mock project-allowlist.js — listEnabledProjects returns our test project
mock.module('../../src/shared/project-allowlist.js', () => ({
  getEnabledProjectsPath: () => '/tmp/test-claude-mem/enabled-projects.json',
  isProjectEnabled: () => true,
  enableProject: () => {},
  disableProject: () => {},
  listEnabledProjects: () => ({ [TEST_PROJECT_ROOT]: { name: 'myapp' } }),
  resolveProjectByName: () => null,
  resolveAllProjectDbPaths: () => [],
  findContainingProject: () => null,
  resolveProjectContext: () => null,
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    success: () => {},
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
  ensureWorkerRunning: async () => true,
  fetchWithTimeout: async (url: string | URL | Request, init?: RequestInit, _timeoutMs?: number) => fetch(url, init),
}));

// ---------------------------------------------------------------------------
// Mock DB that supports prepare().all() / prepare().get()
// ---------------------------------------------------------------------------

function createMockDb() {
  return {
    prepare: mock((_sql: string) => ({
      all: mock((..._args: unknown[]) => []),
      get: mock((..._args: unknown[]) => ({ count: 0 })),
    })),
  };
}

function createMockStore(db: ReturnType<typeof createMockDb>) {
  return { db };
}

// ---------------------------------------------------------------------------
// Mock req/res
// ---------------------------------------------------------------------------

function mockReq(
  { query = {}, body = {}, params = {} }: {
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
  } = {}
) {
  return { query, body, params, path: '/test' } as any;
}

function mockRes() {
  const res: any = { headersSent: false };
  res.json = mock((_data: unknown) => res);
  res.status = mock((_code: number) => res);
  res.send = mock((_body: unknown) => res);
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DataRoutes allowlist iteration uses direct path.join (not resolveProjectDbPath)', () => {
  let mockGetSessionStore: ReturnType<typeof mock>;
  let routeHandlers: Map<string, Function>;

  beforeEach(async () => {
    // Each call to getSessionStore returns a fresh mock store
    const mockDb = createMockDb();
    const store = createMockStore(mockDb);
    mockGetSessionStore = mock((_dbPath?: string) => store);

    const mockDbManager = { getSessionStore: mockGetSessionStore };
    const mockSessionManager = {
      isAnySessionProcessing: mock(() => false),
      getTotalActiveWork: mock(() => 0),
      getActiveSessionCount: mock(() => 0),
      getTotalQueueDepth: mock(() => 0),
      getActiveProjectNames: mock(() => new Set<string>()),
    };
    const mockSseBroadcaster = { getClientCount: mock(() => 0) };
    const mockWorkerService = { broadcastProcessingStatus: mock(() => {}) };
    const mockPaginationHelper = {};

    routeHandlers = new Map();
    const mockApp = {
      get: mock((path: string, handler: Function) => { routeHandlers.set(`GET ${path}`, handler); }),
      post: mock((path: string, handler: Function) => { routeHandlers.set(`POST ${path}`, handler); }),
      delete: mock((path: string, handler: Function) => { routeHandlers.set(`DELETE ${path}`, handler); }),
    } as any;

    const { DataRoutes } = await import('../../src/services/worker/http/routes/DataRoutes.js');
    const dataRoutes = new DataRoutes(
      mockPaginationHelper as any,
      mockDbManager as any,
      mockSessionManager as any,
      mockSseBroadcaster as any,
      mockWorkerService as any,
      Date.now()
    );
    dataRoutes.setupRoutes(mockApp);
  });

  it('handleGetProjects uses direct path.join for allowlist entries, not resolveProjectDbPath', () => {
    // No dbPath query param → triggers allowlist aggregation path
    const handler = routeHandlers.get('GET /api/projects')!;
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    // Find the call that used our project's DB path (skip the global DB call which uses undefined)
    const calls = mockGetSessionStore.mock.calls;
    const projectDbCalls = calls.filter((c: unknown[]) => c[0] !== undefined);

    expect(projectDbCalls.length).toBeGreaterThanOrEqual(1);
    // The handler should use path.join(projectRoot, '.claude', 'mem.db') = CORRECT_DB_PATH
    // NOT resolveProjectDbPath(projectRoot) which returns HEURISTIC_DB_PATH
    expect(projectDbCalls[0][0]).toBe(CORRECT_DB_PATH);
  });

  it('handleGetRecent uses direct path.join for allowlist entries, not resolveProjectDbPath', () => {
    const handler = routeHandlers.get('GET /api/recent')!;
    const req = mockReq({ query: { limit: '10' } });
    const res = mockRes();

    handler(req, res);

    const calls = mockGetSessionStore.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // First call is the project DB — should be direct path, not heuristic
    expect(calls[0][0]).toBe(CORRECT_DB_PATH);
  });

  it('handleGetStatsTrend uses direct path.join for allowlist entries, not resolveProjectDbPath', () => {
    const handler = routeHandlers.get('GET /api/stats/trend')!;
    const req = mockReq({ query: { days: '7' } });
    const res = mockRes();

    handler(req, res);

    const calls = mockGetSessionStore.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // First call is the project DB — should be direct path, not heuristic
    expect(calls[0][0]).toBe(CORRECT_DB_PATH);
  });
});
