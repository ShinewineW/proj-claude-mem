import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';

const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
const testDataDir = join(tmpdir(), `test-session-project-pin-${Date.now()}`);
const projectA = join(testDataDir, 'project-a');
const projectB = join(testDataDir, 'project-b');
const outside = join(testDataDir, 'outside');

mkdirSync(projectA, { recursive: true });
mkdirSync(projectB, { recursive: true });
mkdirSync(outside, { recursive: true });
process.env.CLAUDE_MEM_DATA_DIR = testDataDir;

let rawInput: any;
const capturedInputs: any[] = [];

mock.module('../../src/cli/stdin-reader.js', () => ({
  readJsonFromStdin: async () => rawInput,
}));

mock.module('../../src/cli/adapters/index.js', () => ({
  getPlatformAdapter: () => ({
    normalizeInput: (raw: any) => ({
      sessionId: raw.session_id,
      cwd: raw.cwd,
      prompt: raw.prompt,
      toolName: raw.tool_name,
      toolInput: raw.tool_input,
      toolResponse: raw.tool_response,
    }),
    formatOutput: (result: any) => result ?? {},
  }),
}));

mock.module('../../src/cli/handlers/index.js', () => ({
  getEventHandler: () => ({
    execute: async (input: any) => {
      capturedInputs.push(input);
      return { exitCode: 0 };
    },
  }),
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

import { hookCommand } from '../../src/cli/hook-command.js';
import { enableProject, getEnabledProjectsPath } from '../../src/shared/project-allowlist.js';
import { getSessionProjectContextsPath } from '../../src/shared/session-project-context.js';

describe('hookCommand session project context pinning', () => {
  beforeEach(() => {
    capturedInputs.length = 0;
    rmSync(getEnabledProjectsPath(), { force: true });
    rmSync(getSessionProjectContextsPath(), { force: true });
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  });

  it('uses the first user prompt project when later hooks drift outside the allowlist', async () => {
    enableProject(projectA);

    rawInput = {
      session_id: 'session-a',
      cwd: projectA,
      prompt: 'start here',
    };
    expect(await hookCommand('claude-code', 'session-init', { skipExit: true })).toBe(0);

    rawInput = {
      session_id: 'session-a',
      cwd: outside,
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
      tool_response: { output: outside },
    };
    expect(await hookCommand('claude-code', 'observation', { skipExit: true })).toBe(0);

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[1]._projectContext).toEqual({
      projectRoot: projectA,
      dbPath: join(projectA, '.claude', 'mem.db'),
      projectName: 'project-a',
    });
    expect(existsSync(getSessionProjectContextsPath())).toBe(true);
  });

  it('does not overwrite the pinned project when a later prompt drifts into another enabled project', async () => {
    enableProject(projectA);
    enableProject(projectB);

    rawInput = {
      session_id: 'session-b',
      cwd: projectA,
      prompt: 'first prompt',
    };
    expect(await hookCommand('claude-code', 'session-init', { skipExit: true })).toBe(0);

    rawInput = {
      session_id: 'session-b',
      cwd: projectB,
      prompt: 'later prompt after cwd drift',
    };
    expect(await hookCommand('claude-code', 'session-init', { skipExit: true })).toBe(0);

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[1]._projectContext).toEqual({
      projectRoot: projectA,
      dbPath: join(projectA, '.claude', 'mem.db'),
      projectName: 'project-a',
    });
  });

  it('does not require later submit cwd to be allowlisted once the session is pinned', async () => {
    enableProject(projectA);

    rawInput = {
      session_id: 'session-c',
      cwd: projectA,
      prompt: 'first prompt fixes the project',
    };
    expect(await hookCommand('claude-code', 'session-init', { skipExit: true })).toBe(0);

    rawInput = {
      session_id: 'session-c',
      cwd: outside,
      prompt: 'later submit after cwd drift',
    };
    expect(await hookCommand('claude-code', 'session-init', { skipExit: true })).toBe(0);

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[1]._projectContext).toEqual({
      projectRoot: projectA,
      dbPath: join(projectA, '.claude', 'mem.db'),
      projectName: 'project-a',
    });

    const store = JSON.parse(readFileSync(getSessionProjectContextsPath(), 'utf-8'));
    expect(store.sessions['session-c'].projectRoot).toBe(projectA);
  });
});
