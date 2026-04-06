/**
 * Documents the known divergence between getProjectName() and allowlist-based
 * project names when resolveWorkspaceRoot heuristic fires.
 *
 * getProjectName() uses resolveProjectRoot → resolveWorkspaceRoot heuristic,
 * which can return the parent directory name. Allowlist-based resolution
 * uses basename(allowlistRoot) directly.
 *
 * Fix: callers that have access to allowlist-resolved context (ctx.projectName)
 * must use it instead of calling getProjectName(). See context.ts fix.
 *
 * This test verifies the workaround: context.ts no longer imports getProjectContext.
 */

import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// No mock.module needed — this test reads source files directly

describe('context.ts does not use getProjectContext (workspace heuristic bypass)', () => {
  it('context.ts does not import getProjectContext from project-name', () => {
    const contextSrc = readFileSync(
      join(__dirname, '../../src/cli/handlers/context.ts'),
      'utf-8'
    );
    // After fix: context.ts uses ctx.projectName directly, not getProjectContext import
    expect(contextSrc).not.toMatch(/import.*getProjectContext/);
  });

  it('context.ts uses ctx.projectName for the projects URL parameter', () => {
    const contextSrc = readFileSync(
      join(__dirname, '../../src/cli/handlers/context.ts'),
      'utf-8'
    );
    expect(contextSrc).toContain('ctx.projectName');
  });
});
