/**
 * Regression (oh-my-codex final-gate finding): settings.json can hold API keys
 * (CLAUDE_MEM_GEMINI_API_KEY / CLAUDE_MEM_OPENCODE_API_KEY), so EVERY path that
 * CREATES it must produce an owner-only (0600) file, not a umask-dependent 0644.
 * The C2-T3 fix hardened the SettingsRoutes POST/save path but initially missed
 * the auto-create paths: SettingsDefaultsManager.loadFromFile() (first-create +
 * nested->flat schema migration) and SettingsRoutes.ensureSettingsFile().
 *
 * Source-inspection guard: SettingsDefaultsManager is mock.module'd by 15+ test
 * files, so importing it real is unreliable in full-suite runs (tests/CLAUDE.md
 * convention). A behavioral mode check runs out-of-suite during verification.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const sdmSrc = readFileSync(
  join(import.meta.dir, '../../src/shared/SettingsDefaultsManager.ts'),
  'utf-8',
);
const routesSrc = readFileSync(
  join(import.meta.dir, '../../src/services/worker/http/routes/SettingsRoutes.ts'),
  'utf-8',
);

describe('settings.json owner-only creation (C2-T3 completeness)', () => {
  it('SettingsDefaultsManager imports chmodSync', () => {
    expect(/import\s*\{[^}]*\bchmodSync\b[^}]*\}\s*from\s*["']fs["']/.test(sdmSrc)).toBe(true);
  });

  it('both SettingsDefaultsManager create paths set mode 0o600 + chmodSync (auto-create + migration)', () => {
    expect((sdmSrc.match(/mode:\s*0o600/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((sdmSrc.match(/chmodSync\(\s*settingsPath\s*,\s*0o600\s*\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('SettingsRoutes hardens BOTH the POST save and the ensureSettingsFile create paths', () => {
    expect((routesSrc.match(/mode:\s*0o600/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((routesSrc.match(/chmodSync\(\s*settingsPath\s*,\s*0o600\s*\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
