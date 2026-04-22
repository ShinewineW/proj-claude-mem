/**
 * buildFreshSummaryPrompt: cap annotations + tail reinforcement.
 *
 * Ports from the spec (docs/spec/2026-04-22-claude-mem-summarylane-fixes.md §3).
 *
 * Two additions:
 *   1. When `maxObservations` is set AND total obs > cap, the `<observations>`
 *      block is emitted with:
 *        - count="<rendered_N>" total_this_session="<full_total>"
 *        - an HTML comment explaining earlier N were omitted and are
 *          already captured in prior per-turn summaries.
 *   2. A tail reminder block after the schema instructing Claude that
 *      <user_request> is INPUT DATA, not a request to be answered, and to
 *      emit only the <summary> XML.
 *
 * Why: large prompts cause two failure modes —
 *   - "Lost in the middle": head instruction gets de-weighted vs payload
 *     → Claude responds to <user_request> in natural language.
 *   - Stream-json parser rejection (Claude Code 2.1.117): input line too
 *     large → subprocess exit 1 at stdin parse, no output.
 * Cap mitigates both by size; tail reinforcement doubles down on the first.
 */

import { describe, it, expect, mock } from 'bun:test';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({ name: 'code' }),
      loadMode: () => {},
    }),
  },
}));

import { buildFreshSummaryPrompt } from '../../src/sdk/prompts.js';

function makeObs(idx: number) {
  const tag = String(idx).padStart(4, '0');
  return {
    type: 'feature',
    title: `obs-${tag}`,
    narrative: `narrative ${tag}`,
    facts: [`fact-${tag}`],
  };
}

describe('buildFreshSummaryPrompt: cap annotations', () => {
  it('emits total_this_session="<full>" when obs are truncated', () => {
    const obs = Array.from({ length: 215 }, (_, i) => makeObs(i + 1));
    const prompt = buildFreshSummaryPrompt({
      userPrompt: 'explain results',
      lastAssistantMessage: 'pending',
      observations: obs,
      maxObservations: 60,
    });

    // Rendered count should be 60, full session total annotated too
    expect(prompt).toContain('count="60"');
    expect(prompt).toContain('total_this_session="215"');
  });

  it('omits total_this_session attribute when no truncation happened', () => {
    const obs = Array.from({ length: 30 }, (_, i) => makeObs(i + 1));
    const prompt = buildFreshSummaryPrompt({
      userPrompt: 'explain',
      lastAssistantMessage: 'x',
      observations: obs,
      maxObservations: 60,
    });
    expect(prompt).toContain('count="30"');
    expect(prompt).not.toContain('total_this_session=');
  });

  it('emits an omission comment explaining earlier obs are in prior summaries', () => {
    const obs = Array.from({ length: 100 }, (_, i) => makeObs(i + 1));
    const prompt = buildFreshSummaryPrompt({
      userPrompt: 'x',
      lastAssistantMessage: 'y',
      observations: obs,
      maxObservations: 40,
    });
    // The exact number and phrasing must identify (a) how many were dropped,
    // (b) that they're already in prior per-turn summaries — so the model
    // doesn't try to compensate for "missing" data.
    expect(prompt).toMatch(
      /earlier 60 observation\(s\) omitted.*prior per-turn summaries/s,
    );
  });

  it('keeps the last N (most recent) obs when truncating', () => {
    const obs = Array.from({ length: 100 }, (_, i) => makeObs(i + 1));
    const prompt = buildFreshSummaryPrompt({
      userPrompt: 'x',
      lastAssistantMessage: 'y',
      observations: obs,
      maxObservations: 5,
    });
    expect(prompt).toContain('obs-0096');
    expect(prompt).toContain('obs-0100');
    expect(prompt).not.toContain('obs-0095');
    expect(prompt).not.toContain('obs-0001');
  });
});

describe('buildFreshSummaryPrompt: tail reinforcement', () => {
  it('appends a reminder that <user_request> is INPUT DATA, not a question', () => {
    const prompt = buildFreshSummaryPrompt({
      userPrompt: '重启后死了，连结果都没有了吗？',
      lastAssistantMessage: null,
      observations: [makeObs(1)],
    });
    expect(prompt).toContain('INPUT DATA');
    // Must discourage answering the question AND prose wrapping
    expect(prompt).toMatch(/DO NOT answer/i);
    expect(prompt).toMatch(/only the <summary>/i);
  });

  it('tail reinforcement comes AFTER the schema (last thing Claude reads)', () => {
    const prompt = buildFreshSummaryPrompt({
      userPrompt: 'x',
      lastAssistantMessage: 'y',
      observations: [makeObs(1)],
    });
    const reminderIdx = prompt.indexOf('INPUT DATA');
    // The closing schema marker is </summary>
    const lastSchemaIdx = prompt.lastIndexOf('</summary>');
    expect(reminderIdx).toBeGreaterThan(lastSchemaIdx);
  });

  it('still emits a <summary> schema block (tail reinforcement does not replace schema)', () => {
    const prompt = buildFreshSummaryPrompt({
      userPrompt: 'x',
      lastAssistantMessage: 'y',
      observations: [makeObs(1)],
    });
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain('<request>');
    expect(prompt).toContain('</summary>');
  });
});
