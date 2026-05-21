/**
 * Prompts module tests
 * Tests modular prompt functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/sqlite/prompts/store.ts
 * - API patterns from src/services/sqlite/prompts/get.ts
 * - Test pattern from tests/session_store.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  saveUserPrompt,
  getPromptNumberFromUserPrompts,
  getLatestRealPromptNumber,
  getLatestUserPrompt,
  getAllRecentUserPrompts,
} from '../../src/services/sqlite/Prompts.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { Database } from 'bun:sqlite';

describe('Prompts Module', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a session (for FK constraint on user_prompts.content_session_id)
  function createSession(contentSessionId: string, project: string = 'test-project'): string {
    createSDKSession(db, contentSessionId, project, 'initial prompt');
    return contentSessionId;
  }

  describe('saveUserPrompt', () => {
    it('should store prompt and return numeric ID', () => {
      const contentSessionId = createSession('content-session-prompt-1');
      const promptNumber = 1;
      const promptText = 'First user prompt';

      const id = saveUserPrompt(db, contentSessionId, promptNumber, promptText);

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('should store multiple prompts with incrementing IDs', () => {
      const contentSessionId = createSession('content-session-prompt-2');

      const id1 = saveUserPrompt(db, contentSessionId, 1, 'First prompt');
      const id2 = saveUserPrompt(db, contentSessionId, 2, 'Second prompt');
      const id3 = saveUserPrompt(db, contentSessionId, 3, 'Third prompt');

      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(id1);
      expect(id3).toBeGreaterThan(id2);
    });

    it('should allow prompts from different sessions', () => {
      const sessionA = createSession('session-a');
      const sessionB = createSession('session-b');

      const id1 = saveUserPrompt(db, sessionA, 1, 'Prompt A1');
      const id2 = saveUserPrompt(db, sessionB, 1, 'Prompt B1');

      expect(id1).not.toBe(id2);
    });
  });

  describe('getPromptNumberFromUserPrompts', () => {
    it('should return 0 when no prompts exist', () => {
      const count = getPromptNumberFromUserPrompts(db, 'nonexistent-session');

      expect(count).toBe(0);
    });

    it('should return count of prompts for session', () => {
      const contentSessionId = createSession('count-test-session');

      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(0);

      saveUserPrompt(db, contentSessionId, 1, 'First prompt');
      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(1);

      saveUserPrompt(db, contentSessionId, 2, 'Second prompt');
      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(2);

      saveUserPrompt(db, contentSessionId, 3, 'Third prompt');
      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(3);
    });

    it('should maintain session isolation', () => {
      const sessionA = createSession('isolation-session-a');
      const sessionB = createSession('isolation-session-b');

      // Add prompts to session A
      saveUserPrompt(db, sessionA, 1, 'A1');
      saveUserPrompt(db, sessionA, 2, 'A2');

      // Add prompts to session B
      saveUserPrompt(db, sessionB, 1, 'B1');

      // Session A should have 2 prompts
      expect(getPromptNumberFromUserPrompts(db, sessionA)).toBe(2);

      // Session B should have 1 prompt
      expect(getPromptNumberFromUserPrompts(db, sessionB)).toBe(1);

      // Adding to session B shouldn't affect session A
      saveUserPrompt(db, sessionB, 2, 'B2');
      saveUserPrompt(db, sessionB, 3, 'B3');

      expect(getPromptNumberFromUserPrompts(db, sessionA)).toBe(2);
      expect(getPromptNumberFromUserPrompts(db, sessionB)).toBe(3);
    });

    it('should handle edge case of many prompts', () => {
      const contentSessionId = createSession('many-prompts-session');

      for (let i = 1; i <= 100; i++) {
        saveUserPrompt(db, contentSessionId, i, `Prompt ${i}`);
      }

      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(100);
    });
  });

  describe('getLatestRealPromptNumber (attribution anchor)', () => {
    it('returns 0 when session has no prompts', () => {
      expect(getLatestRealPromptNumber(db, 'never-saved')).toBe(0);
    });

    it('returns the latest prompt_number when all rows are real', () => {
      const sess = createSession('all-real');
      saveUserPrompt(db, sess, 1, 'hello');
      saveUserPrompt(db, sess, 2, 'world');
      saveUserPrompt(db, sess, 3, 'again');

      expect(getLatestRealPromptNumber(db, sess)).toBe(3);
    });

    it('ignores trailing redacted rows', () => {
      const sess = createSession('trailing-redacted');
      saveUserPrompt(db, sess, 1, 'real one');
      saveUserPrompt(db, sess, 2, '', true);
      saveUserPrompt(db, sess, 3, '', true);

      // counter still advances for assignment, but attribution stays on prompt 1
      expect(getPromptNumberFromUserPrompts(db, sess)).toBe(3);
      expect(getLatestRealPromptNumber(db, sess)).toBe(1);
    });

    it('returns the prior real prompt when a redacted row sits in the middle', () => {
      const sess = createSession('mid-redacted');
      saveUserPrompt(db, sess, 1, 'first ask');
      saveUserPrompt(db, sess, 2, '', true); // <task-notification> noise
      saveUserPrompt(db, sess, 3, 'second ask');

      // Observation arriving between pn=2 redaction and pn=3 save would
      // mis-attribute under the old COUNT-based resolution. New helper picks
      // the latest REAL number — pn=3 once it lands, pn=1 before then.
      expect(getLatestRealPromptNumber(db, sess)).toBe(3);
    });

    it('isolates per session', () => {
      const a = createSession('sess-a');
      const b = createSession('sess-b');
      saveUserPrompt(db, a, 1, 'a1');
      saveUserPrompt(db, b, 1, '', true);

      expect(getLatestRealPromptNumber(db, a)).toBe(1);
      expect(getLatestRealPromptNumber(db, b)).toBe(0);
    });
  });

  describe('viewer-facing reads exclude redacted rows', () => {
    it('getLatestUserPrompt skips redacted placeholder', () => {
      const sess = createSession('viewer-latest');
      saveUserPrompt(db, sess, 1, 'real prompt body');
      saveUserPrompt(db, sess, 2, '', true);

      const latest = getLatestUserPrompt(db, sess);
      expect(latest).toBeDefined();
      expect(latest?.prompt_number).toBe(1);
      expect(latest?.prompt_text).toBe('real prompt body');
    });

    it('getAllRecentUserPrompts excludes redacted rows', () => {
      const sess = createSession('viewer-recent');
      saveUserPrompt(db, sess, 1, 'visible one');
      saveUserPrompt(db, sess, 2, '', true);
      saveUserPrompt(db, sess, 3, 'visible two');

      const rows = getAllRecentUserPrompts(db, 50);
      const forSession = rows.filter(r => r.content_session_id === sess);
      expect(forSession.map(r => r.prompt_number).sort()).toEqual([1, 3]);
    });
  });
});
