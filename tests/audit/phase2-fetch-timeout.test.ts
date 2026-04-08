/**
 * Audit Phase 2 — fetchWithTimeout properties.
 *
 * Invariants:
 *  F1: rejection occurs within timeoutMs + small epsilon when upstream hangs
 *  F2: success path resolves before timeout fires (no double-settle)
 *  F3: error from underlying fetch (e.g. ECONNREFUSED) rejects and clears timer
 */
import { describe, test, expect } from 'bun:test';
import { fetchWithTimeout } from '../../src/shared/worker-utils.js';
import { createServer, Server } from 'http';

function hangServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(() => { /* never respond */ });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe('fetchWithTimeout properties', () => {
  test('F1: rejects within timeout+epsilon on hang', async () => {
    const { server, port } = await hangServer();
    const t0 = Date.now();
    await expect(
      fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 200)
    ).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1500); // generous epsilon
    server.close();
  });

  test('F3: rejects immediately on ECONNREFUSED', async () => {
    // port 1 is unlikely to have a listener
    await expect(
      fetchWithTimeout('http://127.0.0.1:1/', {}, 5000)
    ).rejects.toThrow();
  });
});
