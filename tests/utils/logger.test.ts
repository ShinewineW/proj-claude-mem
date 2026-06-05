import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanupOldLogs, logger, LogLevel } from '../../src/utils/logger.js';

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

describe('logger circular-reference safety (DEBUG mode)', () => {
  const tmpLogDir = join(tmpdir(), 'claude-mem-logger-circ-' + Date.now());
  const tmpLogFile = join(tmpLogDir, 'test.log');
  // Snapshot the singleton's mutable fields so we never touch production paths
  // and never leak the forced DEBUG level into other test files.
  let savedLevel: any;
  let savedPath: any;
  let savedInit: any;
  let savedDate: any;

  beforeEach(() => {
    mkdirSync(tmpLogDir, { recursive: true });
    savedLevel = (logger as any).level;
    savedPath = (logger as any).logFilePath;
    savedInit = (logger as any).logFileInitialized;
    savedDate = (logger as any).logFileDate;
    // Force DEBUG (the only branch that JSON.stringifies the data arg) and
    // redirect output to a temp file (never ~/.claude-mem/logs).
    (logger as any).level = LogLevel.DEBUG;
    (logger as any).logFilePath = tmpLogFile;
    (logger as any).logFileInitialized = true;
    (logger as any).logFileDate = new Date().toISOString().split('T')[0];
  });

  afterEach(() => {
    (logger as any).level = savedLevel;
    (logger as any).logFilePath = savedPath;
    (logger as any).logFileInitialized = savedInit;
    (logger as any).logFileDate = savedDate;
    rmSync(tmpLogDir, { recursive: true, force: true });
  });

  it('does not throw on a SMALL (<=3 key) circular object and writes a string', () => {
    // <=3 keys is the branch where formatData() itself called JSON.stringify,
    // so the log()-level try/catch fallback re-threw and crashed the caller.
    const obj: any = { a: 1 };
    obj.self = obj;

    expect(() => logger.debug('WORKER', 'small circular', {}, obj)).not.toThrow();

    const contents = readFileSync(tmpLogFile, 'utf-8');
    expect(typeof contents).toBe('string');
    expect(contents).toContain('small circular');
  });

  it('does not throw on a LARGE (>3 key) circular object', () => {
    const obj: any = { a: 1, b: 2, c: 3, d: 4 };
    obj.loop = obj;

    expect(() => logger.debug('WORKER', 'large circular', {}, obj)).not.toThrow();
    const contents = readFileSync(tmpLogFile, 'utf-8');
    expect(contents).toContain('large circular');
  });

  it('still serializes a normal small object correctly', () => {
    expect(() => logger.debug('WORKER', 'normal', {}, { x: 1, y: 2 })).not.toThrow();
    const contents = readFileSync(tmpLogFile, 'utf-8');
    expect(contents).toContain('normal');
  });
});
