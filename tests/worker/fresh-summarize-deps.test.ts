import { describe, it, expect } from 'bun:test';
import { buildFreshSummarizeDeps } from '../../src/services/worker/fresh-summarize-deps.js';

function makeInput() {
  return {
    getObservationsForSession: () => [],
    modelId: 'claude-sonnet-4-6',
    disallowedTools: ['Bash', 'Edit', 'Write'],
    signal: new AbortController().signal,
    isolatedEnv: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
    cwd: '/tmp/observer-sessions',
    pathToClaudeCodeExecutable: '/usr/local/bin/claude',
  };
}

describe('buildFreshSummarizeDeps', () => {
  it('returns an object matching FreshSummarizeDeps with all 9 fields', () => {
    const deps = buildFreshSummarizeDeps(makeInput());
    expect(deps).toHaveProperty('query');
    expect(typeof deps.getObservationsForSession).toBe('function');
    expect(deps.modelId).toBe('claude-sonnet-4-6');
    expect(deps.disallowedTools).toEqual(['Bash', 'Edit', 'Write']);
    expect(deps.abortController).toBeInstanceOf(AbortController);
    expect(deps.isolatedEnv).toEqual({ PATH: '/usr/bin' });
    expect(deps.cwd).toBe('/tmp/observer-sessions');
    expect(deps.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
  });

  it('abortController is driven by the caller-supplied AbortSignal (shutdown plumbing)', () => {
    const outerController = new AbortController();
    const deps = buildFreshSummarizeDeps({ ...makeInput(), signal: outerController.signal });
    expect(deps.abortController.signal.aborted).toBe(false);
    outerController.abort();
    expect(deps.abortController.signal.aborted).toBe(true);
  });

  it('propagates already-aborted signal synchronously', () => {
    const pre = new AbortController();
    pre.abort();
    const deps = buildFreshSummarizeDeps({ ...makeInput(), signal: pre.signal });
    expect(deps.abortController.signal.aborted).toBe(true);
  });

  it('getObservationsForSession is the closure the caller supplied', () => {
    const mine = () => [{ type: 'mine', title: 't', narrative: null, facts: [] }];
    const deps = buildFreshSummarizeDeps({ ...makeInput(), getObservationsForSession: mine });
    expect(deps.getObservationsForSession('any-id')[0].type).toBe('mine');
  });
});
