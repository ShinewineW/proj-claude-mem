import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('BypassLane settings — dead code regression guard', () => {
  it('BypassLane.ts does not reference settings.CLAUDE_MEM_BYPASS_MAX_*', () => {
    const src = readFileSync('src/services/worker/BypassLane.ts', 'utf-8');
    expect(src).not.toContain('settings.CLAUDE_MEM_BYPASS_MAX_CONTEXT_MESSAGES');
    expect(src).not.toContain('settings.CLAUDE_MEM_BYPASS_MAX_TOKENS');
  });

  it('SettingsDefaultsManager DEFAULTS does not declare CLAUDE_MEM_BYPASS_MAX_* keys', () => {
    const src = readFileSync('src/shared/SettingsDefaultsManager.ts', 'utf-8');
    expect(src).not.toContain('CLAUDE_MEM_BYPASS_MAX_CONTEXT_MESSAGES');
    expect(src).not.toContain('CLAUDE_MEM_BYPASS_MAX_TOKENS');
  });

  it('BypassLane.ts still declares DEFAULT_MAX_CONTEXT_MESSAGES and DEFAULT_MAX_ESTIMATED_TOKENS', () => {
    const src = readFileSync('src/services/worker/BypassLane.ts', 'utf-8');
    expect(src).toMatch(/DEFAULT_MAX_CONTEXT_MESSAGES\s*=/);
    expect(src).toMatch(/DEFAULT_MAX_ESTIMATED_TOKENS\s*=/);
  });
});
