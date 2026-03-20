/**
 * Import bulk dedup tests
 *
 * Verifies that importObservation() and importSessionSummary() use
 * content-hash-based deduplication and store content_hash in the database.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { importSdkSession, importObservation, importSessionSummary } from '../../src/services/sqlite/import/bulk.js';
import { logger } from '../../src/utils/logger.js';
import type { Database } from 'bun:sqlite';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('Import Bulk Dedup', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    importSdkSession(db, {
      content_session_id: 'content-test-1',
      memory_session_id: 'mem-test-1',
      project: 'test-project',
      user_prompt: 'test prompt',
      started_at: '2026-01-01T00:00:00Z',
      started_at_epoch: Date.now(),
      completed_at: null,
      completed_at_epoch: null,
      status: 'completed',
    });
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    db.close();
  });

  describe('importObservation', () => {
    const baseObs = {
      memory_session_id: 'mem-test-1',
      project: 'test-project',
      text: 'observation text',
      type: 'discovery',
      title: 'Test Title',
      subtitle: 'sub',
      facts: '["fact1"]',
      narrative: 'Test narrative',
      concepts: '["concept1"]',
      files_read: '["file.ts"]',
      files_modified: null,
      prompt_number: 1,
      discovery_tokens: 100,
      created_at: '2026-01-01T00:00:00Z',
      created_at_epoch: Date.now(),
    };

    it('should store content_hash on first import', () => {
      const result = importObservation(db, baseObs);

      expect(result.imported).toBe(true);

      const row = db.prepare('SELECT content_hash FROM observations WHERE id = ?').get(result.id) as any;
      expect(row.content_hash).not.toBeNull();
      expect(typeof row.content_hash).toBe('string');
      expect(row.content_hash.length).toBe(16);
    });

    it('should detect duplicate on second import of identical observation', () => {
      const first = importObservation(db, baseObs);
      expect(first.imported).toBe(true);

      const second = importObservation(db, baseObs);
      expect(second.imported).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('should import different observation as new record', () => {
      const first = importObservation(db, baseObs);
      expect(first.imported).toBe(true);

      const different = {
        ...baseObs,
        title: 'Different Title',
        narrative: 'Different narrative',
      };
      const second = importObservation(db, different);

      expect(second.imported).toBe(true);
      expect(second.id).not.toBe(first.id);
    });

    it('should handle null title and narrative in hash computation', () => {
      const nullObs = {
        ...baseObs,
        title: null,
        narrative: null,
      };

      const result = importObservation(db, nullObs);
      expect(result.imported).toBe(true);

      const row = db.prepare('SELECT content_hash FROM observations WHERE id = ?').get(result.id) as any;
      expect(row.content_hash).not.toBeNull();
    });
  });

  describe('importSessionSummary', () => {
    const baseSummary = {
      memory_session_id: 'mem-test-1',
      project: 'test-project',
      request: 'Test request',
      investigated: 'Test investigated',
      learned: 'learned stuff',
      completed: 'completed stuff',
      next_steps: 'next steps',
      files_read: '["file.ts"]',
      files_edited: null,
      notes: 'notes',
      prompt_number: 1,
      discovery_tokens: 200,
      created_at: '2026-01-01T00:00:00Z',
      created_at_epoch: Date.now(),
    };

    it('should store content_hash on first import', () => {
      const result = importSessionSummary(db, baseSummary);

      expect(result.imported).toBe(true);

      const row = db.prepare('SELECT content_hash FROM session_summaries WHERE id = ?').get(result.id) as any;
      expect(row.content_hash).not.toBeNull();
      expect(row.content_hash.length).toBe(16);
    });

    it('should detect duplicate on second import of identical summary', () => {
      const first = importSessionSummary(db, baseSummary);
      expect(first.imported).toBe(true);

      const second = importSessionSummary(db, baseSummary);
      expect(second.imported).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('should import different summary as new record', () => {
      const first = importSessionSummary(db, baseSummary);
      expect(first.imported).toBe(true);

      const different = {
        ...baseSummary,
        request: 'Different request',
        investigated: 'Different investigation',
      };
      const second = importSessionSummary(db, different);

      expect(second.imported).toBe(true);
      expect(second.id).not.toBe(first.id);
    });
  });
});
