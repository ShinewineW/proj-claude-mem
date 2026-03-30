/**
 * Retention settings defaults — verifies retention-related default values.
 *
 * Uses file-based assertions instead of importing SettingsDefaultsManager,
 * because mock.module() from 15+ test files pollutes the module in full-suite runs.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const sourceFile = readFileSync(
  join(__dirname, "../../src/shared/SettingsDefaultsManager.ts"),
  "utf-8"
);

function getDefault(key: string): string | undefined {
  const regex = new RegExp(`${key}:\\s*["']([^"']*)["']`);
  return sourceFile.match(regex)?.[1];
}

describe("retention settings defaults", () => {
  it("has retention defaults", () => {
    expect(getDefault("CLAUDE_MEM_RETENTION_ENABLED")).toBe("true");
    expect(getDefault("CLAUDE_MEM_RETENTION_DAYS")).toBe("30");
    expect(getDefault("CLAUDE_MEM_RETENTION_SCORE_THRESHOLD")).toBe("0.3");
    expect(getDefault("CLAUDE_MEM_RETENTION_MAX_KEPT")).toBe("3000");
  });
});
