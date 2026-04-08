import { describe, it, expect } from 'bun:test';

describe('observation handler fetch timeout', () => {
  it('uses fetchWithTimeout instead of raw fetch', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync('src/cli/handlers/observation.ts', 'utf-8');
    expect(source).toContain('fetchWithTimeout');
    expect(source).not.toMatch(/await fetch\(`http:\/\/127/);
  });
});
