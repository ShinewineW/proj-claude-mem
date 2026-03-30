/**
 * Pure staleness check — extracted from SDKAgent.isProcessStale callback for testability.
 */
export function checkProcessStaleness(
  session: { generatorPromise: unknown; lastResponseAt: number | null } | null | undefined,
  trackedProcess: { spawnedAt: number } | null | undefined,
  staleResponseThresholdMs: number,
  staleInitThresholdMs: number,
): boolean {
  // Check 1: session deleted/reaped
  if (!session) return true;
  // Check 2: generator finished but process didn't exit
  if (!session.generatorPromise) return true;

  const now = Date.now();

  // Check 3: had responses before but stopped
  if (session.lastResponseAt !== null) {
    if (now - session.lastResponseAt > staleResponseThresholdMs) return true;
  } else if (trackedProcess) {
    // Check 4: never responded, check spawn age
    if (now - trackedProcess.spawnedAt > staleInitThresholdMs) return true;
  }

  return false;
}
