import { describe, it, expect } from "bun:test";
import { resolveProjectRoot } from "../../src/shared/paths.js";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveProjectRoot", () => {
  it("applies workspace parent heuristic: git repo whose parent has CLAUDE.md returns parent", () => {
    // proj-claude-mem is a git repo; its parent ClaudeMem-ProjIso has CLAUDE.md and is not a git repo.
    // The heuristic should return ClaudeMem-ProjIso as the workspace root.
    const result = resolveProjectRoot(process.cwd());
    expect(result).toMatch(/ClaudeMem-ProjIso$/);
  });

  it("returns cwd for a non-git directory", () => {
    const tmp = join(tmpdir(), `test-no-git-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const result = resolveProjectRoot(tmp);
      expect(result).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns same root for subdirectory inside repo", () => {
    const rootResult = resolveProjectRoot(process.cwd());
    const subResult = resolveProjectRoot(join(process.cwd(), "src"));
    expect(subResult).toBe(rootResult);
  });
});
