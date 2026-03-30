/**
 * Settings defaults audit — verifies critical default values are correct.
 *
 * Uses file-based assertions (readFileSync on .ts source) instead of importing
 * SettingsDefaultsManager directly, because mock.module() from 15+ test files
 * pollutes the module with incomplete stubs in full-suite runs.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const sourceFile = readFileSync(
  join(__dirname, "../../src/shared/SettingsDefaultsManager.ts"),
  "utf-8"
);

/** Extract a default value from the DEFAULTS object in source */
function getDefault(key: string): string | undefined {
  const regex = new RegExp(`${key}:\\s*["']([^"']*)["']`);
  const match = sourceFile.match(regex);
  return match?.[1];
}

describe("Settings defaults — audit fixes (2026-03-28)", () => {
  test("MAX_CONCURRENT_AGENTS default is 4 (P0 fix: pool starvation)", () => {
    expect(getDefault("CLAUDE_MEM_MAX_CONCURRENT_AGENTS")).toBe("4");
  });

  test("SKIP_TOOLS includes Task tools (P2 fix: coverage expansion)", () => {
    const skipTools = getDefault("CLAUDE_MEM_SKIP_TOOLS");
    expect(skipTools).toBeDefined();
    for (const tool of ["TaskUpdate", "TaskCreate", "TaskGet", "TaskList", "TaskStop", "TaskOutput"]) {
      expect(skipTools).toContain(tool);
    }
  });
});
