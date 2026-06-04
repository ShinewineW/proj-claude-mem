import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync, chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// POSIX permission bits only matter off-win32.
const isWin = process.platform === 'win32';

describe('credential file permissions (0600 file / 0700 dir)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-perms-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(isWin)('writeFileSync mode 0o600 + chmodSync yields owner-only file', () => {
    // Mirrors the EnvManager.saveClaudeMemEnv write path exactly.
    const f = join(dir, '.env');
    writeFileSync(f, 'ANTHROPIC_API_KEY=secret\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(f, 0o600);
    const mode = statSync(f).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(isWin)('mkdirSync mode 0o700 + chmodSync yields owner-only dir', () => {
    const d = join(dir, 'sub');
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
    const mode = statSync(d).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

// Source-level guards: pin that the production writers actually set 0600/0700.
// (The dynamic test above proves the OS honors the bits; these prove the code
//  uses them, without writing to the real ~/.claude-mem.)
import { readFileSync } from 'fs';
describe('source guards: writers set restrictive permissions', () => {
  it('EnvManager imports chmodSync and chmods .env (0600) + dir (0700)', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../src/shared/EnvManager.ts'),
      'utf-8',
    );
    expect(src).toMatch(/import\s*\{[^}]*chmodSync[^}]*\}\s*from\s*['"]fs['"]/);
    expect(src).toContain('mode: 0o700');
    expect(src).toContain('chmodSync(DATA_DIR, 0o700)');
    expect(src).toMatch(/mode:\s*0o600/);
    expect(src).toContain('chmodSync(ENV_FILE_PATH, 0o600)');
  });

  it('SettingsRoutes chmods settings.json to 0600 after write', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../src/services/worker/http/routes/SettingsRoutes.ts'),
      'utf-8',
    );
    expect(src).toMatch(/import\s*\{[^}]*chmodSync[^}]*\}\s*from\s*['"]fs['"]/);
    expect(src).toMatch(/mode:\s*0o600/);
    expect(src).toContain('chmodSync(settingsPath, 0o600)');
  });
});
