/**
 * Workspace root detection.
 *
 * Lives in its own module rather than paths.ts so the predicate stays testable
 * on its own: ~20 worker/service tests install a process-wide
 * `mock.module('paths.js')`, which would otherwise swallow any direct test of
 * this logic when the full suite runs.
 */

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Does `dir` look like a Claude Code project/workspace root?
 *
 * The mere existence of `.claude/` is NOT sufficient. A directory that only
 * holds shared assets — e.g. a parent carrying `.claude/skills/` so several
 * sibling projects can share skills — is not a project root. Treating it as
 * one makes a nested git repo resolve to its parent, so the project NAME
 * (parent) diverges from the allowlist-routed DB (child) and a phantom
 * parent-named project leaks into the child's database. That divergence is
 * the reason projectNameFromDbPath() exists; this predicate removes its cause.
 *
 * A real root carries at least one marker that a bare shared-asset directory
 * never has: a root-level CLAUDE.md, `.claude/CLAUDE.md`, a settings file, or
 * an existing `.claude/mem.db` (claude-mem is already anchored here).
 */
export function hasWorkspaceMarker(dir: string): boolean {
  if (existsSync(join(dir, 'CLAUDE.md'))) return true;

  const claudeDir = join(dir, '.claude');
  if (!existsSync(claudeDir)) return false;

  return (
    existsSync(join(claudeDir, 'CLAUDE.md')) ||
    existsSync(join(claudeDir, 'settings.json')) ||
    existsSync(join(claudeDir, 'settings.local.json')) ||
    existsSync(join(claudeDir, 'mem.db'))
  );
}
