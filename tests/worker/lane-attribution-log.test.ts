import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

describe("per-lane store attribution log tags (inline in message, F5.1-safe)", () => {
  test("SDK store log carries inline lane=sdk", () => {
    const src = readFileSync("src/services/worker/agents/ResponseProcessor.ts", "utf-8");
    expect(src).toContain("lane=sdk");
    expect(src).toMatch(/STORED \| lane=sdk/);
  });

  test("bypass success log carries inline lane=bypass + obsCount in the message string", () => {
    const src = readFileSync("src/services/worker/BypassLane.ts", "utf-8");
    expect(src).toMatch(/STORED \| lane=bypass/);
    expect(src).toMatch(/lane=bypass[^`]*obsCount=/);
  });

  test("bypass dead-letter drop is visible (Q3): DEAD_LETTER branch on finalStatus=failed", () => {
    const src = readFileSync("src/services/worker/BypassLane.ts", "utf-8");
    expect(src).toContain("DEAD_LETTER");
    expect(src).toContain('finalStatus === "failed"');
  });
});
