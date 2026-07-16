import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

const SRC = readFileSync("src/shared/SettingsDefaultsManager.ts", "utf-8");

describe("SKIP defaults expanded (Route A)", () => {
  test("SKIP_TOOLS includes ScheduleWakeup and ToolSearch", () => {
    expect(SRC).toContain("ScheduleWakeup");
    expect(SRC).toContain("ToolSearch");
  });
  test("SKIP_TOOL_PATTERNS includes standalone Bash nav and Read noise paths", () => {
    expect(SRC).toContain("Bash:cd *");
    expect(SRC).toContain("Read:*/node_modules/*");
    expect(SRC).toContain("Read:*.log");
  });
  test("cat/head/tail are narrowed to noise paths (decision 3), never blanket", () => {
    expect(SRC).toContain("Bash:cat *.log");
    expect(SRC).toContain("Bash:cat */logs/*");
    expect(SRC).not.toContain("Bash:cat *,");   // 一刀切形态不得出现
    expect(SRC).not.toContain("Bash:head *,");
    expect(SRC).not.toContain("Bash:tail *,");
  });
});
