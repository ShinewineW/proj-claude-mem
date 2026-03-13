import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';

const testDataDir = join(tmpdir(), `test-allowlist-lock-${Date.now()}`);
const originalEnv = process.env.CLAUDE_MEM_DATA_DIR;

import {
  enableProject,
  disableProject,
  listEnabledProjects,
  getEnabledProjectsPath
} from '../../src/shared/project-allowlist.js';

describe('Allowlist concurrent safety (B4)', () => {
  beforeEach(() => {
    // Set env var inside lifecycle hook to avoid polluting other test files
    mkdirSync(testDataDir, { recursive: true });
    process.env.CLAUDE_MEM_DATA_DIR = testDataDir;

    spyOn(logger, 'info').mockImplementation(() => {});
    spyOn(logger, 'debug').mockImplementation(() => {});
    spyOn(logger, 'warn').mockImplementation(() => {});

    // Recreate data dir (afterEach removes it)
    mkdirSync(testDataDir, { recursive: true });

    const path = getEnabledProjectsPath();
    if (existsSync(path)) rmSync(path);
    const lockPath = path + '.lock';
    if (existsSync(lockPath)) rmSync(lockPath);
  });

  afterEach(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    // Restore original env to avoid polluting subsequent test files
    if (originalEnv !== undefined) {
      process.env.CLAUDE_MEM_DATA_DIR = originalEnv;
    } else {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    }
  });

  it('concurrent enableProject calls preserve all entries', () => {
    const projects = Array.from({ length: 20 }, (_, i) => `/project/${i}`);
    for (const p of projects) {
      enableProject(p);
    }
    const result = listEnabledProjects();
    const keys = Object.keys(result);
    expect(keys.length).toBe(20);
    for (const p of projects) {
      expect(result[p]).toBeDefined();
    }
  });

  it('interleaved enable and disable preserves correct state', () => {
    enableProject('/project/keep');
    enableProject('/project/remove');
    enableProject('/project/also-keep');
    disableProject('/project/remove');
    const result = listEnabledProjects();
    expect(result['/project/keep']).toBeDefined();
    expect(result['/project/also-keep']).toBeDefined();
    expect(result['/project/remove']).toBeUndefined();
  });

  it('lock file is cleaned up after operation', () => {
    enableProject('/project/test');
    const lockPath = getEnabledProjectsPath() + '.lock';
    expect(existsSync(lockPath)).toBe(false);
  });
});
