import { SessionStore } from '../../sqlite/SessionStore.js';
import { logger } from '../../../utils/logger.js';

/**
 * Validates user prompt privacy for session operations
 *
 * Centralizes privacy checks to avoid duplicate validation logic across route handlers.
 * If user prompt was entirely private (stripped to empty string), we skip processing.
 */
export class PrivacyCheckValidator {
  /** Returned when user prompt is not yet in DB (compaction race, worker restart). */
  static readonly PROMPT_NOT_FOUND_PLACEHOLDER = '[prompt not yet recorded]';
  /**
   * Check if user prompt is public (not entirely private)
   *
   * IMPORTANT: "Prompt not found" (null from getUserPrompt) is NOT the same as
   * "prompt was private" (empty string after tag stripping). After context compaction
   * or worker restart, the user prompt may not yet be saved when PostToolUse fires.
   * In that case we must NOT skip the observation — only skip if the prompt was
   * explicitly saved as empty (i.e., entirely wrapped in <private> tags).
   *
   * @param store - SessionStore instance
   * @param contentSessionId - Claude session ID
   * @param promptNumber - Prompt number within session
   * @param operationType - Type of operation being validated ('observation' or 'summarize')
   * @returns User prompt text if public, null if private (explicitly empty)
   */
  static checkUserPromptPrivacy(
    store: SessionStore,
    contentSessionId: string,
    promptNumber: number,
    operationType: 'observation' | 'summarize',
    sessionDbId: number,
    additionalContext?: Record<string, any>
  ): string | null {
    const userPrompt = store.getUserPrompt(contentSessionId, promptNumber);

    // Prompt not found in DB — this is NOT a privacy signal.
    // Common causes: compaction race, worker restart, session ID change.
    // Allow the operation to proceed with a synthetic placeholder.
    if (userPrompt === null) {
      logger.warn('HOOK', `${operationType}: user prompt #${promptNumber} not found in DB — proceeding (not a privacy skip)`, {
        sessionId: sessionDbId,
        promptNumber,
        contentSessionId,
        ...additionalContext
      });
      return PrivacyCheckValidator.PROMPT_NOT_FOUND_PLACEHOLDER;
    }

    // Prompt exists but was stripped to empty by privacy tag removal.
    // This IS a genuine privacy signal — skip the operation.
    if (userPrompt.trim() === '') {
      logger.debug('HOOK', `Skipping ${operationType} - user prompt was entirely private`, {
        sessionId: sessionDbId,
        promptNumber,
        ...additionalContext
      });
      return null;
    }

    return userPrompt;
  }
}
