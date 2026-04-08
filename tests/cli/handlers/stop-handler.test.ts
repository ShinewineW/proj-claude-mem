import { describe, it, expect } from 'bun:test';

describe('stop handler', () => {
  it('is registered in handlers/index.ts as stop event type', async () => {
    const { readFileSync } = await import('fs');
    const indexSource = readFileSync('src/cli/handlers/index.ts', 'utf-8');
    expect(indexSource).toContain("'stop'");
    expect(indexSource).toContain('stopHandler');
  });

  it('stop.ts exists and exports stopHandler', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync('src/cli/handlers/stop.ts', 'utf-8');
    expect(source).toContain('export const stopHandler');
    expect(source).toContain('summarizeHandler');
    expect(source).toContain('sessionCompleteHandler');
  });

  it('calls summarize before session-complete (sequential)', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync('src/cli/handlers/stop.ts', 'utf-8');
    const summarizeIdx = source.indexOf('summarizeHandler.execute');
    const completeIdx = source.indexOf('sessionCompleteHandler.execute');
    expect(summarizeIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    expect(summarizeIdx).toBeLessThan(completeIdx);
  });
});
