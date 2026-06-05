/**
 * Audit Phase 3 — computeObservationContentHash dedup-identity properties.
 *
 * The dedup hash is the semantic identity of an observation:
 * H(memory_session_id, title, narrative). A boundary-ambiguous join would let
 * two DISTINCT (sid, title, narrative) tuples hash to the same value, causing a
 * genuinely-different observation to be silently dropped as a duplicate inside
 * the 30s DEDUP_WINDOW_MS.
 *
 * Properties:
 *  H1: shape — always 16 lowercase hex chars
 *  H2: determinism — same tuple -> same hash
 *  H3: delimiter unambiguity for DELIMITER-FREE inputs — distinct field vectors
 *      whose values never contain the \x00 join byte must NOT collide (the join
 *      must be injective on the FIELD VECTOR, modulo the documented `|| ''`
 *      nullish coercion). [FINDING: injectivity FAILS once a field value itself
 *      contains \x00 — see H3c. NUL bytes are not produced by the XML observation
 *      parser, so this is a theoretical boundary, not a live data-loss path.]
 *  H4: per-field sensitivity — changing exactly one field changes the hash
 *  H5: nullish coercion is the ONLY collapsing behavior (null/undefined/'' equal,
 *      but nothing else collapses)
 */
import { describe, test, expect } from 'bun:test';
import { computeObservationContentHash } from '../../src/services/sqlite/observations/store.js';
import { computeSummaryContentHash } from '../../src/services/sqlite/summaries/store.js';

// --- deterministic PRNG (mulberry32) so failures are reproducible -------------
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

// Realistic alphabet: the chars an XML-parsed title/narrative can contain.
// Deliberately EXCLUDES the \x00 join byte — H3 asserts injectivity over the
// inputs the function actually receives. H3c separately probes the \x00 boundary.
const ALPHABET = ['a', 'b', '/', '.', '\n', '<', '>', '\\', ' ', 'x', '1'];

function randStr(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * (maxLen + 1));
  let s = '';
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return s;
}

type Field = string | null;
function randField(rng: () => number): Field {
  const r = rng();
  if (r < 0.08) return null;
  return randStr(rng, 6);
}

// Canonical form for the `|| ''` coercion the implementation applies. Two field
// vectors that share this canonical form are *expected* to collide; everything
// else must not.
function canon(f: Field): string {
  return f || '';
}

const HEX16 = /^[0-9a-f]{16}$/;

