/**
 * Stop Handler — Composite handler for Stop hook event
 *
 * Replaces the shell `;`-separated `summarize ; session-complete` with
 * a single in-process sequential call. Saves one full process fork chain (~150ms).
 *
 * Phase 1 (summarize): must complete before session-complete to avoid summary loss.
 * Phase 2 (session-complete): runs even if summarize fails.
 */

import { summarizeHandler } from './summarize.js';
import { sessionCompleteHandler } from './session-complete.js';
import { logger } from '../../utils/logger.js';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';

export const stopHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Phase 1: summarize must complete before session-complete
    try {
      await summarizeHandler.execute(input);
    } catch (error) {
      logger.warn('STOP', 'Summarize failed, continuing to session-complete', {}, error as Error);
    }

    // Phase 2: session-complete
    return sessionCompleteHandler.execute(input);
  }
};
