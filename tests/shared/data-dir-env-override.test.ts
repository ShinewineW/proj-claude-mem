/**
 * Verify DATA_DIR and getEnabledProjectsPath() respect process.env.CLAUDE_MEM_DATA_DIR.
 *
 * Root cause: ES module `import` statements are hoisted — they execute before
 * any inline `process.env` assignments.  A module-level constant evaluated at
 * import time therefore always sees the default value, causing test cleanup to
 * delete the real ~/.claude-mem/enabled-projects.json.
 *
 * The fix: getEnabledProjectsPath() reads process.env lazily at call time.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { mkdirSync } from "fs";

const savedEnv = process.env.CLAUDE_MEM_DATA_DIR;

describe("DATA_DIR env override", () => {
  afterEach(() => {
    // Restore original env state
    if (savedEnv !== undefined) {
      process.env.CLAUDE_MEM_DATA_DIR = savedEnv;
    } else {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    }
  });

  it("uses process.env.CLAUDE_MEM_DATA_DIR when set", async () => {
    const customDir = join(tmpdir(), `test-data-dir-${Date.now()}`);
    process.env.CLAUDE_MEM_DATA_DIR = customDir;

    const pathsMod = await import(`../../src/shared/paths.ts?t=${Date.now()}`);
    expect(pathsMod.DATA_DIR).toBe(customDir);
  });

  it("falls back to ~/.claude-mem when env var is not set", async () => {
    delete process.env.CLAUDE_MEM_DATA_DIR;

    const pathsMod = await import(`../../src/shared/paths.ts?t2=${Date.now()}`);
    expect(pathsMod.DATA_DIR).toBe(join(homedir(), ".claude-mem"));
  });
});

describe("getEnabledProjectsPath() lazy resolution", () => {
  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.CLAUDE_MEM_DATA_DIR = savedEnv;
    } else {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    }
  });

  it("resolves to custom dir when env var is set", () => {
    const customDir = join(tmpdir(), `test-allowlist-lazy-${Date.now()}`);
    mkdirSync(customDir, { recursive: true });
    process.env.CLAUDE_MEM_DATA_DIR = customDir;

    const { getEnabledProjectsPath } = require("../../src/shared/project-allowlist.ts");
    expect(getEnabledProjectsPath()).toBe(join(customDir, "enabled-projects.json"));
  });

  it("resolves to ~/.claude-mem when env var is not set", () => {
    delete process.env.CLAUDE_MEM_DATA_DIR;

    const { getEnabledProjectsPath } = require("../../src/shared/project-allowlist.ts");
    expect(getEnabledProjectsPath()).toBe(
      join(homedir(), ".claude-mem", "enabled-projects.json")
    );
  });

  it("changes path dynamically when env var changes", () => {
    const { getEnabledProjectsPath } = require("../../src/shared/project-allowlist.ts");

    const dir1 = join(tmpdir(), `test-dynamic-1-${Date.now()}`);
    process.env.CLAUDE_MEM_DATA_DIR = dir1;
    expect(getEnabledProjectsPath()).toBe(join(dir1, "enabled-projects.json"));

    const dir2 = join(tmpdir(), `test-dynamic-2-${Date.now()}`);
    process.env.CLAUDE_MEM_DATA_DIR = dir2;
    expect(getEnabledProjectsPath()).toBe(join(dir2, "enabled-projects.json"));
  });
});
