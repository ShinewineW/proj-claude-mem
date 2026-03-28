import { describe, test, expect } from "bun:test";
import {
  parseSkipPatterns,
  shouldSkipObservation,
} from "../../src/services/worker/http/routes/observation-filter.js";

describe("parseSkipPatterns", () => {
  test("parses comma-separated tool:glob pairs with pre-compiled regex", () => {
    const patterns = parseSkipPatterns("Read:*.SKILL.md,Glob:*");
    expect(patterns.length).toBe(2);
    expect(patterns[0].tool).toBe("Read");
    expect(patterns[0].glob).toBe("*.SKILL.md");
    expect(patterns[0].regex).toBeInstanceOf(RegExp);
    expect(patterns[0].regex.test("foo.SKILL.md")).toBe(true);
    expect(patterns[1].tool).toBe("Glob");
    expect(patterns[1].glob).toBe("*");
  });

  test("returns empty array for empty string", () => {
    expect(parseSkipPatterns("")).toEqual([]);
  });

  test("trims whitespace", () => {
    const patterns = parseSkipPatterns(" Read:*.md , Glob:* ");
    expect(patterns.length).toBe(2);
    expect(patterns[0].tool).toBe("Read");
    expect(patterns[0].glob).toBe("*.md");
    expect(patterns[1].tool).toBe("Glob");
  });

  test("skips malformed entries (no colon)", () => {
    const patterns = parseSkipPatterns("Read:*.md,BadEntry,Glob:*");
    expect(patterns.length).toBe(2);
    expect(patterns[0].tool).toBe("Read");
    expect(patterns[1].tool).toBe("Glob");
  });
});

describe("shouldSkipObservation", () => {
  const defaultPatterns = parseSkipPatterns(
    "Read:*SKILL.md,Read:*/.claude/rules/*,Read:*settings.json,Read:*hooks.json,Glob:*",
  );

  test("does NOT skip Agent tool by default", () => {
    expect(
      shouldSkipObservation(
        "Agent",
        { prompt: "do something" },
        defaultPatterns,
      ),
    ).toBe(false);
  });

  test("skips Read of SKILL.md files", () => {
    expect(
      shouldSkipObservation(
        "Read",
        { file_path: "/home/user/.claude/skills/foo/SKILL.md" },
        defaultPatterns,
      ),
    ).toBe(true);
  });

  test("skips Read of .claude/rules/ files", () => {
    expect(
      shouldSkipObservation(
        "Read",
        { file_path: "/project/.claude/rules/arch.md" },
        defaultPatterns,
      ),
    ).toBe(true);
  });

  test("skips Glob tool", () => {
    expect(
      shouldSkipObservation("Glob", { pattern: "**/*.ts" }, defaultPatterns),
    ).toBe(true);
  });

  test("does NOT skip Grep tool by default", () => {
    expect(
      shouldSkipObservation("Grep", { pattern: "someFunc" }, defaultPatterns),
    ).toBe(false);
  });

  test("does NOT skip Edit tool (not in patterns)", () => {
    expect(
      shouldSkipObservation(
        "Edit",
        { file_path: "/project/src/foo.ts" },
        defaultPatterns,
      ),
    ).toBe(false);
  });

  test("does NOT skip Read of source files", () => {
    expect(
      shouldSkipObservation(
        "Read",
        { file_path: "/project/src/foo.ts" },
        defaultPatterns,
      ),
    ).toBe(false);
  });

  test("skips Read of settings.json", () => {
    expect(
      shouldSkipObservation(
        "Read",
        { file_path: "/home/user/.claude/settings.json" },
        defaultPatterns,
      ),
    ).toBe(true);
  });

  test("returns false for empty patterns", () => {
    expect(shouldSkipObservation("Read", { file_path: "/foo" }, [])).toBe(
      false,
    );
  });

  test("matches tool name exactly (case-sensitive)", () => {
    expect(
      shouldSkipObservation(
        "read",
        { file_path: "/project/SKILL.md" },
        defaultPatterns,
      ),
    ).toBe(false);
  });
});
