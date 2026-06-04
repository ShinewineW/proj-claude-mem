/**
 * Regression (#1297): chroma-mcp must spawn with cwd=$HOME so pydantic-settings
 * does not read project .env/.env.local files (which often hold non-chroma vars)
 * and crash the subprocess into a permanent backoff loop.
 *
 * Source-inspection guard: ChromaMcpManager pulls in a chain of mock.module'd
 * modules during full-suite runs, so we pin the production source string instead
 * of spawning a real StdioClientTransport (repo convention, see tests/CLAUDE.md
 * and process-registry-killed.test.ts).
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('ChromaMcpManager cwd=homedir (#1297)', () => {
  const SRC = readFileSync(
    join(import.meta.dir, '../../../src/services/sync/ChromaMcpManager.ts'),
    'utf-8'
  );

  it('imports os', () => {
    expect(/import os from ['"]os['"]/.test(SRC)).toBe(true);
  });

  it('passes cwd: os.homedir() to the chroma-mcp StdioClientTransport options', () => {
    expect(SRC.includes('cwd: os.homedir()')).toBe(true);
  });
});
