/**
 * User prompt storage operations
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

/**
 * Save a user prompt to the database
 *
 * @param isRedacted When true, marks the row so PrivacyCheckValidator skips
 *   downstream processing. See SessionStore.saveUserPrompt for rationale.
 * @returns The inserted row ID
 */
export function saveUserPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number,
  promptText: string,
  isRedacted: boolean = false
): number {
  const now = new Date();
  const nowEpoch = now.getTime();

  const stmt = db.prepare(`
    INSERT INTO user_prompts
    (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, is_redacted)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch, isRedacted ? 1 : 0);
  return result.lastInsertRowid as number;
}

/**
 * Check if a user prompt was explicitly marked redacted at save time.
 */
export function isUserPromptRedacted(
  db: Database,
  contentSessionId: string,
  promptNumber: number
): boolean {
  const stmt = db.prepare(`
    SELECT is_redacted
    FROM user_prompts
    WHERE content_session_id = ? AND prompt_number = ?
    LIMIT 1
  `);
  const result = stmt.get(contentSessionId, promptNumber) as { is_redacted: number } | undefined;
  return result?.is_redacted === 1;
}
