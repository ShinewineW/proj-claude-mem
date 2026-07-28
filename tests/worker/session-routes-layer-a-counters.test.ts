/**
 * Behavioral tests for Layer A skip counters at the route level (audit R1-3).
 *
 * Drives the REAL handleObservationsByClaudeId handler and asserts that each
 * skip branch increments the matching layerAStats counter and short-circuits
 * with the right response — not just that the counters exist.
 *
 * Mock justification: SettingsDefaultsManager is a sanctioned leaf mock
 * (15+ files); it pins SKIP_TOOLS/SKIP_TOOL_PATTERNS so the test does not
 * depend on the machine's real settings.json.
 */
import { describe, it, expect, mock, spyOn, beforeEach, afterEach, afterAll } from 'bun:test';

let mockSettings: Record<string, string> = {};

// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../src/shared/SettingsDefaultsManager.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../src/shared/SettingsDefaultsManager.js', { ...__real0 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => mockSettings,
    get: (key: string) => mockSettings[key] ?? '',
    getInt: (key: string) => parseInt(mockSettings[key] ?? '0', 10) || 0,
  },
}));

import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { layerAStats } from '../../src/services/worker/http/routes/observation-filter.js';
import { PrivacyCheckValidator } from '../../src/services/worker/validation/PrivacyCheckValidator.js';
import { logger } from '../../src/utils/logger.js';

function createMockReq(body: Record<string, unknown>) {
  return { body, params: {}, query: {}, path: '/api/sessions/observations' } as any;
}

function createMockRes() {
  const res: any = { _json: undefined, _status: 200, headersSent: false };
  res.json = mock((payload: unknown) => {
    res._json = payload;
    res.headersSent = true;
    return res;
  });
  res.status = mock((code: number) => {
    res._status = code;
    return res;
  });
  return res;
}

function buildRoutes() {
  const sessionStore = {
    createSDKSession: mock(() => 42),
    getLatestRealPromptNumber: mock(() => 1),
  };
  const queueObservation = mock(() => true);
  const sessionManager = {
    queueObservation,
    getPendingMessageStore: mock(() => ({ getPendingObservationCountUpToPrompt: () => 0 })),
  };
  const dbManager = { getSessionStore: mock(() => sessionStore) };
  const eventBroadcaster = { broadcastObservationQueued: mock(() => {}) };
  const routes = new SessionRoutes(
    sessionManager as any,
    dbManager as any,
    {} as any,
    eventBroadcaster as any,
    {} as any,
  );
  (routes as any).ensureGeneratorRunning = () => {};
  return { routes, queueObservation };
}

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let privacySpy: ReturnType<typeof spyOn> | null = null;

describe('Layer A counters — route behavior', () => {
  beforeEach(() => {
    mockSettings = {
      CLAUDE_MEM_SKIP_TOOLS: 'TodoWrite,ScheduleWakeup',
      CLAUDE_MEM_SKIP_TOOL_PATTERNS: 'Bash:cd *,Read:*.log',
    };
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    privacySpy = spyOn(PrivacyCheckValidator, 'checkUserPromptPrivacy').mockReturnValue({
      prompt_text: 'real prompt',
    } as any);
  });

  afterEach(() => {
    loggerSpies.forEach((s) => s.mockRestore());
    privacySpy?.mockRestore();
  });

  it('SKIP_TOOLS exact match increments toolExcluded and responds tool_excluded', () => {
    const { routes } = buildRoutes();
    const before = layerAStats.toolExcluded;
    const res = createMockRes();
    (routes as any).handleObservationsByClaudeId(
      createMockReq({ contentSessionId: 'cs-1', tool_name: 'TodoWrite', tool_input: {}, cwd: '/x' }),
      res,
    );
    expect(res._json).toEqual({ status: 'skipped', reason: 'tool_excluded' });
    expect(layerAStats.toolExcluded).toBe(before + 1);
  });

  it('pattern filter increments patternFiltered and responds pattern_filtered', () => {
    const { routes } = buildRoutes();
    const before = layerAStats.patternFiltered;
    const res = createMockRes();
    (routes as any).handleObservationsByClaudeId(
      createMockReq({ contentSessionId: 'cs-1', tool_name: 'Bash', tool_input: { command: 'cd /repo' }, cwd: '/x' }),
      res,
    );
    expect(res._json).toEqual({ status: 'skipped', reason: 'pattern_filtered' });
    expect(layerAStats.patternFiltered).toBe(before + 1);
  });

  it('compound Bash command bypasses the filter and gets queued (guard at route level)', () => {
    const { routes, queueObservation } = buildRoutes();
    const beforeTool = layerAStats.toolExcluded;
    const beforePattern = layerAStats.patternFiltered;
    const res = createMockRes();
    (routes as any).handleObservationsByClaudeId(
      createMockReq({
        contentSessionId: 'cs-1',
        tool_name: 'Bash',
        tool_input: { command: 'cd /repo && pytest -q' },
        cwd: '/x',
        dbPath: '/x/.claude/mem.db',
      }),
      res,
    );
    expect(res._json).toEqual({ status: 'queued' });
    expect(queueObservation).toHaveBeenCalledTimes(1);
    expect(layerAStats.toolExcluded).toBe(beforeTool);
    expect(layerAStats.patternFiltered).toBe(beforePattern);
  });
});
