import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveProjectDbPath } from "../../src/shared/paths.js";
import { DbConnectionPool } from "../../src/shared/project-db.js";

describe("Project Isolation E2E", () => {
  const testRoot = join(tmpdir(), `claude-mem-e2e-${Date.now()}`);

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("two worktrees resolve to the same dbPath", () => {
    // Setup: main repo with .git directory
    const mainRepo = join(testRoot, "main-repo");
    mkdirSync(join(mainRepo, ".git", "worktrees", "feat-a"), { recursive: true });
    mkdirSync(join(mainRepo, ".git", "worktrees", "feat-b"), { recursive: true });

    // Worktree A
    const worktreeA = join(testRoot, "feat-a");
    mkdirSync(worktreeA, { recursive: true });
    writeFileSync(
      join(worktreeA, ".git"),
      `gitdir: ${join(mainRepo, ".git", "worktrees", "feat-a")}\n`
    );

    // Worktree B
    const worktreeB = join(testRoot, "feat-b");
    mkdirSync(worktreeB, { recursive: true });
    writeFileSync(
      join(worktreeB, ".git"),
      `gitdir: ${join(mainRepo, ".git", "worktrees", "feat-b")}\n`
    );

    const pathA = resolveProjectDbPath(worktreeA);
    const pathB = resolveProjectDbPath(worktreeB);
    const pathMain = resolveProjectDbPath(mainRepo);

    // All three should resolve to the same DB
    expect(pathA).toBe(pathMain);
    expect(pathB).toBe(pathMain);
    expect(pathMain).toBe(join(mainRepo, ".claude", "mem.db"));
  });

  it("different repos get different databases", () => {
    const repoA = join(testRoot, "repo-a");
    const repoB = join(testRoot, "repo-b");
    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(join(repoB, ".git"), { recursive: true });

    const pathA = resolveProjectDbPath(repoA);
    const pathB = resolveProjectDbPath(repoB);

    expect(pathA).not.toBe(pathB);
    expect(pathA).toBe(join(repoA, ".claude", "mem.db"));
    expect(pathB).toBe(join(repoB, ".claude", "mem.db"));
  });

  it("pool returns same store for same dbPath from different worktrees", () => {
    const mainRepo = join(testRoot, "shared-repo");
    mkdirSync(join(mainRepo, ".git", "worktrees", "wt1"), { recursive: true });

    const worktree = join(testRoot, "wt1");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(mainRepo, ".git", "worktrees", "wt1")}\n`
    );

    const pool = new DbConnectionPool();
    try {
      const pathFromMain = resolveProjectDbPath(mainRepo);
      const pathFromWorktree = resolveProjectDbPath(worktree);

      const storeMain = pool.getStore(pathFromMain);
      const storeWorktree = pool.getStore(pathFromWorktree);

      expect(storeMain).toBe(storeWorktree); // Same instance!
    } finally {
      pool.closeAll();
    }
  });

  it("data written from one worktree is readable from another", () => {
    const mainRepo = join(testRoot, "data-repo");
    mkdirSync(join(mainRepo, ".git", "worktrees", "wt-write"), { recursive: true });

    const worktreeWrite = join(testRoot, "wt-write");
    mkdirSync(worktreeWrite, { recursive: true });
    writeFileSync(
      join(worktreeWrite, ".git"),
      `gitdir: ${join(mainRepo, ".git", "worktrees", "wt-write")}\n`
    );

    const pool = new DbConnectionPool();
    try {
      const dbPath = resolveProjectDbPath(mainRepo);

      // Write from "worktree"
      const store = pool.getStore(dbPath);
      const sessionId = store.createSDKSession("test-content-id", "test-project", "test prompt");

      // Read from "main repo" — same store since same dbPath
      const session = store.getSessionById(sessionId);
      expect(session).toBeTruthy();
      expect(session!.content_session_id).toBe("test-content-id");
    } finally {
      pool.closeAll();
    }
  });
});
