/**
 * File Edit Handler - Cursor-specific afterFileEdit
 *
 * Handles file edit observations from Cursor IDE.
 * Similar to observation handler but with file-specific metadata.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, fetchWithTimeout } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { resolveProjectContext } from '../../shared/project-allowlist.js';
import { writeFallbackEntry } from '../../shared/fallback-queue.js';

export const fileEditHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, filePath, edits } = input;

    if (!filePath) {
      throw new Error('fileEditHandler requires filePath');
    }

    // Validate required fields before sending to worker
    if (!cwd) {
      throw new Error(`Missing cwd in FileEdit hook input for session ${sessionId}, file ${filePath}`);
    }

    // Project context resolution
    const ctx = input._projectContext ?? resolveProjectContext(cwd);
    if (!ctx) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
    const { dbPath } = ctx;

    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      writeFallbackEntry({
        type: 'observation', sessionId, cwd, dbPath,
        timestamp: Date.now(),
        payload: { tool_name: 'write_file', tool_input: { filePath, edits }, tool_response: { success: true } }
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const port = getWorkerPort();

    logger.dataIn('HOOK', `FileEdit: ${filePath}`, {
      workerPort: port,
      editCount: edits?.length ?? 0
    });

    // Send to worker as an observation with file edit metadata
    // The observation handler on the worker will process this appropriately
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/sessions/observations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contentSessionId: sessionId,
            tool_name: 'write_file',
            tool_input: { filePath, edits },
            tool_response: { success: true },
            cwd,
            dbPath
          })
        },
        10_000
      );

      if (!response.ok) {
        logger.warn('HOOK', 'File edit observation storage failed, writing fallback', { status: response.status, filePath });
        writeFallbackEntry({
          type: 'observation', sessionId, cwd, dbPath,
          timestamp: Date.now(),
          payload: { tool_name: 'write_file', tool_input: { filePath, edits }, tool_response: { success: true } }
        });
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      logger.debug('HOOK', 'File edit observation sent successfully', { filePath });
    } catch (error) {
      logger.warn('HOOK', 'File edit observation fetch error, writing fallback', { error: error instanceof Error ? error.message : String(error) });
      writeFallbackEntry({
        type: 'observation', sessionId, cwd, dbPath,
        timestamp: Date.now(),
        payload: { tool_name: 'write_file', tool_input: { filePath, edits }, tool_response: { success: true } }
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    return { continue: true, suppressOutput: true };
  }
};
