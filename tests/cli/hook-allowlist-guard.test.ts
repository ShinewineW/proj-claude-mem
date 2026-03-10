import { describe, it, expect, mock, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";

const testDataDir = join(tmpdir(), `test-hook-guard-${Date.now()}`);
mkdirSync(testDataDir, { recursive: true });
process.env.CLAUDE_MEM_DATA_DIR = testDataDir;

mock.module("../../src/cli/stdin-reader.js", () => ({
  readJsonFromStdin: async () => ({
    session_id: "test-session",
    cwd: "/disabled/project",
    hook_event_name: "UserPromptSubmit",
  }),
}));

mock.module("../../src/cli/adapters/index.js", () => ({
  getPlatformAdapter: () => ({
    normalizeInput: (raw: any) => ({ ...raw }),
    formatOutput: (result: any) => result,
  }),
}));

let handlerCallCount = 0;
mock.module("../../src/cli/handlers/index.js", () => ({
  getEventHandler: () => ({
    execute: async () => { handlerCallCount++; return { exitCode: 0 }; },
  }),
}));

mock.module("../../src/utils/logger.js", () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

mock.module("../../src/shared/hook-constants.js", () => ({
  HOOK_EXIT_CODES: { SUCCESS: 0, FAILURE: 1, BLOCKING_ERROR: 2, USER_MESSAGE_ONLY: 3 },
}));

import { hookCommand } from "../../src/cli/hook-command.js";
import { enableProject, disableProject, getEnabledProjectsPath } from "../../src/shared/project-allowlist.js";
import { resolveProjectRoot } from "../../src/shared/paths.js";

describe("hookCommand allowlist guard", () => {
  afterEach(() => {
    handlerCallCount = 0;
    if (existsSync(getEnabledProjectsPath())) rmSync(getEnabledProjectsPath());
  });

  it("returns 0 and skips handler when project is NOT in allowlist", async () => {
    const exitCode = await hookCommand("claude-code", "UserPromptSubmit", { skipExit: true });
    expect(exitCode).toBe(0);
    expect(handlerCallCount).toBe(0);
  });

  it("calls handler when project IS in allowlist", async () => {
    const projectRoot = resolveProjectRoot("/disabled/project");
    enableProject(projectRoot);
    try {
      await hookCommand("claude-code", "UserPromptSubmit", { skipExit: true });
      expect(handlerCallCount).toBe(1);
    } finally {
      disableProject(projectRoot);
    }
  });
});
