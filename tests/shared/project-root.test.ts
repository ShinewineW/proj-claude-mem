import { describe, it, expect } from "bun:test";
import { resolveProjectRoot } from "../../src/shared/paths.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

describe("resolveProjectRoot", () => {
  it("applies workspace parent heuristic: git repo whose parent has CLAUDE.md returns parent", () => {
    const workspace = makeTempDir("workspace-parent");
    const repo = join(workspace, "nested-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(workspace, "CLAUDE.md"), "# test workspace\n");
    execSync("git init", { cwd: repo, stdio: "ignore" });

    try {
      const result = resolveProjectRoot(repo);
      expect(result).toBe(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("returns cwd for a non-git directory", () => {
    const tmp = makeTempDir("test-no-git");
    try {
      const result = resolveProjectRoot(tmp);
      expect(result).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns same root for subdirectory inside repo", () => {
    const repo = makeTempDir("standalone-repo");
    const subdir = join(repo, "src");
    mkdirSync(subdir, { recursive: true });
    execSync("git init", { cwd: repo, stdio: "ignore" });

    try {
      const rootResult = resolveProjectRoot(repo);
      const subResult = resolveProjectRoot(subdir);
      expect(subResult).toBe(rootResult);
      expect(rootResult).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
