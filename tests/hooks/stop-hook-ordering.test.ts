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
    expect(command).toContain('[ -z "$_R" ] && _R="$HOME/.claude/plugins/marketplaces/thedotmack/plugin"');
    // _R prefix only appears once (persists across ; separator)
    const prefixCount = command.split('_R="${CLAUDE_PLUGIN_ROOT}"').length - 1;
    expect(prefixCount).toBe(1);
  });

  it('Stop hook command runs summarize before session-complete', () => {
    const command = hooks.hooks.Stop[0].hooks[0].command;
    const summarizeIdx = command.indexOf('summarize');
    const completeIdx = command.indexOf('session-complete');
    expect(summarizeIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    expect(summarizeIdx).toBeLessThan(completeIdx);
  });

  it('Stop hook uses semicolon separator (not &&)', () => {
    const command = hooks.hooks.Stop[0].hooks[0].command;
    expect(command).toContain(' ; ');
    const betweenCommands = command.substring(
      command.indexOf('summarize') + 'summarize'.length,
      command.indexOf('session-complete')
    );
    expect(betweenCommands).not.toContain('&&');
  });

  it('Stop hook timeout accommodates both commands', () => {
    const timeout = hooks.hooks.Stop[0].hooks[0].timeout;
    expect(timeout).toBeGreaterThanOrEqual(150);
  });
});
