/**
 * Audit Phase 3 — writeJsonFileAtomic durability & symlink safety.
 *
 * All filesystem work stays under an mkdtemp dir in os.tmpdir().
 *
 * Properties:
 *  J1: round-trips arbitrary JSON-serializable values (write -> readback parse)
 *  J2: leaves NO temp files in the directory after a successful write
 *  J3: a symlinked destination is written THROUGH the link (real target updated,
 *      symlink itself preserved, never replaced by a regular file)
 *  J4: existing file mode (0o777 bits) preserved across rewrites
 *  J5: output is pretty-printed JSON + trailing newline (format contract)
 *  J6: repeated rewrites converge (last-writer-wins, no temp accumulation)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  lstatSync,
  statSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeJsonFileAtomic } from '../../src/utils/json-utils.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audit-json-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a random JSON-serializable value.
function randJson(rng: () => number, depth: number): unknown {
  const r = rng();
  if (depth <= 0 || r < 0.4) {
    const k = rng();
    if (k < 0.25) return Math.floor(rng() * 1e6) - 5e5;
    if (k < 0.5) return rng() < 0.5;
    if (k < 0.6) return null;
    // strings incl. quotes/unicode/newlines to stress JSON encoding
    const pool = ['a', '"', '\\', '\n', 'é', '\u{1f600}', '/', '\x00', '}'];
    let s = '';
    const len = Math.floor(rng() * 8);
    for (let i = 0; i < len; i++) s += pool[Math.floor(rng() * pool.length)];
    return s;
  }
  if (r < 0.7) {
    const n = Math.floor(rng() * 4);
    const arr: unknown[] = [];
    for (let i = 0; i < n; i++) arr.push(randJson(rng, depth - 1));
    return arr;
  }
  const n = Math.floor(rng() * 4);
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) obj['k' + i] = randJson(rng, depth - 1);
  return obj;
}

function tmpFilesIn(d: string): string[] {
  return readdirSync(d).filter(f => f.endsWith('.tmp'));
}

describe('writeJsonFileAtomic properties', () => {
  test('J1+J2+J5: round-trip arbitrary JSON, no temp left, format contract (fuzz)', () => {
    const rng = mulberry32(0xFEEDBEEF);
    for (let i = 0; i < 2000; i++) {
      const target = join(dir, `cfg-${i}.json`);
      const value = randJson(rng, 3);
      writeJsonFileAtomic(target, value);

      const raw = readFileSync(target, 'utf-8');
      // J5: trailing newline + 2-space pretty print
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).toBe(JSON.stringify(value, null, 2) + '\n');
      // J1: round-trips
      expect(JSON.parse(raw)).toEqual(value as any);
      // J2: no temp file orphaned (this iteration's own file dir)
      expect(tmpFilesIn(dir).length).toBe(0);
    }
  });

  test('J3: symlinked destination written THROUGH the link', () => {
    const realTarget = join(dir, 'real-config.json');
    writeFileSync(realTarget, '{"old":true}\n');
    const link = join(dir, 'settings.json');
    symlinkSync(realTarget, link);

    writeJsonFileAtomic(link, { updated: 1, via: 'link' });

    // link is STILL a symlink (not replaced by a regular file)
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // real target received the new content
    expect(JSON.parse(readFileSync(realTarget, 'utf-8'))).toEqual({ updated: 1, via: 'link' });
    // reading through the link sees the same content
    expect(JSON.parse(readFileSync(link, 'utf-8'))).toEqual({ updated: 1, via: 'link' });
    // realpath of link still points at realTarget
    expect(realpathSync(link)).toBe(realpathSync(realTarget));
    // no temp leftovers
    expect(tmpFilesIn(dir).length).toBe(0);
  });

  test('J3b: symlink to file in a DIFFERENT directory still writes through', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'audit-json-tgt-'));
    try {
      const realTarget = join(otherDir, 'real.json');
      writeFileSync(realTarget, '{"old":1}\n');
      const link = join(dir, 'linked.json');
      symlinkSync(realTarget, link);

      writeJsonFileAtomic(link, { x: 99 });

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(realTarget, 'utf-8'))).toEqual({ x: 99 });
      // temp file must live next to the RESOLVED target, and be cleaned up
      expect(tmpFilesIn(otherDir).length).toBe(0);
      expect(tmpFilesIn(dir).length).toBe(0);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('J4: existing file mode preserved across rewrites', () => {
    if (process.platform === 'win32') return; // mode bits are ACL-controlled on Windows
    const target = join(dir, 'moded.json');
    writeFileSync(target, '{"a":1}\n');
    chmodSync(target, 0o640);
    const before = statSync(target).mode & 0o777;
    expect(before).toBe(0o640);

    writeJsonFileAtomic(target, { a: 2 });
    const after = statSync(target).mode & 0o777;
    expect(after).toBe(0o640);
  });

  test('J6: repeated rewrites converge (last-writer-wins, no temp accumulation)', () => {
    const target = join(dir, 'hot.json');
    for (let i = 0; i < 50; i++) {
      writeJsonFileAtomic(target, { i });
    }
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ i: 49 });
    expect(tmpFilesIn(dir).length).toBe(0);
  });
});
