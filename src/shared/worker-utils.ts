import path from "path";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT } from "./paths.js";

// Named constants for health checks
// Allow env var override for users on slow systems (e.g., CLAUDE_MEM_HEALTH_TIMEOUT_MS=10000)
const HEALTH_CHECK_TIMEOUT_MS = (() => {
  const envVal = process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= 500 && parsed <= 300000) {
      return parsed;
    }
    // Invalid env var — log once and use default
    logger.warn('SYSTEM', 'Invalid CLAUDE_MEM_HEALTH_TIMEOUT_MS, using default', {
      value: envVal, min: 500, max: 300000
    });
  }
  return getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);
})();

/**
 * Fetch with a timeout using Promise.race instead of AbortSignal.
 * AbortSignal.timeout() causes a libuv assertion crash in Bun on Windows,
 * so we use a racing setTimeout pattern that avoids signal cleanup entirely.
 * The orphaned fetch is harmless since the process exits shortly after.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(
      () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    fetch(url, init).then(
      response => { clearTimeout(timeoutId); resolve(response); },
      err => { clearTimeout(timeoutId); reject(err); }
    );
  });
}

// Cache to avoid repeated settings file reads
let cachedPort: number | null = null;
let cachedHost: string | null = null;

/**
 * Get the worker port number from settings
 * Uses CLAUDE_MEM_WORKER_PORT from settings file or default (37777)
 * Caches the port value to avoid repeated file reads
 */
export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
  return cachedPort;
}

/**
 * Get the worker host address
 * Uses CLAUDE_MEM_WORKER_HOST from settings file or default (127.0.0.1)
 * Caches the host value to avoid repeated file reads
 */
export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedHost = settings.CLAUDE_MEM_WORKER_HOST;
  return cachedHost;
}

/**
 * Clear the cached port and host values
 * Call this when settings are updated to force re-reading from file
 */
export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
}

/**
 * Check if worker HTTP server is responsive
 * Uses /api/health (liveness) instead of /api/readiness because:
 * - Hooks have 15-second timeout, but full initialization can take 5+ minutes (MCP connection)
 * - /api/health returns 200 as soon as HTTP server is up (sufficient for hook communication)
 * - /api/readiness returns 503 until full initialization completes (too slow for hooks)
 * See: https://github.com/thedotmack/claude-mem/issues/811
 */
