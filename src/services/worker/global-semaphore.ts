/**
 * GlobalSemaphore: bounds concurrent bypass REST calls across all sessions.
 * limitFn is read on each acquire AND each release so config changes take
 * effect live in both directions (R1-2): a grant only happens while
 * inFlight < limitFn(), so lowering G under backlog drains to the new limit
 * instead of ping-ponging at the old one. Waiters parked by a decrease are
 * woken by later releases once inFlight sinks below the new limit.
 * acquire() rejects ONLY on signal abort. Fast path may overtake queued
 * waiters when the limit grows mid-flight — acceptable, never deadlocks.
 */
export class GlobalSemaphore {
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  constructor(private limitFn: () => number) {}

  async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('aborted');
    if (this.inFlight < this.limitFn()) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.inFlight++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('aborted'));
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    // R1-2: consult the live limit before granting — a freed slot is only
    // handed to a waiter if concurrency stays within the CURRENT limit.
    // R2-2: grant in a LOOP — when the limit was raised under backlog, a
    // single release must wake as many parked waiters as the new capacity
    // allows, not just one (each grant() increments inFlight, so the loop
    // condition self-terminates at the live limit).
    while (this.waiters.length > 0 && this.inFlight < this.limitFn()) {
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
