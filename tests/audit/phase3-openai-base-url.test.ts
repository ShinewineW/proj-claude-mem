/**
 * Audit Phase 3 — resolveOpenAICompatibleChatCompletionsUrl normalization.
 *
 * Rules under test (src/shared/openai-compatible-base-url.ts):
 *   - unset/blank  -> defaultUrl verbatim (backward compat)
 *   - already ends in /chat/completions (case-insensitive, trailing / stripped)
 *     -> used verbatim (no double-append)
 *   - otherwise -> /chat/completions appended exactly once
 *
 * Properties:
 *  U1: blank/whitespace/null/undefined -> defaultUrl (unchanged)
 *  U2: idempotence — resolve(resolve(x)) === resolve(x) for any configured x
 *  U3: output always ends in /chat/completions (case-preserved suffix appended,
 *      or pre-existing suffix preserved as-is) and never double-appends
 *  U4: trailing slashes are collapsed before the suffix decision
 *  U5: case-insensitive suffix detection (no double append for CHAT/COMPLETIONS)
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveOpenAICompatibleChatCompletionsUrl,
  DEFAULT_OPENCODE_API_URL,
} from '../../src/shared/openai-compatible-base-url.js';

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

const SUFFIX = '/chat/completions';
const DEF = DEFAULT_OPENCODE_API_URL;

// Random-ish base URL fragments, including trailing slashes and case variants.
const HOSTS = ['https://api.deepseek.com/v1', 'http://localhost:1234/v1', 'https://x.y/zen/go/v1', 'HTTPS://API.X.COM'];
const TRAILERS = ['', '/', '//', '///'];
const SUFFIXES = ['', SUFFIX, '/CHAT/COMPLETIONS', '/Chat/Completions', SUFFIX + '/', SUFFIX + '//'];

function randUrl(rng: () => number): string {
  const host = HOSTS[Math.floor(rng() * HOSTS.length)];
  const suf = SUFFIXES[Math.floor(rng() * SUFFIXES.length)];
  const tr = TRAILERS[Math.floor(rng() * TRAILERS.length)];
  return host + suf + tr;
}

describe('resolveOpenAICompatibleChatCompletionsUrl', () => {
  test('U1: blank/null/undefined -> defaultUrl', () => {
    for (const blank of ['', '   ', '\t\n', null, undefined]) {
      expect(resolveOpenAICompatibleChatCompletionsUrl(blank as any, DEF)).toBe(DEF);
    }
  });

  test('U2: idempotent for any configured URL (fuzz)', () => {
    const rng = mulberry32(0xABCDEF);
    for (let i = 0; i < 20000; i++) {
      const input = randUrl(rng);
      const once = resolveOpenAICompatibleChatCompletionsUrl(input, DEF);
      const twice = resolveOpenAICompatibleChatCompletionsUrl(once, DEF);
      expect(twice).toBe(once);
    }
  });

  test('U3: result ends in /chat/completions and never double-appends (fuzz)', () => {
    const rng = mulberry32(0x13371337);
    for (let i = 0; i < 20000; i++) {
      const input = randUrl(rng);
      const out = resolveOpenAICompatibleChatCompletionsUrl(input, DEF);
      // The suffix is present case-insensitively at the end.
      expect(out.toLowerCase().endsWith(SUFFIX)).toBe(true);
      // Never two consecutive occurrences -> no double-append.
      const occ = out.toLowerCase().split(SUFFIX).length - 1;
      expect(occ).toBe(1);
    }
  });

  test('U4: trailing slashes collapsed before suffix decision', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://a.b/v1/', DEF)).toBe('https://a.b/v1/chat/completions');
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://a.b/v1///', DEF)).toBe('https://a.b/v1/chat/completions');
    // already-suffixed with trailing slash collapses to the canonical form.
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://a.b/v1/chat/completions/', DEF))
      .toBe('https://a.b/v1/chat/completions');
  });

  test('U5: case-insensitive suffix is preserved verbatim (no re-append)', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://a.b/CHAT/COMPLETIONS', DEF))
      .toBe('https://a.b/CHAT/COMPLETIONS');
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://a.b/Chat/Completions/', DEF))
      .toBe('https://a.b/Chat/Completions');
  });

  test('U6: base URL without suffix gets exactly one append', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://api.deepseek.com/v1', DEF))
      .toBe('https://api.deepseek.com/v1/chat/completions');
  });

  // Security (fix G): the resolver sends the OpenCode Bearer API key + observation
  // content to whatever base URL is configured. A malformed or non-http(s) value
  // must NOT be used as the destination — fall back to the default rather than
  // leak credentials to a fat-fingered / attacker-controlled host.
  describe('G: non-http(s) / malformed base URL falls back to default', () => {
    const bad = [
      'file:///etc/passwd',
      'ftp://evil.example.com/v1',
      'gopher://x',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'not a url at all',
      'http://',                 // no host
      'https://',                // no host
      '://missing-scheme/v1',
      '   http://ok but spaces', // unparseable
      'ws://evil/v1',
      'wss://evil/v1',
    ];
    for (const b of bad) {
      test(`rejects ${JSON.stringify(b)} -> defaultUrl`, () => {
        expect(resolveOpenAICompatibleChatCompletionsUrl(b, DEF)).toBe(DEF);
      });
    }

    test('accepts valid http and https hosts', () => {
      expect(resolveOpenAICompatibleChatCompletionsUrl('http://localhost:1234/v1', DEF))
        .toBe('http://localhost:1234/v1/chat/completions');
      expect(resolveOpenAICompatibleChatCompletionsUrl('https://api.deepseek.com/v1', DEF))
        .toBe('https://api.deepseek.com/v1/chat/completions');
    });
  });
});
