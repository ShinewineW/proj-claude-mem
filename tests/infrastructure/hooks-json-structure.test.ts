import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('hooks.json structure (P0+P4+P5)', () => {
  const hooks = JSON.parse(readFileSync('plugin/hooks/hooks.json', 'utf-8'));

  it('all hook commands use hook-client.cjs, not worker-service.cjs for hooks', () => {
    const json = JSON.stringify(hooks);
    const hookClientMatches = json.match(/hook-client\.cjs/g) || [];
    expect(hookClientMatches.length).toBeGreaterThanOrEqual(4);

    expect(json).not.toContain('worker-service.cjs hook');
  });

  it('SessionStart has exactly 2 hooks (smart-install + context)', () => {
    const sessionStart = hooks.hooks.SessionStart[0];
    expect(sessionStart.hooks).toHaveLength(2);
    expect(sessionStart.hooks[0].command).toContain('smart-install.js');
    expect(sessionStart.hooks[1].command).toContain('hook-client.cjs');
    expect(sessionStart.hooks[1].command).toContain('context');
  });

  it('Stop hook uses single "stop" event (not summarize ; session-complete)', () => {
    const stop = hooks.hooks.Stop[0];
    expect(stop.hooks).toHaveLength(1);
    expect(stop.hooks[0].command).toContain('hook-client.cjs');
    expect(stop.hooks[0].command).toContain('stop');
    expect(stop.hooks[0].command).not.toContain('summarize');
    expect(stop.hooks[0].command).not.toContain('session-complete');
  });

  it('no standalone worker-service.cjs start command in SessionStart', () => {
    const sessionStart = hooks.hooks.SessionStart[0];
    const commands = sessionStart.hooks.map((h: any) => h.command);
    const hasStandaloneStart = commands.some((c: string) =>
      c.includes('worker-service.cjs') && c.includes(' start')
    );
    expect(hasStandaloneStart).toBe(false);
  });
});
