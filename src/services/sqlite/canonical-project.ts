/**
 * Canonical project name for a database connection.
 *
 * The write-boundary invariant: a row's `project` column is derived from the
 * database file the row is being written into — never from what the caller
 * passed in. Callers reach this layer through several resolvers (allowlist
 * routing, cwd heuristics, request bodies); any of them can disagree with the
 * routed DB, and a single disagreement plants a phantom project that shows up
 * as an extra entry in `SELECT DISTINCT project` forever.
 *
 * Fixing individual callers only removes today's divergence. Deriving the name
 * here removes the possibility of divergence, for every current and future
 * caller, because `db.filename` is the same file the INSERT lands in.
 *
 * Scope: only per-project databases (`<projectRoot>/.claude/mem.db`) have a
 * canonical name. The global/legacy DB and `:memory:` do not, so there the
 * caller-supplied value is passed through unchanged and existing "project is
 * required" guards still apply.
 */

import type { Database } from 'bun:sqlite';
import { projectNameFromDbPath } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

/**
 * Resolve the project name that must be written into `db`.
 *
 * Args:
 *   db: The connection the row will be inserted into.
 *   supplied: The caller-provided project name (may be empty).
 *
 * Returns:
 *   The DB-derived name for a per-project database, otherwise `supplied`.
 */
export function canonicalProject(db: Database, supplied: string): string {
  const derived = projectNameFromDbPath(db.filename);
  if (!derived) return supplied;

  if (supplied && supplied !== derived) {
    logger.warn('DB', 'Project name disagreed with its database — using the database-derived name', {
      supplied,
      canonical: derived,
      dbPath: db.filename,
    });
  }

  return derived;
}
