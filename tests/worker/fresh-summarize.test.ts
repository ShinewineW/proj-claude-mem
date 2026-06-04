/**
 * runFreshSummarizeQuery orchestration tests.
 *
 * runFreshSummarizeQuery spawns a fresh Claude SDK query() WITHOUT resume,
 * feeds it buildFreshSummaryPrompt, consumes assistant text, parses a
 * <summary> XML block, and returns a structured result. This is how we avoid
 * the observer-conditioning poisoning documented in
 * attn_sink/0sum-investigation/NOTES.md.
 *
 * We inject the SDK query() function as a dependency so these tests never
 * spawn a real Claude subprocess.
 */

import { describe, it, expect, mock, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        observation_types: [
          { id: 'discovery' },
          { id: 'feature' },
          { id: 'bugfix' },
        ],
      }),
      loadMode: () => {},
    }),
  },
}));

import {
  runFreshSummarizeQuery,
  type FreshSummarizeDeps,
  type FreshSummarizeInput,
} from '../../src/services/worker/fresh-summarize.js';
import { OBSERVER_DISALLOWED_TOOLS } from '../../src/sdk/hardened-options.js';

// ----- helpers -----------------------------------------------------------

type FakeSdkMessage =
  | { type: 'system'; session_id: string }
  | {
      type: 'assistant';
      session_id: string;
      message: {
        content: Array<{ type: 'text'; text: string }>;
        usage?: { input_tokens: number; output_tokens: number };
      };
    }
  | { type: 'result'; session_id: string; stop_reason: string };

interface CapturedQueryCall {
  options: any;
  promptYielded: Array<unknown>;
}

function makeFakeQuery(messages: FakeSdkMessage[]) {
  const captured: CapturedQueryCall = { options: null, promptYielded: [] };
  const fn = (args: { prompt: AsyncIterable<unknown>; options: any }) => {
    captured.options = args.options;
    // Drain the yielded prompt into the captured list so tests can inspect it
    const drainPromise = (async () => {
      for await (const p of args.prompt) captured.promptYielded.push(p);
    })();
    // Return the SDK response iterator
    return (async function* () {
      // Let the prompt drain start before we begin yielding, so tests that
      // inspect captured.promptYielded after consuming the response see values
      await drainPromise;
      for (const m of messages) yield m;
    })();
  };
  return { fn, captured };
}

function makeDeps(overrides: Partial<FreshSummarizeDeps> = {}): FreshSummarizeDeps {
  const { fn } = makeFakeQuery([]);
  return {
    query: fn as any,
    getObservationsForSession: () => [],
    modelId: 'claude-sonnet-4-6',
    disallowedTools: ['Bash', 'Read', 'Write'],
    abortController: new AbortController(),
    isolatedEnv: {},
    cwd: '/tmp/observer',
    pathToClaudeCodeExecutable: '/usr/local/bin/claude',
    ...overrides,
  };
}

const baseInput: FreshSummarizeInput = {
  memorySessionId: 'mem-123',
  userPrompt: 'Tune the cache',
  lastAssistantMessage: 'Cache tuned, tests green.',
};

// Build a minimal-valid summary XML string Claude might return
const VALID_SUMMARY_XML = `<summary>
  <request>Tune the cache</request>
  <investigated>LRU vs FIFO eviction</investigated>
  <learned>LRU reduces stale entries to &lt;1%</learned>
  <completed>Swapped to LRU with size cap</completed>
  <next_steps>Monitor eviction rate for a week</next_steps>
  <notes></notes>
</summary>`;

// ----- tests -------------------------------------------------------------

