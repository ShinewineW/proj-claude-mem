/**
 * Pattern-based observation filtering (Layer A).
 *
 * Filters low-value tool observations before they are enqueued to
 * the pending_messages table, reducing wasted SDK API calls.
 */

import { logger } from '../../../../utils/logger.js';

export interface ToolPattern {
  tool: string;
  glob: string;
  regex: RegExp; // pre-compiled from glob for O(1) matching
}

/**
 * Compile a glob pattern to a RegExp.
 * `*` matches any sequence of characters (including path separators).
 */
function globToRegex(pattern: string): RegExp {
  const regexStr =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
      .replace(/\*/g, '.*') + // * → .*
    '$';
  return new RegExp(regexStr);
}

/**
 * Parse a comma-separated setting string into ToolPattern array.
 * Format: "ToolName:glob_pattern,ToolName2:glob_pattern2"
 * Malformed entries (no colon) are silently skipped.
 */
export function parseSkipPatterns(setting: string): ToolPattern[] {
  if (!setting || !setting.trim()) return [];

  const patterns = setting
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes(':'))
    .map((s) => {
      const colonIdx = s.indexOf(':');
      const glob = s.slice(colonIdx + 1);
      return {
        tool: s.slice(0, colonIdx),
        glob,
        regex: globToRegex(glob),
      };
    });

  logger.debug('FILTER', `Parsed ${patterns.length} skip patterns`, {
    patterns: patterns.map(p => `${p.tool}:${p.glob}`),
  });

  return patterns;
}

/**
 * Extract the field value to match against the glob pattern.
 *
 * Field extraction by tool_name:
 * - Read → tool_input.file_path
 * - Glob → tool_input.pattern
 * - Grep → tool_input.pattern
 * - Other → undefined (must use wildcard glob '*' for tool-name-only match)
 */
function extractMatchField(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolInput) return undefined;

  switch (toolName) {
    case 'Read':
      return typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
    case 'Glob':
    case 'Grep':
      return typeof toolInput.pattern === 'string' ? toolInput.pattern : undefined;
    case 'Bash':
      return typeof toolInput.command === 'string' ? toolInput.command : undefined;
    default:
      return undefined;
  }
}

/**
 * Check if an observation should be skipped based on pattern matching.
 *
 * Returns true if the tool_name matches a pattern AND the extracted
 * field matches the pre-compiled regex. For wildcard glob '*',
 * always matches regardless of tool_input.
 */
export function shouldSkipObservation(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  patterns: ToolPattern[],
): boolean {
  // Bash compound-command guard: a command that chains, backgrounds, or redirects
  // (&, &&, ||, ;, |, $( ), backtick, >, <) almost always wraps real work
  // (e.g. `cd /repo && pytest`, `cd /repo & pytest`). Single `&`/`|` in the char
  // class subsumes `&&`/`||`.
  // HARD RULE: never skip these — deliberately overrides even an explicit
  // user-configured `Bash:*` wildcard (compound commands always get observed).
  if (toolName === 'Bash') {
    const command = typeof toolInput?.command === 'string' ? toolInput.command : undefined;
    if (command !== undefined && /[&;|<>`]|\$\(/.test(command)) {
      return false;
    }
  }
  for (const pattern of patterns) {
    if (pattern.tool !== toolName) continue;

    // Wildcard glob: always matches for this tool
    if (pattern.glob === '*') return true;

    const fieldValue = extractMatchField(toolName, toolInput);
    if (fieldValue !== undefined && pattern.regex.test(fieldValue)) {
      return true;
    }
  }
  return false;
}
