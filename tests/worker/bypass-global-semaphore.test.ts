import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { GlobalSemaphore } from "../../src/services/worker/global-semaphore.js";
import { BypassLane } from "../../src/services/worker/BypassLane.js";

describe("GlobalSemaphore", () => {
  test("caps concurrent holders at limit", async () => {
    const sem = new GlobalSemaphore(() => 2);
    const ac = new AbortController();
    let peak = 0, cur = 0;
    const work = async () => {
      await sem.acquire(ac.signal);
      cur++; peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 20));
      cur--; sem.release();
    };
    await Promise.all([work(), work(), work(), work()]);
    expect(peak).toBe(2);
  });

  test("converges downward when limit decreases under backlog (R1-2)", async () => {
    // Start with limit 3, saturate with holders + waiters, then drop limit to 1.
    // release() must NOT hand the freed slot straight to a waiter while
    // inFlight >= new limit; concurrency must drain to 1, not stay pinned at 3.
    let limit = 3;
    const sem = new GlobalSemaphore(() => limit);
    const ac = new AbortController();
    let peakAfterDecrease = 0, cur = 0;
    let decreased = false;
    const work = async () => {
      await sem.acquire(ac.signal);
      cur++;
      if (decreased) peakAfterDecrease = Math.max(peakAfterDecrease, cur);
      await new Promise((r) => setTimeout(r, 20));
      cur--; sem.release();
    };
    const batch1 = [work(), work(), work(), work(), work(), work()]; // 3 hold, 3 wait
    await new Promise((r) => setTimeout(r, 5));
    limit = 1; decreased = true;
    await Promise.all(batch1);
    // Waiters granted after the decrease must respect the new limit of 1.
    expect(peakAfterDecrease).toBeLessThanOrEqual(1);
  });

  test("one release fills all new capacity when limit increases under backlog (R2-2)", async () => {
    // limit 1: one holder + 5 parked waiters. Raise limit to 6, then the
    // single holder releases — the release loop must wake ALL 5 waiters at
    // once (peak 5), not just one.
    let limit = 1;
    const sem = new GlobalSemaphore(() => limit);
    const ac = new AbortController();
    let peak = 0, cur = 0;
    let releaseHolder!: () => void;
    const holderDone = new Promise<void>((r) => (releaseHolder = r));
    const holder = (async () => {
      await sem.acquire(ac.signal);
      await holderDone;
      sem.release();
    })();
    await new Promise((r) => setTimeout(r, 5)); // holder owns the only slot
    const work = async () => {
      await sem.acquire(ac.signal);
      cur++; peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 20));
      cur--; sem.release();
    };
    const waiters = [work(), work(), work(), work(), work()]; // all park
    await new Promise((r) => setTimeout(r, 5));
    limit = 6;
    releaseHolder();
    await Promise.all([holder, ...waiters]);
    expect(peak).toBe(5); // all five waiters ran concurrently after one release
  });

  test("acquire rejects on abort and removes the waiter", async () => {
    const sem = new GlobalSemaphore(() => 1);
    const ac1 = new AbortController();
    await sem.acquire(ac1.signal); // hold the only slot
    const ac2 = new AbortController();
    const waiting = sem.acquire(ac2.signal);
    ac2.abort();
    await expect(waiting).rejects.toThrow("aborted");
    sem.release(); // must not grant the aborted waiter or throw
  });
});

describe("H1: semaphore acquired before row claimed", () => {
  const SRC = readFileSync("src/services/worker/BypassLane.ts", "utf-8");

  test("acquire precedes claim in consumeLoop (processing window excludes the wait)", () => {
    const acquireIdx = SRC.indexOf("globalSemaphore.acquire");
    const claimIdx = SRC.indexOf("claimNextObservation(session.sessionDbId)");
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(-1);
    // If a refactor moves claim before acquire, a claimed row sits in 'processing'
    // during the (possibly long) semaphore wait; when G is saturated it can exceed
    // the 60s self-heal threshold -> the row is reset to pending -> duplicate
    // consumption. This ordering is the entire H1 mitigation; pin it.
    expect(acquireIdx).toBeLessThan(claimIdx);
  });
});

describe("consumeLoop empty-queue backoff (no hot spin)", () => {
  test("claims at most twice within 150ms against an empty queue", async () => {
    const lane = new BypassLane() as any;
    lane.state = "ACTIVE";
    let claimCalls = 0;
    const fakeStore = {
      claimNextObservation() { claimCalls++; return null; },
      retryMessage() {},
      markFailed() {},
    };
    lane.sessionManager = {
      getPendingMessageStore: () => fakeStore,
      notifyMessageAvailable() {},
    };
    lane.dbManager = {};
    const ac = new AbortController();
    const session = {
      sessionDbId: 1,
      dbPath: "/tmp/x",
      memorySessionId: "m1",
      abortController: new AbortController(),
    } as any;

    const loop = lane.consumeLoop(session, ac.signal);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await loop;

    // POLL_MS=500ms backoff → exactly 1 claim within 150ms.
    // A hot-spinning loop (the v1 plan's `if (!message) continue;` bug) would
    // rack up thousands. Allow 2 for scheduler slack.
    expect(claimCalls).toBeLessThanOrEqual(2);
    // R1-5: lower bound too — a permanently blocked consumer (0 claims) must
    // NOT pass this test; the loop has to actually reach the claim site.
    expect(claimCalls).toBeGreaterThanOrEqual(1);
  });
});
