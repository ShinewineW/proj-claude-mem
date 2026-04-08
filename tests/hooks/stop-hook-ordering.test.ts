import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('hooks.json Stop hook ordering', () => {
  const hooksPath = join(__dirname, '../../plugin/hooks/hooks.json');
  const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));

  it('Stop event has exactly one hook entry', () => {
    const stopHooks = hooks.hooks.Stop;
    expect(stopHooks).toHaveLength(1);
    expect(stopHooks[0].hooks).toHaveLength(1);
  });

  it('Stop hook command uses _R fallback prefix', () => {
    const command = hooks.hooks.Stop[0].hooks[0].command;
    expect(command).toContain('_R="${CLAUDE_PLUGIN_ROOT}"');
    expect(command).toContain('[ -z "$_R" ] && _R="$HOME/.claude/plugins/cache/thedotmack/claude-mem/10.5.2"');
    const prefixCount = command.split('_R="${CLAUDE_PLUGIN_ROOT}"').length - 1;
    expect(prefixCount).toBe(1);
  });

  it('Stop hook uses single stop event', () => {
    const command = hooks.hooks.Stop[0].hooks[0].command;
    expect(command).toContain('hook-client.cjs');
    expect(command).toContain('stop');
    expect(command).not.toContain('summarize');
    expect(command).not.toContain('session-complete');
  });

  it('Stop hook timeout accommodates both commands', () => {
    const timeout = hooks.hooks.Stop[0].hooks[0].timeout;
    expect(timeout).toBeGreaterThanOrEqual(150);
  });
});
