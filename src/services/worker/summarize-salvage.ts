/**
 * Summarize salvage utilities.
 *
 * Shared logic for synthesizing a session summary from recent DB observations
 * when the normal summarize path cannot produce one. Used in three places:
 *
 *   1. Pre-queue (SessionManager.queueSummarize)
 *        — fires when the hook yields no assistant text, before we waste an
 *          SDK invocation on an empty prompt.
 *   2. HTTP route (SessionRoutes.handleSummarizeByClaudeId)
 *        — same as above but surfaces a SSE broadcast via the worker.
 *   3. In-response (ResponseProcessor) — fallback branch when Claude's response
 *      yielded neither parseable observations nor raw text.
 *
 * Keeping the synthesis in one place means "what a salvaged summary looks
 * like" only changes in one spot, and all three entry paths converge on the
 * same dedup window in SessionStore.storeSummary.
 */

import type { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';

export interface SummaryPayload {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

export interface SalvageBroadcastPayload {
  id: number;
  session_id: string;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
  project: string;
  prompt_number: number | null;
  created_at_epoch: number;
}

export interface SynthesisResult {
  summary: SummaryPayload;
  obsCount: number;
  titleSample: string[];
}

export type SalvageStatus = 'salvaged' | 'skipped' | 'fallthrough';

export interface SalvageResult {
  status: SalvageStatus;
  summaryId?: number;
  obsCount: number;
}

/**
 * Build a synthesized summary object from recent session observations.
 * Returns null if the session has no observations to draw from.
 */
export function synthesizeSummaryFromRecentObservations(
  store: SessionStore,
  memorySessionId: string,
  userPrompt: string | null,
  notePrefix: string,
  limit: number = 20,
): SynthesisResult | null {
  const recent = store.getRecentObservationsForSession(memorySessionId, limit);
  if (recent.length === 0) return null;

  const titles = recent
    .map(o => o.title)
    .filter((t): t is string => !!t && t.trim() !== '');
  const narratives = recent
    .map(o => o.narrative)
    .filter((n): n is string => !!n && n.trim() !== '');
  const factList: string[] = [];
  for (const obs of recent) {
    if (!obs.facts) continue;
    try {
      const parsed = JSON.parse(obs.facts);
      if (Array.isArray(parsed)) {
        for (const f of parsed) {
          if (typeof f === 'string' && f.trim() !== '') factList.push(f);
        }
      }
    } catch {
      // facts column may be plain text or malformed — skip
    }
  }
  const completedTitles = recent
    .filter(o => o.type === 'feature' || o.type === 'bugfix')
    .map(o => o.title)
    .filter((t): t is string => !!t);

  const summary: SummaryPayload = {
    request: userPrompt?.trim() || `Session observations (${recent.length} items)`,
    investigated: narratives.slice(0, 5).join('\n\n') || titles.slice(0, 10).join('; '),
    learned: factList.slice(0, 10).join('; ') || titles.slice(0, 10).join('; '),
    completed: completedTitles.slice(0, 5).join('; '),
    next_steps: '',
    notes: `[Salvaged from ${recent.length} observation(s) — ${notePrefix}]`,
  };

  return { summary, obsCount: recent.length, titleSample: titles.slice(0, 3) };
}

/**
 * Pre-queue salvage path: invoked before enqueueing a summarize when the
 * caller's lastAssistantMessage is empty/whitespace. Stores the synthesized
 * summary and (optionally) notifies SSE subscribers.
 */
export function attemptEmptyTranscriptSalvage(
  store: SessionStore,
  sessionDbId: number,
  lastAssistantMessage: string | undefined,
  promptNumber: number | null,
  onStored?: (payload: SalvageBroadcastPayload) => void,
): SalvageResult {
  const trimmed = typeof lastAssistantMessage === 'string' ? lastAssistantMessage.trim() : '';
  if (trimmed) return { status: 'fallthrough', obsCount: 0 };

  const sessionRow = store.getSessionById(sessionDbId);
  if (!sessionRow?.memory_session_id) {
    return { status: 'fallthrough', obsCount: 0 };
  }

  const synthesized = synthesizeSummaryFromRecentObservations(
    store,
    sessionRow.memory_session_id,
    sessionRow.user_prompt,
    'transcript had no assistant text',
  );

  if (!synthesized) {
    logger.info('SESSION', 'Skipping summarize — empty transcript AND 0 observations', {
      sessionId: sessionDbId,
    });
    return { status: 'skipped', obsCount: 0 };
  }

  let result: { id: number; createdAtEpoch: number };
  try {
    result = store.storeSummary(
      sessionRow.memory_session_id,
      sessionRow.project,
      synthesized.summary,
      promptNumber ?? undefined,
      0,
    );
  } catch (err) {
    logger.error(
      'SESSION',
      'Salvage storeSummary failed — falling through to normal queue',
      { sessionId: sessionDbId },
      err as Error,
    );
    return { status: 'fallthrough', obsCount: synthesized.obsCount };
  }

  logger.warn(
    'PARSER',
    `Synthesized summary from ${synthesized.obsCount} observation(s) — no transcript text`,
    {
      sessionId: sessionDbId,
      summaryId: result.id,
      obsCount: synthesized.obsCount,
      titleSample: synthesized.titleSample,
    },
  );

  if (onStored) {
    onStored({
      id: result.id,
      session_id: sessionRow.content_session_id,
      request: synthesized.summary.request,
      investigated: synthesized.summary.investigated,
      learned: synthesized.summary.learned,
      completed: synthesized.summary.completed,
      next_steps: synthesized.summary.next_steps,
      notes: synthesized.summary.notes,
      project: sessionRow.project,
      prompt_number: promptNumber,
      created_at_epoch: result.createdAtEpoch,
    });
  }

  return { status: 'salvaged', summaryId: result.id, obsCount: synthesized.obsCount };
}
