import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveProjectDbPath } from "../../src/shared/paths.js";

describe("resolveProjectDbPath", () => {
  const testRoot = join(tmpdir(), `claude-mem-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testRoot, { recursive: true });
    delete process.env.CLAUDE_MEM_PROJECT_DB_PATH;
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    delete process.env.CLAUDE_MEM_PROJECT_DB_PATH;
  });

  it("returns env override when CLAUDE_MEM_PROJECT_DB_PATH is set", () => {
    process.env.CLAUDE_MEM_PROJECT_DB_PATH = "/custom/path/mem.db";
    expect(resolveProjectDbPath("/any/dir")).toBe("/custom/path/mem.db");
  });

  it("returns <cwd>/.claude/mem.db for non-git directory", () => {
    const nonGitDir = join(testRoot, "no-git");
    mkdirSync(nonGitDir, { recursive: true });
    expect(resolveProjectDbPath(nonGitDir)).toBe(join(nonGitDir, ".claude", "mem.db"));
  });

  it("returns <gitRoot>/.claude/mem.db for main repo", () => {
    const repoDir = join(testRoot, "main-repo");
    mkdirSync(join(repoDir, ".git"), { recursive: true }); // .git as directory = main repo
    const subDir = join(repoDir, "src", "lib");
    mkdirSync(subDir, { recursive: true });
    expect(resolveProjectDbPath(subDir)).toBe(join(repoDir, ".claude", "mem.db"));
  });

  it("returns <parentRepo>/.claude/mem.db for worktree", () => {
    const parentRepo = join(testRoot, "parent");
    mkdirSync(join(parentRepo, ".git", "worktrees", "feat-x"), { recursive: true });

    const worktreeDir = join(testRoot, "feat-x");
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      join(worktreeDir, ".git"),
      `gitdir: ${join(parentRepo, ".git", "worktrees", "feat-x")}\n`
    );
    expect(resolveProjectDbPath(worktreeDir)).toBe(join(parentRepo, ".claude", "mem.db"));
  });

  it("falls back to process.cwd() when cwd is undefined", () => {
    const result = resolveProjectDbPath();
    expect(result).toEndWith(".claude/mem.db");
  });
});
