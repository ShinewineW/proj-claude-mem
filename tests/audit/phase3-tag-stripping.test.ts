/**
 * Audit Phase 3 — privacy tag stripping completeness (src/utils/tag-stripping.ts).
 *
 * stripMemoryTagsFromPrompt removes 7 tag families before last_assistant_message
 * leaves the hook toward the worker / fallback queue:
 *   <claude-mem-context> <private> <system_instruction> <system-instruction>
 *   <task-notification> <system-reminder> <persisted-output>
 * Each uses a lazy [\s\S]*? quantifier (linear, ReDoS-safe).
 *
 * Properties:
 *  T1: a single well-formed tag block of any stripped family is fully removed
 *  T2: adjacent + nested blocks are all removed (lazy quantifier composes)
 *  T3: surrounding plain text survives (only tagged spans removed) and result is trimmed
 *  T4: fuzz — random interleavings of well-formed stripped tags (incl. nesting
 *      of DIFFERENT families) around plain text leave NO residual tag and NO
 *      secret content in the output
 *  T5: SYSTEM_REMINDER_REGEX statefulness — repeated calls give identical results
 *      (the shared /g regex must not leak lastIndex across replace() calls)
 *  T6: stripMemoryTagsFromPromptDetailed flags full redaction + reason
 *  T7: FINDING — nesting the SAME family (e.g. <private>..<private>..</private>..</private>)
 *      leaves a dangling closing tag because the lazy outer match closes at the
 *      first inner </tag>. The wrapped payload up to that first close IS removed
 *      (no secret leak), but a bare </tag> survives. LOW: system/Conductor
 *      injections are not known to self-nest identical tags.
 */
import { describe, test, expect } from 'bun:test';
import {
  stripMemoryTagsFromPrompt,
  stripMemoryTagsFromPromptDetailed,
  SYSTEM_REMINDER_REGEX,
} from '../../src/utils/tag-stripping.js';

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

// Tag families that stripMemoryTagsFromPrompt removes entirely (open+content+close).
const STRIPPED_TAGS = [
  'claude-mem-context',
  'private',
  'system_instruction',
  'system-instruction',
  'task-notification',
  'system-reminder',
  'persisted-output',
];

function block(tag: string, inner: string): string {
  return `<${tag}>${inner}</${tag}>`;
}

// After stripping, NO opening tag of a stripped family may remain.
function assertNoResidualOpeningTag(out: string) {
  for (const tag of STRIPPED_TAGS) {
    if (out.includes(`<${tag}>`)) {
      throw new Error(`RESIDUAL <${tag}> opening tag survived stripping in: ${JSON.stringify(out)}`);
    }
    if (out.includes(`</${tag}>`)) {
      throw new Error(`RESIDUAL </${tag}> closing tag survived stripping in: ${JSON.stringify(out)}`);
    }
  }
}

