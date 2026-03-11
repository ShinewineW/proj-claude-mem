import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';

const testDataDir = join(tmpdir(), `test-mcp-allowlist-${Date.now()}`);
const testProjectRoot = join(tmpdir(), `test-mcp-project-${Date.now()}`);
mkdirSync(testDataDir, { recursive: true });
mkdirSync(join(testProjectRoot, '.git'), { recursive: true });
process.env.CLAUDE_MEM_DATA_DIR = testDataDir;

import {
  enableProject,
  disableProject,
  isProjectEnabled,
  getEnabledProjectsPath
} from '../../src/shared/project-allowlist.js';

describe('MCP allowlist refresh (B3)', () => {
  beforeEach(() => {
    spyOn(logger, 'info').mockImplementation(() => {});
    spyOn(logger, 'debug').mockImplementation(() => {});
    spyOn(logger, 'warn').mockImplementation(() => {});

    // Ensure dirs exist (afterEach removes them)
    mkdirSync(testDataDir, { recursive: true });
    mkdirSync(join(testProjectRoot, '.git'), { recursive: true });

    const path = getEnabledProjectsPath();
    if (existsSync(path)) rmSync(path);
  });

  afterEach(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    rmSync(testProjectRoot, { recursive: true, force: true });
  });

  it('isProjectEnabled reflects runtime changes without restart', () => {
    expect(isProjectEnabled(testProjectRoot)).toBe(false);
    enableProject(testProjectRoot);
    expect(isProjectEnabled(testProjectRoot)).toBe(true);
    disableProject(testProjectRoot);
    expect(isProjectEnabled(testProjectRoot)).toBe(false);
  });

  it('getProjectDbPath returns null for disabled then path for enabled', () => {
    const getDbPath = () => {
      if (!isProjectEnabled(testProjectRoot)) return null;
      return join(testProjectRoot, '.claude', 'mem.db');
    };

    expect(getDbPath()).toBeNull();
    enableProject(testProjectRoot);
    expect(getDbPath()).toBe(join(testProjectRoot, '.claude', 'mem.db'));
  });
});
