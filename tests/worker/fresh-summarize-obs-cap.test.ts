/**
 * runFreshSummarizeQuery — observation count cap tests.
 *
 * Why this exists:
 *   Production session 164 (skills_workspace prior; ClaudeMem-ProjIso reproduction
 *   2026-04-22) accumulated 215 observations and the resulting fresh-summarize
 *   prompt exceeded Claude Code 2.1.117's `--input-format stream-json` single-line
 *   parser limit. Subprocess crashed exit 1 in 3-5s with stderr:
 *     "Error parsing streaming input line: {...}"
 *   Every retry hit the same wall and the message was dead-lettered.
 *
 *   Mitigation: cap observation list at the prompt-builder boundary. Default
 *   60 most recent — well under the parser limit, semantically correct (most
 *   recent obs are highest-value for summary).
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

import {
  runFreshSummarizeQuery,
  type FreshSummarizeDeps,
  type FreshSummarizeInput,
  type FreshSummarizeObservation,
} from '../../src/services/worker/fresh-summarize.js';

// ----- helpers -----------------------------------------------------------

interface CapturedQueryCall {
  options: any;
  promptYielded: Array<unknown>;
}

function makeFakeQuery(messages: any[] = []) {
  const captured: CapturedQueryCall = { options: null, promptYielded: [] };
  const fn = (args: { prompt: AsyncIterable<unknown>; options: any }) => {
    captured.options = args.options;
    const drainPromise = (async () => {
      for await (const p of args.prompt) captured.promptYielded.push(p);
    })();
    return (async function* () {
      await drainPromise;
      for (const m of messages) yield m;
    })();
  };
  return { fn, captured };
}

function makeObs(idx: number): FreshSummarizeObservation {
  // 4-digit zero-padded index — prevents substring collisions in `toContain`
  // assertions (e.g. "obs-0001" is NOT a substring of "obs-0100").
  const tag = String(idx).padStart(4, '0');
  return {
    type: 'feature',
    title: `obs-${tag}`,
    narrative: `narrative ${tag}`,
    facts: [`fact-${tag}`],
  };
}

function makeDeps(
  obs: FreshSummarizeObservation[],
  overrides: Partial<FreshSummarizeDeps> = {},
): FreshSummarizeDeps {
  const { fn } = makeFakeQuery([]);
  return {
    query: fn as any,
    getObservationsForSession: () => obs,
    modelId: 'claude-sonnet-4-6',
    disallowedTools: [],
    abortController: new AbortController(),
    isolatedEnv: {},
    cwd: '/tmp/observer',
    pathToClaudeCodeExecutable: '/usr/local/bin/claude',
    ...overrides,
  };
}

const baseInput: FreshSummarizeInput = {
  memorySessionId: 'mem-cap-test',
  userPrompt: 'investigate prompt size',
  lastAssistantMessage: 'prior assistant text',
};

// ----- tests -------------------------------------------------------------

describe('runFreshSummarizeQuery: maxObservations cap', () => {
  it('passes ALL observations to the prompt when maxObservations is unset (back-compat)', async () => {
    const obs = Array.from({ length: 80 }, (_, i) => makeObs(i + 1));
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps(obs, { query: fn as any });
    const result = await runFreshSummarizeQuery(deps, baseInput);

    expect(result.obsCount).toBe(80);
    const content = (captured.promptYielded[0] as any).message.content;
    // First and last markers both present — no truncation
    expect(content).toContain('obs-0001');
    expect(content).toContain('obs-0080');
  });

  it('caps prompt to the last N observations when maxObservations is set', async () => {
    const obs = Array.from({ length: 100 }, (_, i) => makeObs(i + 1));
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps(obs, { query: fn as any });
    const result = await runFreshSummarizeQuery(deps, {
      ...baseInput,
      maxObservations: 60,
    });

    // result.obsCount reflects the post-cap count (what the prompt actually saw)
    expect(result.obsCount).toBe(60);

    const content = (captured.promptYielded[0] as any).message.content;
    // Most recent obs (#100) MUST be present
    expect(content).toContain('obs-0100');
    // Boundary: #41 included (100 - 60 + 1), #40 excluded
    expect(content).toContain('obs-0041');
    expect(content).not.toContain('obs-0040');
    expect(content).not.toContain('obs-0001');
  });

  it('does not cap when observation count is at or below maxObservations', async () => {
    const obs = Array.from({ length: 30 }, (_, i) => makeObs(i + 1));
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps(obs, { query: fn as any });
    const result = await runFreshSummarizeQuery(deps, {
      ...baseInput,
      maxObservations: 60,
    });

    expect(result.obsCount).toBe(30);
    const content = (captured.promptYielded[0] as any).message.content;
    expect(content).toContain('obs-0001');
    expect(content).toContain('obs-0030');
  });

  it('treats maxObservations: 0 as "use all" (defensive — never silently nuke obs)', async () => {
    // Rationale: a misconfigured 0 should not produce an empty-obs summary.
    // Treat 0 as "no cap" so we never feed Claude an obs-free prompt by accident.
    const obs = Array.from({ length: 10 }, (_, i) => makeObs(i + 1));
    const { fn } = makeFakeQuery([]);
    const deps = makeDeps(obs, { query: fn as any });
    const result = await runFreshSummarizeQuery(deps, {
      ...baseInput,
      maxObservations: 0,
    });
    expect(result.obsCount).toBe(10);
  });

  it('caps to floor of 1 when maxObservations: 1', async () => {
    const obs = Array.from({ length: 50 }, (_, i) => makeObs(i + 1));
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps(obs, { query: fn as any });
    const result = await runFreshSummarizeQuery(deps, {
      ...baseInput,
      maxObservations: 1,
    });
    expect(result.obsCount).toBe(1);
    const content = (captured.promptYielded[0] as any).message.content;
    expect(content).toContain('obs-0050'); // most recent only
    expect(content).not.toContain('obs-0049');
  });
});
