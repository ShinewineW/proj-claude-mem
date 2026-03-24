// tests/cli/hook-nested-repo-guard.test.ts
// L5: hookCommand() with nested git repo cwd — guard passes, handler called with correct _projectContext
import { describe, it, expect, mock, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

// --- Setup: env + directories BEFORE any module load ---
const TEST_DATA_DIR = join(tmpdir(), `test-hook-guard-nested-${Date.now()}`);
const TEST_PROJECT = join(TEST_DATA_DIR, 'my-workspace');
const NESTED_REPO = join(TEST_PROJECT, 'references', 'cloned-repo');
const NESTED_CWD = join(NESTED_REPO, 'src', 'deep');

const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

mkdirSync(join(TEST_PROJECT, '.claude'), { recursive: true });
mkdirSync(NESTED_CWD, { recursive: true });
execSync('git init', { cwd: NESTED_REPO, stdio: 'ignore' });
writeFileSync(
  join(TEST_DATA_DIR, 'enabled-projects.json'),
  JSON.stringify({ [TEST_PROJECT]: { enabledAt: '2026-01-01T00:00:00.000Z' } })
);

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// --- Mock stdin: cwd points INSIDE the nested git repo ---
mock.module('../../src/cli/stdin-reader.js', () => ({
  readJsonFromStdin: async () => ({
    session_id: 'test-nested-session',
    cwd: NESTED_CWD,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'test prompt',
  }),
}));

// --- Mock adapter: passthrough ---
mock.module('../../src/cli/adapters/index.js', () => ({
  getPlatformAdapter: () => ({
    normalizeInput: (raw: any) => ({
      sessionId: raw.session_id,
      cwd: raw.cwd,
      prompt: raw.prompt,
    }),
    formatOutput: (result: any) => result ?? {},
  }),
}));

// --- Mock handler: capture input to verify _projectContext ---
let capturedInputs: any[] = [];
mock.module('../../src/cli/handlers/index.js', () => ({
  getEventHandler: () => ({
    execute: async (input: any) => {
      capturedInputs.push(input);
      return { exitCode: 0 };
    },
  }),
}));

// --- Mock logger ---
mock.module('../../src/utils/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dataIn: () => {}, formatTool: () => '' },
}));

// --- Import AFTER all mocks are in place ---
import { hookCommand } from '../../src/cli/hook-command.js';

describe('L5: hookCommand with nested git repo cwd', () => {
  it('does NOT exit and calls handler with correct _projectContext', async () => {
    capturedInputs = [];

    const exitCode = await hookCommand('claude-code', 'UserPromptSubmit', { skipExit: true });

    // 1. Guard did NOT exit (would return before calling handler)
    expect(exitCode).toBe(0);

    // 2. Handler WAS called (guard passed, not blocked)
    expect(capturedInputs.length).toBe(1);

    // 3. _projectContext injected with PARENT project, not nested repo
    const input = capturedInputs[0];
    expect(input._projectContext).toBeDefined();
    expect(input._projectContext.projectRoot).toBe(TEST_PROJECT);
    expect(input._projectContext.dbPath).toBe(join(TEST_PROJECT, '.claude', 'mem.db'));
    expect(input._projectContext.projectName).toBe('my-workspace');

    // 4. Original cwd is preserved (for logging/diagnostics)
    expect(input.cwd).toBe(NESTED_CWD);
  });
});
