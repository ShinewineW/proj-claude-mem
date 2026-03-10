/**
 * Tests that MemoryRoutes.handleSaveMemory passes dbPath from request body
 * to DatabaseManager.getSessionStore(), ensuring manual memories are saved
 * to the correct per-project database.
 */

import { describe, test, expect, mock } from 'bun:test';
import { MemoryRoutes } from '../../src/services/worker/http/routes/MemoryRoutes.js';

describe('MemoryRoutes dbPath threading', () => {
  function createMocks(dbPath?: string) {
    const mockStore = {
      getOrCreateManualSession: mock(() => 42),
      storeObservation: mock(() => ({ id: 1, createdAtEpoch: Date.now() })),
    };

    const mockChromaSync = {
      syncObservation: mock(() => Promise.resolve()),
    };

    const getSessionStoreSpy = mock((path?: string) => mockStore);
    const getChromaSyncSpy = mock(() => mockChromaSync);

    const mockDbManager = {
      getSessionStore: getSessionStoreSpy,
      getChromaSync: getChromaSyncSpy,
    } as any;

    const req = {
      body: {
        text: 'test memory content',
        ...(dbPath !== undefined && { dbPath }),
      },
      path: '/api/memory/save',
    } as any;

    const resJsonMock = mock(() => {});
    const res = {
      json: resJsonMock,
      status: mock(() => ({ json: mock(() => {}) })),
      headersSent: false,
    } as any;

    return { mockDbManager, mockStore, mockChromaSync, getSessionStoreSpy, req, res, resJsonMock };
  }

  test('passes dbPath from request body to getSessionStore', async () => {
    const testDbPath = '/projects/myrepo/.claude/mem.db';
    const { mockDbManager, getSessionStoreSpy, req, res } = createMocks(testDbPath);

    const routes = new MemoryRoutes(mockDbManager, 'default-project');

    // handleSaveMemory is a private arrow property wrapped by wrapHandler.
    // Access it via setupRoutes: capture the registered handler.
    const handlers: Record<string, Function> = {};
    const fakeApp = {
      post: (path: string, handler: Function) => { handlers[path] = handler; },
    } as any;
    routes.setupRoutes(fakeApp);

    const handler = handlers['/api/memory/save'];
    expect(handler).toBeDefined();

    // wrapHandler wraps the async handler; call and await any promise
    await handler(req, res);

    // Key assertion: getSessionStore must be called with the dbPath
    expect(getSessionStoreSpy).toHaveBeenCalledTimes(1);
    expect(getSessionStoreSpy.mock.calls[0][0]).toBe(testDbPath);
  });

  test('calls getSessionStore without dbPath when body has no dbPath', async () => {
    const { mockDbManager, getSessionStoreSpy, req, res } = createMocks();

    const routes = new MemoryRoutes(mockDbManager, 'default-project');

    const handlers: Record<string, Function> = {};
    const fakeApp = {
      post: (path: string, handler: Function) => { handlers[path] = handler; },
    } as any;
    routes.setupRoutes(fakeApp);

    await handlers['/api/memory/save'](req, res);

    expect(getSessionStoreSpy).toHaveBeenCalledTimes(1);
    // When no dbPath in body, should be called with undefined
    expect(getSessionStoreSpy.mock.calls[0][0]).toBeUndefined();
  });
});
