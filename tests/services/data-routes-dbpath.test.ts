/**
 * Tests that DataRoutes handlers pass dbPath to getSessionStore().
 *
 * Verifies fix for 4 handlers that previously called getSessionStore()
 * without dbPath, falling back to global DB instead of per-project DB.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Module-level mocks (must be before any import of production code)
// ---------------------------------------------------------------------------

// Mock paths.js with ALL exports to prevent cross-test contamination
// (bun:test mock.module is global and persists across test files)
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
  resolveProjectDbPath: () => '/tmp/test-project/.claude/mem.db',
  resolveProjectRoot: () => '/tmp/test-project',
}));

// Mock logger to prevent real logging (must include all methods used by BaseRouteHandler etc.)
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

// Mock worker-utils
mock.module('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
  ensureWorkerRunning: async () => true,
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock store returned by getSessionStore
function createMockStore() {
  return {
    db: {}, // Needed by PendingMessageStore constructor
    getObservationById: mock(() => ({ id: 1, title: 'test' })),
    getSessionSummariesByIds: mock(() => [{ id: 1 }]),
    getSdkSessionsBySessionIds: mock(() => [{ id: 's1' }]),
    getUserPromptsByIds: mock(() => [{ id: 1, text: 'test' }]),
    importSdkSession: mock(() => ({ imported: true })),
    importSessionSummary: mock(() => ({ imported: true })),
    importObservation: mock(() => ({ imported: true })),
    importUserPrompt: mock(() => ({ imported: true })),
  };
}

// Mock req/res factories
function mockReq(
  { query = {}, body = {}, params = {} }: { query?: Record<string, string>; body?: Record<string, unknown>; params?: Record<string, string> } = {}
) {
  return { query, body, params, path: '/test' } as any;
}

function mockRes() {
  const res: any = { headersSent: false };
  res.json = mock(() => res);
  res.status = mock(() => res);
  res.send = mock(() => res);
  return res;
}

// ---------------------------------------------------------------------------
// We test each handler by instantiating DataRoutes with mocks, then calling
// the handler via the express app mock that captures registered routes.
// ---------------------------------------------------------------------------

describe('DataRoutes dbPath propagation', () => {
  let mockGetSessionStore: ReturnType<typeof mock>;
  let mockStore: ReturnType<typeof createMockStore>;
  let routeHandlers: Map<string, Function>;

  beforeEach(async () => {
    mockStore = createMockStore();
    mockGetSessionStore = mock(() => mockStore);

    const mockDbManager = { getSessionStore: mockGetSessionStore };
    const mockSessionManager = {
      isAnySessionProcessing: mock(() => false),
      getTotalActiveWork: mock(() => 0),
      getActiveSessionCount: mock(() => 0),
      getTotalQueueDepth: mock(() => 0),
    };
    const mockSseBroadcaster = { getClientCount: mock(() => 0) };
    const mockWorkerService = { broadcastProcessingStatus: mock(() => {}) };
    const mockPaginationHelper = {};

    // Capture route handlers registered by setupRoutes
    routeHandlers = new Map();
    const mockApp = {
      get: mock((path: string, handler: Function) => { routeHandlers.set(`GET ${path}`, handler); }),
      post: mock((path: string, handler: Function) => { routeHandlers.set(`POST ${path}`, handler); }),
      delete: mock((path: string, handler: Function) => { routeHandlers.set(`DELETE ${path}`, handler); }),
    } as any;

    // Dynamically import to avoid module-level side effects
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

  const TEST_DB_PATH = '/projects/myapp/.claude/mem.db';

  it('handleGetObservationById passes dbPath from query param', () => {
    const handler = routeHandlers.get('GET /api/observation/:id')!;
    const req = mockReq({ query: { dbPath: TEST_DB_PATH }, params: { id: '42' } });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(TEST_DB_PATH);
  });

  it('handleGetSessionById passes dbPath from query param', () => {
    const handler = routeHandlers.get('GET /api/session/:id')!;
    const req = mockReq({ query: { dbPath: TEST_DB_PATH }, params: { id: '7' } });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(TEST_DB_PATH);
  });

  it('handleGetSdkSessionsByIds passes dbPath from POST body', () => {
    const handler = routeHandlers.get('POST /api/sdk-sessions/batch')!;
    const req = mockReq({ body: { memorySessionIds: ['s1'], dbPath: TEST_DB_PATH } });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(TEST_DB_PATH);
  });

  it('handleGetPromptById passes dbPath from query param', () => {
    const handler = routeHandlers.get('GET /api/prompt/:id')!;
    const req = mockReq({ query: { dbPath: TEST_DB_PATH }, params: { id: '99' } });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(TEST_DB_PATH);
  });

  it('handleGetObservationById falls back to undefined when no dbPath', () => {
    const handler = routeHandlers.get('GET /api/observation/:id')!;
    const req = mockReq({ params: { id: '42' } });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(undefined);
  });

  it('handleImport passes dbPath from POST body', () => {
    const handler = routeHandlers.get('POST /api/import')!;
    const req = mockReq({
      body: {
        dbPath: TEST_DB_PATH,
        sessions: [{ id: 's1' }],
        summaries: [],
        observations: [],
        prompts: [],
      },
    });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(TEST_DB_PATH);
  });

  it('handleGetPendingQueue passes dbPath from query param', () => {
    const handler = routeHandlers.get('GET /api/pending-queue')!;
    const req = mockReq({ query: { dbPath: TEST_DB_PATH } });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(TEST_DB_PATH);
  });

  it('handleClearFailedQueue passes dbPath from query param', () => {
    const handler = routeHandlers.get('DELETE /api/pending-queue/failed')!;
    const req = mockReq({ query: { dbPath: TEST_DB_PATH } });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(TEST_DB_PATH);
  });

  it('handleClearAllQueue passes dbPath from query param', () => {
    const handler = routeHandlers.get('DELETE /api/pending-queue/all')!;
    const req = mockReq({ query: { dbPath: TEST_DB_PATH } });
    const res = mockRes();

    handler(req, res);

    expect(mockGetSessionStore).toHaveBeenCalledWith(TEST_DB_PATH);
  });
});
