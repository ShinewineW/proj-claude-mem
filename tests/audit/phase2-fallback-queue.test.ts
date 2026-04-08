/**
 * Audit Phase 2 — Fallback queue properties.
 *
 * Invariants:
 *  Q1: any writeFallbackEntry result is a parseable JSON file
 *  Q2: readFallbackEntries round-trips writeFallbackEntry
 *  Q3: malformed JSON files in dir are silently discarded (not thrown)
 *  Q4: filenames use only safe chars (no traversal via sessionId)
 *  Q5: cleanupStaleFallbacks removes files older than maxAgeMs
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeFallbackEntry,
  readFallbackEntries,
  cleanupStaleFallbacks,
} from '../../src/shared/fallback-queue.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audit-fb-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('fallback queue properties', () => {
  test('Q1+Q2: round-trip write/read', () => {
    writeFallbackEntry({
      type: 'observation',
      sessionId: 'sess-1',
      cwd: '/tmp/x',
      dbPath: '/tmp/mem.db',
      timestamp: 1000,
      payload: { tool_name: 'Read', tool_input: { file: 'a' } },
    }, dir);
    const read = readFallbackEntries(dir);
    expect(read.length).toBe(1);
    expect(read[0].entry.sessionId).toBe('sess-1');
    expect(read[0].entry.payload.tool_name).toBe('Read');
    const raw = readFileSync(read[0].filepath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('Q3: malformed files discarded silently', () => {
    writeFileSync(join(dir, '99999-bad.json'), '{not json', 'utf-8');
    const read = readFallbackEntries(dir);
    expect(read.length).toBe(0);
    // File should have been unlinked
    expect(readdirSync(dir).length).toBe(0);
  });

  test('Q4: filename is timestamp-random.json — sessionId NOT in filename', () => {
    const evil = '../../../etc/passwd';
    writeFallbackEntry({
      type: 'observation', sessionId: evil, cwd: '/tmp/x',
      dbPath: '/tmp/mem.db', timestamp: 2000, payload: {},
    }, dir);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d+-[a-z0-9]+\.json$/);
    expect(files[0]).not.toContain('..');
    expect(files[0]).not.toContain('/');
  });

  test('Q5: cleanupStaleFallbacks removes old files', () => {
    writeFallbackEntry({
      type: 'observation', sessionId: 's', cwd: '/', dbPath: '/', timestamp: 1, payload: {},
    }, dir);
    const files = readdirSync(dir);
    // backdate mtime by 2 days
    const p = join(dir, files[0]);
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(p, past, past);
    const removed = cleanupStaleFallbacks(dir, 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(readdirSync(dir).length).toBe(0);
  });

  test('Q6: many concurrent writes — low but nonzero collision rate', () => {
    // Filename uses timestamp + 6-char base36 random (~2B combos).
    // Document that collisions are theoretically possible but negligible.
    const N = 500;
    for (let i = 0; i < N; i++) {
      writeFallbackEntry({
        type: 'observation', sessionId: `s${i}`, cwd: '/', dbPath: '/', timestamp: 1000, payload: {},
      }, dir);
    }
    const files = readdirSync(dir);
    // Accept small loss from collision, but expect nearly all to land
    expect(files.length).toBeGreaterThan(N - 5);
  });
});
