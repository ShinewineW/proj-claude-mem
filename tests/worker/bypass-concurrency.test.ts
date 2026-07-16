import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";

// White-box fixture (same pattern as bypass-openai.test.ts): mock leaf deps
// BEFORE importing BypassLane, drive concurrency via mutable mockSettings.
let mockSettings: Record<string, string> = {};

mock.module("../../src/shared/paths.js", () => ({
  DATA_DIR: "/tmp/test-claude-mem",
  DB_PATH: "/tmp/test-claude-mem/claude-mem.db",
  USER_SETTINGS_PATH: "/tmp/test-settings.json",
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  resolveProjectDbPath: () => "/tmp/test-project/.claude/mem.db",
  resolveProjectRoot: () => "/tmp/test-project",
}));

mock.module("../../src/utils/logger.js", () => ({
  logger: {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    failure: () => {}, success: () => {}, formatTool: () => "mock-tool",
  },
}));

mock.module("../../src/shared/SettingsDefaultsManager.js", () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => mockSettings,
    get: (key: string) => mockSettings[key] ?? "",
    getInt: (key: string) => parseInt(mockSettings[key] ?? "0", 10) || 0,
  },
}));

mock.module("../../src/shared/EnvManager.js", () => ({
  getCredential: () => "",
}));

import { BypassLane } from "../../src/services/worker/BypassLane.js";

const BYPASS = readFileSync("src/services/worker/BypassLane.ts", "utf-8");

describe("per-session bypass concurrency (C-as-switch)", () => {
  test("startForSession spawns concurrency loops", () => {
    expect(BYPASS).toContain("CLAUDE_MEM_BYPASS_CONCURRENCY");
    expect(BYPASS).toContain("for (let i = 0; i < concurrency; i++)");
  });
  test("M1 guarded delete: all-exited AND same-controller", () => {
    expect(BYPASS).toContain("running <= 0 && this.activeConsumers.get(session.sessionDbId) === ownAc");
  });
  test("lifecycle stays untouched: no concurrency gate around stopForSession call sites", () => {
    const ROUTES = readFileSync("src/services/worker/http/routes/SessionRoutes.ts", "utf-8");
    const WS = readFileSync("src/services/worker-service.ts", "utf-8");
    expect(ROUTES).not.toContain("BYPASS_CONCURRENCY");
    expect(WS).not.toContain("BYPASS_CONCURRENCY");
  });
});

describe("startForSession spawns C consumers (behavioral)", () => {
  beforeEach(() => {
    mockSettings = { CLAUDE_MEM_BYPASS_CONCURRENCY: "3" };
  });

  function makeSession(id = 1): any {
    return {
      sessionDbId: id,
      dbPath: "/tmp/test-project/.claude/mem.db",
      memorySessionId: "mem-1",
      project: "test",
      abortController: new AbortController(),
    };
  }

  test("C=3 spawns exactly 3 consumeLoop invocations sharing one map entry", () => {
    const lane = new BypassLane() as any;
    lane.state = "ACTIVE";
    let loopInvocations = 0;
    lane.consumeLoop = () => {
      loopInvocations++;
      return new Promise<void>(() => {}); // never resolves — loops stay "running"
    };
    lane.startForSession(makeSession());
    expect(loopInvocations).toBe(3);
    expect(lane.activeConsumers.size).toBe(1); // one shared ownAc entry
  });

  test("map entry survives until ALL loops exit (M1 all-exited)", async () => {
    const lane = new BypassLane() as any;
    lane.state = "ACTIVE";
    const resolvers: Array<() => void> = [];
    lane.consumeLoop = () =>
      new Promise<void>((resolve) => resolvers.push(resolve));
    lane.startForSession(makeSession());
    expect(resolvers.length).toBe(3);

    resolvers[0]!();
    resolvers[1]!();
    await new Promise((r) => setTimeout(r, 5));
    expect(lane.activeConsumers.size).toBe(1); // 2 of 3 exited — entry stays

    resolvers[2]!();
    await new Promise((r) => setTimeout(r, 5));
    expect(lane.activeConsumers.size).toBe(0); // all exited — entry deleted
  });

  test("stale batch does not clobber a replacement controller (M1 same-controller)", async () => {
    const lane = new BypassLane() as any;
    lane.state = "ACTIVE";
    const session = makeSession();
    const firstBatch: Array<() => void> = [];
    lane.consumeLoop = () =>
      new Promise<void>((resolve) => firstBatch.push(resolve));

    lane.startForSession(session);
    const oldAc = lane.activeConsumers.get(session.sessionDbId);
    expect(firstBatch.length).toBe(3);

    // Stop (aborts old ownAc, entry stays until loops drain) then restart —
    // startForSession sees the aborted controller and installs a NEW ownAc.
    lane.stopForSession(session.sessionDbId);
    lane.consumeLoop = () => new Promise<void>(() => {}); // new batch never exits
    lane.startForSession(session);
    const newAc = lane.activeConsumers.get(session.sessionDbId);
    expect(newAc).not.toBe(oldAc);

    // Drain the OLD batch — its onLoopDone must NOT delete the NEW entry.
    for (const resolve of firstBatch) resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(lane.activeConsumers.get(session.sessionDbId)).toBe(newAc);
  });
});

describe("status metrics report real loop count (audit R1-2)", () => {
  test("C=3: activeConsumers === 3 loops, activeSessions === 1; both drain to 0", async () => {
    mockSettings = { CLAUDE_MEM_BYPASS_CONCURRENCY: "3" };
    const lane = new BypassLane() as any;
    lane.state = "ACTIVE";
    const resolvers: Array<() => void> = [];
    lane.consumeLoop = () => new Promise<void>((resolve) => resolvers.push(resolve));
    lane.startForSession({
      sessionDbId: 7,
      dbPath: "/tmp/test-project/.claude/mem.db",
      memorySessionId: "mem-7",
      project: "test",
      abortController: new AbortController(),
    } as any);
    expect(lane.getStatus().activeConsumers).toBe(3); // real loops, not session groups
    expect(lane.getStatus().activeSessions).toBe(1);

    for (const r of resolvers) r();
    await new Promise((r) => setTimeout(r, 5));
    expect(lane.getStatus().activeConsumers).toBe(0);
    expect(lane.getStatus().activeSessions).toBe(0);
  });
});
