import { describe, test, expect } from "bun:test";
import {
  WORKER_ANCHOR_PREFIX,
  isWorkerAnchor,
  mintWorkerAnchor,
  observerResumeEnabled,
  mintInitialAnchor,
  shouldClearStaleAnchorOnResumeFailure,
  resetSessionAnchorForFreshStart,
} from "../../src/shared/observer-anchor.js";

describe("observer-anchor", () => {
  test("prefix is 'cm-'", () => {
    expect(WORKER_ANCHOR_PREFIX).toBe("cm-");
  });

  test("isWorkerAnchor recognizes cm- ids only", () => {
    expect(isWorkerAnchor("cm-abc")).toBe(true);
    expect(isWorkerAnchor("cm-" + "0".repeat(36))).toBe(true);
    expect(isWorkerAnchor("550e8400-e29b-41d4-a716-446655440000")).toBe(false); // real SDK id
    expect(isWorkerAnchor("manual-proj")).toBe(false);
    expect(isWorkerAnchor(null)).toBe(false);
    expect(isWorkerAnchor(undefined)).toBe(false);
    expect(isWorkerAnchor("")).toBe(false);
  });

  test("mintWorkerAnchor returns a cm- prefixed, unique, non-empty id", () => {
    const a = mintWorkerAnchor();
    const b = mintWorkerAnchor();
    expect(isWorkerAnchor(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan("cm-".length + 10);
  });

  test("observerResumeEnabled: 'true' => true, anything else => false", () => {
    expect(observerResumeEnabled({ CLAUDE_MEM_OBSERVER_RESUME: "true" })).toBe(true);
    expect(observerResumeEnabled({ CLAUDE_MEM_OBSERVER_RESUME: "false" })).toBe(false);
    expect(observerResumeEnabled({ CLAUDE_MEM_OBSERVER_RESUME: "" })).toBe(false);
    expect(observerResumeEnabled({})).toBe(false);
  });

  test("mintInitialAnchor: resume ON => null (SDK seeds); OFF => cm- anchor", () => {
    expect(mintInitialAnchor({ CLAUDE_MEM_OBSERVER_RESUME: "true" })).toBeNull();
    const off = mintInitialAnchor({ CLAUDE_MEM_OBSERVER_RESUME: "false" });
    expect(isWorkerAnchor(off)).toBe(true);
  });

  test("shouldClearStaleAnchorOnResumeFailure: only legacy SDK-id anchors are clearable", () => {
    expect(shouldClearStaleAnchorOnResumeFailure("No conversation found with session ID x", "sdk-id")).toBe(true);
    expect(shouldClearStaleAnchorOnResumeFailure("Request aborted by user", "sdk-id")).toBe(true);
    // cm- worker anchor is never resumed, hence never stale — must NOT be cleared,
    // even on the broad 'aborted by user' match (watchdog aborts hit it too).
    expect(shouldClearStaleAnchorOnResumeFailure("No conversation found", "cm-abc")).toBe(false);
    expect(shouldClearStaleAnchorOnResumeFailure("aborted by user", "cm-abc")).toBe(false);
    expect(shouldClearStaleAnchorOnResumeFailure("some other error", "sdk-id")).toBe(false);
    expect(shouldClearStaleAnchorOnResumeFailure("No conversation found", null)).toBe(false);
    expect(shouldClearStaleAnchorOnResumeFailure("No conversation found", undefined)).toBe(false);
  });

  test("resetSessionAnchorForFreshStart: keeps cm- (no store call), clears legacy, always forceInit", () => {
    const calls: Array<[number, string | null]> = [];
    const store = { updateMemorySessionId: (id: number, v: string | null) => { calls.push([id, v]); } };

    const cm = { sessionDbId: 1, memorySessionId: "cm-x", forceInit: false };
    expect(resetSessionAnchorForFreshStart(store, cm)).toBe(false);
    expect(cm.memorySessionId).toBe("cm-x");
    expect(cm.forceInit).toBe(true);
    expect(calls.length).toBe(0); // DB never touched for a worker anchor

    const legacy = { sessionDbId: 2, memorySessionId: "sdk-id", forceInit: false };
    expect(resetSessionAnchorForFreshStart(store, legacy)).toBe(true);
    expect(legacy.memorySessionId).toBeNull();
    expect(legacy.forceInit).toBe(true);
    expect(calls).toEqual([[2, null]]);

    const empty = { sessionDbId: 3, memorySessionId: null, forceInit: false };
    expect(resetSessionAnchorForFreshStart(store, empty)).toBe(false);
    expect(empty.forceInit).toBe(true);
    expect(calls.length).toBe(1); // nothing to clear → no extra call
  });
});
