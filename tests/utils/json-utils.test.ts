import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readdirSync, statSync, lstatSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeJsonFileAtomic } from '../../src/utils/json-utils.js';

const baseDir = join(tmpdir(), `json-utils-test-${Date.now()}`);

beforeEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  mkdirSync(baseDir, { recursive: true });
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('writeJsonFileAtomic', () => {
  it('writes JSON with trailing newline', () => {
    const f = join(baseDir, 'a.json');
    writeJsonFileAtomic(f, { hello: 'world' });
    const raw = readFileSync(f, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ hello: 'world' });
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('creates the parent directory if missing', () => {
    const f = join(baseDir, 'nested', 'deep', 'b.json');
    writeJsonFileAtomic(f, { x: 1 });
    expect(existsSync(f)).toBe(true);
  });

  it('leaves no temp files behind on success', () => {
    const f = join(baseDir, 'c.json');
    writeJsonFileAtomic(f, { a: 1 });
    const leftovers = readdirSync(baseDir).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('writes THROUGH a symlinked destination (does not replace the link)', () => {
    const realTarget = join(baseDir, 'real.json');
    writeFileSync(realTarget, '{"v":0}\n');
    const link = join(baseDir, 'link.json');
    symlinkSync(realTarget, link);

    writeJsonFileAtomic(link, { v: 42 });

    // The symlink must still be a symlink...
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // ...and the real target must hold the new content.
    expect(JSON.parse(readFileSync(realTarget, 'utf-8'))).toEqual({ v: 42 });
  });

  it('preserves existing file mode bits AND replaces content', () => {
    const f = join(baseDir, 'mode.json');
    writeFileSync(f, '{}\n', { mode: 0o640 });
    writeJsonFileAtomic(f, { y: 2 });
    expect(statSync(f).mode & 0o777).toBe(0o640);
    // Verify the OLD content is actually REPLACED with the NEW content (guards
    // against a future refactor that skips/partially-writes the file).
    expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual({ y: 2 });
  });
});
