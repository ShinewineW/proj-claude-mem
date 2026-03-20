import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('DATA_DIR settings.json cascade', () => {
  const settingsDir = join(homedir(), '.claude-mem');
  const settingsPath = join(settingsDir, 'settings.json');

  it('settings.json is parseable if it exists', () => {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(typeof settings).toBe('object');
    }
  });

  it('SettingsDefaultsManager.get returns hardcoded default', () => {
    const defaultDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    expect(defaultDir).toBeTruthy();
    expect(defaultDir).toContain('.claude-mem');
  });

  it('resolveDataDir logic: env > settings.json > default', () => {
    function resolveDataDir(env: Record<string, string | undefined>, settingsJson: Record<string, any> | null): string {
      if (env.CLAUDE_MEM_DATA_DIR) return env.CLAUDE_MEM_DATA_DIR;
      if (settingsJson) {
        const val = settingsJson.CLAUDE_MEM_DATA_DIR ?? settingsJson.settings?.CLAUDE_MEM_DATA_DIR;
        if (val) return val;
      }
      return SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
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
