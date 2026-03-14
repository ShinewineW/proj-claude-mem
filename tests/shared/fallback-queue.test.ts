import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeFallbackEntry,
  readFallbackEntries,
  deleteFallbackFile,
  cleanupStaleFallbacks,
  type FallbackEntry
} from '../../src/shared/fallback-queue';

const TEST_DIR = join(tmpdir(), `fallback-test-${Date.now()}`);

describe('fallback-queue', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test('writeFallbackEntry creates file in target directory', () => {
    const entry: FallbackEntry = {
      type: 'observation',
      sessionId: 'cs-1',
      cwd: '/test/project',
      dbPath: '/test/.claude/mem.db',
      timestamp: Date.now(),
      payload: { tool_name: 'Read', tool_input: '{}', tool_response: 'ok' }
    };
    writeFallbackEntry(entry, TEST_DIR);
    const files = readdirSync(TEST_DIR).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);
  });

  test('readFallbackEntries returns written entries with filepath', () => {
    const entry: FallbackEntry = {
      type: 'observation',
      sessionId: 'cs-2',
      cwd: '/test',
      dbPath: '/test/.claude/mem.db',
      timestamp: Date.now(),
      payload: { tool_name: 'Bash' }
    };
    writeFallbackEntry(entry, TEST_DIR);
    const results = readFallbackEntries(TEST_DIR);
    expect(results.length).toBe(1);
    expect(results[0].entry.sessionId).toBe('cs-2');
    expect(results[0].entry.type).toBe('observation');
    expect(results[0].filepath).toContain('.json');
  });

  test('deleteFallbackFile removes the file', () => {
    const entry: FallbackEntry = {
      type: 'summarize',
      sessionId: 'cs-3',
      cwd: '/test',
      dbPath: '/test/.claude/mem.db',
      timestamp: Date.now(),
      payload: { last_assistant_message: 'hello' }
    };
    writeFallbackEntry(entry, TEST_DIR);
    const results = readFallbackEntries(TEST_DIR);
    expect(results.length).toBe(1);
    deleteFallbackFile(results[0].filepath);
    expect(readFallbackEntries(TEST_DIR).length).toBe(0);
  });

  test('readFallbackEntries returns empty array for nonexistent directory', () => {
    expect(readFallbackEntries('/nonexistent/path')).toEqual([]);
  });

  test('cleanupStaleFallbacks removes files older than maxAge', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const oldFile = join(TEST_DIR, '1000000000000-old.json');
    writeFileSync(oldFile, JSON.stringify({ type: 'observation', timestamp: 1000000000000 }));
    // Set mtime to the past so cleanupStaleFallbacks considers it stale
    const pastTime = new Date(Date.now() - 2000);
    utimesSync(oldFile, pastTime, pastTime);
    writeFallbackEntry({
      type: 'observation', sessionId: 'cs-new', cwd: '/test',
      dbPath: '/test/.claude/mem.db', timestamp: Date.now(), payload: {}
    }, TEST_DIR);
    const removed = cleanupStaleFallbacks(TEST_DIR, 1000);
    expect(removed).toBe(1);
    expect(readFallbackEntries(TEST_DIR).length).toBe(1);
  });

  test('readFallbackEntries skips and deletes malformed JSON files', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'bad.json'), 'not valid json{{{');
    writeFallbackEntry({
      type: 'observation', sessionId: 'cs-good', cwd: '/test',
      dbPath: '/test/.claude/mem.db', timestamp: Date.now(), payload: {}
    }, TEST_DIR);
    const results = readFallbackEntries(TEST_DIR);
    expect(results.length).toBe(1);
    expect(results[0].entry.sessionId).toBe('cs-good');
    expect(readdirSync(TEST_DIR).length).toBe(1);
  });
});
