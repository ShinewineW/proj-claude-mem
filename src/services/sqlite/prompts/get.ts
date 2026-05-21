/**
 * User prompt retrieval operations
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { UserPromptRecord, LatestPromptResult } from '../../../types/database.js';
import type { RecentUserPromptResult, PromptWithProject, GetPromptsByIdsOptions } from './types.js';
import { assertValidLimit } from '../query-utils.js';

/**
 * Get user prompt by session ID and prompt number
 * @returns The prompt text, or null if not found
 */
export function getUserPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number
): string | null {
  const stmt = db.prepare(`
    SELECT prompt_text
    FROM user_prompts
    WHERE content_session_id = ? AND prompt_number = ?
    LIMIT 1
  `);

  const result = stmt.get(contentSessionId, promptNumber) as { prompt_text: string } | undefined;
  return result?.prompt_text ?? null;
}

/**
 * Get current prompt number by counting user_prompts for this session
 * Replaces the prompt_counter column which is no longer maintained
 *
 * NOTE: counts ALL rows (including is_redacted=1). Use only when ASSIGNING
 * the next prompt_number to a freshly arriving prompt — the redacted-row
 * placeholders must advance the counter to keep numbering monotonic and
 * prevent the stale-prompt skip-loop fixed in migration 32. For ATTRIBUTING
 * downstream work (observation / summarize) to a turn, use
 * `getLatestRealPromptNumber` instead so noise prompts (`<task-notification>`,
 * Monitor events, etc.) don't steal credit for work belonging to the
 * preceding real user prompt.
 */
export function getPromptNumberFromUserPrompts(db: Database, contentSessionId: string): number {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
  `).get(contentSessionId) as { count: number };
  return result.count;
}

/**
 * Get the latest non-redacted prompt_number for attribution purposes.
 *
 * Use this when answering "which user prompt does this observation/summary
 * belong to?". Redacted placeholder rows (is_redacted=1) advance the global
 * counter but do not represent user intent, so work that arrives in their
 * window should attribute back to the preceding real prompt. Returns 0 when
 * no real prompt exists yet for the session.
 */
export function getLatestRealPromptNumber(db: Database, contentSessionId: string): number {
  const result = db.prepare(`
    SELECT COALESCE(MAX(prompt_number), 0) AS pn
    FROM user_prompts
    WHERE content_session_id = ? AND is_redacted = 0
  `).get(contentSessionId) as { pn: number };
  return result.pn;
}

/**
 * Get latest user prompt with session info for a Claude session
 * Used for syncing prompts to Chroma during session initialization and for
 * broadcasting "new prompt" SSE events. Redacted placeholder rows are skipped
 * — they have no content to sync and would render as a blank Ask card in the
 * viewer.
 */
export function getLatestUserPrompt(
  db: Database,
  contentSessionId: string
): LatestPromptResult | undefined {
  const stmt = db.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.content_session_id = ?
      AND up.is_redacted = 0
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `);

  return stmt.get(contentSessionId) as LatestPromptResult | undefined;
}

/**
 * Get recent user prompts across all sessions (for web UI)
 * Excludes redacted placeholders — they carry no user-visible content.
 */
export function getAllRecentUserPrompts(
  db: Database,
  limit: number = 100
): RecentUserPromptResult[] {
  const stmt = db.prepare(`
    SELECT
      up.id,
      up.content_session_id,
      s.project,
      up.prompt_number,
      up.prompt_text,
      up.created_at,
      up.created_at_epoch
    FROM user_prompts up
    LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.is_redacted = 0
    ORDER BY up.created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(limit) as RecentUserPromptResult[];
}

/**
 * Get a single user prompt by ID
 */
export function getPromptById(db: Database, id: number): PromptWithProject | null {
  const stmt = db.prepare(`
    SELECT
      p.id,
      p.content_session_id,
      p.prompt_number,
      p.prompt_text,
      s.project,
      p.created_at,
      p.created_at_epoch
    FROM user_prompts p
    LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE p.id = ?
    LIMIT 1
  `);

  return (stmt.get(id) as PromptWithProject | undefined) || null;
}

/**
 * Get multiple user prompts by IDs
 */
export function getPromptsByIds(db: Database, ids: number[]): PromptWithProject[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT
      p.id,
      p.content_session_id,
      p.prompt_number,
      p.prompt_text,
      s.project,
      p.created_at,
      p.created_at_epoch
    FROM user_prompts p
    LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE p.id IN (${placeholders})
    ORDER BY p.created_at_epoch DESC
  `);

  return stmt.all(...ids) as PromptWithProject[];
}

/**
 * Get user prompts by IDs (for hybrid Chroma search)
 * Returns prompts in specified temporal order with optional project filter
 */
export function getUserPromptsByIds(
  db: Database,
  ids: number[],
  options: GetPromptsByIdsOptions = {}
): UserPromptRecord[] {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';

  assertValidLimit(limit);

  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];

  const projectFilter = project ? 'AND s.project = ?' : '';
  if (project) params.push(project);

  const stmt = db.prepare(`
    SELECT
      up.*,
      s.project,
      s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.id IN (${placeholders}) ${projectFilter}
    ORDER BY up.created_at_epoch ${orderClause}
    ${limit ? 'LIMIT ?' : ''}
  `);

  const allParams = limit ? [...params, limit] : params;
  return stmt.all(...allParams) as UserPromptRecord[];
}
