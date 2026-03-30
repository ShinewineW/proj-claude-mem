import { describe, it, expect } from 'bun:test';

const createMockSession = (overrides: Record<string, unknown> = {}) => ({
  sessionDbId: 1,
  generatorPromise: Promise.resolve(),
  lastResponseAt: null as number | null,
  ...overrides,
});

const createMockProcess = (overrides: Record<string, unknown> = {}) => ({
  pid: 12345,
  sessionDbId: 1,
  spawnedAt: Date.now(),
  dbPath: '/tmp/test.db',
  ...overrides,
});

describe('Enhanced isProcessStale', () => {
  const { checkProcessStaleness } = require('../../src/services/worker/stale-detection');

  it('should return true when session does not exist', () => {
    expect(checkProcessStaleness(null, null, 180000, 120000)).toBe(true);
  });

  it('should return true when generatorPromise is null', () => {
    const session = createMockSession({ generatorPromise: null });
    expect(checkProcessStaleness(session, null, 180000, 120000)).toBe(true);
  });

  it('should return true when lastResponseAt exceeds threshold (check 3)', () => {
    const session = createMockSession({
      lastResponseAt: Date.now() - 240000, // 4 min ago
    });
    expect(checkProcessStaleness(session, null, 180000, 120000)).toBe(true);
  });

  it('should return false when lastResponseAt is within threshold', () => {
    const session = createMockSession({
      lastResponseAt: Date.now() - 60000, // 1 min ago
    });
    expect(checkProcessStaleness(session, null, 180000, 120000)).toBe(false);
  });

  it('should return true when never responded and spawn exceeds init threshold (check 4)', () => {
    const session = createMockSession({ lastResponseAt: null });
    const proc = createMockProcess({ spawnedAt: Date.now() - 180000 }); // 3 min ago
    expect(checkProcessStaleness(session, proc, 180000, 120000)).toBe(true);
  });

  it('should return false when never responded but spawn is recent', () => {
    const session = createMockSession({ lastResponseAt: null });
    const proc = createMockProcess({ spawnedAt: Date.now() - 30000 }); // 30s ago
    expect(checkProcessStaleness(session, proc, 180000, 120000)).toBe(false);
  });

  it('should return false when never responded and no tracked process', () => {
    const session = createMockSession({ lastResponseAt: null });
    expect(checkProcessStaleness(session, null, 180000, 120000)).toBe(false);
  });
});
