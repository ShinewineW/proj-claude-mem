import { describe, it, expect } from 'bun:test';
import { SummaryLaneTelemetry } from '../../src/services/worker/SummaryLaneTelemetry.js';

describe('SummaryLaneTelemetry', () => {
  it('tracks counters across lifecycle events', () => {
    const t = new SummaryLaneTelemetry();
    t.recordClaimed(1, Date.now() - 500);
    t.recordProcessed(1);
    t.recordClaimed(2, Date.now() - 300);
    t.recordFailed(2);
    t.recordRetried(2, 1);

    const c = t.getCounters();
    expect(c.claimed).toBe(2);
    expect(c.processed).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.retried).toBe(1);
    expect(c.deadLetters).toBe(0);
  });

  it('records dead-letters separately', () => {
    const t = new SummaryLaneTelemetry();
    t.recordDeadLetter(99);
    expect(t.getCounters().deadLetters).toBe(1);
  });

  it('stop() clears the queue depth interval (no throw)', () => {
    const t = new SummaryLaneTelemetry();
    expect(() => t.stop()).not.toThrow();
  });
});