describe('computeObservationContentHash properties', () => {
  test('H1+H2: shape is 16 hex and deterministic (fuzz)', () => {
    const rng = mulberry32(0xC0FFEE);
    for (let i = 0; i < 5000; i++) {
      const sid = randField(rng);
      const title = randField(rng);
      const narr = randField(rng);
      const h1 = computeObservationContentHash(sid as any, title, narr);
      const h2 = computeObservationContentHash(sid as any, title, narr);
      expect(h1).toMatch(HEX16);
      expect(h1).toBe(h2);
    }
  });

  test('H3: distinct (delimiter-free) field vectors never collide', () => {
    const rng = mulberry32(0x1234abcd);
    // Map canonical-tuple -> hash. A collision between two DIFFERENT canonical
    // tuples is a real dedup bug (false-positive dedup => data loss).
    const seen = new Map<string, string>(); // hash -> canonical key
    let collisions: Array<{ a: string; b: string; hash: string }> = [];

    for (let i = 0; i < 60000; i++) {
      const v: [Field, Field, Field] = [randField(rng), randField(rng), randField(rng)];
      const key = [canon(v[0]), canon(v[1]), canon(v[2])].map(s => JSON.stringify(s)).join('|');
      const hash = computeObservationContentHash(v[0] as any, v[1], v[2]);

      const prevKey = seen.get(hash);
      if (prevKey !== undefined) {
        if (prevKey !== key) {
          collisions.push({ a: prevKey, b: key, hash });
        }
      } else {
        seen.set(hash, key);
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `COLLISION between distinct field vectors:\n` +
          collisions.slice(0, 5).map(c => `  hash=${c.hash}\n    A=${c.a}\n    B=${c.b}`).join('\n')
      );
    }
    expect(collisions.length).toBe(0);
  });

  test('H3c: FINDING — delimiter-injection (\\x00 in a field) DOES collide', () => {
    // INTENTIONALLY NOT FIXED — pins a documented, non-triggering edge.
    // Documented limitation of a delimiter-join hash: if a field value itself
    // contains the \x00 join byte, boundary ambiguity returns. ("", "", "\x00")
    // and ("", "\x00", "") both serialize to "\x00\x00" before hashing.
    // This is a LOW-severity theoretical boundary: the XML observation parser
    // never emits NUL bytes into title/narrative, so distinct real observations
    // cannot reach this collision. Pinned here so any future change to the join
    // strategy (or any path that lets NUL into these fields) is caught.
    const a = computeObservationContentHash('', '', '\x00');
    const b = computeObservationContentHash('', '\x00', '');
    expect(a).toBe(b); // collision — distinct field vectors, same hash
  });

  test('H3b: targeted boundary-shift attack does not collide', () => {
    // Without a delimiter, ("ab","",  "c") and ("a","b","c") and ("","ab","c")
    // would all concat to "abc". The \x00 join must keep them distinct.
    const variants: Array<[string, string, string]> = [
      ['ab', '', 'c'],
      ['a', 'b', 'c'],
      ['', 'ab', 'c'],
      ['abc', '', ''],
      ['', '', 'abc'],
      ['a', '', 'bc'],
    ];
    const hashes = variants.map(v => computeObservationContentHash(v[0], v[1], v[2]));
    const unique = new Set(hashes);
    expect(unique.size).toBe(variants.length);
  });

  test('H4: changing one field changes the hash (sensitivity)', () => {
    const rng = mulberry32(0x55aa55aa);
    for (let i = 0; i < 3000; i++) {
      const sid = randStr(rng, 6) + 'S'; // non-empty so canon != ''
      const title = randStr(rng, 6) + 'T';
      const narr = randStr(rng, 6) + 'N';
      const base = computeObservationContentHash(sid, title, narr);
      // perturb each field with a guaranteed-different value
      expect(computeObservationContentHash(sid + 'Z', title, narr)).not.toBe(base);
      expect(computeObservationContentHash(sid, title + 'Z', narr)).not.toBe(base);
      expect(computeObservationContentHash(sid, title, narr + 'Z')).not.toBe(base);
    }
  });

  test('H5: null/undefined/empty coerce identically and nothing else collapses', () => {
    const base = computeObservationContentHash('s', 't', 'n');
    expect(computeObservationContentHash('s', '' as any, 'n')).not.toBe(base);
    // The documented coercion: null / undefined / '' are equal for any position.
    expect(computeObservationContentHash(null as any, 't', 'n'))
      .toBe(computeObservationContentHash('' as any, 't', 'n'));
    expect(computeObservationContentHash('s', null, 'n'))
      .toBe(computeObservationContentHash('s', '', 'n'));
    expect(computeObservationContentHash('s', undefined as any, 'n'))
      .toBe(computeObservationContentHash('s', null, 'n'));
    expect(computeObservationContentHash('s', 't', null))
      .toBe(computeObservationContentHash('s', 't', ''));
  });
});

describe('computeSummaryContentHash properties (fix H — same \\x00-join footgun)', () => {
  test('S1+S2: shape is 16 hex and deterministic', () => {
    const h1 = computeSummaryContentHash('ms-1', 'req', 'inv');
    const h2 = computeSummaryContentHash('ms-1', 'req', 'inv');
    expect(h1).toMatch(HEX16);
    expect(h1).toBe(h2);
  });

  test('S3: boundary-shifted fields must NOT collide (the H fix)', () => {
    // Before the fix, fields were raw-concatenated (sid + req + inv), so distinct
    // tuples whose concatenations are equal hashed identically -> false dedup.
    // ("a","b","") and ("a","","b") and ("ab","","") and ("","ab","") and
    // ("","","ab") all concat to "ab" after the sid; the \x00 join keeps them
    // distinct.
    const variants: Array<[string, string | null, string | null]> = [
      ['a', 'b', ''],
      ['a', '', 'b'],
      ['ab', '', ''],
      ['', 'ab', ''],
      ['', '', 'ab'],
      ['', 'a', 'b'],
    ];
    const hashes = variants.map(v => computeSummaryContentHash(v[0], v[1], v[2]));
    expect(new Set(hashes).size).toBe(variants.length);
  });

  test('S4: per-field sensitivity — changing one field changes the hash', () => {
    const base = computeSummaryContentHash('ms', 'req', 'inv');
    expect(computeSummaryContentHash('ms2', 'req', 'inv')).not.toBe(base);
    expect(computeSummaryContentHash('ms', 'req2', 'inv')).not.toBe(base);
    expect(computeSummaryContentHash('ms', 'req', 'inv2')).not.toBe(base);
  });

  test('S5: null/empty coercion is the only collapsing behavior', () => {
    expect(computeSummaryContentHash('ms', null, 'inv'))
      .toBe(computeSummaryContentHash('ms', '', 'inv'));
    expect(computeSummaryContentHash('ms', 'req', null))
      .toBe(computeSummaryContentHash('ms', 'req', ''));
    // default investigated arg is null -> same as ''
    expect(computeSummaryContentHash('ms', 'req'))
      .toBe(computeSummaryContentHash('ms', 'req', ''));
  });
});
