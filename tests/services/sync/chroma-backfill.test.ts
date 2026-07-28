import { describe, it, expect, mock, beforeEach, afterEach, spyOn, afterAll } from 'bun:test';

// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../../src/shared/project-allowlist.js';
import * as __real1 from '../../../src/shared/paths.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../../src/shared/project-allowlist.js', { ...__real0 }],
  ['../../../src/shared/paths.js', { ...__real1 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

mock.module("../../../src/utils/logger.js", () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    success: () => {},
  },
}));

mock.module("../../../src/services/sqlite/SessionStore.js", () => ({
  SessionStore: class MockSessionStore {
    db = { prepare: () => ({ all: () => [], get: () => ({ count: 0 }) }) };
    close() {}
  },
}));

const mockProjects: Record<string, { enabledAt: string }> = {};
mock.module("../../../src/shared/project-allowlist.js", () => ({
  listEnabledProjects: () => ({ ...mockProjects }),
}));

const mockDbPaths: Record<string, string> = {};
mock.module("../../../src/shared/paths.js", () => ({
  resolveProjectDbPath: (cwd: string) => mockDbPaths[cwd] || `/mock/${cwd}/.claude/mem.db`,
  USER_SETTINGS_PATH: "/mock/settings.json",
  DATA_DIR: '/tmp/test-claude-mem',
}));

import { ChromaMcpManager } from "../../../src/services/sync/ChromaMcpManager.js";

describe("ChromaSync.ensureBackfilled(sessionStore)", () => {
  beforeEach(() => {
    spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({ callTool: async () => ({ metadatas: [] }) } as any);
  });

  afterEach(() => {
    mock.restore();
  });

  it("reads from the injected SessionStore, not global DB", async () => {
    const { ChromaSync } = await import("../../../src/services/sync/ChromaSync.js");
    const sync = new ChromaSync("cm__test_12345678");

    const queriedTables: string[] = [];
    const mockDb = {
      prepare: (sql: string) => {
        queriedTables.push(sql);
        return { all: () => [], get: () => ({ count: 0 }) };
      },
    };
    const mockStore = { db: mockDb, close: () => {} } as any;

    await sync.ensureBackfilled(mockStore);
    expect(queriedTables.length).toBeGreaterThan(0);
    expect(queriedTables.some(q => q.includes("observations"))).toBe(true);
  });
});

describe("ChromaSync.backfillAllProjects(dbManager)", () => {
  beforeEach(() => {
    Object.keys(mockProjects).forEach(k => delete mockProjects[k]);
    Object.keys(mockDbPaths).forEach(k => delete mockDbPaths[k]);
    spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({ callTool: async () => ({ metadatas: [] }) } as any);
  });

  afterEach(() => {
    mock.restore();
  });

  it("iterates projects from allowlist", async () => {
    const { ChromaSync } = await import("../../../src/services/sync/ChromaSync.js");

    mockProjects["/home/user/projA"] = { enabledAt: "2026-01-01T00:00:00Z" };
    mockProjects["/home/user/projB"] = { enabledAt: "2026-01-02T00:00:00Z" };
    mockDbPaths["/home/user/projA"] = "/home/user/projA/.claude/mem.db";
    mockDbPaths["/home/user/projB"] = "/home/user/projB/.claude/mem.db";

    const calls: string[] = [];
    const mockDbManager = {
      getChromaSync: (dbPath: string) => {
        calls.push(dbPath);
        return new ChromaSync(`cm__mock_${dbPath.slice(-10)}`);
      },
      getSessionStore: (dbPath: string) => ({
        db: { prepare: () => ({ all: () => [], get: () => ({ count: 0 }) }) },
      }),
    } as any;

    await ChromaSync.backfillAllProjects(mockDbManager);
    expect(calls).toContain("/home/user/projA/.claude/mem.db");
    expect(calls).toContain("/home/user/projB/.claude/mem.db");
  });

  it("continues to next project if one fails", async () => {
    const { ChromaSync } = await import("../../../src/services/sync/ChromaSync.js");

    mockProjects["/home/user/good"] = { enabledAt: "2026-01-01T00:00:00Z" };
    mockProjects["/home/user/bad"] = { enabledAt: "2026-01-02T00:00:00Z" };
    mockDbPaths["/home/user/good"] = "/home/user/good/.claude/mem.db";
    mockDbPaths["/home/user/bad"] = "/home/user/bad/.claude/mem.db";

    let goodCalled = false;
    const mockDbManager = {
      getChromaSync: (dbPath: string) => {
        if (dbPath.includes("bad")) return null;
        return new ChromaSync(`cm__mock_good`);
      },
      getSessionStore: (dbPath: string) => {
        if (dbPath.includes("good")) goodCalled = true;
        return { db: { prepare: () => ({ all: () => [], get: () => ({ count: 0 }) }) } };
      },
    } as any;

    await ChromaSync.backfillAllProjects(mockDbManager);
    expect(goodCalled).toBe(true);
  });
});
