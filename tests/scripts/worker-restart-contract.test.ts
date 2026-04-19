/**
 * Contract / structural smoke tests for scripts/lib/worker-restart.cjs.
 *
 * This shared helper is loaded by both sync-to-cache.cjs and
 * sync-marketplace.cjs (commit d5c0e69a). Before the refactor, each sync
 * script had its own copy of the shutdown-spawn-poll loop, and regressions
 * would silently print "Worker restart triggered" even when the daemon
 * never came back.
 *
 * Behavioural integration coverage (real HTTP server / real spawn) is not
 * in scope for these tests — that would require a full worker harness.
 * What we pin here is the MODULE CONTRACT that the sync scripts depend on:
 *
 *   - `restartWorker` is exported as a named function
 *   - `triggerShutdown` and `healthOk` are NOT exported (keep internal)
 *   - `restartWorker` accepts an options object (opt-ional args only)
 *
 * Any refactor that renames / drops / changes the arity of the export will
 * trigger a loud failure here instead of a silent "restart triggered" lie
 * at deploy time.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const PROJECT_ROOT = join(import.meta.dir, '..', '..');
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'lib', 'worker-restart.cjs');

const nodeRequire = createRequire(import.meta.url);

describe('scripts/lib/worker-restart.cjs — module contract', () => {
  it('script file exists at the expected path', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('exports restartWorker as a named function', () => {
    const mod = nodeRequire(SCRIPT_PATH);
    expect(typeof mod.restartWorker).toBe('function');
  });

  it('restartWorker takes a single options object (arity <= 1)', () => {
    // A downstream caller will hit the default branch for every option.
    // If someone converts this to positional args the sync scripts break.
    const mod = nodeRequire(SCRIPT_PATH);
    expect(mod.restartWorker.length).toBeLessThanOrEqual(1);
  });

  it('does NOT export internal helpers (triggerShutdown, healthOk)', () => {
    // These are intentionally private — sync scripts should call
    // restartWorker(), not recompose the shutdown+poll loop themselves.
    const mod = nodeRequire(SCRIPT_PATH);
    expect(mod.triggerShutdown).toBeUndefined();
    expect(mod.healthOk).toBeUndefined();
  });

  it('drives a full shutdown → spawn → poll cycle (not a fire-and-forget POST)', () => {
    // Source-level pin: the file must contain the signature calls of a
    // real cycle, not just the old "POST /api/admin/restart + return"
    // pattern that silently failed (see commit d5c0e69a root cause).
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toContain('/api/admin/restart');
    expect(src).toContain('/api/health');
    expect(src).toContain('execFileSync');
    // Two spawn attempts required — single attempt reintroduces the race
    // that 5df65b55 fixed.
    expect(src).toMatch(/attempt\s*<=\s*2|attempt\s*=\s*1;\s*attempt\s*<=\s*2/);
  });

  it('surfaces spawn stderr on failure (not silent exit)', () => {
    // d5c0e69a Finding 2: the old restartWorker used stdio: 'ignore',
    // hiding the plugin-path bug for weeks. Pin that stderr capture is
    // present.
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/stdio:\s*['"]pipe['"]/);
    expect(src).toContain('err.stderr');
  });

  it('polls /api/health with a bounded deadline (no infinite wait)', () => {
    // The health poll must have a wall-clock bound — an unbounded loop
    // would hang the build-and-sync script if the worker never came up.
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/Date\.now\(\)\s*\+\s*10_?000/);
    expect(src).toMatch(/while\s*\(\s*Date\.now\(\)\s*<\s*deadline\s*\)/);
  });
});
