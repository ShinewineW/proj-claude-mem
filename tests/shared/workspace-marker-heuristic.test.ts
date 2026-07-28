/**
 * Regression: a parent directory that merely holds `.claude/` must not be
 * mistaken for a workspace root.
 *
 * Incident (3rd recurrence): `/…/wangjiazhe/` held only `.claude/skills/` —
 * shared skills for several sibling projects, not a project of its own. The
 * old marker test (`existsSync('.claude')`) treated it as a workspace root, so
 * a nested git repo (`skills_workspace`) resolved its project NAME to the
 * parent while the allowlist routed its DB to the child. Every write made
 * through a cwd-based resolver then planted a phantom "wangjiazhe" project
 * inside `skills_workspace/.claude/mem.db`, which surfaced as a 4th project in
 * a viewer whose allowlist only had 3.
 *
 * Fix: require a marker a shared-asset directory never carries — CLAUDE.md,
 * `.claude/CLAUDE.md`, `.claude/settings*.json`, or an existing `.claude/mem.db`.
 *
 * These tests target hasWorkspaceMarker directly rather than going through
 * paths.js, so they stay green under the process-wide mock.module('paths.js')
 * that ~20 worker/service tests install during a full-suite run.
 */

import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { hasWorkspaceMarker } from '../../src/shared/workspace-marker.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'cm-marker-'));
}

describe('hasWorkspaceMarker', () => {
  it('rejects a directory whose .claude/ holds only shared assets', () => {
    const dir = makeDir();
    // Exactly the incident shape: .claude/ exists but carries only skills.
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });

    try {
      expect(hasWorkspaceMarker(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a directory with no .claude/ at all', () => {
    const dir = makeDir();
    try {
      expect(hasWorkspaceMarker(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a root-level CLAUDE.md', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'CLAUDE.md'), '# workspace\n');

    try {
      expect(hasWorkspaceMarker(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['.claude/CLAUDE.md', join('.claude', 'CLAUDE.md')],
    ['.claude/settings.json', join('.claude', 'settings.json')],
    ['.claude/settings.local.json', join('.claude', 'settings.local.json')],
    ['.claude/mem.db', join('.claude', 'mem.db')],
  ])('accepts %s', (_label, relPath) => {
    const dir = makeDir();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, relPath), '');

    try {
      expect(hasWorkspaceMarker(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
