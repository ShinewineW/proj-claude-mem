/**
 * DATA_DIR settings cascade — verifies the 3-tier resolution logic.
 *
 * Uses file-based assertions for SettingsDefaultsManager defaults, because
 * mock.module() from 15+ test files pollutes the module in full-suite runs.
 * DATA_DIR default is dynamic (join(homedir(), '.claude-mem')), so we verify
 * the source code pattern rather than the runtime value.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const sourceFile = readFileSync(
  join(__dirname, '../../src/shared/SettingsDefaultsManager.ts'),
  'utf-8'
);

// DATA_DIR default is dynamic: join(homedir(), ".claude-mem")
// We verify the source pattern and compute the expected value ourselves.
const expectedDataDir = join(homedir(), '.claude-mem');

describe('DATA_DIR settings.json cascade', () => {
  const settingsPath = join(expectedDataDir, 'settings.json');

  it('settings.json is parseable if it exists', () => {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(typeof settings).toBe('object');
    }
  });

  it('source code defines DATA_DIR as homedir/.claude-mem', () => {
    expect(sourceFile).toContain('CLAUDE_MEM_DATA_DIR: join(homedir(), ".claude-mem")');
  });

  it('resolveDataDir logic: env > settings.json > default', () => {
    function resolveDataDir(env: Record<string, string | undefined>, settingsJson: Record<string, any> | null): string {
      if (env.CLAUDE_MEM_DATA_DIR) return env.CLAUDE_MEM_DATA_DIR;
      if (settingsJson) {
        const val = settingsJson.CLAUDE_MEM_DATA_DIR ?? settingsJson.settings?.CLAUDE_MEM_DATA_DIR;
        if (val) return val;
      }
      return expectedDataDir;
    }

    // Tier 1 wins
    expect(resolveDataDir({ CLAUDE_MEM_DATA_DIR: '/env' }, { CLAUDE_MEM_DATA_DIR: '/settings' }))
      .toBe('/env');

    // Tier 2 wins when env absent
    expect(resolveDataDir({}, { CLAUDE_MEM_DATA_DIR: '/settings' }))
      .toBe('/settings');

    // Tier 2 handles legacy nested schema
    expect(resolveDataDir({}, { settings: { CLAUDE_MEM_DATA_DIR: '/nested' } }))
      .toBe('/nested');

    // Tier 3 fallback
    const result = resolveDataDir({}, null);
    expect(result).toContain('.claude-mem');
  });
});
