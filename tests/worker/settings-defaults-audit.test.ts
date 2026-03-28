import { describe, test, expect } from "bun:test";
import { SettingsDefaultsManager } from "../../src/shared/SettingsDefaultsManager.js";

describe("Settings defaults — audit fixes (2026-03-28)", () => {
  const defaults = SettingsDefaultsManager.getAllDefaults();

  test("MAX_CONCURRENT_AGENTS default is 4 (P0 fix: pool starvation)", () => {
    expect(defaults.CLAUDE_MEM_MAX_CONCURRENT_AGENTS).toBe("4");
  });
});
