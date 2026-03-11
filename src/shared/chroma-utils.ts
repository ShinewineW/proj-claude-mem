/**
 * Utility functions for Chroma vector database collection naming.
 */

import { createHash } from 'crypto';
import { basename, dirname } from 'path';

/**
 * Compute a deterministic Chroma collection name for a per-project database.
 *
 * Format: cm__<sanitizedProjectName>_<8-char-sha256-of-dbPath>
 *
 * Chroma collection name constraints:
 * - Characters: [a-zA-Z0-9._-]
 * - Length: 3-512
 * - Must start and end with [a-zA-Z0-9]
 *
 * Args:
 *     dbPath: Absolute path to the project's mem.db file.
 *
 * Returns:
 *     Deterministic collection name safe for Chroma.
 */
export function getCollectionName(dbPath: string): string {
  const parentDir = dirname(dbPath);
  const grandparentDir = dirname(parentDir);
  const parentName = basename(parentDir);

  // Standard structure: <project>/.claude/mem.db → use project name
  // Env override: /tmp/custom/mem.db → use parent dir name
  const rawProjectName = parentName === '.claude'
    ? basename(grandparentDir)
    : parentName;

  // Sanitize to Chroma-safe characters, strip leading/trailing non-alphanumeric
  const sanitized = rawProjectName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '');

  const projectPart = sanitized || 'unknown';
  const hash = createHash('sha256').update(dbPath).digest('hex').slice(0, 8);

  return `cm__${projectPart}_${hash}`;
}
