/**
 * ProcessRegistry: Track spawned Claude subprocesses
 *
 * Fixes Issue #737: Claude haiku subprocesses don't terminate properly,
 * causing zombie process accumulation (user reported 155 processes / 51GB RAM).
 *
 * Root causes:
 * 1. SDK's SpawnedProcess interface hides subprocess PIDs
 * 2. deleteSession() doesn't verify subprocess exit before cleanup
 * 3. abort() is fire-and-forget with no confirmation
 *
 * Solution:
 * - Use SDK's spawnClaudeCodeProcess option to capture PIDs
 * - Track all spawned processes with session association
 * - Verify exit on session deletion with timeout + SIGKILL escalation
 * - Safety net orphan reaper runs every 1 minute
 */

import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { filterEmptyFlagPairs } from './spawn-args-filter.js';

const execAsync = promisify(exec);

interface TrackedProcess {
  pid: number;
  sessionDbId: number;
  spawnedAt: number;
  process: ChildProcess;
  dbPath?: string;  // Per-project DB path for composite key session lookup
}

interface ClaudeSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

// PID Registry - tracks spawned Claude subprocesses
export const processRegistry = new Map<number, TrackedProcess>();

/**
 * Register a spawned process in the registry
 */
export function registerProcess(pid: number, sessionDbId: number, process: ChildProcess, dbPath?: string): void {
  processRegistry.set(pid, { pid, sessionDbId, spawnedAt: Date.now(), process, dbPath });
  logger.info('PROCESS', `Registered PID ${pid} for session ${sessionDbId}`, { pid, sessionDbId });
}

/**
 * Unregister a process from the registry and notify pool waiters
 */
export function unregisterProcess(pid: number): void {
  processRegistry.delete(pid);
  logger.debug('PROCESS', `Unregistered PID ${pid}`, { pid });
  // Notify waiters that a pool slot may be available
  notifySlotAvailable();
}

/**
 * Get process info by session ID.
 *
 * The numeric sessionDbId is NOT globally unique — two different projects (DBs)
 * can each have a live session with the same numeric id. When a dbPath is
 * supplied, the lookup also matches on `info.dbPath === dbPath` so callers that
 * act destructively on the result (SIGTERM/SIGKILL) only touch the process that
 * belongs to the same project. Omitting dbPath preserves the legacy
 * sessionDbId-only behavior.
 *
 * Warns if multiple processes match (indicates a race condition).
 */
export function getProcessBySession(sessionDbId: number, dbPath?: string): TrackedProcess | undefined {
  const matches: TrackedProcess[] = [];
  for (const [, info] of processRegistry) {
    if (info.sessionDbId !== sessionDbId) continue;
    if (dbPath !== undefined && info.dbPath !== dbPath) continue;
    matches.push(info);
  }
  if (matches.length > 1) {
    logger.warn('PROCESS', `Multiple processes found for session ${sessionDbId}`, {
      count: matches.length,
      dbPath,
      pids: matches.map(m => m.pid)
    });
  }
  return matches[0];
}

/**
 * Get count of active processes in the registry
 */
export function getActiveCount(): number {
  return processRegistry.size;
}

// Waiters for pool slots - resolved when a process exits and frees a slot
const slotWaiters: Array<() => void> = [];

/**
 * Notify waiters that a slot has freed up
 */
function notifySlotAvailable(): void {
  const waiter = slotWaiters.shift();
  if (waiter) waiter();
}

/**
 * Wait for a pool slot to become available (promise-based, not polling)
 * @param maxConcurrent Max number of concurrent agents
 * @param timeoutMs Max time to wait before giving up
 * @param isProcessStale Optional callback to detect zombie processes for active reclamation.
 *   Called with (pid, sessionDbId, dbPath). If returns true, the process is killed to free a slot.
 */
