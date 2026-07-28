/**
 * Tests for context inject retry-on-500 behavior.
 *
 * When /api/context/inject returns 500 (worker alive but broken),
 * the context handler should:
 * 1. Log the response body for diagnostics
 * 2. Write a stderr warning to the user
 * 3. Restart the worker and retry once
 */
import { describe, it, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import type { NormalizedHookInput } from '../../../src/cli/types.js';

// Track fetch calls for assertions
let fetchCallCount = 0;
let fetchResponses: Array<{ status: number; body: string }> = [];

const mockFetch = mock((url: string) => {
  const idx = fetchCallCount++;
  const resp = fetchResponses[idx] ?? { status: 200, body: '' };
  return Promise.resolve(new Response(resp.body, { status: resp.status }));
});
const originalFetch = globalThis.fetch;
globalThis.fetch = mockFetch as any;
afterAll(() => { globalThis.fetch = originalFetch; });

// Track restartWorker calls
let restartWorkerResult = true;
let restartWorkerCalled = false;

// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../../src/shared/SettingsDefaultsManager.js';
import * as __real1 from '../../../src/utils/project-filter.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../../src/shared/SettingsDefaultsManager.js', { ...__real0 }],
  ['../../../src/utils/project-filter.js', { ...__real1 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: mock(() => Promise.resolve(true)),
  getWorkerPort: mock(() => 37777),
  fetchWithTimeout: async (url: string | URL | Request, init?: RequestInit, _timeoutMs?: number) => fetch(url, init),
  restartWorker: mock(() => {
    restartWorkerCalled = true;
    return Promise.resolve(restartWorkerResult);
  }),
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    dataIn: () => {},
    formatTool: (n: string) => n,
  },
}));

mock.module('../../../src/shared/hook-constants.js', () => ({
  HOOK_EXIT_CODES: { SUCCESS: 0, FAILURE: 1, BLOCKING_ERROR: 2 },
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({
      CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false',
      CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    }),
  },
}));

mock.module('../../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

// Capture stderr writes
let stderrOutput = '';
const originalStderrWrite = process.stderr.write;
const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
  stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
  return true;
});
afterAll(() => { stderrSpy.mockRestore(); });

const makeInput = (): NormalizedHookInput => ({
  sessionId: 'test-session',
  cwd: '/workspace/my-project',
  _projectContext: {
    projectRoot: '/workspace/my-project',
    dbPath: '/workspace/my-project/.claude/mem.db',
    projectName: 'my-project',
  },
});

describe('Context inject retry-on-500', () => {
  beforeEach(() => {
    fetchCallCount = 0;
    fetchResponses = [];
    mockFetch.mockClear();
    restartWorkerCalled = false;
    restartWorkerResult = true;
    stderrOutput = '';
  });

  it('returns context normally on 200 (no restart)', async () => {
    fetchResponses = [
      { status: 200, body: '# context data' },
    ];

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute(makeInput());

    expect(result.hookSpecificOutput?.additionalContext).toBe('# context data');
    expect(restartWorkerCalled).toBe(false);
    expect(stderrOutput).not.toContain('⚠');
  });

  it('restarts worker and retries on 500, succeeds on retry', async () => {
    fetchResponses = [
      { status: 500, body: 'Internal Server Error: database locked' },
      // After restart, retry succeeds
      { status: 200, body: '# recovered context' },
    ];

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute(makeInput());

    expect(restartWorkerCalled).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toBe('# recovered context');
    expect(stderrOutput).toContain('Restarting worker');
    expect(stderrOutput).toContain('Context recovered');
  });

  it('returns empty context when restart succeeds but retry still fails', async () => {
    fetchResponses = [
      { status: 500, body: 'broken' },
      { status: 500, body: 'still broken' },
    ];

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute(makeInput());

    expect(restartWorkerCalled).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(stderrOutput).toContain('still failing after restart');
  });

  it('returns empty context when worker restart itself fails', async () => {
    restartWorkerResult = false;
    fetchResponses = [
      { status: 500, body: 'broken' },
    ];

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute(makeInput());

    expect(restartWorkerCalled).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(stderrOutput).toContain('restart failed');
  });
});
