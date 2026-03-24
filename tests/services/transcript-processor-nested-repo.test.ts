// tests/services/transcript-processor-nested-repo.test.ts
// L6: processor.queueSummary() with drifted cwd → fetch POST body contains parent project dbPath
import { describe, it, expect, mock, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

// --- Setup: env + directories BEFORE any module load ---
const TEST_DATA_DIR = join(tmpdir(), `test-transcript-nested-${Date.now()}`);
const TEST_PROJECT = join(TEST_DATA_DIR, 'my-workspace');
const NESTED_REPO = join(TEST_PROJECT, 'refs', 'cloned');
const DRIFTED_CWD = join(NESTED_REPO, 'src');

const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

mkdirSync(join(TEST_PROJECT, '.claude'), { recursive: true });
mkdirSync(DRIFTED_CWD, { recursive: true });
execSync('git init', { cwd: NESTED_REPO, stdio: 'ignore' });
writeFileSync(
  join(TEST_DATA_DIR, 'enabled-projects.json'),
  JSON.stringify({ [TEST_PROJECT]: { enabledAt: '2026-01-01T00:00:00.000Z' } })
);

// --- Capture fetch calls ---
let fetchCalls: Array<{ url: string; body: any }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, opts?: any) => {
  const body = opts?.body ? JSON.parse(opts.body) : null;
  fetchCalls.push({ url, body });
  return new Response('{}', { status: 200 });
}) as any;

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// --- Mock worker utils ---
mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: async () => true,
  getWorkerPort: () => 37777,
}));

// --- Mock logger ---
mock.module('../../src/utils/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// --- Mock transitive dependencies ---
mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'my-workspace',
  getProjectContext: () => ({ project: 'my-workspace', allProjects: ['my-workspace'] }),
}));

mock.module('../../src/utils/agents-md-utils.js', () => ({
  writeAgentsMd: () => {},
}));

mock.module('../../src/services/transcripts/config.js', () => ({
  expandHomePath: (p: string) => p,
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: { loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }) },
}));

mock.module('../../src/shared/hook-constants.js', () => ({
  HOOK_EXIT_CODES: { SUCCESS: 0, FAILURE: 1, BLOCKING_ERROR: 2 },
  HOOK_TIMEOUTS: { DEFAULT: 30000 },
  getTimeout: (v: number) => v,
}));

// --- Import processor AFTER mocks ---
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';

describe('L6: transcript queueSummary with drifted cwd', () => {
  it('sends PARENT project dbPath, not nested repo dbPath, via fetch POST', async () => {
    fetchCalls = [];
    const processor = new TranscriptEventProcessor();

    // Construct a session with DRIFTED cwd (inside nested git repo)
    const session = {
      sessionId: 'transcript-test-session',
      cwd: DRIFTED_CWD,                      // ← drifted into nested git repo
      project: 'my-workspace',
      lastAssistantMessage: 'test summary content',
      pendingTools: new Map(),
    };

    // Call queueSummary via cast (private method)
    await (processor as any).queueSummary(session);

    // Verify fetch was called
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:37777/api/sessions/summarize');

    // KEY ASSERTION: dbPath in POST body is the PARENT project's path
    const sentDbPath = fetchCalls[0].body.dbPath;
    expect(sentDbPath).toBe(join(TEST_PROJECT, '.claude', 'mem.db'));

    // NOT the nested repo's path (this is what the old resolveProjectDbPath would produce)
    expect(sentDbPath).not.toBe(join(NESTED_REPO, '.claude', 'mem.db'));
  });
});
