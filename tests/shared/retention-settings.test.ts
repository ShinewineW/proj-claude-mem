import { describe, it, expect } from "bun:test";
import { SettingsDefaultsManager } from "../../src/shared/SettingsDefaultsManager.js";

describe("retention settings defaults", () => {
  it("has retention defaults", () => {
    expect(SettingsDefaultsManager.get("CLAUDE_MEM_RETENTION_ENABLED")).toBe("true");
    expect(SettingsDefaultsManager.get("CLAUDE_MEM_RETENTION_DAYS")).toBe("30");
    expect(SettingsDefaultsManager.get("CLAUDE_MEM_RETENTION_SCORE_THRESHOLD")).toBe("0.3");
    expect(SettingsDefaultsManager.get("CLAUDE_MEM_RETENTION_MAX_KEPT")).toBe("3000");
  });
});
