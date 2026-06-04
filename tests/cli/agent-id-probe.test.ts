import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Source-level guard (string-pinned): the probe must read raw agent fields
// before normalization strips them, and must be clearly marked temporary.
// We assert on the source text rather than exercising process.exit().
describe('agent-id-probe (temporary Q23 instrumentation)', () => {
  const src = readFileSync(
    join(import.meta.dir, '../../src/cli/hook-command.ts'),
    'utf-8',
  );

  it('reads agent_id / agent_type from the RAW stdin object', () => {
    expect(src).toContain('AGENT_ID_PROBE');
    // Must reference rawInput (pre-normalization), not the normalized input
    expect(src).toMatch(/rawInput[\s\S]{0,200}agent_id/);
    expect(src).toMatch(/rawInput[\s\S]{0,200}agent_type/);
  });

  it('is marked as a temporary probe with a removal condition', () => {
    expect(src).toMatch(/TEMPORARY PROBE/i);
    // C2-F7: the probe must carry an explicit removal condition so it cannot
    // silently persist indefinitely once Q23 is decided.
    expect(src).toMatch(/TODO\(Q23\)/);
  });
});
