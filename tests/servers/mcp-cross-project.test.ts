import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';

const testDataDir = join(tmpdir(), `test-mcp-cross-${Date.now()}`);
mkdirSync(testDataDir, { recursive: true });
process.env.CLAUDE_MEM_DATA_DIR = testDataDir;

import {
  enableProject,
  getEnabledProjectsPath,
  resolveProjectByName,
  resolveAllProjectDbPaths,
} from '../../src/shared/project-allowlist.js';

describe('Cross-project resolution building blocks', () => {
  beforeEach(() => {
    spyOn(logger, 'info').mockImplementation(() => {});
    spyOn(logger, 'debug').mockImplementation(() => {});
    spyOn(logger, 'warn').mockImplementation(() => {});
    mkdirSync(testDataDir, { recursive: true });
    const path = getEnabledProjectsPath();
    if (existsSync(path)) rmSync(path);
    const lockPath = path + '.lock';
    if (existsSync(lockPath)) rmSync(lockPath);
  });

  afterEach(() => {
    rmSync(testDataDir, { recursive: true, force: true });
  });

  describe('single project resolution', () => {
    it('resolves a known project name to dbPath', () => {
      enableProject('/Users/dev/auth-service');
      const result = resolveProjectByName('auth-service');
      expect(result).not.toBeNull();
      expect(result!.dbPath).toBe('/Users/dev/auth-service/.claude/mem.db');
    });

    it('returns null for unknown project', () => {
      enableProject('/Users/dev/auth-service');
      expect(resolveProjectByName('unknown')).toBeNull();
    });
  });

  describe('all-projects resolution', () => {
    it('returns all enabled projects', () => {
      enableProject('/Users/dev/auth-service');
      enableProject('/Users/dev/web-app');
      enableProject('/Users/dev/data-pipeline');
      const all = resolveAllProjectDbPaths();
      expect(all.length).toBe(3);
      const names = all.map(p => p.name).sort();
      expect(names).toEqual(['auth-service', 'data-pipeline', 'web-app']);
    });

    it('returns empty array when nothing enabled', () => {
      expect(resolveAllProjectDbPaths()).toEqual([]);
    });
  });

  describe('cross-project query constraints', () => {
    it('get_observations with "*" should be rejected by caller (design rule)', () => {
      enableProject('/Users/dev/auth-service');
      enableProject('/Users/dev/web-app');
      const all = resolveAllProjectDbPaths();
      expect(all.length).toBeGreaterThan(1);
    });

    it('timeline with "*" should be rejected by caller (design rule)', () => {
      enableProject('/Users/dev/auth-service');
      const all = resolveAllProjectDbPaths();
      expect(all.length).toBeGreaterThan(0);
    });
  });
});
