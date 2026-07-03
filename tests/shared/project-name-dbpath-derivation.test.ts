/**
 * Regression: write-path session naming must come from the DB the row is stored
 * in, never from a second cwd-based resolver.
 *
 * Incident (2nd recurrence): an enabled child project that is a real git repo,
 * nested under a parent directory that holds a `.claude/` and is NOT a git repo.
 * The allowlist routes the DB to the child (`<child>/.claude/mem.db`), but the old
 * observation write path named the session with getProjectName(cwd), whose
 * resolveWorkspaceRoot heuristic climbs to the PARENT — leaking a phantom
 * parent-named project (e.g. "wangjiazhe") into the child project's DB
 * (SessionRoutes.ts observation route).
 *
 * Fix: name the session via projectNameFromDbPath(dbPath), which is structurally
 * basename(<child>) — equal to the allowlist projectName and unable to diverge
 * from the DB the row lives in.
 *
 * These tests are intentionally pure (no allowlist/env, no getProjectName/
 * resolveProjectRoot) so they are immune to the full-suite mock.module('paths.js')
 * pollution that ~20 worker/service tests install process-wide.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { projectNameFromDbPath } from '../../src/shared/paths.js';

describe('projectNameFromDbPath (pure)', () => {
  it('derives the project name from a standard per-project DB path', () => {
    expect(projectNameFromDbPath('/a/b/skills_workspace/.claude/mem.db')).toBe('skills_workspace');
  });

  it('returns null for the global/legacy DB path', () => {
    expect(projectNameFromDbPath('/home/u/.claude-mem/claude-mem.db')).toBeNull();
  });

  it('returns null for empty / undefined / non-standard paths', () => {
    expect(projectNameFromDbPath('')).toBeNull();
    expect(projectNameFromDbPath(undefined)).toBeNull();
    expect(projectNameFromDbPath('/a/b/c/mem.db')).toBeNull(); // parent dir is not ".claude"
  });

  it('incident invariant: a child DB path resolves to the CHILD name, not the parent', () => {
    // The allowlist routes a child cwd to <child>/.claude/mem.db (Priority 1). Whatever the
    // parent workspace is called, the name taken from this path is the child's — never the
    // parent that a cwd-based climb (getProjectName → resolveWorkspaceRoot) would have used.
    const childDbPath = '/mnt/pod/parent-workspace/child-repo/.claude/mem.db';
    expect(projectNameFromDbPath(childDbPath)).toBe('child-repo');
    expect(projectNameFromDbPath(childDbPath)).not.toBe('parent-workspace');
  });
});

describe('SessionRoutes observation write path names sessions from the DB, not cwd', () => {
  const src = readFileSync(
    join(__dirname, '../../src/services/worker/http/routes/SessionRoutes.ts'),
    'utf-8'
  );

  it('derives the created-session project via projectNameFromDbPath(dbPath)', () => {
    expect(src).toContain('projectNameFromDbPath(dbPath)');
  });

  it('no longer names the created session from bare getProjectName(cwd)', () => {
    // The regressed form the fix replaced.
    expect(src).not.toContain("const project = cwd ? getProjectName(cwd) : '';");
  });
});
