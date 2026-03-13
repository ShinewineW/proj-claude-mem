import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("DbConnectionPool", () => {
  const testRoot = join(tmpdir(), `claude-mem-pool-test-${Date.now()}`);
  let pool: any; // Will be DbConnectionPool

  beforeEach(async () => {
    mkdirSync(testRoot, { recursive: true });
    // Dynamic import to get fresh module state
    const mod = await import("../../src/shared/project-db.js");
    pool = new mod.DbConnectionPool();
  });

  afterEach(() => {
    pool?.closeAll();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("creates and caches SessionStore for a dbPath", () => {
    const dbPath = join(testRoot, "proj-a", ".claude", "mem.db");
    const store1 = pool.getStore(dbPath);
    const store2 = pool.getStore(dbPath);
    expect(store1).toBe(store2); // Same instance
  });

  it("creates separate stores for different dbPaths", () => {
    const pathA = join(testRoot, "proj-a", ".claude", "mem.db");
    const pathB = join(testRoot, "proj-b", ".claude", "mem.db");
    const storeA = pool.getStore(pathA);
    const storeB = pool.getStore(pathB);
    expect(storeA).not.toBe(storeB);
  });

  it("creates parent directory automatically", () => {
    const dbDir = join(testRoot, "new-proj", ".claude");
    const dbPath = join(dbDir, "mem.db");
    pool.getStore(dbPath);
    expect(existsSync(dbDir)).toBe(true);
  });

  it("tracks lastActiveDbPath", () => {
    const pathA = join(testRoot, "proj-a", ".claude", "mem.db");
    const pathB = join(testRoot, "proj-b", ".claude", "mem.db");
    pool.getStore(pathA);
    expect(pool.getLastActiveDbPath()).toBe(pathA);
    pool.getStore(pathB);
    expect(pool.getLastActiveDbPath()).toBe(pathB);
  });

  it("evicts oldest when exceeding MAX_CONNECTIONS", () => {
    // Create MAX + 1 connections
    const paths: string[] = [];
    for (let i = 0; i <= 10; i++) {
      const p = join(testRoot, `proj-${i}`, ".claude", "mem.db");
      paths.push(p);
      pool.getStore(p);
    }
    // First connection should have been evicted
    expect(pool.connectionCount()).toBe(10);
  });
});

describe("DbConnectionPool eviction with active operations", () => {
  const testRoot = join(tmpdir(), `claude-mem-evict-test-${Date.now()}`);
  let pool: any;

  beforeEach(async () => {
    mkdirSync(testRoot, { recursive: true });
    const mod = await import("../../src/shared/project-db.js");
    pool = new mod.DbConnectionPool(2);
  });

  afterEach(() => {
    pool?.closeAll();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("should not evict a connection with active operations", () => {
    const pathA = join(testRoot, "proj-a", ".claude", "mem.db");
    const pathB = join(testRoot, "proj-b", ".claude", "mem.db");
    const pathC = join(testRoot, "proj-c", ".claude", "mem.db");

    const store1 = pool.getStore(pathA);
    pool.getStore(pathB);
    expect(pool.connectionCount()).toBe(2);

    // Mark proj-a as active — it should not be evicted
    pool.acquireRef(pathA);

    // Adding proj-c should evict proj-b (idle), not proj-a (active)
    pool.getStore(pathC);
    expect(pool.connectionCount()).toBe(2);

    // proj-a should still be cached (same instance)
    const store1Again = pool.getStore(pathA);
    expect(store1Again).toBe(store1);

    pool.releaseRef(pathA);
  });

  it("should throw when all connections are active and pool is full", () => {
    const pathA = join(testRoot, "proj-d", ".claude", "mem.db");
    const pathB = join(testRoot, "proj-e", ".claude", "mem.db");
    const pathC = join(testRoot, "proj-f", ".claude", "mem.db");

    pool.getStore(pathA);
    pool.getStore(pathB);
    pool.acquireRef(pathA);
    pool.acquireRef(pathB);

    expect(() => {
      pool.getStore(pathC);
    }).toThrow(/all connections are active/i);

    pool.releaseRef(pathA);
    pool.releaseRef(pathB);
  });
});

describe("ensureGitignore", () => {
  const testRoot = join(tmpdir(), `claude-mem-gitignore-test-${Date.now()}`);

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("appends .claude/mem.db to existing .gitignore", async () => {
    const repoRoot = join(testRoot, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const { writeFileSync } = await import("fs");
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n");

    const { ensureGitignore } = await import("../../src/shared/project-db.js");
    ensureGitignore(repoRoot);

    const content = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(content).toContain(".claude/mem.db*");
  });

  it("creates .gitignore with entry when file does not exist", async () => {
    const repoRoot = join(testRoot, "repo-no-gitignore");
    mkdirSync(repoRoot, { recursive: true });

    const { ensureGitignore } = await import("../../src/shared/project-db.js");
    ensureGitignore(repoRoot);

    const gitignorePath = join(repoRoot, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, "utf8");
    expect(content).toContain(".claude/mem.db*");
  });

  it("does not duplicate entry if already present", async () => {
    const repoRoot = join(testRoot, "repo2");
    mkdirSync(repoRoot, { recursive: true });
    const { writeFileSync } = await import("fs");
    writeFileSync(join(repoRoot, ".gitignore"), ".claude/mem.db*\n");

    const { ensureGitignore } = await import("../../src/shared/project-db.js");
    ensureGitignore(repoRoot);

    const content = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    const matches = content.match(/\.claude\/mem\.db\*/g);
    expect(matches?.length).toBe(1);
  });
});
