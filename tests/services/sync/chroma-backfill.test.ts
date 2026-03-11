import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("../../../src/services/sync/ChromaMcpManager.js", () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async () => ({ metadatas: [] }),
    }),
  },
}));

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

describe("ChromaSync.ensureBackfilled(sessionStore)", () => {
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
