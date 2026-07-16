/**
 * SettingsRoutes persistence regression test (Phase 1 SDK Token Optimization).
 *
 * Guards against the Round1 write-back allowlist bug: new settings keys
 * must be in the settingKeys array to persist via POST /api/settings.
 *
 * NOTE: Uses file-based verification instead of SettingsDefaultsManager import
 * because mock.module() from 15+ test files pollutes the SettingsDefaultsManager
 * module at process level in bun test.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(import.meta.dir, '../../src');

describe('Phase 1 settings persistence', () => {
  test('Phase 1 keys exist in SettingsDefaults interface', () => {
    const content = readFileSync(join(SRC_ROOT, 'shared/SettingsDefaultsManager.ts'), 'utf-8');
    expect(content).toContain('CLAUDE_MEM_SKIP_TOOL_PATTERNS: string');
    expect(content).toContain('CLAUDE_MEM_BATCH_MAX_SIZE: string');
    expect(content).toContain('CLAUDE_MEM_OBS_MAX_FIELD_CHARS: string');
  });

  test('Phase 1 keys have defaults in DEFAULTS object', () => {
    const content = readFileSync(join(SRC_ROOT, 'shared/SettingsDefaultsManager.ts'), 'utf-8');
    // Check that DEFAULTS assignment block contains the Phase 1 keys with actual values
    expect(content).toMatch(/CLAUDE_MEM_SKIP_TOOL_PATTERNS:\s*["'][^"']+["']/);
    expect(content).toMatch(/CLAUDE_MEM_BATCH_MAX_SIZE:\s*["']5["']/);
    expect(content).toMatch(/CLAUDE_MEM_OBS_MAX_FIELD_CHARS:\s*["']8000["']/);
  });

  test('Phase 1 keys are in SettingsRoutes write-back allowlist', () => {
    const content = readFileSync(join(SRC_ROOT, 'services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    // The settingKeys array must include these keys for POST /api/settings to persist them
    expect(content).toContain("'CLAUDE_MEM_SKIP_TOOL_PATTERNS'");
    expect(content).toContain("'CLAUDE_MEM_BATCH_MAX_SIZE'");
    expect(content).toContain("'CLAUDE_MEM_OBS_MAX_FIELD_CHARS'");
  });

  test('Phase 1 keys have validation in SettingsRoutes', () => {
    const content = readFileSync(join(SRC_ROOT, 'services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    // BATCH_MAX_SIZE must be validated (1-20)
    expect(content).toContain('CLAUDE_MEM_BATCH_MAX_SIZE');
    expect(content).toMatch(/batchMax.*1.*20|between 1 and 20/);
    // OBS_MAX_FIELD_CHARS must be validated (500-100000)
    expect(content).toContain('CLAUDE_MEM_OBS_MAX_FIELD_CHARS');
    expect(content).toMatch(/maxChars.*500.*100000|between 500 and 100000/);
    // SKIP_TOOL_PATTERNS must have length/format validation
    expect(content).toMatch(/SKIP_TOOL_PATTERNS.*1000|under 1000/);
  });
});

describe('SummaryLane max-cap settings persistence', () => {
  test('CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS exists in SettingsDefaults interface', () => {
    const content = readFileSync(join(SRC_ROOT, 'shared/SettingsDefaultsManager.ts'), 'utf-8');
    expect(content).toContain('CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS: string');
  });

  test('CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS has a default in DEFAULTS', () => {
    const content = readFileSync(join(SRC_ROOT, 'shared/SettingsDefaultsManager.ts'), 'utf-8');
    expect(content).toMatch(/CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS:\s*["']150["']/);
  });

  test('CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS is in SettingsRoutes write-back allowlist', () => {
    const content = readFileSync(join(SRC_ROOT, 'services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    expect(content).toContain("'CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS'");
  });

  test('CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS has validation in SettingsRoutes', () => {
    const content = readFileSync(join(SRC_ROOT, 'services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    expect(content).toContain('CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS');
    expect(content).toMatch(/between 1 and 2000/);
  });
});

describe('OpenAI base URL settings persistence (fix F)', () => {
  test('CLAUDE_MEM_OPENAI_BASE_URL is in SettingsRoutes write-back allowlist', () => {
    // Without this, BypassLane consumes the key but POST /api/settings silently
    // drops it (200 OK, no effect).
    const content = readFileSync(join(SRC_ROOT, 'services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    expect(content).toContain("'CLAUDE_MEM_OPENAI_BASE_URL'");
  });

  test('CLAUDE_MEM_OPENAI_BASE_URL has http(s) validation in SettingsRoutes', () => {
    const content = readFileSync(join(SRC_ROOT, 'services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    // Must reject non-http(s) / malformed values consistent with the resolver.
    expect(content).toMatch(/CLAUDE_MEM_OPENAI_BASE_URL[\s\S]{0,400}(http|https|valid URL)/);
  });
});

describe('OpenAI base URL validation logic (behavioral, isolated)', () => {
  // validateSettings is pure (no I/O), so we can drive it directly through a
  // fresh instance without touching the production settings file.
  test('rejects a non-http(s) base URL with a 4xx-style validation error', async () => {
    const { SettingsRoutes } = await import('../../src/services/worker/http/routes/SettingsRoutes.js');
    const routes: any = new SettingsRoutes();
    const bad = routes.validateSettings({ CLAUDE_MEM_OPENAI_BASE_URL: 'ftp://evil/v1' });
    expect(bad.valid).toBe(false);
    const ok = routes.validateSettings({ CLAUDE_MEM_OPENAI_BASE_URL: 'https://api.deepseek.com/v1' });
    expect(ok.valid).toBe(true);
    // blank is allowed (means "bypass disabled")
    const blank = routes.validateSettings({ CLAUDE_MEM_OPENAI_BASE_URL: '' });
    expect(blank.valid).toBe(true);
  });
});

describe('Bypass tiered-cooldown / concurrency validation (behavioral, isolated)', () => {
  // validateSettings is pure — drive it directly (same pattern as base URL suite).
  const KEYS: Array<[string, string, string, string]> = [
    // [key, in-range, below-min, above-max]
    ['CLAUDE_MEM_BYPASS_CONCURRENCY', '3', '0', '17'],
    ['CLAUDE_MEM_BYPASS_MAX_CONSUMERS', '6', '0', '65'],
    ['CLAUDE_MEM_BYPASS_MAX_FAILURES', '3', '0', '21'],
    ['CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS', '1800000', '59999', '86400001'],
    ['CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS', '21600000', '59999', '86400001'],
    ['CLAUDE_MEM_BYPASS_COOLDOWN_MS', '180000', '999', '86400001'],
  ];

  test('accepts in-range integers, rejects below-min / above-max / junk / fractional', async () => {
    const { SettingsRoutes } = await import('../../src/services/worker/http/routes/SettingsRoutes.js');
    const routes: any = new SettingsRoutes();
    for (const [key, ok, below, above] of KEYS) {
      expect(routes.validateSettings({ [key]: ok }).valid).toBe(true);
      expect(routes.validateSettings({ [key]: below }).valid).toBe(false);
      expect(routes.validateSettings({ [key]: above }).valid).toBe(false);
      expect(routes.validateSettings({ [key]: '3junk' }).valid).toBe(false);
      expect(routes.validateSettings({ [key]: '1.5' }).valid).toBe(false);
      // empty string = "not provided", passes through (defaults apply)
      expect(routes.validateSettings({ [key]: '' }).valid).toBe(true);
    }
  });

  test('all six keys are in the settingKeys write-back allowlist', () => {
    const content = readFileSync(join(SRC_ROOT, 'services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    for (const [key] of KEYS) {
      expect(content).toContain(`'${key}'`);
    }
  });
});
