/**
 * Tests for dbPath threading through CLI handlers.
 *
 * Verifies that ALL HTTP requests from CLI handlers include
 * the dbPath parameter for per-project DB isolation.
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
    if (urlStr.includes('/api/sessions/init')) {
      return new Response(JSON.stringify({
        sessionDbId: 1,
        promptNumber: 1,
        skipped: false,
        contextInjected: false
      }), { status: 200 });
    }
    if (urlStr.includes('/sessions/') && urlStr.includes('/init')) {
      return new Response(JSON.stringify({ status: 'initialized', sessionDbId: 1 }), { status: 200 });
    }
    if (urlStr.includes('/api/sessions/observations')) {
      return new Response(JSON.stringify({ status: 'queued' }), { status: 200 });
    }
    // Default: health/version checks
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// Mock dependencies
mock.module("../../../src/shared/worker-utils.js", () => ({
  ensureWorkerRunning: async () => true,
  getWorkerPort: () => 37777,
}));

mock.module("../../../src/utils/project-name.js", () => ({
  getProjectName: () => "test-project",
}));

mock.module("../../../src/utils/logger.js", () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    dataIn: () => {},
    failure: () => {},
    formatTool: (name: string) => name,
  },
}));

mock.module("../../../src/shared/paths.js", () => ({
  resolveProjectDbPath: () => "/test/project/.claude/mem.db",
  USER_SETTINGS_PATH: "/tmp/test-settings.json",
}));

mock.module("../../../src/shared/SettingsDefaultsManager.js", () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: "" }),
  },
}));

mock.module("../../../src/utils/project-filter.js", () => ({
  isProjectExcluded: () => false,
}));

mock.module("../../../src/shared/hook-constants.js", () => ({
  HOOK_EXIT_CODES: { SUCCESS: 0, NON_BLOCKING_ERROR: 1, BLOCKING_ERROR: 2 },
}));

describe("dbPath threading in CLI handlers", () => {
  beforeEach(() => {
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  describe("session-init handler", () => {
    it("includes dbPath in BOTH /api/sessions/init and /sessions/{id}/init requests", async () => {
      const { sessionInitHandler } = await import("../../../src/cli/handlers/session-init.js");

      await sessionInitHandler.execute({
        sessionId: "test-session-123",
        cwd: "/test/project",
        prompt: "hello world",
        platform: "claude-code",
      } as any);

      // First request: /api/sessions/init
      const initRequest = fetchCalls.find(c => c.url.includes("/api/sessions/init"));
      expect(initRequest).toBeDefined();
      expect(initRequest!.body.dbPath).toBe("/test/project/.claude/mem.db");

      // Second request: /sessions/{sessionDbId}/init
      const agentInitRequest = fetchCalls.find(
        c => c.url.match(/\/sessions\/\d+\/init/) && !c.url.includes("/api/")
      );
      expect(agentInitRequest).toBeDefined();
      expect(agentInitRequest!.body.dbPath).toBe("/test/project/.claude/mem.db");
    });
  });

  describe("observation handler", () => {
    it("includes dbPath in /api/sessions/observations request", async () => {
      const { observationHandler } = await import("../../../src/cli/handlers/observation.js");

      await observationHandler.execute({
        sessionId: "test-session-123",
        cwd: "/test/project",
        toolName: "Bash",
        toolInput: '{"command": "ls"}',
        toolResponse: "file1.ts\nfile2.ts",
      } as any);

      const obsRequest = fetchCalls.find(c => c.url.includes("/api/sessions/observations"));
      expect(obsRequest).toBeDefined();
      expect(obsRequest!.body.dbPath).toBe("/test/project/.claude/mem.db");
    });
  });
});
