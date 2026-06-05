import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanupOldLogs } from '../../src/utils/logger.js';

describe('cleanupOldLogs', () => {
  const testLogsDir = join(tmpdir(), 'claude-mem-log-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testLogsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testLogsDir, { recursive: true, force: true });
  });

  it('should delete log files older than maxAgeDays', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];
    const oldFile = join(testLogsDir, `claude-mem-${oldDate}.log`);
    writeFileSync(oldFile, 'old log content');

    const todayDate = new Date().toISOString().split('T')[0];
    const todayFile = join(testLogsDir, `claude-mem-${todayDate}.log`);
    writeFileSync(todayFile, 'today log content');

    cleanupOldLogs(testLogsDir, 7);

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(todayFile)).toBe(true);
  });

  it('should not delete non-log files', () => {
    const otherFile = join(testLogsDir, 'other-file.txt');
    writeFileSync(otherFile, 'should stay');

    cleanupOldLogs(testLogsDir, 7);

    expect(existsSync(otherFile)).toBe(true);
  });

  it('should handle empty directory gracefully', () => {
    expect(() => cleanupOldLogs(testLogsDir, 7)).not.toThrow();
  });

  it('should handle non-existent directory gracefully', () => {
    expect(() => cleanupOldLogs('/tmp/does-not-exist-xyz', 7)).not.toThrow();
  });
});

describe('logger circular-reference safety (formatData crash-safety)', () => {
  // NOTE: the real `logger` singleton is mock.module()'d by 15+ other test files
  // (process-level, irreversible in bun), so importing/exercising it here would
  // hit a no-op stub in full-suite runs. The fix lives in the private formatData
  // small-object branch, so we (a) source-pin the try/catch wrapper and (b)
  // functionally verify the EXACT branch logic inline, fully isolated from the
  // mocked singleton. See tests/CLAUDE.md "mock.module() Gotcha".
  const SRC = readFileSync(join(import.meta.dir, '../../src/utils/logger.ts'), 'utf-8');

  // Faithful inline copy of the fixed formatData small-object branch.
  function smallObjectBranch(data: any): string {
    const keys = Object.keys(data);
    if (keys.length <= 3) {
      try {
        return JSON.stringify(data);
      } catch {
        return `{${keys.length} keys: ${keys.join(', ')}} (uninspectable)`;
      }
    }
    return `{${keys.length} keys: ${keys.slice(0, 3).join(', ')}...}`;
  }

  it('source: small-object JSON.stringify is wrapped in try/catch', () => {
    // The whole point of the fix — without this wrapper a <=3-key circular
    // object re-throws out of the log() fallback and crashes the caller.
    const branch = SRC.slice(SRC.indexOf('if (keys.length <= 3)'), SRC.indexOf('if (keys.length <= 3)') + 700);
    expect(branch).toContain('try {');
    expect(branch).toContain('return JSON.stringify(data);');
    expect(branch).toContain('(uninspectable)');
  });

  it('does not throw on a SMALL (<=3 key) circular object and returns a string', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    let out: any;
    expect(() => { out = smallObjectBranch(obj); }).not.toThrow();
    expect(typeof out).toBe('string');
    expect(out).toContain('uninspectable');
  });

  it('does not throw on a LARGE (>3 key) circular object', () => {
    const obj: any = { a: 1, b: 2, c: 3, d: 4 };
    obj.loop = obj;
    expect(() => smallObjectBranch(obj)).not.toThrow();
  });

  it('still serializes a normal small object correctly', () => {
    expect(smallObjectBranch({ x: 1, y: 2 })).toBe('{"x":1,"y":2}');
  });
});