describe('runFreshSummarizeQuery', () => {
  it('calls query() with NO resume option (fresh session, no observer priming)', async () => {
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps({ query: fn as any });
    await runFreshSummarizeQuery(deps, baseInput);
    expect(captured.options).toBeDefined();
    expect(captured.options.resume).toBeUndefined();
  });

  it('propagates the abortController to the query options', async () => {
    const { fn, captured } = makeFakeQuery([]);
    const controller = new AbortController();
    const deps = makeDeps({ query: fn as any, abortController: controller });
    await runFreshSummarizeQuery(deps, baseInput);
    expect(captured.options.abortController).toBe(controller);
  });

  it('always applies the hardened OBSERVER_DISALLOWED_TOOLS, ignoring deps.disallowedTools', async () => {
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps({ query: fn as any });
    // Even a narrow deps deny-list must be overridden by the hardened lockdown.
    deps.disallowedTools = ['Bash', 'Read', 'Write', 'Grep'];
    await runFreshSummarizeQuery(deps, baseInput);
    // Hardened helper supplies the full 12-tool deny-list, plus tools:[] /
    // allowedTools:[] for defense-in-depth.
    expect(captured.options.disallowedTools).toEqual([...OBSERVER_DISALLOWED_TOOLS]);
    expect(captured.options.tools).toEqual([]);
    expect(captured.options.allowedTools).toEqual([]);
  });

  it('yields a single user message containing the fresh-summary prompt', async () => {
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps({ query: fn as any });
    await runFreshSummarizeQuery(deps, baseInput);
    expect(captured.promptYielded.length).toBe(1);
    const msg = captured.promptYielded[0] as any;
    // Should be an SDK-compatible user message with embedded content
    expect(msg.type).toBe('user');
    const content = typeof msg.message.content === 'string'
      ? msg.message.content
      : msg.message.content.map((c: any) => c.text).join('');
    // Prompt should contain the user request and the summary XML template
    expect(content).toContain('Tune the cache');
    expect(content).toContain('<summary>');
    // Must not resurrect observer priming
    expect(content).not.toContain('<observation>');
  });

  it('loads observations via the injected DB function using memorySessionId', async () => {
    const captured: string[] = [];
    const { fn } = makeFakeQuery([]);
    const deps = makeDeps({
      query: fn as any,
      getObservationsForSession: (id: string) => {
        captured.push(id);
        return [
          { type: 'feature', title: 't', narrative: 'n', facts: ['f1'] },
        ];
      },
    });
    await runFreshSummarizeQuery(deps, { ...baseInput, memorySessionId: 'mem-XYZ' });
    expect(captured).toEqual(['mem-XYZ']);
  });

  it('embeds loaded observations into the prompt', async () => {
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps({
      query: fn as any,
      getObservationsForSession: () => [
        { type: 'feature', title: 'Added LRU eviction', narrative: 'n', facts: ['f'] },
      ],
    });
    await runFreshSummarizeQuery(deps, baseInput);
    const content = (captured.promptYielded[0] as any).message.content;
    const text = typeof content === 'string'
      ? content
      : content.map((c: any) => c.text).join('');
    expect(text).toContain('Added LRU eviction');
    expect(text).toMatch(/count="1"/);
  });

  it('parses valid <summary> XML from the assistant response and returns success', async () => {
    const { fn } = makeFakeQuery([
      { type: 'system', session_id: 's1' },
      {
        type: 'assistant',
        session_id: 's1',
        message: {
          content: [{ type: 'text', text: VALID_SUMMARY_XML }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      { type: 'result', session_id: 's1', stop_reason: 'end_turn' },
    ]);
    const deps = makeDeps({ query: fn as any });
    const result = await runFreshSummarizeQuery(deps, baseInput);
    expect(result.status).toBe('success');
    expect(result.summary).toBeDefined();
    expect(result.summary!.request).toBe('Tune the cache');
    expect(result.summary!.completed).toContain('LRU');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it('returns status=parse_failed when assistant emits prose (e.g., observer drift)', async () => {
    const { fn } = makeFakeQuery([
      {
        type: 'assistant',
        session_id: 's1',
        message: {
          content: [{ type: 'text', text: "I'm observing, no tool executions yet..." }],
        },
      },
      { type: 'result', session_id: 's1', stop_reason: 'end_turn' },
    ]);
    const deps = makeDeps({ query: fn as any });
    const result = await runFreshSummarizeQuery(deps, baseInput);
    expect(result.status).toBe('parse_failed');
    expect(result.summary).toBeUndefined();
    expect(result.rawText).toContain("I'm observing");
  });

  it('returns status=no_text when no assistant messages arrive', async () => {
    const { fn } = makeFakeQuery([
      { type: 'system', session_id: 's1' },
      { type: 'result', session_id: 's1', stop_reason: 'end_turn' },
    ]);
    const deps = makeDeps({ query: fn as any });
    const result = await runFreshSummarizeQuery(deps, baseInput);
    expect(result.status).toBe('no_text');
  });

  it('returns status=aborted when query throws AbortError mid-stream', async () => {
    const controller = new AbortController();
    const badQuery = (_args: any) => {
      return (async function* () {
        // Simulate the SDK raising on abort
        controller.abort();
        const err: any = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      })();
    };
    const deps = makeDeps({ query: badQuery as any, abortController: controller });
    const result = await runFreshSummarizeQuery(deps, baseInput);
    expect(result.status).toBe('aborted');
  });

  it('concatenates multiple assistant text chunks before parsing', async () => {
    const half1 = VALID_SUMMARY_XML.slice(0, 40);
    const half2 = VALID_SUMMARY_XML.slice(40);
    const { fn } = makeFakeQuery([
      {
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: half1 }] },
      },
      {
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: half2 }] },
      },
      { type: 'result', session_id: 's1', stop_reason: 'end_turn' },
    ]);
    const deps = makeDeps({ query: fn as any });
    const result = await runFreshSummarizeQuery(deps, baseInput);
    expect(result.status).toBe('success');
  });

  it('sets a sane CWD (isolated from user project) on the query', async () => {
    const { fn, captured } = makeFakeQuery([]);
    const deps = makeDeps({ query: fn as any, cwd: '/tmp/observer-sessions' });
    await runFreshSummarizeQuery(deps, baseInput);
    expect(captured.options.cwd).toBe('/tmp/observer-sessions');
  });

  it('passes the isolatedEnv to the query (credential isolation)', async () => {
    const { fn, captured } = makeFakeQuery([]);
    const env = { ANTHROPIC_API_KEY: 'test-key' } as any;
    const deps = makeDeps({ query: fn as any, isolatedEnv: env });
    await runFreshSummarizeQuery(deps, baseInput);
    expect(captured.options.env).toBe(env);
  });

  it('tolerates thrown non-abort errors and returns status=error', async () => {
    const badQuery = (_args: any) => {
      return (async function* () {
        throw new Error('network exploded');
      })();
    };
    const deps = makeDeps({ query: badQuery as any });
    const result = await runFreshSummarizeQuery(deps, baseInput);
    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('network exploded');
  });

  describe('SDK_USAGE telemetry emission', () => {
    // Find the SDK_USAGE record that logger.info was called with. Returns
    // [category, message, context] or null.
    function findSdkUsageCall(spy: ReturnType<typeof spyOn>): any[] | null {
      for (const call of spy.mock.calls) {
        if (call[0] === 'SDK' && call[1] === 'SDK_USAGE') return call;
      }
      return null;
    }

    it('emits one SDK_USAGE log with channel=claude_sdk_fresh_summarize on success', async () => {
      const spy = spyOn(logger, 'info').mockImplementation(() => {});
      const { fn } = makeFakeQuery([
        {
          type: 'assistant',
          session_id: 's1',
          message: {
            content: [{ type: 'text', text: VALID_SUMMARY_XML }],
            usage: { input_tokens: 123, output_tokens: 45 },
          },
        },
        { type: 'result', session_id: 's1', stop_reason: 'end_turn' },
      ]);
      const deps = makeDeps({ query: fn as any });
      const result = await runFreshSummarizeQuery(deps, baseInput);

      const call = findSdkUsageCall(spy);
      spy.mockRestore();
      expect(result.status).toBe('success');
      expect(call).not.toBeNull();
      const ctx = call![2];
      expect(ctx.usageChannel).toBe('claude_sdk_fresh_summarize');
      expect(ctx.inputTokens).toBe(123);
      expect(ctx.outputTokens).toBe(45);
      expect(ctx.status).toBe('success');
      expect(ctx.memorySessionId).toBe(baseInput.memorySessionId);
      expect(typeof ctx.durationMs).toBe('number');
      expect(ctx.obsCount).toBe(0);
    });

    it('emits SDK_USAGE even on parse_failed (so cost of failed attempts is visible)', async () => {
      const spy = spyOn(logger, 'info').mockImplementation(() => {});
      const { fn } = makeFakeQuery([
        {
          type: 'assistant',
          session_id: 's1',
          message: {
            content: [{ type: 'text', text: "I'm observing, nothing yet" }],
            usage: { input_tokens: 50, output_tokens: 10 },
          },
        },
        { type: 'result', session_id: 's1', stop_reason: 'end_turn' },
      ]);
      const deps = makeDeps({ query: fn as any });
      await runFreshSummarizeQuery(deps, baseInput);

      const call = findSdkUsageCall(spy);
      spy.mockRestore();
      expect(call).not.toBeNull();
      const ctx = call![2];
      expect(ctx.usageChannel).toBe('claude_sdk_fresh_summarize');
      expect(ctx.status).toBe('parse_failed');
      expect(ctx.inputTokens).toBe(50);
      expect(ctx.outputTokens).toBe(10);
    });

    it('does NOT emit SDK_USAGE when the query throws (no tokens consumed)', async () => {
      const spy = spyOn(logger, 'info').mockImplementation(() => {});
      const badQuery = (_args: any) => {
        return (async function* () {
          throw new Error('network exploded');
        })();
      };
      const deps = makeDeps({ query: badQuery as any });
      await runFreshSummarizeQuery(deps, baseInput);

      const call = findSdkUsageCall(spy);
      spy.mockRestore();
      // On throw-before-any-assistant, Claude may not have been reached at
      // all; skip the usage line so aggregators aren't confused by zero-token
      // rows that look like free successes.
      expect(call).toBeNull();
    });
  });
});
