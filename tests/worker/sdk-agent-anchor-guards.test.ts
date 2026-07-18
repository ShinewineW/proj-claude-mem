import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import {
  shouldPersistSDKSessionId,
  shouldResumeSDKSession,
} from "../../src/services/worker/SDKAgent.js";
import { resetSessionAnchorForFreshStart } from "../../src/shared/observer-anchor.js";
import { SessionStore } from "../../src/services/sqlite/SessionStore.js";

describe("shouldPersistSDKSessionId — never overwrite a cm- worker anchor", () => {
  const sdkInit = { type: "system", subtype: "init", session_id: "sdk-real-id" };

  test("cm- anchor is NEVER overwritten by an SDK id", () => {
    expect(shouldPersistSDKSessionId(sdkInit, "cm-stable")).toBe(false);
  });

  test("legacy NULL anchor still adopts the SDK init id (unchanged)", () => {
    expect(shouldPersistSDKSessionId(sdkInit, null)).toBe(true);
  });

  test("legacy SDK-id anchor still updates to a new SDK id (unchanged)", () => {
    expect(shouldPersistSDKSessionId(sdkInit, "old-sdk-id")).toBe(true);
  });

  test("ephemeral hook_* messages still rejected (unchanged)", () => {
    expect(
      shouldPersistSDKSessionId(
        { type: "system", subtype: "hook_started", session_id: "ephemeral" },
        null,
      ),
    ).toBe(false);
  });
});

describe("shouldResumeSDKSession — production function (评审 R1-3: no replica)", () => {
  test("cm- anchor never resumes even on a continuation prompt", () => {
    expect(shouldResumeSDKSession({ memorySessionId: "cm-x", lastPromptNumber: 5 })).toBe(false);
  });

  test("a real SDK-id anchor resumes on a continuation prompt (legacy unchanged)", () => {
    expect(shouldResumeSDKSession({ memorySessionId: "sdk-real", lastPromptNumber: 5 })).toBe(true);
  });

  test("first prompt never resumes regardless of anchor", () => {
    expect(shouldResumeSDKSession({ memorySessionId: "sdk-real", lastPromptNumber: 1 })).toBe(false);
  });

  test("forceInit / proactiveReset still veto resume (legacy unchanged)", () => {
    expect(shouldResumeSDKSession({ memorySessionId: "sdk-real", lastPromptNumber: 5, forceInit: true })).toBe(false);
    expect(shouldResumeSDKSession({ memorySessionId: "sdk-real", lastPromptNumber: 5, proactiveReset: true })).toBe(false);
  });

  test("null anchor never resumes", () => {
    expect(shouldResumeSDKSession({ memorySessionId: null, lastPromptNumber: 5 })).toBe(false);
  });
});

describe("resetSessionAnchorForFreshStart — behavioral, real SessionStore + FK children (评审 R2-1)", () => {
  function makeStoreWithSession(anchor: string) {
    const store = new SessionStore(":memory:"); // real migrations → real schema + FK
    const now = Date.now();
    const sid = store.getDatabase().prepare(
      "INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, memory_session_id) VALUES (?,?,?,?,?,?)"
    ).run(`content-${anchor}`, "proj", "hi", new Date(now).toISOString(), now, anchor).lastInsertRowid as number;
    return { store, sid };
  }

  test("cm- anchor + existing FK child row: DB parent/child and memory untouched, no exception", () => {
    const { store, sid } = makeStoreWithSession("cm-stable");
    const now = Date.now();
    store.getDatabase().prepare(
      "INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch) VALUES (?,?,?,?,?,?)"
    ).run("cm-stable", "proj", "obs body", "discovery", new Date(now).toISOString(), now);

    const session: any = { sessionDbId: sid, memorySessionId: "cm-stable", forceInit: false };
    const cleared = resetSessionAnchorForFreshStart(store, session); // must not throw
    expect(cleared).toBe(false);
    expect(session.memorySessionId).toBe("cm-stable"); // memory anchor preserved
    expect(session.forceInit).toBe(true);              // fresh start still forced
    const parent = store.getDatabase().prepare("SELECT memory_session_id FROM sdk_sessions WHERE id = ?").get(sid) as any;
    expect(parent.memory_session_id).toBe("cm-stable"); // DB anchor preserved
    const child = store.getDatabase().prepare("SELECT memory_session_id FROM observations").get() as any;
    expect(child.memory_session_id).toBe("cm-stable");  // no CASCADE re-point
  });

  test("legacy SDK-id anchor: cleared in DB and memory, forceInit set (unchanged behavior)", () => {
    const { store, sid } = makeStoreWithSession("sdk-stale-id");
    const session: any = { sessionDbId: sid, memorySessionId: "sdk-stale-id", forceInit: false };
    const cleared = resetSessionAnchorForFreshStart(store, session);
    expect(cleared).toBe(true);
    expect(session.memorySessionId).toBeNull();
    expect(session.forceInit).toBe(true);
    const parent = store.getDatabase().prepare("SELECT memory_session_id FROM sdk_sessions WHERE id = ?").get(sid) as any;
    expect(parent.memory_session_id).toBeNull();
  });
});

describe("anchor-clearing sites wired through the tested helper (评审 R1-1/R2-1 wiring assertions)", () => {
  // Behavior is pinned by the real-store tests above; these assertions pin the
  // WIRING: all three production sites must route through the helper, so the
  // behavioral tests actually cover the production paths.
  test("context-overflow site calls resetSessionAnchorForFreshStart", () => {
    const src = readFileSync("src/services/worker/SDKAgent.ts", "utf-8");
    const at = src.indexOf("Context overflow detected");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 1500)).toContain("resetSessionAnchorForFreshStart(");
    // and the raw clear must be gone from the overflow branch:
    expect(src.slice(at, at + 1500)).not.toContain("updateMemorySessionId(session.sessionDbId, null)");
  });

  test("stale-resume sites gate on shouldClearStaleAnchorOnResumeFailure and clear via the helper", () => {
    for (const f of [
      "src/services/worker/http/routes/SessionRoutes.ts",
      "src/services/worker-service.ts",
    ]) {
      const src = readFileSync(f, "utf-8");
      expect(src).toContain("shouldClearStaleAnchorOnResumeFailure(errorMessage, session.memorySessionId)");
      expect(src).toContain("resetSessionAnchorForFreshStart(");
      expect(src).not.toContain("updateMemorySessionId(session.sessionDbId, null)");
    }
  });
});
