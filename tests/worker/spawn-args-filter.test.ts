/**
 * Agent SDK args filter — pair-aware removal of empty-string values.
 *
 * Problem (Claude Code 2.1.109+):
 *   The Agent SDK emits `["--setting-sources", ""]` whenever settingSources
 *   defaults to []. The CLI then sees the empty string as an invalid value
 *   for --setting-sources. Worse: if the empty string gets silently dropped
 *   (Bun, or our own naive filter), the *next* flag (--permission-mode) is
 *   consumed as the --setting-sources value, producing:
 *
 *     Error processing --setting-sources: Invalid setting source:
 *     --permission-mode. Valid options are: user, project, local
 *
 *   and Claude exits with code 1 before any prompt is sent.
 *
 * The fix: when an empty-string arg follows a --flag, drop BOTH, not just
 * the empty string. This was the shape of the upstream v12.1.6 fix and
 * what our earlier port got wrong.
 */

import { describe, it, expect } from 'bun:test';
import { filterEmptyFlagPairs } from '../../src/services/worker/spawn-args-filter.js';

describe('filterEmptyFlagPairs', () => {
  it('drops a --flag when its value is an empty string', () => {
    const input = ['--setting-sources', '', '--permission-mode', 'default'];
    expect(filterEmptyFlagPairs(input)).toEqual(['--permission-mode', 'default']);
  });

  it('preserves flags with real values', () => {
    const input = ['--model', 'claude-sonnet-4-6', '--verbose'];
    expect(filterEmptyFlagPairs(input)).toEqual(['--model', 'claude-sonnet-4-6', '--verbose']);
  });

  it('handles multiple empty-valued flags', () => {
    const input = [
      '--a', '', '--b', 'v', '--c', '', '--d', 'w',
    ];
    expect(filterEmptyFlagPairs(input)).toEqual([
      '--b', 'v', '--d', 'w',
    ]);
  });

  it('drops lone empty strings even without a preceding flag', () => {
    // Empty strings in argv are never useful to Claude CLI; drop them too
    // as a defensive measure. No preceding flag means no pair to remove.
    const input = ['', '--model', 'x'];
    expect(filterEmptyFlagPairs(input)).toEqual(['--model', 'x']);
  });

  it('does not touch positional args', () => {
    const input = ['claude', '--model', 'x', 'positional-arg'];
    expect(filterEmptyFlagPairs(input)).toEqual(['claude', '--model', 'x', 'positional-arg']);
  });

  it('reproduces the exact Claude Code 2.1.109+ scenario', () => {
    const input = [
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--model', 'claude-sonnet-4-6',
      '--disallowedTools', 'Bash,Read',
      '--setting-sources', '',
      '--permission-mode', 'default',
    ];
    const out = filterEmptyFlagPairs(input);
    // --setting-sources AND its empty value must both be gone
    expect(out).not.toContain('--setting-sources');
    expect(out).not.toContain('');
    // --permission-mode must still be present with its real value (was at
    // risk of being consumed as --setting-sources's value).
    const idx = out.indexOf('--permission-mode');
    expect(idx).toBeGreaterThan(-1);
    expect(out[idx + 1]).toBe('default');
  });

  it('handles back-to-back empty-valued flags', () => {
    const input = ['--a', '', '--b', '', '--c', 'v'];
    expect(filterEmptyFlagPairs(input)).toEqual(['--c', 'v']);
  });

  it('handles empty string with no preceding flag (pathological input)', () => {
    // "-x" is a short flag; "--" is end-of-options. Either way, the empty
    // after a non-flag should NOT cause us to strip the non-flag arg.
    const input = ['--model', 'x', 'positional', '', '--verbose'];
    // The empty here follows a positional arg, not a --flag — we should
    // still drop the empty (it's noise) but leave 'positional' intact.
    const out = filterEmptyFlagPairs(input);
    expect(out).toContain('positional');
    expect(out).not.toContain('');
  });

  it('returns a new array (does not mutate input)', () => {
    const input = ['--a', '', '--b', 'v'];
    const snapshot = [...input];
    filterEmptyFlagPairs(input);
    expect(input).toEqual(snapshot);
  });
});
