import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import net from 'net';
import {
  isPortInUse,
  waitForHealth,
  waitForPortFree,
  getInstalledPluginVersion,
  checkVersionMatch
} from '../../src/services/infrastructure/HealthMonitor.js';

describe('HealthMonitor', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Atomic socket-bind isPortInUse is POSIX-only; skip on Windows CI where the
  // HTTP fallback (not socket bind) is the live path.
  if (process.platform !== 'win32') {
    describe('isPortInUse', () => {
      it('returns true when a port is actually bound (EADDRINUSE)', async () => {
        const server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const port = (server.address() as net.AddressInfo).port;
        try {
          const result = await isPortInUse(port);
          expect(result).toBe(true);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });

      it('returns false for a free port (listen succeeds)', async () => {
        // Grab a free port by binding+closing, then probe it.
        const probe = net.createServer();
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
        const port = (probe.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        const result = await isPortInUse(port);
        expect(result).toBe(false);
      });
    });
  }

  describe('waitForHealth', () => {
    it('should succeed immediately when server responds', async () => {
      global.fetch = mock(() => Promise.resolve({ ok: true } as Response));

      const start = Date.now();
      const result = await waitForHealth(37777, 5000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      // Should return quickly (within first poll cycle)
      expect(elapsed).toBeLessThan(1000);
    });

    it('should timeout when no server responds', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const start = Date.now();
      const result = await waitForHealth(39999, 1500);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      // Should take close to timeout duration
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2500);
    });

    it('should succeed after server becomes available', async () => {
      let callCount = 0;
      global.fetch = mock(() => {
        callCount++;
        // Fail first 2 calls, succeed on third
        if (callCount < 3) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve({ ok: true } as Response);
      });

      const result = await waitForHealth(37777, 5000);

      expect(result).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should check health endpoint for liveness', async () => {
      const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
      global.fetch = fetchMock;

      await waitForHealth(37777, 1000);

      // waitForHealth uses /api/health (liveness), not /api/readiness
      // This is because hooks have 15-second timeout but full initialization can take 5+ minutes
      // See: https://github.com/thedotmack/claude-mem/issues/811
      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][0]).toBe('http://127.0.0.1:37777/api/health');
    });

    it('should use default timeout when not specified', async () => {
      global.fetch = mock(() => Promise.resolve({ ok: true } as Response));

      // Just verify it doesn't throw and returns quickly
      const result = await waitForHealth(37777);

      expect(result).toBe(true);
    });
  });

  describe('getInstalledPluginVersion', () => {
    it('should return a valid semver string', () => {
      const version = getInstalledPluginVersion();

      // Should be a string matching semver pattern or 'unknown'
      if (version !== 'unknown') {
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
      }
    });

    it('should not throw on ENOENT (graceful degradation)', () => {
      // The function handles ENOENT internally — should not throw
      // If package.json exists, it returns the version; if not, 'unknown'
      expect(() => getInstalledPluginVersion()).not.toThrow();
    });
  });

  describe('checkVersionMatch', () => {
    it('should assume match when worker version is unavailable', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const result = await checkVersionMatch(39999);

      expect(result.matches).toBe(true);
      expect(result.workerVersion).toBeNull();
    });

    it('should detect version mismatch', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: '0.0.0-definitely-wrong' })
      } as Response));

      const result = await checkVersionMatch(37777);

      // Unless the plugin version is also '0.0.0-definitely-wrong', this should be a mismatch
      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion !== 'unknown' && pluginVersion !== '0.0.0-definitely-wrong') {
        expect(result.matches).toBe(false);
      }
    });

    it('should detect version match', async () => {
      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion === 'unknown') return; // Skip if can't read plugin version

      global.fetch = mock(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: pluginVersion })
      } as Response));

      const result = await checkVersionMatch(37777);

      expect(result.matches).toBe(true);
      expect(result.pluginVersion).toBe(pluginVersion);
      expect(result.workerVersion).toBe(pluginVersion);
    });
  });

  describe('waitForPortFree', () => {
    it('returns true immediately when port is already free', async () => {
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
      const port = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const start = Date.now();
      const result = await waitForPortFree(port, 5000);
      expect(result).toBe(true);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('times out while the port stays occupied', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as net.AddressInfo).port;
      try {
        const start = Date.now();
        const result = await waitForPortFree(port, 1500);
        expect(result).toBe(false);
        expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('should use default timeout when not specified', async () => {
      // Just verify it doesn't throw and returns quickly for a free port
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
      const port = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const result = await waitForPortFree(port);

      expect(result).toBe(true);
    });
  });
});
