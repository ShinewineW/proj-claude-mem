// tests/cli/handlers/project-context-priority.test.ts
// L4: handler sends _projectContext.dbPath, not drifted cwd resolution
import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import type { NormalizedHookInput } from '../../../src/cli/types.js';

// Mock worker dependencies
const mockFetch = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
const originalFetch = globalThis.fetch;
globalThis.fetch = mockFetch as any;
afterAll(() => { globalThis.fetch = originalFetch; });

mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: mock(() => Promise.resolve(true)),
  getWorkerPort: mock(() => 37777),
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dataIn: () => {}, failure: () => {}, formatTool: (n: string) => n },
}));

mock.module('../../../src/shared/hook-constants.js', () => ({
  HOOK_EXIT_CODES: { SUCCESS: 0, FAILURE: 1, BLOCKING_ERROR: 2 },
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: { loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }) },
}));

mock.module('../../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

describe('L4: handler _projectContext priority over drifted cwd', () => {
  beforeEach(() => { mockFetch.mockClear(); });

  it('user-message handler sends _projectContext.dbPath, not drifted cwd resolution', async () => {
    const { userMessageHandler } = await import('../../../src/cli/handlers/user-message.js');

    const correctCtx = {
      projectRoot: '/workspace/my-project',
      dbPath: '/workspace/my-project/.claude/mem.db',
      projectName: 'my-project',
    };

    const input: NormalizedHookInput = {
      sessionId: 'test-session-123',
      cwd: '/workspace/my-project/refs/cloned-repo/src',  // drifted cwd
      _projectContext: correctCtx,
    };

    await userMessageHandler.execute(input);

    // Extract what was sent to worker
    expect(mockFetch).toHaveBeenCalled();
    const [url, opts] = mockFetch.mock.calls[0];
    const body = opts?.body ? JSON.parse(opts.body as string) : null;

    // Key assertion: dbPath comes from _projectContext, NOT from resolving drifted cwd
    if (body?.dbPath) {
      expect(body.dbPath).toBe('/workspace/my-project/.claude/mem.db');
    } else {
      expect(String(url)).toContain(encodeURIComponent('/workspace/my-project/.claude/mem.db'));
    }
  });
});