export async function waitForSlot(
  maxConcurrent: number,
  timeoutMs: number = 60_000,
  isProcessStale?: (pid: number, sessionDbId: number, dbPath?: string) => boolean
): Promise<void> {
  if (processRegistry.size < maxConcurrent) return;

  // Active reclamation: check if any pool occupant is a zombie
  if (isProcessStale) {
    for (const [pid, info] of processRegistry) {
      if (isProcessStale(pid, info.sessionDbId, info.dbPath)) {
        logger.warn('PROCESS', `Reclaiming stale pool slot — killing PID ${pid} (session ${info.sessionDbId})`, {
          pid,
          sessionDbId: info.sessionDbId,
          dbPath: info.dbPath,
          ageMs: Date.now() - info.spawnedAt
        });
        try {
          info.process.kill('SIGKILL');
        } catch {
          // Already dead
        }
        unregisterProcess(pid);

        if (processRegistry.size < maxConcurrent) return;
      }
    }
  }

  logger.info('PROCESS', `Pool limit reached (${processRegistry.size}/${maxConcurrent}), waiting for slot...`);

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = slotWaiters.indexOf(onSlot);
      if (idx >= 0) slotWaiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for agent pool slot after ${timeoutMs}ms`));
    }, timeoutMs);

    const onSlot = () => {
      clearTimeout(timeout);
      if (processRegistry.size < maxConcurrent) {
        resolve();
      } else {
        slotWaiters.push(onSlot);
      }
    };

    slotWaiters.push(onSlot);
  });
}

/**
 * Get all active PIDs (for debugging)
 */
export function getActiveProcesses(): Array<{ pid: number; sessionDbId: number; ageMs: number }> {
  const now = Date.now();
  return Array.from(processRegistry.values()).map(info => ({
    pid: info.pid,
    sessionDbId: info.sessionDbId,
    ageMs: now - info.spawnedAt
  }));
}

/**
 * Wait for a process to exit with timeout, escalating to SIGKILL if needed
 * Uses event-based waiting instead of polling to avoid CPU overhead
 */
export async function ensureProcessExit(tracked: TrackedProcess, timeoutMs: number = 5000): Promise<void> {
  const { pid, process: proc } = tracked;

  // Already exited?
  if (proc.exitCode !== null) {
    unregisterProcess(pid);
    return;
  }

  // Wait for graceful exit with timeout using event-based approach
  const exitPromise = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  // Check if exited gracefully
  if (proc.exitCode !== null) {
    unregisterProcess(pid);
    return;
  }

  // Timeout: escalate to SIGKILL
  logger.warn('PROCESS', `PID ${pid} did not exit after ${timeoutMs}ms, sending SIGKILL`, { pid, timeoutMs });
  try {
    proc.kill('SIGKILL');
  } catch {
    // Already dead
  }

  // Brief wait for SIGKILL to take effect
  await new Promise(resolve => setTimeout(resolve, 200));
  unregisterProcess(pid);
}

/**
 * Kill idle daemon children (claude processes spawned by worker-service)
 *
 * These are SDK-spawned claude processes that completed their work but
 * didn't terminate properly. They remain as children of the worker-service
 * daemon, consuming memory without doing useful work.
 *
 * Criteria for cleanup:
 * - Process name is "claude"
 * - Parent PID is the worker-service daemon (this process)
 * - Process has 0% CPU (idle)
 * - Process has been running for more than 1 minute
 */
async function killIdleDaemonChildren(): Promise<number> {
  if (process.platform === 'win32') {
    // Windows: Different process model, skip for now
    return 0;
  }

  const daemonPid = process.pid;
  let killed = 0;

  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,%cpu,etime,comm 2>/dev/null | grep "claude$" || true'
    );

    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const [pidStr, ppidStr, cpuStr, etime] = parts;
      const pid = parseInt(pidStr, 10);
      const ppid = parseInt(ppidStr, 10);
      const cpu = parseFloat(cpuStr);

      // Skip if not a child of this daemon
      if (ppid !== daemonPid) continue;

      // Skip if actively using CPU
      if (cpu > 0) continue;

      // Parse elapsed time to minutes
      // Formats: MM:SS, HH:MM:SS, D-HH:MM:SS
      let minutes = 0;
      const dayMatch = etime.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
      const hourMatch = etime.match(/^(\d+):(\d+):(\d+)$/);
      const minMatch = etime.match(/^(\d+):(\d+)$/);

      if (dayMatch) {
        minutes = parseInt(dayMatch[1], 10) * 24 * 60 +
                  parseInt(dayMatch[2], 10) * 60 +
                  parseInt(dayMatch[3], 10);
      } else if (hourMatch) {
        minutes = parseInt(hourMatch[1], 10) * 60 +
                  parseInt(hourMatch[2], 10);
      } else if (minMatch) {
        minutes = parseInt(minMatch[1], 10);
      }

      // Kill if idle for more than 1 minute
      if (minutes >= 1) {
        logger.info('PROCESS', `Killing idle daemon child PID ${pid} (idle ${minutes}m)`, { pid, minutes });
        try {
          process.kill(pid, 'SIGKILL');
          killed++;
        } catch {
          // Already dead or permission denied
        }
      }
    }
  } catch {
    // No matches or command error
  }

  return killed;
}

/**
 * Kill system-level orphans (ppid=1 on Unix)
 * These are Claude processes whose parent died unexpectedly
 */
async function killSystemOrphans(): Promise<number> {
  if (process.platform === 'win32') {
    return 0; // Windows doesn't have ppid=1 orphan concept
  }

  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,args 2>/dev/null | grep -E "claude.*haiku|claude.*output-format" | grep -v grep'
    );

    let killed = 0;
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const match = line.trim().match(/^(\d+)\s+(\d+)/);
      if (match && parseInt(match[2]) === 1) { // ppid=1 = orphan
        const orphanPid = parseInt(match[1]);
        logger.warn('PROCESS', `Killing system orphan PID ${orphanPid}`, { pid: orphanPid });
        try {
          process.kill(orphanPid, 'SIGKILL');
          killed++;
        } catch {
          // Already dead or permission denied
        }
      }
    }
    return killed;
  } catch {
    return 0; // No matches or error
  }
}

/**
 * Reap orphaned processes - both registry-tracked and system-level
 */
export async function reapOrphanedProcesses(activeSessionIds: Set<number>): Promise<number> {
  let killed = 0;

  // Registry-based: kill processes for dead sessions
  for (const [pid, info] of processRegistry) {
    if (activeSessionIds.has(info.sessionDbId)) continue; // Active = safe

    logger.warn('PROCESS', `Killing orphan PID ${pid} (session ${info.sessionDbId} gone)`, { pid, sessionDbId: info.sessionDbId });
    try {
      info.process.kill('SIGKILL');
      killed++;
    } catch {
      // Already dead
    }
    unregisterProcess(pid);
  }

  // System-level: find ppid=1 orphans
  killed += await killSystemOrphans();

  // Daemon children: find idle SDK processes that didn't terminate
  killed += await killIdleDaemonChildren();

  return killed;
}

function spawnClaudeChild(spawnOptions: ClaudeSpawnOptions): ChildProcess {
  // On Windows, use cmd.exe wrapper for .cmd files to properly handle paths with spaces.
  const useCmdWrapper = process.platform === 'win32' && spawnOptions.command.endsWith('.cmd');

  // Pair-aware filter: when the SDK emits `["--setting-sources", ""]`
  // (happens when settingSources defaults to []), dropping only the empty
  // string leaves --setting-sources orphaned and Claude consumes the next flag
  // as its value. See tests/worker/spawn-args-filter.test.ts.
  const args = filterEmptyFlagPairs(spawnOptions.args);

  return useCmdWrapper
    ? spawn('cmd.exe', ['/d', '/c', spawnOptions.command, ...args], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: spawnOptions.signal,
        windowsHide: true
      })
    : spawn(spawnOptions.command, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: spawnOptions.signal, // CRITICAL: Pass signal for AbortController integration
        windowsHide: true
      });
}

function captureStderrTail(child: ChildProcess, label: string): () => string | undefined {
  let stderrTail = '';
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      logger.debug('SDK_SPAWN', `[${label}] stderr: ${chunk.trim()}`);
      stderrTail = (stderrTail + chunk).slice(-2048);
    });
  }
  return () => stderrTail.trim() || undefined;
}

function toSdkProcess(child: ChildProcess) {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    kill: child.kill.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child)
  };
}

/**
 * Create a custom SDK spawn function that surfaces a bounded stderr tail on
 * non-zero exit WITHOUT registering the process in ProcessRegistry.
 *
 * SummaryLane uses this for fresh-summarize: we want crash diagnostics, but
 * registering the fresh subprocess under the host session lets observer pool
 * stale-session reclamation SIGKILL it while it is still running.
 */
export function createUntrackedStderrTailSpawn(label: string) {
  return (spawnOptions: ClaudeSpawnOptions) => {
    const child = spawnClaudeChild(spawnOptions);
    const getStderrTail = captureStderrTail(child, label);

    child.on('exit', (code: number | null, signal: string | null) => {
      if (code !== 0) {
        logger.warn('SDK_SPAWN', `[${label}] Claude process exited`, {
          code,
          signal,
          pid: child.pid,
          stderrTail: getStderrTail(),
        });
      }
    });

    return toSdkProcess(child);
  };
}

/**
 * Create a custom spawn function for SDK that captures PIDs
 *
 * The SDK's spawnClaudeCodeProcess option allows us to intercept subprocess
 * creation and capture the PID before the SDK hides it.
 *
 * NOTE: Session isolation is handled via the `cwd` option in SDKAgent.ts,
 * NOT via CLAUDE_CONFIG_DIR (which breaks authentication).
 */
export function createPidCapturingSpawn(sessionDbId: number, dbPath?: string) {
  return (spawnOptions: ClaudeSpawnOptions) => {
    // Kill any existing live process for THIS session AND THIS project before
    // spawning a new one. Multiple processes sharing the same --resume UUID waste
    // API credits and can conflict with each other (#1590). The lookup is
    // dbPath-scoped: the numeric sessionDbId is not globally unique across
    // projects, so an unscoped match could SIGTERM an unrelated live subprocess
    // belonging to a different project that happens to share the same id.
    const existing = getProcessBySession(sessionDbId, dbPath);
    if (existing && existing.process.exitCode === null) {
      logger.warn('PROCESS', `Killing duplicate process PID ${existing.pid} before spawning new one for session ${sessionDbId}`, {
        existingPid: existing.pid,
        sessionDbId
      });
      try {
        existing.process.kill('SIGTERM');
      } catch {
        // Already dead — nothing to signal.
      }
      // kill('SIGTERM') is asynchronous, so exitCode is still null here; the old
      // synchronous `exitCode !== null` check was effectively always false and
      // left the stale entry in the registry until the async 'exit' handler
      // fired. Unregister unconditionally now — unregisterProcess is idempotent
      // (Map.delete on an absent key is a no-op), so the later 'exit' handler
      // unregistering the same pid is harmless.
      unregisterProcess(existing.pid);
    }

    const child = spawnClaudeChild(spawnOptions);

    // Capture stderr for debugging spawn failures. The per-chunk DEBUG line is
    // gated out at INFO level, so we also retain a bounded tail of recent stderr
    // and surface it on non-zero exit (where the CLI prints WHY it bailed —
    // e.g. usage limit, auth, arg errors). 2KB is enough for the final message
    // without unbounded growth on long-lived observer subprocesses.
    const getStderrTail = captureStderrTail(child, `session-${sessionDbId}`);

    // Register PID
    if (child.pid) {
      registerProcess(child.pid, sessionDbId, child, dbPath);

      // Auto-unregister on exit
      child.on('exit', (code: number | null, signal: string | null) => {
        if (code !== 0) {
          logger.warn('SDK_SPAWN', `[session-${sessionDbId}] Claude process exited`, {
            code,
            signal,
            pid: child.pid,
            stderrTail: getStderrTail(),
          });
        }
        if (child.pid) {
          unregisterProcess(child.pid);
        }
      });
    }

    // Return SDK-compatible interface
    return toSdkProcess(child);
  };
}

/**
 * Start the orphan reaper interval
 * Returns cleanup function to stop the interval
 */
export function startOrphanReaper(getActiveSessionIds: () => Set<number>, intervalMs: number = 1 * 60 * 1000): () => void {
  const interval = setInterval(async () => {
    try {
      const activeIds = getActiveSessionIds();
      const killed = await reapOrphanedProcesses(activeIds);
      if (killed > 0) {
        logger.info('PROCESS', `Reaper cleaned up ${killed} orphaned processes`, { killed });
      }
    } catch (error) {
      logger.error('PROCESS', 'Reaper error', {}, error as Error);
    }
  }, intervalMs);

  // Return cleanup function
  return () => clearInterval(interval);
}
