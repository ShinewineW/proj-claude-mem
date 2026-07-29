import type { DatabaseManager } from './DatabaseManager.js';
import type { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';

type FallbackQueueModule = typeof import('../../shared/fallback-queue.js');

export interface FallbackReplayDependencies {
  dbManager: Pick<DatabaseManager, 'getSessionStore'>;
  sessionManager: Pick<SessionManager, 'queueObservation' | 'queueSummarize'>;
  fallbackDir?: string;
  fallbackQueue?: FallbackQueueModule;
}

/**
 * Replay fallback entries written by hooks while the worker was unreachable.
 * Dependencies are injectable so the recovery path can be tested without
 * constructing the full worker or touching the user's fallback directory.
 */
export async function replayFallbackEntriesForWorker(
  deps: FallbackReplayDependencies,
): Promise<number> {
  const {
    readFallbackEntries,
    deleteFallbackFile,
    cleanupStaleFallbacks,
    getDefaultFallbackDir,
  } = deps.fallbackQueue ?? await import('../../shared/fallback-queue.js');
  const fallbackDir = deps.fallbackDir ?? getDefaultFallbackDir();

  const staleRemoved = cleanupStaleFallbacks(fallbackDir);
  if (staleRemoved > 0) {
    logger.info('SYSTEM', `Cleaned up ${staleRemoved} stale fallback files`);
  }

  const entries = readFallbackEntries(fallbackDir);
  let replayed = 0;

  for (const { entry, filepath } of entries) {
    try {
      const store = deps.dbManager.getSessionStore(entry.dbPath);
      const existing = store.db.prepare(
        'SELECT id FROM sdk_sessions WHERE content_session_id = ?'
      ).get(entry.sessionId) as { id: number } | undefined;

      if (!existing) {
        logger.debug('SYSTEM', 'Fallback entry references non-existent session, discarding', { filepath });
        deleteFallbackFile(filepath);
        continue;
      }

      const sessionDbId = existing.id;

      if (entry.type === 'observation') {
        const toolName = entry.payload.tool_name as string | undefined;
        if (!toolName) {
          logger.warn('SYSTEM', 'Fallback entry missing tool_name, skipping', { filepath });
          deleteFallbackFile(filepath);
          continue;
        }
        const enqueued = deps.sessionManager.queueObservation(sessionDbId, {
          tool_name: toolName,
          tool_input: entry.payload.tool_input,
          tool_response: entry.payload.tool_response,
          cwd: entry.cwd,
          prompt_number: (entry.payload.prompt_number as number) ?? 0
        }, entry.dbPath);
        if (!enqueued) {
          logger.info('SYSTEM', 'Replayed observation dropped by backpressure', { sessionDbId });
        }
      } else if (entry.type === 'summarize') {
        // Attribution resolves to the latest real prompt at the fallback time.
        let promptNumber: number | null | undefined =
          entry.payload.prompt_number as number | null | undefined;
        if (typeof promptNumber !== 'number') {
          try {
            const row = store.db.prepare(`
              SELECT MAX(prompt_number) AS mx FROM user_prompts
              WHERE content_session_id = ?
                AND created_at_epoch <= ?
                AND is_redacted = 0
            `).get(entry.sessionId, entry.timestamp) as { mx: number | null } | undefined;
            promptNumber = row?.mx ?? null;
          } catch (err) {
            logger.warn('SYSTEM', 'Fallback summarize: resolve-at-replay failed', { filepath }, err as Error);
            promptNumber = null;
          }
        }
        if (typeof promptNumber !== 'number') {
          logger.warn('SYSTEM', 'Fallback summarize entry has no resolvable prompt_number, dropping', {
            filepath, contentSessionId: entry.sessionId,
          });
          deleteFallbackFile(filepath);
          continue;
        }

        // Identity includes redacted placeholders and uses the same timestamp.
        let turnNumber: number | null =
          (entry.payload.turn_number as number | null | undefined) ?? null;
        if (typeof turnNumber !== 'number') {
          try {
            const row = store.db.prepare(`
              SELECT MAX(prompt_number) AS mx FROM user_prompts
              WHERE content_session_id = ?
                AND created_at_epoch <= ?
            `).get(entry.sessionId, entry.timestamp) as { mx: number | null } | undefined;
            turnNumber = row?.mx ?? null;
          } catch (err) {
            logger.warn('SYSTEM', 'Fallback summarize: turn-number resolve failed', { filepath }, err as Error);
            turnNumber = null;
          }
        }
        deps.sessionManager.queueSummarize(
          sessionDbId,
          {
            lastAssistantMessage: entry.payload.last_assistant_message as string | undefined,
            promptNumber,
            turnNumber: turnNumber ?? promptNumber,
            queuedAtEpoch: entry.timestamp,
          },
          entry.dbPath,
        );
      }

      deleteFallbackFile(filepath);
      replayed++;
    } catch (replayError) {
      logger.warn('SYSTEM', 'Failed to replay fallback entry, deleting', { filepath }, replayError as Error);
      deleteFallbackFile(filepath);
    }
  }

  return replayed;
}
