/**
 * Tests for dbPath input validation in DatabaseManager.
 *
 * Validates that dbPath values from HTTP requests are safe:
 * - Must be absolute path
 * - Must end with mem.db
 * - Must not contain path traversal (..)
 * - undefined passes through (fallback chain)
 */

import { describe, it, expect } from 'bun:test';
import { validateDbPath } from '../../src/services/worker/DatabaseManager.js';

describe('validateDbPath', () => {
  it('accepts a valid absolute path ending with mem.db', () => {
    expect(() => validateDbPath('/Users/foo/project/.claude/mem.db')).not.toThrow();
  });

  it('accepts undefined (triggers fallback chain)', () => {
    expect(() => validateDbPath(undefined)).not.toThrow();
  });

  it('rejects a relative path', () => {
    expect(() => validateDbPath('./foo/mem.db')).toThrow(/absolute path/i);
  });

  it('rejects path traversal with ..', () => {
    expect(() => validateDbPath('/Users/../etc/passwd')).toThrow(/path traversal/i);
  });

  it('rejects wrong filename', () => {
    expect(() => validateDbPath('/Users/foo/project/.claude/evil.db')).toThrow(/mem\.db/i);
  });

  it('rejects empty string', () => {
    expect(() => validateDbPath('')).toThrow();
  });

  it('accepts null (same as undefined, triggers fallback chain)', () => {
    expect(() => validateDbPath(null)).not.toThrow();
  });
});
