/**
 * Context Handler - SessionStart
 *
 * Extracted from context-hook.ts - calls worker to generate context.
 * Returns context as hookSpecificOutput for Claude Code to inject.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, restartWorker } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { resolveProjectContext } from '../../shared/project-allowlist.js';

const EMPTY_CONTEXT_RESULT: HookResult = {
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
  exitCode: HOOK_EXIT_CODES.SUCCESS
};

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      return EMPTY_CONTEXT_RESULT;
    }

    const cwd = input.cwd ?? process.cwd();
    const ctx = input._projectContext ?? resolveProjectContext(cwd);
    if (!ctx) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
    const { dbPath } = ctx;

    const port = getWorkerPort();

    // Check if terminal output should be shown (load settings early)
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    // ctx.projectName is allowlist-resolved; getProjectContext() heuristic can diverge
    const projectsParam = ctx.projectName;
    const url = `http://127.0.0.1:${port}/api/context/inject?projects=${encodeURIComponent(projectsParam)}&dbPath=${encodeURIComponent(dbPath)}`;

    try {
      const result = await fetchContextWithRetry(url, port, showTerminalOutput);
      return result;
    } catch (error) {
      // Worker unreachable — return empty context gracefully
      logger.warn('HOOK', 'Context fetch error, returning empty', { error: error instanceof Error ? error.message : String(error) });
      return EMPTY_CONTEXT_RESULT;
    }
  }
};

/**
 * Fetch context from worker. On 500, restart worker and retry once.
 * Addresses the "alive but broken" daemon scenario (e.g., stale Bun runtime after brew upgrade).
 */
async function fetchContextWithRetry(
  url: string,
  port: number,
  showTerminalOutput: boolean,
): Promise<HookResult> {
  const colorUrl = `${url}&colors=true`;

  // First attempt
  const [response, colorResponse] = await Promise.all([
    fetch(url),
    showTerminalOutput ? fetch(colorUrl).catch(() => null) : Promise.resolve(null)
  ]);

  if (response.ok) {
    return buildSuccessResult(response, colorResponse, port, showTerminalOutput);
  }

  // --- First attempt failed (non-200) ---
  // Log the response body for diagnostics (previously only status was logged)
  const errorBody = await response.text().catch(() => '(unreadable)');
  logger.error('HOOK', 'Context inject returned non-200, attempting worker restart', {
    status: response.status,
    body: errorBody.slice(0, 500)
  });
  process.stderr.write(`[claude-mem] ⚠ Context injection failed (HTTP ${response.status}). Restarting worker...\n`);

  // Restart worker and retry once
  const restarted = await restartWorker();
  if (!restarted) {
    logger.error('HOOK', 'Worker restart failed — context unavailable for this session');
    process.stderr.write('[claude-mem] ⚠ Worker restart failed. Session starts without historical context.\n');
    return EMPTY_CONTEXT_RESULT;
  }

  // Retry after restart
  const retryPort = getWorkerPort();
  const retryUrl = url.replace(`:${port}/`, `:${retryPort}/`);
  const retryColorUrl = `${retryUrl}&colors=true`;

  const [retryResponse, retryColorResponse] = await Promise.all([
    fetch(retryUrl),
    showTerminalOutput ? fetch(retryColorUrl).catch(() => null) : Promise.resolve(null)
  ]);

  if (retryResponse.ok) {
    logger.info('HOOK', 'Context inject succeeded after worker restart');
    process.stderr.write('[claude-mem] ✓ Worker restarted. Context recovered.\n');
    return buildSuccessResult(retryResponse, retryColorResponse, retryPort, showTerminalOutput);
  }

  // Retry also failed
  const retryBody = await retryResponse.text().catch(() => '(unreadable)');
  logger.error('HOOK', 'Context inject failed after worker restart', {
    status: retryResponse.status,
    body: retryBody.slice(0, 500)
  });
  process.stderr.write('[claude-mem] ⚠ Context injection still failing after restart. Session starts without historical context.\n');
  return EMPTY_CONTEXT_RESULT;
}

async function buildSuccessResult(
  response: Response,
  colorResponse: Response | null,
  port: number,
  showTerminalOutput: boolean,
): Promise<HookResult> {
  const [contextResult, colorResult] = await Promise.all([
    response.text(),
    colorResponse?.ok ? colorResponse.text() : Promise.resolve('')
  ]);

  const additionalContext = contextResult.trim();
  const coloredTimeline = colorResult.trim();

  const systemMessage = showTerminalOutput && coloredTimeline
    ? `${coloredTimeline}\n\nView Observations Live @ http://localhost:${port}`
    : undefined;

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext
    },
    systemMessage
  };
}
