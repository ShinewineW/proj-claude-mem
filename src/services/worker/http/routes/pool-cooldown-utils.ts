import type { ActiveSession } from '../../../worker-types.js';

const POOL_TIMEOUT_PATTERN = 'Timed out waiting for agent pool slot';

export function isPoolTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(POOL_TIMEOUT_PATTERN);
}

export function shouldEnterCooldown(
  error: unknown,
  session: { totalPoolTimeouts: number },
  maxPoolRetries: number,
): boolean {
  return isPoolTimeoutError(error) && session.totalPoolTimeouts < maxPoolRetries;
}
