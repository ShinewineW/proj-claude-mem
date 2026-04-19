/**
 * Fresh-query summarize path.
 *
 * Context:
 *   The memory agent's long-lived SDK session is strongly primed as an
 *   observer by the init + repeated observation prompts. A mid-session
 *   "mode switch to summary" prompt is empirically overridden by that
 *   conditioning — in production we observed 0 valid <summary> XML in
 *   100% of attempts (see attn_sink/0sum-investigation/NOTES.md).
 *
 *   This module runs summarize in a completely fresh Claude SDK query()
 *   — no resume, no observer history, just the self-contained prompt from
 *   buildFreshSummaryPrompt. The observer session remains untouched and
 *   continues processing observations in parallel.
 *
 * Design:
 *   All external boundaries are injected via FreshSummarizeDeps so the
 *   function is fully unit-testable without spawning a real Claude process.
 */

import { buildFreshSummaryPrompt } from '../../sdk/prompts.js';
import { parseSummary, type ParsedSummary } from '../../sdk/parser.js';
import { logger } from '../../utils/logger.js';

export interface FreshSummarizeObservation {
  type: string;
  title: string | null;
  narrative: string | null;
  facts: string[];
}

export type SDKQueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncIterable<any>;

export interface FreshSummarizeDeps {
  /** The Claude Agent SDK's query() function (or a test double). */
  query: SDKQueryFn;
  /** Load DB-stored observations for this memorySessionId. */
  getObservationsForSession: (memorySessionId: string) => FreshSummarizeObservation[];
  /** Model ID to pass to the SDK. */
  modelId: string;
  /** Tools the fresh summarize query must not invoke. */
  disallowedTools: string[];
  /** Shared abort controller so session teardown can kill this query too. */
  abortController: AbortController;
  /** Isolated env vars (see EnvManager.buildIsolatedEnv). */
  isolatedEnv: NodeJS.ProcessEnv;
  /** CWD — use observer-sessions dir to stay out of user's resume list. */
  cwd: string;
  /** Path to the `claude` executable (from findClaudeExecutable). */
  pathToClaudeCodeExecutable: string;
  /**
   * Optional: pid-capturing spawn wrapper. When present, the SDK uses it so
   * ProcessRegistry can track/kill the fresh subprocess. Omitted in tests.
   */
  spawnClaudeCodeProcess?: (spawnOptions: unknown) => unknown;
}

export interface FreshSummarizeInput {
  memorySessionId: string;
  userPrompt: string;
  lastAssistantMessage: string | null | undefined;
}

export type FreshSummarizeStatus =
  | 'success'
  | 'parse_failed'
  | 'no_text'
  | 'aborted'
  | 'error';

export interface FreshSummarizeResult {
  status: FreshSummarizeStatus;
  summary?: ParsedSummary;
  rawText?: string;
  error?: Error;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  obsCount: number;
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string };
  return e.name === 'AbortError' || (e.message?.toLowerCase().includes('abort') ?? false);
}

export async function runFreshSummarizeQuery(
  deps: FreshSummarizeDeps,
  input: FreshSummarizeInput,
): Promise<FreshSummarizeResult> {
  const startedAt = Date.now();
  const observations = deps.getObservationsForSession(input.memorySessionId);
  const obsCount = observations.length;

  const promptText = buildFreshSummaryPrompt({
    userPrompt: input.userPrompt,
    lastAssistantMessage: input.lastAssistantMessage,
    observations,
  });

  // The SDK expects `prompt` to be an async iterable of user messages.
  // We yield exactly one and return — a single-turn conversation.
  async function* promptIterator() {
    yield {
      type: 'user',
      message: { role: 'user', content: promptText },
      session_id: `fresh-summarize-${input.memorySessionId}`,
      parent_tool_use_id: null,
      isSynthetic: true,
    };
  }

  const options: Record<string, unknown> = {
    model: deps.modelId,
    cwd: deps.cwd,
    disallowedTools: deps.disallowedTools,
    abortController: deps.abortController,
    pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
    env: deps.isolatedEnv,
    // Explicitly NO resume — this is the entire point of the fresh path.
  };
  if (deps.spawnClaudeCodeProcess) {
    options.spawnClaudeCodeProcess = deps.spawnClaudeCodeProcess;
  }

  let collectedText = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    const response = deps.query({ prompt: promptIterator(), options });
    for await (const message of response) {
      if (!message || typeof message !== 'object') continue;
      const m = message as { type?: string; message?: any };
      if (m.type !== 'assistant' || !m.message) continue;
      const content = m.message.content;
      const text = Array.isArray(content)
        ? content
            .filter((c: any) => c && c.type === 'text')
            .map((c: any) => c.text ?? '')
            .join('')
        : typeof content === 'string'
          ? content
          : '';
      collectedText += text;
      const usage = m.message.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      if (usage) {
        if (typeof usage.input_tokens === 'number') {
          inputTokens = (inputTokens ?? 0) + usage.input_tokens;
        }
        if (typeof usage.output_tokens === 'number') {
          outputTokens = (outputTokens ?? 0) + usage.output_tokens;
        }
      }
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (isAbortError(err)) {
      logger.info('SDK', 'Fresh summarize aborted', {
        memorySessionId: input.memorySessionId,
        durationMs,
      });
      return { status: 'aborted', durationMs, obsCount };
    }
    logger.error(
      'SDK',
      'Fresh summarize errored',
      {
        memorySessionId: input.memorySessionId,
        durationMs,
      },
      err as Error,
    );
    return { status: 'error', error: err as Error, durationMs, obsCount };
  }

  const durationMs = Date.now() - startedAt;
  const trimmed = collectedText.trim();
  const parsed = trimmed.length > 0 ? parseSummary(trimmed) : null;

  const status: FreshSummarizeStatus = parsed
    ? 'success'
    : trimmed.length === 0
      ? 'no_text'
      : 'parse_failed';

  // Emit SDK_USAGE line so the daily aggregator (grep on usageChannel) picks
  // up fresh-path cost. Channel distinguishes from the observer session's
  // claude_sdk_main channel. Only emit when at least one assistant message
  // was seen (i.e. tokens may have been consumed); pure-throw cases in the
  // catch block above skip this path intentionally so aggregators don't see
  // zero-token "free success" rows.
  if (inputTokens !== undefined || outputTokens !== undefined) {
    logger.info('SDK', 'SDK_USAGE', {
      usageChannel: 'claude_sdk_fresh_summarize',
      memorySessionId: input.memorySessionId,
      status,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      durationMs,
      obsCount,
    });
  }

  if (status === 'no_text') {
    return { status, durationMs, obsCount, inputTokens, outputTokens };
  }
  if (status === 'parse_failed') {
    return {
      status,
      rawText: collectedText,
      durationMs,
      obsCount,
      inputTokens,
      outputTokens,
    };
  }
  return {
    status,
    summary: parsed!,
    rawText: collectedText,
    durationMs,
    obsCount,
    inputTokens,
    outputTokens,
  };
}
