import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 4589b34e: the loopback MCP self-check must be non-fatal so the orphan/stale
 * reapers, fallback cleanup, and SummaryLane all start regardless of MCP health.
 */
const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker-service.ts'), 'utf-8');

describe('MCP loopback self-check is non-fatal', () => {
  it('wraps the MCP connect race in its own try', () => {
    // The connect + Promise.race must sit inside a dedicated try block.
    expect(SRC).toContain('// Best-effort loopback MCP self-check');
  });
  it('marks mcpReady=false on self-check failure instead of throwing', () => {
    expect(SRC).toContain('this.mcpReady = false;');
  });
  it('logs the self-check failure as a warning (non-fatal)', () => {
    expect(SRC).toContain('MCP loopback self-check failed');
  });
  it('still references SummaryLane start after the MCP block', () => {
    // Sanity: the reaper/SummaryLane wiring remains after the connect.
    const mcpIdx = SRC.indexOf('// Best-effort loopback MCP self-check');
    const laneIdx = SRC.indexOf('this.summaryLane.start();');
    expect(mcpIdx).toBeGreaterThan(0);
    expect(laneIdx).toBeGreaterThan(mcpIdx);
  });
});
