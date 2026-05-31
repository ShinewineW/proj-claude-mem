/**
 * Single source of truth for `FreshSummarizeDeps` construction.
 *
 * Consumed by SummaryLane.buildDeps (Chunk 6b.1) and transitionally by
 * SDKAgent.runFreshSummarize until Chunk 8 removes that method. Keeps the
 * atomic 4-6 block ESM-pure and preserves the AbortSignal → AbortController
 * plumbing that session teardown depends on.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { FreshSummarizeDeps } from './fresh-summarize.js';

export interface BuildFreshSummarizeDepsInput {
  getObservationsForSession: FreshSummarizeDeps['getObservationsForSession'];
  modelId: string;
  disallowedTools: string[];
  /**
   * Caller-owned AbortSignal. The helper wires it to an internally-owned
   * AbortController so `FreshSummarizeDeps.abortController` fires when the
   * caller aborts. This is the shutdown plumbing — without it,
   * SummaryLane.stop()/SessionManager.finalizeSession cannot cancel an
   * in-flight fresh subprocess.
   */
  signal: AbortSignal;
  isolatedEnv: NodeJS.ProcessEnv;
  cwd: string;
  pathToClaudeCodeExecutable: string;
  /** Optional SDK spawn wrapper; fresh-summarize uses an untracked stderr-tail wrapper. */
  spawnClaudeCodeProcess?: FreshSummarizeDeps['spawnClaudeCodeProcess'];
}

export function buildFreshSummarizeDeps(input: BuildFreshSummarizeDepsInput): FreshSummarizeDeps {
  const abortController = new AbortController();
  if (input.signal.aborted) {
    abortController.abort();
  } else {
    input.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  return {
    query: query as unknown as FreshSummarizeDeps['query'],
    getObservationsForSession: input.getObservationsForSession,
    modelId: input.modelId,
    disallowedTools: input.disallowedTools,
    abortController,
    isolatedEnv: input.isolatedEnv,
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    spawnClaudeCodeProcess: input.spawnClaudeCodeProcess,
  };
}
