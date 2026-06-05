/**
 * Audit Phase 3 — parseFileList robustness (#1359).
 *
 * parseFileList feeds the files-for-session aggregation query. A throw here
 * crashes the aggregation across the WHOLE session, so the contract is:
 * never throw on any DB string, return string[], and at worst lose fidelity.
 *
 * Properties:
 *  F1: never throws on arbitrary/adversarial strings, always returns an Array
 *      (the load-bearing "don't crash the aggregation query" invariant — HOLDS)
 *  F3: round-trips JSON arrays of strings (JSON.stringify(arr) -> arr)
 *  F4: legacy bare-path / non-array JSON wraps to [String(parsed)]
 *  F5: invalid JSON wraps to [value] (the raw string), not a throw
 *  F6: null/undefined/'' -> []
 *  F2c: FIXED — a JSON array of NON-strings ([1,2,3], [null], [{}]) is now
 *       mapped through String() so parseFileList honors its `string[]` contract.
 *       (Previously returned un-coerced elements; fixed in the Stage-4 H/I fix.)
 */
import { describe, test, expect } from 'bun:test';
import { parseFileList } from '../../src/services/sqlite/observations/files.js';

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

// Chars chosen to break naive JSON parsing: quotes, brackets, escapes, control.
const CHARS = ['"', "'", '[', ']', '{', '}', ',', ':', '\\', '/', '.', '\n', '\t', '\x00', 'a', '1', ' ', 'n', 'u', 'l', 't', 'r', 'e'];

function randDbString(rng: () => number): string {
  const len = Math.floor(rng() * 40);
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(rng() * CHARS.length)];
  return s;
}

describe('parseFileList robustness (#1359)', () => {
  test('F1: never throws and always returns an Array (fuzz arbitrary input)', () => {
    const rng = mulberry32(0xBADF00D);
    for (let i = 0; i < 20000; i++) {
      const input = randDbString(rng);
      let out: unknown;
      try {
        out = parseFileList(input);
      } catch (e) {
        throw new Error(`THREW on input ${JSON.stringify(input)}: ${(e as Error).message}`);
      }
      expect(Array.isArray(out)).toBe(true);
    }
  });

  test('F1b: never throws on injected JSON-fragment seeds (returns an Array)', () => {
    const seeds = [
      '[', ']', '[]', '[1', '{"a":1}', 'null', 'true', 'false', '42', '"x"',
      '[null]', '[1,2,3]', '["a",1,null,true]', '\\', '"', '[[[[', '{{{{',
      'NaN', 'undefined', '[,]', '[1,]', '["a"', 'Infinity', '-0',
    ];
    for (const s of seeds) {
      const out = parseFileList(s);
      expect(Array.isArray(out)).toBe(true);
    }
  });

  test('F2c: FIXED — JSON array of non-strings is String()-coerced (string[] contract)', () => {
    // The array branch now maps every element through String(), honoring the
    // `string[]` return type. Primitives stringify to their literal form; null
    // and objects stringify to 'null' / '[object Object]'.
    expect(parseFileList('[1,2,3]')).toEqual(['1', '2', '3']);
    expect(parseFileList('[1,2,3]').map(x => typeof x)).toEqual(['string', 'string', 'string']);
    expect(parseFileList('[null]')).toEqual(['null']);
    expect(parseFileList('[{}]')).toEqual(['[object Object]']);
    // Mixed array: the string stays, the number is stringified.
    expect(parseFileList('["a",1]')).toEqual(['a', '1']);
    // All elements are strings now.
    expect(parseFileList('["a",1]').every(x => typeof x === 'string')).toBe(true);
  });

  test('F3: round-trips JSON arrays of strings', () => {
    const rng = mulberry32(0x5EED5);
    for (let i = 0; i < 5000; i++) {
      const n = Math.floor(rng() * 5);
      const arr: string[] = [];
      for (let j = 0; j < n; j++) arr.push('/path/' + randDbString(rng));
      const serialized = JSON.stringify(arr);
      const out = parseFileList(serialized);
      expect(out).toEqual(arr);
    }
  });

  test('F4: non-array JSON wraps to [String(parsed)]', () => {
    expect(parseFileList('42')).toEqual(['42']);
    expect(parseFileList('true')).toEqual(['true']);
    expect(parseFileList('"hello"')).toEqual(['hello']);
    // value='null' is truthy (non-empty string), JSON.parse yields null (not an
    // array), so it wraps String(null) === 'null'.
    expect(parseFileList('null')).toEqual(['null']);
  });

  test('F5: legacy bare path / invalid JSON wraps to [value]', () => {
    expect(parseFileList('/foo/bar.ts')).toEqual(['/foo/bar.ts']);
    expect(parseFileList('C:\\x\\y.ts')).toEqual(['C:\\x\\y.ts']);
    expect(parseFileList('not json at all')).toEqual(['not json at all']);
    expect(parseFileList('[unclosed')).toEqual(['[unclosed']);
  });

  test('F6: null/undefined/empty -> []', () => {
    expect(parseFileList(null)).toEqual([]);
    expect(parseFileList(undefined)).toEqual([]);
    expect(parseFileList('')).toEqual([]);
  });
});
