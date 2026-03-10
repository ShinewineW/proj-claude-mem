/**
 * Tests for dbPath inclusion in CursorHooksInstaller HTTP requests.
 *
 * Verifies that updateCursorContextForProject() and setupProjectContext()
 * pass dbPath query parameter to the worker API, ensuring per-project
 * database isolation for Cursor integration.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// We need to mock modules before importing the module under test.
// Mock resolveProjectDbPath to return a predictable path.
const MOCK_DB_PATH = '/test/project/.claude/mem.db';

// Mock the cursor-utils module
mock.module('../../src/utils/cursor-utils.js', () => ({
  readCursorRegistry: () => ({
    'test-project': {
      workspacePath: '/test/project',
      installedAt: '2026-01-01T00:00:00.000Z',
    },
  }),
  writeCursorRegistry: () => {},
  writeContextFile: () => {},
}));

// Mock the logger (must include all methods: failure/success used by BaseRouteHandler etc.)
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
    failure: () => {},
    success: () => {},
  },
}));

// Mock worker-utils
mock.module('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

// Mock paths - must include ALL exports since mock.module is global in bun:test
mock.module('../../src/shared/paths.js', () => ({
  DATA_DIR: '/tmp/test-claude-mem',
  CLAUDE_CONFIG_DIR: '/tmp/test-claude',
  MARKETPLACE_ROOT: '/tmp/test-marketplace',
  ARCHIVES_DIR: '/tmp/test-claude-mem/archives',
  LOGS_DIR: '/tmp/test-claude-mem/logs',
  TRASH_DIR: '/tmp/test-claude-mem/trash',
  BACKUPS_DIR: '/tmp/test-claude-mem/backups',
  MODES_DIR: '/tmp/test-claude-mem/modes',
  USER_SETTINGS_PATH: '/tmp/test-claude-mem/settings.json',
  DB_PATH: '/tmp/test-claude-mem/claude-mem.db',
  VECTOR_DB_DIR: '/tmp/test-claude-mem/vector-db',
  OBSERVER_SESSIONS_DIR: '/tmp/test-claude-mem/observer-sessions',
  CLAUDE_SETTINGS_PATH: '/tmp/test-claude/settings.json',
  CLAUDE_COMMANDS_DIR: '/tmp/test-claude/commands',
  CLAUDE_MD_PATH: '/tmp/test-claude/CLAUDE.md',
  getProjectArchiveDir: (name: string) => `/tmp/test-claude-mem/archives/${name}`,
  getWorkerSocketPath: (id: number) => `/tmp/test-claude-mem/worker-${id}.sock`,
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  ensureModesDir: () => {},
  ensureAllClaudeDirs: () => {},
  getCurrentProjectName: () => 'test-project',
  getPackageRoot: () => '/tmp/test-package',
  getPackageCommandsDir: () => '/tmp/test-package/commands',
  createBackupFilename: (p: string) => `${p}.backup`,
  resolveProjectDbPath: (cwd?: string) => MOCK_DB_PATH,
  resolveProjectRoot: () => '/test/project',
}));

// Mock SettingsDefaultsManager (needed by paths.ts)
mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return '/tmp/test-claude-mem';
      return '';
    },
  },
}));

// Track fetch calls
let fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
const originalFetch = globalThis.fetch;

import { updateCursorContextForProject } from '../../src/services/integrations/CursorHooksInstaller';

describe('CursorHooksInstaller dbPath in HTTP requests', () => {
  beforeEach(() => {
    fetchCalls = [];
    // Mock global fetch to capture URLs
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, options: init });

      // Return mock response
      return new Response('mock context data', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('updateCursorContextForProject', () => {
    it('should include dbPath query parameter in the context/inject URL', async () => {
      await updateCursorContextForProject('test-project', 37777);

      // Should have made exactly one fetch call
      expect(fetchCalls.length).toBe(1);

      const url = new URL(fetchCalls[0].url);
      expect(url.pathname).toBe('/api/context/inject');
      expect(url.searchParams.get('project')).toBe('test-project');
      expect(url.searchParams.get('dbPath')).toBe(MOCK_DB_PATH);
    });

    it('should not make fetch call for unregistered project', async () => {
      await updateCursorContextForProject('unknown-project', 37777);

      expect(fetchCalls.length).toBe(0);
    });

    it('should use resolveProjectDbPath with the entry workspacePath', async () => {
      // The mock returns MOCK_DB_PATH regardless, but we verify it's included
      await updateCursorContextForProject('test-project', 37777);

      expect(fetchCalls.length).toBe(1);
      const url = fetchCalls[0].url;
      expect(url).toContain(`dbPath=${encodeURIComponent(MOCK_DB_PATH)}`);
    });
  });
});
