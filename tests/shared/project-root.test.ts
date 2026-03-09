import { describe, it, expect } from "bun:test";
import { resolveProjectRoot } from "../../src/shared/paths.js";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveProjectRoot", () => {
  it("returns git root for a path inside a git repo", () => {
    // Use the current repo (proj-claude-mem) as a real git repo
    const result = resolveProjectRoot(process.cwd());
    // Should end with proj-claude-mem (the git root)
    expect(result).toMatch(/proj-claude-mem$/);
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