async function isWorkerHealthy(): Promise<boolean> {
  const port = getWorkerPort();
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${port}/api/health`, {}, HEALTH_CHECK_TIMEOUT_MS
  );
  return response.ok;
}

/**
 * Get the current plugin version from package.json.
 * Returns 'unknown' on ENOENT/EBUSY (shutdown race condition, fix #1042).
 */
function getPluginVersion(): string {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'plugin', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EBUSY') {
      logger.debug('SYSTEM', 'Could not read plugin version (shutdown race)', { code });
      return 'unknown';
    }
    throw error;
  }
}

/**
 * Get the running worker's version from the API
 */
async function getWorkerVersion(): Promise<string> {
  const port = getWorkerPort();
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${port}/api/version`, {}, HEALTH_CHECK_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

// Throttle version checks to at most once per 60s (P2 §3.2.3)
let lastVersionCheckAt = 0;
const VERSION_CHECK_INTERVAL_MS = 60_000;

/**
 * Check if worker version matches plugin version.
 * Log-only on mismatch — does NOT trigger restart from the hook path.
 *
 * DESIGN (spec §3.2.3): The old worker is backward-compatible. Sending a
 * restart from here would actively shut down a working worker, pushing
 * PostToolUse into ECONNREFUSED → fallback queue. The hook path only logs.
 *
 * Restart happens via two best-effort paths:
 * 1. build-and-sync (sync-to-cache.cjs POST)
 * 2. Natural lifecycle: idle timeout, OOM, manual restart
 *
 * Throttled to once per 60s to reduce HTTP overhead.
 */
async function checkWorkerVersion(): Promise<void> {
  const now = Date.now();
  if (now - lastVersionCheckAt < VERSION_CHECK_INTERVAL_MS) return;
  lastVersionCheckAt = now;

  try {
    const pluginVersion = getPluginVersion();
    if (pluginVersion === 'unknown') return;

    const workerVersion = await getWorkerVersion();
    if (workerVersion === 'unknown') return;

    if (pluginVersion !== workerVersion) {
      logger.warn('HOOK', `Version mismatch: worker=${workerVersion}, plugin=${pluginVersion}`, {
        note: 'Restart will happen via build-and-sync or natural lifecycle. Hook path does not restart.'
      });
    }
  } catch (error) {
    logger.debug('SYSTEM', 'Version check failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}


/**
 * Try to start the worker by spawning the start command.
 * This is a fallback for when the worker crashed after SessionStart.
 * Returns true if the worker became healthy after the spawn attempt.
 */
async function tryStartWorker(): Promise<boolean> {
  try {
    const workerScript = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');
    const bunRunner = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'bun-runner.js');

    logger.info('SYSTEM', 'Worker not healthy — attempting auto-start');

    // Spawn worker start synchronously with a short timeout.
    // Capture stderr so diagnostic output (ENOENT, wrong path, etc.) surfaces
    // in the log instead of being silently dropped — the previous 'ignore'
    // stdio hid a MARKETPLACE_ROOT path bug for weeks.
    execFileSync('node', [bunRunner, workerScript, 'start'], {
      timeout: 12_000,
      stdio: 'pipe'
    });

    // Verify the worker is now healthy
    return await isWorkerHealthy();
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    logger.warn('SYSTEM', 'Worker auto-start failed', {
      error: err.message ?? String(error),
      exitCode: err.status,
      stderrTail: stderr ? stderr.split('\n').slice(-3).join(' | ') : undefined,
    });
    return false;
  }
}

/**
 * Force-restart the worker daemon.
 * Sends shutdown to the running worker, waits for port to free, then starts fresh.
 * Used when the worker is alive (health check passes) but functionally broken
 * (e.g., context inject returns 500 due to stale Bun runtime after brew upgrade).
 *
 * Uses `worker-service.cjs restart` which handles: httpShutdown → SIGTERM → SIGKILL → spawn.
 * Returns true if the restarted worker is healthy.
 */
export async function restartWorker(): Promise<boolean> {
  try {
    const workerScript = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');
    const bunRunner = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'bun-runner.js');

    logger.info('SYSTEM', 'Force-restarting worker daemon');

    execFileSync('node', [bunRunner, workerScript, 'restart'], {
      timeout: 12_000,
      stdio: 'pipe'
    });

    return await isWorkerHealthy();
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    logger.warn('SYSTEM', 'Worker restart failed', {
      error: err.message ?? String(error),
      exitCode: err.status,
      stderrTail: stderr ? stderr.split('\n').slice(-3).join(' | ') : undefined,
    });
    return false;
  }
}

/**
 * Ensure worker service is running
 * Quick health check first; if unhealthy, attempts auto-start once.
 * This prevents silent hook degradation when the worker crashes after SessionStart.
 */
export async function ensureWorkerRunning(): Promise<boolean> {
  // Quick health check (single attempt, no polling)
  try {
    if (await isWorkerHealthy()) {
      await checkWorkerVersion();  // logs warning on mismatch, doesn't restart
      return true;  // Worker healthy
    }
  } catch (e) {
    // Not healthy - will try auto-start below
    logger.debug('SYSTEM', 'Worker health check failed', {
      error: e instanceof Error ? e.message : String(e)
    });
  }

  // Worker not healthy — try to start it (fixes post-compaction crash scenario)
  const started = await tryStartWorker();
  if (started) {
    logger.info('SYSTEM', 'Worker auto-started successfully');
    return true;
  }

  logger.warn('SYSTEM', 'Worker not healthy and auto-start failed');
  return false;
}
