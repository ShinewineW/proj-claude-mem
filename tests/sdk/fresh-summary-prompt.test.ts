/**
 * buildFreshSummaryPrompt tests — the self-contained summary prompt used by
 * the fresh-query summarize path (src/services/worker/SDKAgent.runFreshSummarizeQuery).
 *
 * Why this prompt exists:
 *   The memory agent's long-lived SDK session is primed as an observer by
 *   the init + observation prompts. A mid-session "mode switch" to summary
 *   is empirically overridden by that observer conditioning — Claude keeps
 *   producing observer prose instead of <summary> XML.
 *
 *   The fix: run summarize in a fresh query() with NO observer priming. This
 *   prompt must be fully self-contained: no observer role, no <observation>
 *   template, no "this is an observation" framing — just the data needed to
 *   produce one <summary> block.
 */

import { describe, it, expect, mock } from 'bun:test';

// Mock ModeManager so we don't depend on the full mode config (same pattern as
// session-history-summary.test.ts).
mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({ name: 'code' }),
      loadMode: () => {},
    }),
  },
}));

import { buildFreshSummaryPrompt } from '../../src/sdk/prompts.js';

describe('buildFreshSummaryPrompt', () => {
  const baseInput = {
    userPrompt: 'Refactor the cache layer for better eviction',
    lastAssistantMessage: 'Applied the LRU eviction policy and added tests.',
    observations: [
      {
        type: 'feature',
        title: 'Swapped cache to LRU',
        narrative: 'Replaced FIFO with LRU map; added eviction callback.',
        facts: ['LRU size capped at 1000', 'Eviction fires at 95% full'],
      },
      {
        type: 'discovery',
        title: 'Stale entries under load',
        narrative: 'Benchmark showed 3% stale rate before the change.',
        facts: ['Measured on k6 load test', 'Stale entries correlated with FIFO'],
      },
    ],
  };

  it('includes the full <summary> XML template (all six fields)', () => {
    const prompt = buildFreshSummaryPrompt(baseInput);
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain('</summary>');
    expect(prompt).toContain('<request>');
    expect(prompt).toContain('<investigated>');
    expect(prompt).toContain('<learned>');
    expect(prompt).toContain('<completed>');
    expect(prompt).toContain('<next_steps>');
    expect(prompt).toContain('<notes>');
  });

  it('includes the user request verbatim', () => {
    const prompt = buildFreshSummaryPrompt(baseInput);
    expect(prompt).toContain('Refactor the cache layer for better eviction');
  });

  it('includes the last assistant message when provided', () => {
    const prompt = buildFreshSummaryPrompt(baseInput);
    expect(prompt).toContain('Applied the LRU eviction policy and added tests.');
  });

  it('handles null/missing last assistant message without throwing', () => {
    const prompt = buildFreshSummaryPrompt({ ...baseInput, lastAssistantMessage: null });
    expect(prompt).toContain('Refactor the cache layer for better eviction');
    // Should not throw, and should not contain a literal "null"/"undefined" token
    expect(prompt).not.toContain('null</last_assistant_message>');
    expect(prompt).not.toContain('undefined</last_assistant_message>');
  });

  it('renders each observation with type, title, narrative, and facts', () => {
    const prompt = buildFreshSummaryPrompt(baseInput);
    expect(prompt).toContain('Swapped cache to LRU');
    expect(prompt).toContain('Stale entries under load');
    expect(prompt).toContain('LRU size capped at 1000');
    expect(prompt).toContain('Benchmark showed 3% stale rate');
    expect(prompt).toMatch(/count="2"/);
  });

  it('handles zero observations gracefully (still produces a valid prompt)', () => {
    const prompt = buildFreshSummaryPrompt({ ...baseInput, observations: [] });
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain(baseInput.userPrompt);
    expect(prompt).toMatch(/count="0"/);
  });

  it('does NOT prime the model as an observer', () => {
    // This is the whole point of the fresh prompt: no observer conditioning.
    // Any of these substrings would indicate we accidentally re-used the
    // observer-role text from buildInitPrompt / buildContinuationPrompt.
    const prompt = buildFreshSummaryPrompt(baseInput);
    const lower = prompt.toLowerCase();
    expect(lower).not.toContain('you are the memory agent observer');
    expect(lower).not.toContain('observer role');
    expect(lower).not.toContain('recording_focus');
    expect(lower).not.toContain('--- observation only ---');
    // The literal "<observation>" token should never appear — even in
    // "don't output <observation>" framing, because mentioning the forbidden
    // token increases the chance of the model emitting it.
    expect(prompt).not.toContain('<observation>');
  });

  it('forbids observation tags, prose, and requires exactly one summary block', () => {
    const prompt = buildFreshSummaryPrompt(baseInput);
    const lower = prompt.toLowerCase();
    // Must forbid observation output so Claude does not fall back to observer
    // habits when confused.
    expect(lower).toContain('do not output observation');
    // Must forbid free prose so "I'm observing..." style replies are not valid.
    expect(lower).toContain('do not output prose');
    // Must make clear it's exactly one summary block.
    expect(prompt).toMatch(/exactly one <summary>/i);
  });

  it('truncates overlong narrative and facts (prevents prompt explosion)', () => {
    const hugeNarrative = 'x'.repeat(10_000);
    const hugeFact = 'y'.repeat(10_000);
    const prompt = buildFreshSummaryPrompt({
      ...baseInput,
      observations: [{
        type: 'discovery',
        title: 'Huge obs',
        narrative: hugeNarrative,
        facts: [hugeFact],
      }],
      maxFieldChars: 500,
    });
    // No field should appear at full 10k length
    expect(prompt.includes(hugeNarrative)).toBe(false);
    expect(prompt.includes(hugeFact)).toBe(false);
    // Truncation marker should be present
    expect(prompt).toMatch(/truncated/i);
  });

  it('preserves observation ordering (index attribute matches array order)', () => {
    const prompt = buildFreshSummaryPrompt(baseInput);
    const idx1 = prompt.indexOf('index="1"');
    const idx2 = prompt.indexOf('index="2"');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    // The earlier indexed block should contain the first observation's title
    const beforeIdx2 = prompt.substring(0, idx2);
    expect(beforeIdx2).toContain('Swapped cache to LRU');
  });

  it('XML-escapes dangerous characters in observation fields', () => {
    const prompt = buildFreshSummaryPrompt({
      ...baseInput,
      observations: [{
        type: 'bugfix',
        title: 'Fixed <script> tag & "quote" handling',
        narrative: 'Issue was <observation> leaking into output',
        facts: ['Closed brackets > and & were the culprit'],
      }],
    });
    // Must escape < > & otherwise a nested observation token breaks the
    // outer XML and could even re-prime the model.
    expect(prompt).not.toContain('<script>');
    // User-provided "<observation>" must be escaped (prompt itself never
    // contains the literal token — see "does NOT prime the model as an
    // observer" test above).
    expect(prompt).not.toContain('<observation>');
    // Escaped form of the injected user content should be present
    expect(prompt).toMatch(/&lt;script&gt;/);
    expect(prompt).toMatch(/&lt;observation&gt;/);
  });

  it('omits the last_assistant_message block when message is empty string', () => {
    const prompt = buildFreshSummaryPrompt({ ...baseInput, lastAssistantMessage: '' });
    // We don't want an empty <last_assistant_message></last_assistant_message>
    // confusing the model into thinking the assistant literally said nothing.
    // Either the element is omitted entirely, or it's present but clearly marked.
    // We test for: no completely-empty element pattern.
    expect(prompt).not.toMatch(/<last_assistant_message>\s*<\/last_assistant_message>/);
  });
});
