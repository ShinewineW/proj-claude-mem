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

// ────────────────────────────────────────────────────────────────
// Mode-driven schema instructions (2026-04-20 regression fix)
// ────────────────────────────────────────────────────────────────
// Before the fresh-query refactor (2026-04-19), summary prompts used the
// ModeConfig.prompts.xml_summary_*_placeholder strings as field guidance —
// e.g. "[Short title capturing the user's request AND the substance of what
// was discussed/done]". The refactor replaced those with hardcoded minimalist
// instructions like "short original request phrase", which caused the model
// to echo the user's prompt instead of synthesizing a work-subject title.
//
// These tests pin the fix: when a mode is supplied, buildFreshSummaryPrompt
// uses the mode's rich placeholder strings so multilingual modes
// (code--zh.json etc.) get their localized instructions for free and the
// model returns to the Apr-8-era "model-organized title" behavior.

describe('buildFreshSummaryPrompt — mode-driven schema instructions', () => {
  const makeTestMode = (): any => ({
    name: 'code',
    description: 'Test mode',
    version: '1.0.0',
    observation_types: [],
    observation_concepts: [],
    prompts: {
      system_identity: 'unused-in-summary',
      spatial_awareness: 'unused-in-summary',
      observer_role: 'unused-in-summary',
      recording_focus: 'unused-in-summary',
      skip_guidance: 'unused-in-summary',
      type_guidance: 'unused-in-summary',
      concept_guidance: 'unused-in-summary',
      field_guidance: 'unused-in-summary',
      output_format_header: 'unused-in-summary',
      format_examples: 'unused-in-summary',
      footer: 'unused-in-summary',
      xml_title_placeholder: 'unused-in-summary',
      xml_subtitle_placeholder: 'unused-in-summary',
      xml_fact_placeholder: 'unused-in-summary',
      xml_narrative_placeholder: 'unused-in-summary',
      xml_concept_placeholder: 'unused-in-summary',
      xml_file_placeholder: 'unused-in-summary',
      xml_summary_request_placeholder:
        "[MODE_REQUEST_INSTRUCTION: Short title capturing the user's request AND the substance of what was discussed/done]",
      xml_summary_investigated_placeholder:
        '[MODE_INVESTIGATED_INSTRUCTION: What has been explored so far? What was examined?]',
      xml_summary_learned_placeholder:
        '[MODE_LEARNED_INSTRUCTION: What have you learned about how things work?]',
      xml_summary_completed_placeholder:
        '[MODE_COMPLETED_INSTRUCTION: What work has been completed so far?]',
      xml_summary_next_steps_placeholder:
        '[MODE_NEXTSTEPS_INSTRUCTION: What are you actively working on or planning next?]',
      xml_summary_notes_placeholder:
        '[MODE_NOTES_INSTRUCTION: Additional insights or observations]',
      header_memory_start: 'unused-in-summary',
      header_memory_continued: 'unused-in-summary',
      header_summary_checkpoint: 'unused-in-summary',
      continuation_greeting: 'unused-in-summary',
      continuation_instruction: 'unused-in-summary',
      summary_instruction:
        'MODE_SUMMARY_INSTRUCTION: Write progress notes of what was done, what was learned, and what is next.',
      summary_context_label: 'unused-in-summary',
      summary_format_instruction: 'unused-in-summary',
      summary_footer: 'unused-in-summary',
    },
  });

  const baseInput = {
    userPrompt: 'Refactor the cache layer',
    lastAssistantMessage: 'Applied LRU.',
    observations: [
      { type: 'feature', title: 'LRU swap', narrative: 'n', facts: ['f1'] },
    ],
  };

  it('uses mode.prompts.xml_summary_*_placeholder for all six schema fields when mode is provided', () => {
    const prompt = buildFreshSummaryPrompt({ ...baseInput, mode: makeTestMode() });
    // Mode-supplied instructions present
    expect(prompt).toContain("[MODE_REQUEST_INSTRUCTION: Short title capturing the user's request AND the substance of what was discussed/done]");
    expect(prompt).toContain('[MODE_INVESTIGATED_INSTRUCTION: What has been explored so far? What was examined?]');
    expect(prompt).toContain('[MODE_LEARNED_INSTRUCTION: What have you learned about how things work?]');
    expect(prompt).toContain('[MODE_COMPLETED_INSTRUCTION: What work has been completed so far?]');
    expect(prompt).toContain('[MODE_NEXTSTEPS_INSTRUCTION: What are you actively working on or planning next?]');
    expect(prompt).toContain('[MODE_NOTES_INSTRUCTION: Additional insights or observations]');
    // Hardcoded fallback instructions absent — mode overrides them completely
    expect(prompt).not.toContain('short original request phrase');
    expect(prompt).not.toContain('bullets or sentences of what was investigated');
    expect(prompt).not.toContain('bullets of key facts discovered');
    expect(prompt).not.toContain('bullets of what was completed (features, fixes)');
  });

  it('includes mode.prompts.summary_instruction before the schema when mode is provided', () => {
    const prompt = buildFreshSummaryPrompt({ ...baseInput, mode: makeTestMode() });
    expect(prompt).toContain('MODE_SUMMARY_INSTRUCTION: Write progress notes');
    // summary_instruction should appear BEFORE the <summary> template so it
    // shapes the content, not after where it would be ignored.
    const instrIdx = prompt.indexOf('MODE_SUMMARY_INSTRUCTION');
    const schemaIdx = prompt.indexOf('Output exactly one <summary>');
    expect(instrIdx).toBeGreaterThan(-1);
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(instrIdx).toBeLessThan(schemaIdx);
  });

  it('does NOT pull in observer-role language from mode (prevents 0%-valid-XML regression)', () => {
    // Even though ModePrompts contains observer_role / recording_focus /
    // continuation_greeting, the fresh summarize prompt MUST stay observer-
    // free — that was the whole point of the fresh-query refactor. Only the
    // xml_summary_*_placeholder + summary_instruction fields are borrowed.
    const mode = makeTestMode();
    mode.prompts.observer_role = 'OBSERVER_ROLE_SENTINEL: you are a memory agent observing';
    mode.prompts.continuation_greeting = 'CONTINUATION_SENTINEL: Hello memory agent';
    mode.prompts.system_identity = 'SYSTEM_IDENTITY_SENTINEL: you are an observer';
    mode.prompts.recording_focus = 'RECORDING_FOCUS_SENTINEL';
    mode.prompts.summary_footer = 'SUMMARY_FOOTER_SENTINEL: memory agent for a DIFFERENT session';
    const prompt = buildFreshSummaryPrompt({ ...baseInput, mode });
    expect(prompt).not.toContain('OBSERVER_ROLE_SENTINEL');
    expect(prompt).not.toContain('CONTINUATION_SENTINEL');
    expect(prompt).not.toContain('SYSTEM_IDENTITY_SENTINEL');
    expect(prompt).not.toContain('RECORDING_FOCUS_SENTINEL');
    expect(prompt).not.toContain('SUMMARY_FOOTER_SENTINEL');
  });

  it('falls back to hardcoded schema strings when mode is undefined', () => {
    // Preserves backward compatibility for test double callers and any path
    // where ModeManager is unavailable (worker boot before mode load, etc.).
    // Chunk 2 Task 2.1 strengthened the fallback schema to prevent verbatim
    // echoes of user_request in the <request> field.
    const prompt = buildFreshSummaryPrompt(baseInput);
    expect(prompt).toContain('3-8 word title');
    expect(prompt).toContain('NOT a verbatim copy of user_request');
    expect(prompt).toContain('fix auth token expiry');
    expect(prompt).toContain('Bullets or sentences describing what was investigated');
    expect(prompt).toContain('Bullets of key facts or insights discovered');
    expect(prompt).toContain('Bullets of what was completed (features, fixes, decisions)');
    expect(prompt).toContain('Bullets of pending work, or leave empty if none');
    expect(prompt).toContain('Optional short note about constraints / gotchas, or leave empty');
    // Should NOT accidentally contain mode-style sentinels
    expect(prompt).not.toContain('MODE_REQUEST_INSTRUCTION');
  });
});
