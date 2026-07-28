/**
 * Tests for dbPath threading through TranscriptEventProcessor.
 *
 * Verifies that queueSummary() and updateContext() include dbPath
 * in their HTTP requests for per-project DB isolation.
 */

import { describe, it, expect, beforeEach, afterEach, mock, afterAll } from 'bun:test';

// Track all fetch calls to verify dbPath inclusion
let fetchCalls: Array<{ url: string; body: any }> = [];
let fallbackEntries: any[] = [];
let summarizeStatus = 200;

// Mock fetch globally
const originalFetch = globalThis.fetch;

function mockFetch() {
  fetchCalls = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    let body: any = null;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }
    fetchCalls.push({ url: urlStr, body });

    // Return appropriate mock responses based on URL
    if (urlStr.includes('/api/sessions/resolve-prompt-number')) {
      return new Response(JSON.stringify({ prompt_number: 1 }), { status: 200 });
    }
    if (urlStr.includes('/api/sessions/summarize')) {
      return new Response(JSON.stringify({ status: summarizeStatus === 200 ? 'queued' : 'error' }), { status: summarizeStatus });
    }
    if (urlStr.includes('/api/context/inject')) {
      return new Response('mock context content', { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// Mock dependencies
// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../src/shared/paths.js';
import * as __real1 from '../../src/utils/project-name.js';
import * as __real2 from '../../src/shared/project-allowlist.js';
import * as __real3 from '../../src/utils/project-filter.js';
import * as __real4 from '../../src/shared/SettingsDefaultsManager.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../src/shared/paths.js', { ...__real0 }],
  ['../../src/utils/project-name.js', { ...__real1 }],
  ['../../src/shared/project-allowlist.js', { ...__real2 }],
  ['../../src/utils/project-filter.js', { ...__real3 }],
  ['../../src/shared/SettingsDefaultsManager.js', { ...__real4 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

mock.module("../../src/shared/worker-utils.js", () => ({
  ensureWorkerRunning: async () => true,
  getWorkerPort: () => 37777,
  fetchWithTimeout: async (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
}));

mock.module("../../src/shared/fallback-queue.js", () => ({
  writeFallbackEntry: (entry: any) => {
    fallbackEntries.push(entry);
  },
}));

mock.module("../../src/utils/logger.js", () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    success: () => {},
  },
}));

mock.module("../../src/shared/paths.js", () => ({
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
  resolveProjectDbPath: () => "/test/project/.claude/mem.db",
  resolveProjectRoot: () => "/test/project",
}));

mock.module("../../src/utils/project-name.js", () => ({
  getProjectName: () => "test-project",
  getProjectContext: () => ({
    project: "test-project",
    allProjects: ["test-project"],
  }),
}));

mock.module("../../src/shared/project-allowlist.js", () => ({
  resolveProjectContext: () => ({
    projectRoot: "/test/project",
    dbPath: "/test/project/.claude/mem.db",
    projectName: "test-project",
  }),
  isProjectEnabled: () => true,
  findContainingProject: () => "/test/project",
  listEnabledProjects: () => ({}),
  resolveProjectByName: () => null,
  resolveAllProjectDbPaths: () => [],
  getEnabledProjectsPath: () => '/tmp/test-enabled-projects.json',
  enableProject: () => {},
  disableProject: () => {},
}));

mock.module("../../src/utils/agents-md-utils.js", () => ({
  writeAgentsMd: () => {},
}));

mock.module("../../src/services/transcripts/config.js", () => ({
  expandHomePath: (p: string) => p,
}));

// Mock transitive dependencies of handlers imported by processor.ts
// (session-init, observation, file-edit, session-complete)
// We do NOT mock the handlers themselves to avoid polluting other test files.
mock.module("../../src/utils/project-filter.js", () => ({
  isProjectExcluded: () => false,
}));

mock.module("../../src/shared/SettingsDefaultsManager.js", () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: "" }),
  },
}));

mock.module("../../src/shared/hook-constants.js", () => ({
  HOOK_EXIT_CODES: { SUCCESS: 0, FAILURE: 1, BLOCKING_ERROR: 2, USER_MESSAGE_ONLY: 3 },
  HOOK_TIMEOUTS: { DEFAULT: 30000 },
  getTimeout: (v: number) => v,
}));

describe("TranscriptEventProcessor dbPath threading", () => {
  beforeEach(() => {
    fallbackEntries = [];
    summarizeStatus = 200;
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  describe("queueSummary", () => {
    it("includes dbPath in the POST body to /api/sessions/summarize", async () => {
      const { TranscriptEventProcessor } = await import(
        "../../src/services/transcripts/processor.js"
      );
      const processor = new TranscriptEventProcessor();

      const session = {
        sessionId: "test-session-123",
        cwd: "/test/project",
        lastAssistantMessage: "some response",
        pendingTools: new Map(),
      };

      // Call private method directly
      await (processor as any).queueSummary(session);

      const summarizeRequest = fetchCalls.find(c =>
        c.url.includes("/api/sessions/summarize")
      );
      expect(summarizeRequest).toBeDefined();
      expect(summarizeRequest!.body.dbPath).toBe("/test/project/.claude/mem.db");
    });

    it("writes fallback when /api/sessions/summarize returns non-OK", async () => {
      summarizeStatus = 500;

      const { TranscriptEventProcessor } = await import(
        "../../src/services/transcripts/processor.js"
      );
      const processor = new TranscriptEventProcessor();

      const session = {
        sessionId: "test-session-500",
        cwd: "/test/project",
        lastAssistantMessage: "some response",
        pendingTools: new Map(),
      };

      await (processor as any).queueSummary(session);

      expect(fallbackEntries).toHaveLength(1);
      expect(fallbackEntries[0]).toMatchObject({
        type: "summarize",
        sessionId: "test-session-500",
        dbPath: "/test/project/.claude/mem.db",
      });
    });
  });

  describe("updateContext", () => {
    it("includes dbPath in the GET query params to /api/context/inject", async () => {
      const { TranscriptEventProcessor } = await import(
        "../../src/services/transcripts/processor.js"
      );
      const processor = new TranscriptEventProcessor();

      const session = {
        sessionId: "test-session-456",
        cwd: "/test/project",
        pendingTools: new Map(),
      };

      const watch = {
        name: "test-watch",
        workspace: "/test/project",
        context: {
          mode: "agents" as const,
          path: "/test/project/AGENTS.md",
        },
      };

      // Call private method directly
      await (processor as any).updateContext(session, watch);

      const contextRequest = fetchCalls.find(c =>
        c.url.includes("/api/context/inject")
      );
      expect(contextRequest).toBeDefined();
      expect(contextRequest!.url).toContain(
        "dbPath=" + encodeURIComponent("/test/project/.claude/mem.db")
      );
    });
  });
});
