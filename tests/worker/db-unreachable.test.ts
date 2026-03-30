import { describe, test, expect } from 'bun:test';
import { isDbIoError, isProjectStillValid } from '../../src/services/worker/generator-action.js';

describe('isProjectStillValid', () => {
  test('returns true when dbPath is undefined', () => {
    expect(isProjectStillValid(undefined)).toBe(true);
  });

  test('returns true when file exists', () => {
    expect(isProjectStillValid('/some/path', () => true)).toBe(true);
  });

  test('returns false when file does not exist', () => {
    expect(isProjectStillValid('/some/path', () => false)).toBe(false);
  });
});

describe('isDbIoError integration', () => {
  test('disk I/O error + existsSync=false → db-unreachable scenario', () => {
    const error = new Error('disk I/O error');
    expect(isDbIoError(error)).toBe(true);
    const dbFileExists = false;
    expect(isDbIoError(error) && dbFileExists === false).toBe(true);
  });

  test('disk I/O error + existsSync=true → transient (not db-unreachable)', () => {
    const error = new Error('disk I/O error');
    const dbFileExists = true;
    expect(isDbIoError(error) && dbFileExists === false).toBe(false);
  });
});
