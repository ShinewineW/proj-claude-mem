import { describe, it, expect } from 'bun:test';
import { SummaryLane } from '../../src/services/worker/SummaryLane.js';

describe('SummaryLane skeleton', () => {
  it('is in DISABLED state before start()', () => {
    const lane = new SummaryLane();
    expect(lane.getStatus().state).toBe('DISABLED');
  });

  it('start() without wire throws', () => {
    const lane = new SummaryLane();
    expect(() => lane.start()).toThrow(/not wired/i);
  });

  it('start()/stop() transitions through ACTIVE to STOPPED', async () => {
    const lane = new SummaryLane();
    lane.setSessionManager({} as any);
    lane.setDbManager({} as any);
    lane.setDbPathsProvider(() => new Set());
    lane.setBroadcastSummary(() => {});
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    expect(lane.getStatus().state).toBe('ACTIVE');

    await lane.stop();
    expect(lane.getStatus().state).toBe('STOPPED');
  });

  it('start() is idempotent — calling again in ACTIVE is a no-op', () => {
    const lane = new SummaryLane();
    lane.setSessionManager({} as any);
    lane.setDbManager({} as any);
    lane.setDbPathsProvider(() => new Set());
    lane.setBroadcastSummary(() => {});
    lane.setBroadcastProcessingStatus(() => {});

    lane.start();
    lane.start();
    expect(lane.getStatus().state).toBe('ACTIVE');
  });
});
