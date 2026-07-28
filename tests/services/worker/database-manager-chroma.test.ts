import { describe, it, expect, beforeEach, afterEach, mock, afterAll } from 'bun:test';
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Module-level mocks (must be before any import of production code)
// ---------------------------------------------------------------------------

const mockSettings: Record<string, string> = {
  CLAUDE_MEM_CHROMA_ENABLED: 'true',
};
// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../../src/shared/SettingsDefaultsManager.js';
import * as __real1 from '../../../src/shared/paths.js';
import * as __real2 from '../../../src/shared/project-db.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../../src/shared/SettingsDefaultsManager.js', { ...__real0 }],
  ['../../../src/shared/paths.js', { ...__real1 }],
  ['../../../src/shared/project-db.js', { ...__real2 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

mock.module("../../../src/shared/SettingsDefaultsManager.js", () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => mockSettings,
    get: (key: string) => mockSettings[key] || '/tmp/test-claude-mem',
  },
}));

// Mock paths.js
mock.module("../../../src/shared/paths.js", () => ({
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
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  resolveProjectDbPath: () => '/tmp/test-project/.claude/mem.db',
  resolveProjectRoot: () => '/tmp/test-project',
}));

// Mock logger
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

const chromaSyncInstances: any[] = [];
mock.module("../../../src/services/sync/ChromaSync.js", () => ({
  ChromaSync: class MockChromaSync {
    collectionName: string;
    constructor(collectionName: string) {
      this.collectionName = collectionName;
      chromaSyncInstances.push(this);
    }
    async close() {}
  },
}));

// Mock project-db to avoid real SQLite
mock.module("../../../src/shared/project-db.js", () => ({
  DbConnectionPool: class MockPool {
    getStore(dbPath: string) { return { db: {}, close: () => {} }; }
    getSearch(dbPath: string) { return {}; }
    getLastActiveStore() { return null; }
    getLastActiveSearch() { return null; }
    closeAll() {}
  },
}));

describe("DatabaseManager.getChromaSync(dbPath)", () => {
  const testRoot = join(tmpdir(), `claude-mem-dbmgr-chroma-${Date.now()}`);
  let dbManager: any;

  beforeEach(async () => {
    chromaSyncInstances.length = 0;
    mkdirSync(testRoot, { recursive: true });
    for (const proj of ["proj-a", "proj-b"]) {
      mkdirSync(join(testRoot, proj, ".claude"), { recursive: true });
    }
    const { DatabaseManager } = await import("../../../src/services/worker/DatabaseManager.js");
    dbManager = new DatabaseManager();
    await dbManager.initialize(join(testRoot, "proj-a", ".claude", "mem.db"));
  });

  afterEach(async () => {
    await dbManager?.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("returns ChromaSync for a specific dbPath", () => {
    const dbPath = join(testRoot, "proj-b", ".claude", "mem.db");
    const sync = dbManager.getChromaSync(dbPath);
    expect(sync).not.toBeNull();
    expect(sync.collectionName).toMatch(/^cm__proj-b_[a-f0-9]{8}$/);
  });

  it("caches ChromaSync instances for the same dbPath", () => {
    const dbPath = join(testRoot, "proj-b", ".claude", "mem.db");
    const sync1 = dbManager.getChromaSync(dbPath);
    const sync2 = dbManager.getChromaSync(dbPath);
    expect(sync1).toBe(sync2);
  });

  it("returns different instances for different dbPaths", () => {
    const pathA = join(testRoot, "proj-a", ".claude", "mem.db");
    const pathB = join(testRoot, "proj-b", ".claude", "mem.db");
    expect(dbManager.getChromaSync(pathA)).not.toBe(dbManager.getChromaSync(pathB));
  });

  it("falls back to defaultDbPath when no arg provided", () => {
    const sync = dbManager.getChromaSync();
    expect(sync).not.toBeNull();
    expect(sync.collectionName).toMatch(/^cm__proj-a_[a-f0-9]{8}$/);
  });

  it("returns null when Chroma is disabled", async () => {
    mockSettings.CLAUDE_MEM_CHROMA_ENABLED = 'false';
    const { DatabaseManager } = await import("../../../src/services/worker/DatabaseManager.js");
    const mgr = new DatabaseManager();
    await mgr.initialize(join(testRoot, "proj-a", ".claude", "mem.db"));
    expect(mgr.getChromaSync()).toBeNull();
    await mgr.close();
    mockSettings.CLAUDE_MEM_CHROMA_ENABLED = 'true';
  });
});
