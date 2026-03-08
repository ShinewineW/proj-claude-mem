import { describe, it, expect, afterEach } from "bun:test";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "../../src/services/sqlite/SessionStore.js";

describe("SessionStore custom dbPath", () => {
  const testRoot = join(tmpdir(), `claude-mem-store-test-${Date.now()}`);

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("creates parent directory for custom dbPath, not DATA_DIR", () => {
    const customDir = join(testRoot, "project", ".claude");
    const customDbPath = join(customDir, "mem.db");

    // Should auto-create the directory
    const store = new SessionStore(customDbPath);
    expect(existsSync(customDir)).toBe(true);
    store.close();
  });
});
