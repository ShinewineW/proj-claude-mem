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
  test("standalone echo remains observable by default", () => {
    expect(SRC).not.toContain("Bash:echo *");
  });
});

describe("bypass cooldown tier defaults", () => {
  test("quota=30min, auth=6h, maxFailures=3 present in source", () => {
    expect(SRC).toContain("CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS");
    expect(SRC).toContain('"1800000"');   // 30min
    expect(SRC).toContain("CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS");
    expect(SRC).toContain('"21600000"');  // 6h
    expect(SRC).toContain("CLAUDE_MEM_BYPASS_MAX_FAILURES");
  });
});

describe("bypass concurrency defaults", () => {
  test("C=1, G=6 default (backward-compatible)", () => {
    expect(SRC).toContain('CLAUDE_MEM_BYPASS_CONCURRENCY: "1"');
    expect(SRC).toContain('CLAUDE_MEM_BYPASS_MAX_CONSUMERS: "6"');
  });
});
