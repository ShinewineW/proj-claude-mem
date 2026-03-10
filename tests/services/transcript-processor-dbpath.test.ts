/**
 * Tests for dbPath threading through TranscriptEventProcessor.
 *
 * Verifies that queueSummary() and updateContext() include dbPath
 * in their HTTP requests for per-project DB isolation.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Track all fetch calls to verify dbPath inclusion
let fetchCalls: Array<{ url: string; body: any }> = [];

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
    if (urlStr.includes('/api/sessions/summarize')) {
      return new Response(JSON.stringify({ status: 'queued' }), { status: 200 });
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
mock.module("../../src/shared/worker-utils.js", () => ({
  ensureWorkerRunning: async () => true,
  getWorkerPort: () => 37777,
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

mock.module("../../src/utils/agents-md-utils.js", () => ({
  writeAgentsMd: () => {},
}));

mock.module("../../src/services/transcripts/config.js", () => ({
  expandHomePath: (p: string) => p,
}));

// Mock handlers that queueSummary/updateContext don't use directly
// but handleSessionEnd calls sessionCompleteHandler
mock.module("../../src/cli/handlers/session-init.js", () => ({
  sessionInitHandler: { execute: async () => {} },
}));
mock.module("../../src/cli/handlers/observation.js", () => ({
  observationHandler: { execute: async () => {} },
}));
mock.module("../../src/cli/handlers/file-edit.js", () => ({
  fileEditHandler: { execute: async () => {} },
}));
mock.module("../../src/cli/handlers/session-complete.js", () => ({
  sessionCompleteHandler: { execute: async () => {} },
}));

describe("TranscriptEventProcessor dbPath threading", () => {
  beforeEach(() => {
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
