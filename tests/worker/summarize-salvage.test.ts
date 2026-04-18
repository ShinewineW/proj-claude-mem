/**
 * Summarize salvage module tests.
 *
 * Covers both the pre-queue entry point (attemptEmptyTranscriptSalvage) and
 * the shared synthesizer (synthesizeSummaryFromRecentObservations) used by
 * the in-response fallback in ResponseProcessor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  attemptEmptyTranscriptSalvage,
  synthesizeSummaryFromRecentObservations,
} from '../../src/services/worker/summarize-salvage.js';

describe('summarize-salvage', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function seedSession(memoryId: string, userPrompt: string = 'original request'): number {
    const sessionDbId = store.createSDKSession('content-' + memoryId, 'test-project', userPrompt);
    store.ensureMemorySessionIdRegistered(sessionDbId, memoryId);
    return sessionDbId;
  }

  function addObservation(
    memoryId: string,
    type: string,
    title: string | null,
    narrative: string | null = null,
    facts: string[] = [],
    promptNumber: number = 1,
  ): void {
    store.storeObservations(
      memoryId,
      'test-project',
      [{
        type,
        title,
        subtitle: null,
        facts,
        narrative,
        concepts: [],
        files_read: [],
        files_modified: [],
      }],
      null,
      promptNumber,
      0,
    );
  }

  describe('attemptEmptyTranscriptSalvage', () => {
    it('fallthrough when lastAssistantMessage has content', () => {
      const sessionDbId = seedSession('m-1');
      addObservation('m-1', 'discovery', 'something');

      const result = attemptEmptyTranscriptSalvage(store, sessionDbId, 'real text', 1);
      expect(result.status).toBe('fallthrough');
      expect(result.obsCount).toBe(0);
    });

    it('fallthrough when session has no memory_session_id', () => {
      const sessionDbId = store.createSDKSession('content-no-mem', 'test-project', 'x');
      // deliberately NOT registering memory_session_id

      const result = attemptEmptyTranscriptSalvage(store, sessionDbId, '', 1);
      expect(result.status).toBe('fallthrough');
    });

    it('skipped when session has memory_session_id but no observations', () => {
      const sessionDbId = seedSession('m-empty');

      const result = attemptEmptyTranscriptSalvage(store, sessionDbId, '   ', 1);
      expect(result.status).toBe('skipped');
      expect(result.obsCount).toBe(0);
    });

    it('salvaged when observations exist — stores summary and fires callback', () => {
      const sessionDbId = seedSession('m-data', 'Review the design doc');
      addObservation('m-data', 'discovery', 'Read spec', 'Narrative of reading', ['line-count=42']);
      addObservation('m-data', 'feature', 'Implemented parser', null, ['parses JSON']);

      let broadcast: any = null;
      const result = attemptEmptyTranscriptSalvage(
        store,
        sessionDbId,
        undefined,
        3,
        (payload) => { broadcast = payload; },
      );

      expect(result.status).toBe('salvaged');
      expect(result.summaryId).toBeGreaterThan(0);
      expect(result.obsCount).toBe(2);

      // Verify summary actually persisted
      const row = store.db.prepare('SELECT * FROM session_summaries WHERE id = ?').get(result.summaryId);
      expect(row).toBeDefined();
      expect((row as any).request).toBe('Review the design doc');
      expect((row as any).notes).toContain('Salvaged from 2 observation');

      // Callback payload should mirror the stored summary
      expect(broadcast).not.toBeNull();
      expect(broadcast.id).toBe(result.summaryId);
      expect(broadcast.session_id).toBe('content-m-data');
      expect(broadcast.project).toBe('test-project');
      expect(broadcast.prompt_number).toBe(3);
    });

    it('falls back to placeholder request when user_prompt is empty', () => {
      const sessionDbId = seedSession('m-no-prompt', '');
      addObservation('m-no-prompt', 'discovery', 'Found something');

      const result = attemptEmptyTranscriptSalvage(store, sessionDbId, '', 1);
      expect(result.status).toBe('salvaged');
      const row = store.db.prepare('SELECT * FROM session_summaries WHERE id = ?').get(result.summaryId);
      expect((row as any).request).toBe('Session observations (1 items)');
    });
  });

  describe('synthesizeSummaryFromRecentObservations', () => {
    it('returns null for sessions with no observations', () => {
      seedSession('m-none');
      const result = synthesizeSummaryFromRecentObservations(store, 'm-none', null, 'test-note');
      expect(result).toBeNull();
    });

    it('populates completed field from feature/bugfix observations', () => {
      seedSession('m-feat');
      addObservation('m-feat', 'discovery', 'Research');
      addObservation('m-feat', 'feature', 'Shipped feature A');
      addObservation('m-feat', 'bugfix', 'Fixed bug B');

      const result = synthesizeSummaryFromRecentObservations(store, 'm-feat', null, 'test-note');
      expect(result).not.toBeNull();
      expect(result!.obsCount).toBe(3);
      expect(result!.summary.completed).toContain('Shipped feature A');
      expect(result!.summary.completed).toContain('Fixed bug B');
      expect(result!.summary.completed).not.toContain('Research');
    });

    it('survives malformed facts JSON without throwing', () => {
      seedSession('m-bad-facts');
      // Directly insert observation with malformed facts column
      store.db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, facts, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      `).run('m-bad-facts', 'test-project', 'discovery', 'weird obs', 'not-json-at-all', Date.now());

      const result = synthesizeSummaryFromRecentObservations(store, 'm-bad-facts', null, 'test-note');
      expect(result).not.toBeNull();
      expect(result!.obsCount).toBe(1);
      // learned fell back to titles since facts couldn't parse
      expect(result!.summary.learned).toBe('weird obs');
    });

    it('honors the limit parameter', () => {
      seedSession('m-limit');
      for (let i = 0; i < 10; i++) {
        addObservation('m-limit', 'discovery', `obs-${i}`);
      }

      const result = synthesizeSummaryFromRecentObservations(store, 'm-limit', null, 'test-note', 3);
      expect(result).not.toBeNull();
      expect(result!.obsCount).toBe(3);
    });
  });
});
