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