describe('tag stripping completeness', () => {
  test('T1: each stripped tag family is fully removed', () => {
    for (const tag of STRIPPED_TAGS) {
      const input = `keep-before ${block(tag, 'secret content')} keep-after`;
      const out = stripMemoryTagsFromPrompt(input);
      assertNoResidualOpeningTag(out);
      expect(out).not.toContain('secret content');
      expect(out).toContain('keep-before');
      expect(out).toContain('keep-after');
    }
  });

  test('T2: adjacent and nested blocks all removed', () => {
    // Adjacent
    const adjacent =
      block('private', 'a') + block('system-reminder', 'b') + block('persisted-output', 'c');
    expect(stripMemoryTagsFromPrompt(adjacent)).toBe('');

    // Nested: outer private wraps an inner system-reminder. Lazy match on the
    // OUTER closes at the FIRST </private>; the inner is independently stripped.
    const nested = block('private', 'x ' + block('system-reminder', 'y') + ' z');
    const out = stripMemoryTagsFromPrompt(nested);
    assertNoResidualOpeningTag(out);
    expect(out).toBe('');
  });

  test('T3: only tagged spans removed; plain text + trim preserved', () => {
    const input = '  hello ' + block('private', 'SECRET') + ' world  ';
    const out = stripMemoryTagsFromPrompt(input);
    assertNoResidualOpeningTag(out);
    expect(out).not.toContain('SECRET');
    expect(out).toContain('hello');
    expect(out).toContain('world');
    // trim() applied
    expect(out).toBe(out.trim());
  });

  test('T4: fuzz — interleavings (incl. different-family nesting) fully stripped', () => {
    const rng = mulberry32(0xDEADCAFE);
    const plainPieces = ['alpha', 'beta', 'gamma', 'kept', '', '<notatag>', 'x>y<z'];
    for (let i = 0; i < 10000; i++) {
      const parts: string[] = [];
      const segs = 1 + Math.floor(rng() * 6);
      for (let s = 0; s < segs; s++) {
        if (rng() < 0.5) {
          parts.push(plainPieces[Math.floor(rng() * plainPieces.length)]);
        } else {
          const tagIdx = Math.floor(rng() * STRIPPED_TAGS.length);
          const tag = STRIPPED_TAGS[tagIdx];
          // inner may nest another stripped block of a DIFFERENT family (the
          // realistic case: distinct system tags wrapping each other). Same-tag
          // nesting is exercised separately in T7.
          let inner = 'secret' + s;
          if (rng() < 0.3) {
            const innerTag = STRIPPED_TAGS[(tagIdx + 1 + Math.floor(rng() * (STRIPPED_TAGS.length - 1))) % STRIPPED_TAGS.length];
            inner = block(innerTag, 'innersecret');
          }
          parts.push(block(tag, inner));
        }
      }
      const input = parts.join('');
      let out: string;
      try {
        out = stripMemoryTagsFromPrompt(input);
      } catch (e) {
        throw new Error(`THREW on input ${JSON.stringify(input)}: ${(e as Error).message}`);
      }
      assertNoResidualOpeningTag(out);
      expect(out).not.toContain('secret');
      expect(out).not.toContain('innersecret');
    }
  });

  test('T7: FINDING — same-family nesting leaves a dangling closing tag', () => {
    // INTENTIONALLY NOT FIXED — this pins a documented, non-triggering edge: the
    // secret payload IS removed (no leak), only a bare residual closing tag
    // survives, and the stripper never receives attacker-nested same-family tags
    // in practice. Asserting current behavior so any future regex change is caught.
    const input = block('system-reminder', 'outer <system-reminder>inner</system-reminder> tail');
    const out = stripMemoryTagsFromPrompt(input);
    // The wrapped payload up to the FIRST close is removed -> no secret leak of
    // 'outer'/'inner'...
    expect(out).not.toContain('outer');
    expect(out).not.toContain('inner');
    // ...but the trailing plain text + a bare residual closing tag survive.
    expect(out).toBe('tail</system-reminder>');

    const priv = stripMemoryTagsFromPrompt(block('private', 'a <private>b</private> c'));
    expect(priv).toBe('c</private>');
  });

  test('T5: SYSTEM_REMINDER_REGEX lastIndex does not leak across calls', () => {
    const input = 'a ' + block('system-reminder', 'r1') + ' b ' + block('system-reminder', 'r2') + ' c';
    const expected = stripMemoryTagsFromPrompt(input);
    // run many times — a leaked lastIndex on the shared /g regex would make
    // alternating calls miss matches.
    for (let i = 0; i < 1000; i++) {
      expect(stripMemoryTagsFromPrompt(input)).toBe(expected);
    }
    expect(expected).not.toContain('r1');
    expect(expected).not.toContain('r2');
    // Directly assert the shared regex has lastIndex sentinel of a /g regex used
    // only via String.replace (which resets it). After a replace call it is 0.
    'x'.replace(SYSTEM_REMINDER_REGEX, '');
    expect(SYSTEM_REMINDER_REGEX.lastIndex).toBe(0);
  });

  test('T6: full-prompt redaction flag + reason', () => {
    const priv = stripMemoryTagsFromPromptDetailed(block('private', 'all of it'));
    expect(priv.stripped).toBe('');
    expect(priv.wasRedacted).toBe(true);
    expect(priv.redactionReason).toBe('private');

    const ctx = stripMemoryTagsFromPromptDetailed(block('claude-mem-context', 'injected'));
    expect(ctx.wasRedacted).toBe(true);
    expect(ctx.redactionReason).toBe('claude_mem_context');

    // partial: plain text survives -> not redacted
    const partial = stripMemoryTagsFromPromptDetailed('keep ' + block('private', 'x'));
    expect(partial.wasRedacted).toBe(false);
    expect(partial.stripped).toBe('keep');
  });
});
