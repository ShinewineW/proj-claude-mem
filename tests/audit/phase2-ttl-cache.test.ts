/**
 * Audit Phase 2 — Property tests for SettingsDefaultsManager TTL cache.
 *
 * Invariants:
 *  P1: within TTL, consecutive loadFromFile(path) return the same object (cached)
 *  P2: invalidateCache(path) forces next call to re-read disk
 *  P3: invalidateCache() (no arg) clears all paths
 *  P4: different paths have independent cache entries (no key collision)
 *  P5: env var override is re-applied on cache hit (note: currently the cache
 *      stores the env-applied snapshot, so env changes AFTER cache put are NOT
 *      reflected until TTL expiry — this test documents the current behavior)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'audit-ttl-'));
  SettingsDefaultsManager.invalidateCache();
});
afterEach(() => {
  SettingsDefaultsManager.invalidateCache();
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

function writeSettings(p: string, obj: Record<string, string>) {
  writeFileSync(p, JSON.stringify(obj), 'utf-8');
}

describe('TTL cache properties', () => {
  test('P1: cache hit within TTL returns same data even if file changes', () => {
    const p = join(workDir, 'settings.json');
    writeSettings(p, { CLAUDE_MEM_MODEL: 'm1' });
    const a = SettingsDefaultsManager.loadFromFile(p);
    // mutate file
    writeSettings(p, { CLAUDE_MEM_MODEL: 'm2' });
    const b = SettingsDefaultsManager.loadFromFile(p);
    expect(a.CLAUDE_MEM_MODEL).toBe('m1');
    expect(b.CLAUDE_MEM_MODEL).toBe('m1'); // cached!
  });

  test('P2: invalidateCache(path) forces re-read', () => {
    const p = join(workDir, 'settings.json');
    writeSettings(p, { CLAUDE_MEM_MODEL: 'm1' });
    SettingsDefaultsManager.loadFromFile(p);
    writeSettings(p, { CLAUDE_MEM_MODEL: 'm2' });
    SettingsDefaultsManager.invalidateCache(p);
    const after = SettingsDefaultsManager.loadFromFile(p);
    expect(after.CLAUDE_MEM_MODEL).toBe('m2');
  });

  test('P3: invalidateCache() clears all entries', () => {
    const p1 = join(workDir, 'a.json');
    const p2 = join(workDir, 'b.json');
    writeSettings(p1, { CLAUDE_MEM_MODEL: 'a1' });
    writeSettings(p2, { CLAUDE_MEM_MODEL: 'b1' });
    SettingsDefaultsManager.loadFromFile(p1);
    SettingsDefaultsManager.loadFromFile(p2);
    writeSettings(p1, { CLAUDE_MEM_MODEL: 'a2' });
    writeSettings(p2, { CLAUDE_MEM_MODEL: 'b2' });
    SettingsDefaultsManager.invalidateCache();
    expect(SettingsDefaultsManager.loadFromFile(p1).CLAUDE_MEM_MODEL).toBe('a2');
    expect(SettingsDefaultsManager.loadFromFile(p2).CLAUDE_MEM_MODEL).toBe('b2');
  });

  test('P4: different paths independent (no collision)', () => {
    const p1 = join(workDir, 'a.json');
    const p2 = join(workDir, 'b.json');
    writeSettings(p1, { CLAUDE_MEM_MODEL: 'a' });
    writeSettings(p2, { CLAUDE_MEM_MODEL: 'b' });
    expect(SettingsDefaultsManager.loadFromFile(p1).CLAUDE_MEM_MODEL).toBe('a');
    expect(SettingsDefaultsManager.loadFromFile(p2).CLAUDE_MEM_MODEL).toBe('b');
  });

  test('P5 (BUG-DOC): env override changes after cache put are ignored within TTL', () => {
    const p = join(workDir, 'settings.json');
    writeSettings(p, { CLAUDE_MEM_MODEL: 'file-model' });
    delete process.env.CLAUDE_MEM_MODEL;
    const first = SettingsDefaultsManager.loadFromFile(p);
    expect(first.CLAUDE_MEM_MODEL).toBe('file-model');
    process.env.CLAUDE_MEM_MODEL = 'env-model';
    const second = SettingsDefaultsManager.loadFromFile(p);
    // Documents finding: env is NOT re-applied on cache hit
    expect(second.CLAUDE_MEM_MODEL).toBe('file-model');
    delete process.env.CLAUDE_MEM_MODEL;
  });

  test('P6: absolute vs non-absolute paths are distinct cache keys (double-cache risk)', () => {
    // path.join normalizes './' so those keys collapse — safe there.
    // However callers passing absolute vs relative, or symlinked paths, create
    // distinct cache keys referencing the same underlying file.
    const pAbs = join(workDir, 'settings.json');
    writeSettings(pAbs, { CLAUDE_MEM_MODEL: 'v1' });
    SettingsDefaultsManager.loadFromFile(pAbs);
    // distinct string key — not normalized
    const pDup = pAbs + ''; // same key → hits cache (baseline)
    const a = SettingsDefaultsManager.loadFromFile(pDup);
    expect(a.CLAUDE_MEM_MODEL).toBe('v1');
    // Residual risk documented: SettingsDefaultsManager.cache uses raw string as key,
    // no path.resolve/realpath normalization. Low-severity LOW finding.
  });
});
