// tests/integration/nested-git-resolution.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

const TEST_DATA_DIR = join(homedir(), '.claude-mem-test-nested-git');
const TEST_PROJECT = join(TEST_DATA_DIR, 'my-workspace');
const NESTED_REPO = join(TEST_PROJECT, 'references', 'cloned-repo');

describe('nested git repo resolution', () => {
  beforeAll(() => {
    process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;
    // Create workspace structure
    mkdirSync(join(TEST_PROJECT, '.claude'), { recursive: true });
    mkdirSync(join(NESTED_REPO), { recursive: true });
    // Init git in nested repo (simulates git clone)
    execSync('git init', { cwd: NESTED_REPO, stdio: 'ignore' });
    // Write allowlist
    writeFileSync(
      join(TEST_DATA_DIR, 'enabled-projects.json'),
      JSON.stringify({ [TEST_PROJECT]: { enabledAt: '2026-01-01T00:00:00.000Z' } })
    );
  });

  afterAll(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    delete process.env.CLAUDE_MEM_DATA_DIR;
  });

  it('resolves nested git repo cwd back to parent workspace', async () => {
    const { resolveProjectContext } = await import('../../src/shared/project-allowlist.js');
    const deepCwd = join(NESTED_REPO, 'src', 'lib');
    mkdirSync(deepCwd, { recursive: true });

    const result = resolveProjectContext(deepCwd);
    expect(result).not.toBeNull();
    expect(result!.projectRoot).toBe(resolve(TEST_PROJECT));
    expect(result!.projectName).toBe('my-workspace');
    expect(result!.dbPath).toBe(join(resolve(TEST_PROJECT), '.claude', 'mem.db'));
  });

  it('old resolveProjectRoot would have resolved to nested git repo', async () => {
    const { resolveProjectRoot } = await import('../../src/shared/paths.js');
    const deepCwd = join(NESTED_REPO, 'src', 'lib');

    // This demonstrates the bug: old logic finds the nested .git
    const oldRoot = resolveProjectRoot(deepCwd);
    expect(oldRoot).toBe(NESTED_REPO);  // WRONG — not the workspace
  });
});
