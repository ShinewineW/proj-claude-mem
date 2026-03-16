import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';

const testDataDir = join(tmpdir(), `test-cross-project-${Date.now()}`);
mkdirSync(testDataDir, { recursive: true });
process.env.CLAUDE_MEM_DATA_DIR = testDataDir;

import {
  enableProject,
  getEnabledProjectsPath,
  resolveProjectByName,
  resolveAllProjectDbPaths,
} from '../../src/shared/project-allowlist.js';

describe('Cross-project name resolution', () => {
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

  describe('resolveProjectByName', () => {
    it('resolves an enabled project by basename', () => {
      enableProject('/Users/dev/code/auth-service');
      const result = resolveProjectByName('auth-service');
      expect(result).not.toBeNull();
      expect(result!.projectRoot).toBe('/Users/dev/code/auth-service');
      expect(result!.dbPath).toBe('/Users/dev/code/auth-service/.claude/mem.db');
    });

    it('returns null for unknown project name', () => {
      enableProject('/Users/dev/code/auth-service');
      const result = resolveProjectByName('nonexistent');
      expect(result).toBeNull();
    });

    it('returns null when allowlist is empty', () => {
      const result = resolveProjectByName('anything');
      expect(result).toBeNull();
    });

    it('throws on basename collision with disambiguation message', () => {
      enableProject('/Users/dev/code/auth-service');
      enableProject('/Users/dev/other/auth-service');
      expect(() => resolveProjectByName('auth-service')).toThrow('Ambiguous project name');
    });
  });

  describe('resolveAllProjectDbPaths', () => {
    it('returns empty array when no projects enabled', () => {
      const result = resolveAllProjectDbPaths();
      expect(result).toEqual([]);
    });

    it('returns all enabled projects with name, root, and dbPath', () => {
      enableProject('/Users/dev/code/auth-service');
      enableProject('/Users/dev/code/web-app');
      const result = resolveAllProjectDbPaths();
      expect(result.length).toBe(2);

      const names = result.map(p => p.name).sort();
      expect(names).toEqual(['auth-service', 'web-app']);

      for (const p of result) {
        expect(p.dbPath).toBe(join(p.projectRoot, '.claude', 'mem.db'));
      }
    });
  });
});
