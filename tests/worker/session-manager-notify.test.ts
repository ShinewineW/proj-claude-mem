import { describe, it, expect, mock, afterAll } from 'bun:test';
import { EventEmitter } from 'events';

// Module-level mocks (must be before production code imports)
// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../src/shared/paths.js';
import * as __real1 from '../../src/shared/SettingsDefaultsManager.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../src/shared/paths.js', { ...__real0 }],
  ['../../src/shared/SettingsDefaultsManager.js', { ...__real1 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

mock.module('../../src/shared/paths.js', () => ({
  DATA_DIR: '/tmp/test-claude-mem',
  DB_PATH: '/tmp/test-claude-mem/claude-mem.db',
  USER_SETTINGS_PATH: '/tmp/test-settings.json',
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  resolveProjectDbPath: () => '/tmp/test-project/.claude/mem.db',
  resolveProjectRoot: () => '/tmp/test-project',
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    success: () => {},
    formatTool: () => 'mock-tool',
  },
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({}),
    get: () => '',
    getInt: () => 0,
  },
}));

/**
 * Unit test for SessionManager.notifyMessageAvailable().
 * Tests the emitter lookup by composite key and event emission.
 *
 * We mock the internal sessionQueues Map directly since SessionManager
 * construction requires a real DatabaseManager.
 */
describe('SessionManager.notifyMessageAvailable', () => {
  it('emits message event on the correct session emitter', async () => {
    const { SessionManager } = await import('../../src/services/worker/SessionManager.js');

    const mockDbManager = {
      getSessionStore: () => ({ db: {} }),
    } as any;

    const manager = new SessionManager(mockDbManager);
    const emitter = new EventEmitter();
    const received = new Promise<boolean>(resolve => {
      emitter.once('message', () => resolve(true));
      setTimeout(() => resolve(false), 100);
    });

    // Inject emitter into sessionQueues with correct composite key
    const key = '/tmp/test.db::42';
    (manager as any).sessionQueues.set(key, emitter);

    manager.notifyMessageAvailable(42, '/tmp/test.db');

    expect(await received).toBe(true);
  });

  it('is no-op when session has no emitter', async () => {
    const { SessionManager } = await import('../../src/services/worker/SessionManager.js');

    const mockDbManager = { getSessionStore: () => ({ db: {} }) } as any;
    const manager = new SessionManager(mockDbManager);

    // Should not throw
    manager.notifyMessageAvailable(999, '/tmp/nonexistent.db');
  });

  it('uses _default key when dbPath is undefined', async () => {
    const { SessionManager } = await import('../../src/services/worker/SessionManager.js');

    const mockDbManager = { getSessionStore: () => ({ db: {} }) } as any;
    const manager = new SessionManager(mockDbManager);

    const emitter = new EventEmitter();
    const received = new Promise<boolean>(resolve => {
      emitter.once('message', () => resolve(true));
      setTimeout(() => resolve(false), 100);
    });

    (manager as any).sessionQueues.set('_default::42', emitter);

    manager.notifyMessageAvailable(42); // no dbPath

    expect(await received).toBe(true);
  });
});
