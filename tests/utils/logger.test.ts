import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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
