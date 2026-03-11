import { describe, it, expect } from "bun:test";
import { getCollectionName } from "../../src/shared/chroma-utils.js";

describe("getCollectionName", () => {
  it("produces cm__<projectName>_<hash> format", () => {
    const name = getCollectionName("/Users/dev/MyProject/.claude/mem.db");
    expect(name).toMatch(/^cm__MyProject_[a-f0-9]{8}$/);
  });

  it("is idempotent for the same dbPath", () => {
    const path = "/Users/dev/SomeProject/.claude/mem.db";
    expect(getCollectionName(path)).toBe(getCollectionName(path));
  });

  it("produces different names for different dbPaths", () => {
    const a = getCollectionName("/Users/dev/ProjectA/.claude/mem.db");
    const b = getCollectionName("/Users/dev/ProjectB/.claude/mem.db");
    expect(a).not.toBe(b);
  });

  it("sanitizes special characters in project name", () => {
    const name = getCollectionName("/Users/dev/my project (v2)/.claude/mem.db");
    expect(name).toMatch(/^cm__[a-zA-Z0-9._-]+_[a-f0-9]{8}$/);
  });

  it("handles deeply nested paths", () => {
    const name = getCollectionName("/a/b/c/d/MyRepo/.claude/mem.db");
    expect(name).toMatch(/^cm__MyRepo_[a-f0-9]{8}$/);
  });

  it("handles env override paths (non-standard structure)", () => {
    const name = getCollectionName("/tmp/custom/mem.db");
    expect(name).toMatch(/^cm__[a-zA-Z0-9._-]+_[a-f0-9]{8}$/);
  });

  it("produces names within Chroma's 3-512 char limit", () => {
    const name = getCollectionName("/Users/dev/x/.claude/mem.db");
    expect(name.length).toBeGreaterThanOrEqual(3);
    expect(name.length).toBeLessThanOrEqual(512);
  });

  it("starts and ends with alphanumeric (Chroma requirement)", () => {
    const name = getCollectionName("/Users/dev/my-project-/.claude/mem.db");
    expect(name).toMatch(/^[a-zA-Z0-9]/);
    expect(name).toMatch(/[a-zA-Z0-9]$/);
  });
});
