/**
 * LIMIT injection prevention tests
 *
 * Verifies that all getByIds functions reject non-integer limit values
 * and correctly parameterize valid limits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { getObservationsByIds } from '../../src/services/sqlite/observations/get.js';
import { getSummariesByIds } from '../../src/services/sqlite/summaries/get.js';
import { getUserPromptsByIds } from '../../src/services/sqlite/prompts/get.js';
import {
  storeObservation,
} from '../../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';

describe('LIMIT injection prevention', () => {
  let db: Database;
  let observationIds: number[];

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;

    // Create a session and some observations for valid-limit tests
    const sessionId = createSDKSession(db, 'test-content-session', 'test-project');
    updateMemorySessionId(db, sessionId, 'test-memory-session');

    observationIds = [];
    for (let i = 0; i < 5; i++) {
      const input: ObservationInput = {
        type: 'discovery',
        title: `Observation ${i}`,
        subtitle: `Subtitle ${i}`,
        facts: ['fact'],
        narrative: 'narrative',
        concepts: ['concept'],
        files_read: [],
        files_modified: [],
      };
      const result = storeObservation(db, 'test-memory-session', 'test-project', input, 1);
      observationIds.push(result.id);
    }
  });

  afterEach(() => {
    db.close();
  });

  describe('getObservationsByIds', () => {
    it('should throw on string injection attempt', () => {
      expect(() => {
        getObservationsByIds(db, observationIds, { limit: '1; DROP TABLE observations--' as any });
      }).toThrow('Invalid limit');
    });

    it('should throw on negative number', () => {
      expect(() => {
        getObservationsByIds(db, observationIds, { limit: -1 });
      }).toThrow('Invalid limit');
    });

    it('should throw on NaN', () => {
      expect(() => {
        getObservationsByIds(db, observationIds, { limit: NaN });
      }).toThrow('Invalid limit');
    });

    it('should throw on float', () => {
      expect(() => {
        getObservationsByIds(db, observationIds, { limit: 2.5 });
      }).toThrow('Invalid limit');
    });

    it('should throw on zero', () => {
      expect(() => {
        getObservationsByIds(db, observationIds, { limit: 0 });
      }).toThrow('Invalid limit');
    });

    it('should work with valid positive integer', () => {
      const results = getObservationsByIds(db, observationIds, { limit: 2 });
      expect(results.length).toBe(2);
    });

    it('should work without limit', () => {
      const results = getObservationsByIds(db, observationIds);
      expect(results.length).toBe(5);
    });
  });

  describe('getSummariesByIds', () => {
    it('should throw on string injection attempt', () => {
      expect(() => {
        getSummariesByIds(db, [1], { limit: '1; DROP TABLE session_summaries--' as any });
      }).toThrow('Invalid limit');
    });

    it('should throw on negative number', () => {
      expect(() => {
        getSummariesByIds(db, [1], { limit: -5 });
      }).toThrow('Invalid limit');
    });

    it('should throw on NaN', () => {
      expect(() => {
        getSummariesByIds(db, [1], { limit: NaN });
      }).toThrow('Invalid limit');
    });
  });

  describe('getUserPromptsByIds', () => {
    it('should throw on string injection attempt', () => {
      expect(() => {
        getUserPromptsByIds(db, [1], { limit: '1; DROP TABLE user_prompts--' as any });
      }).toThrow('Invalid limit');
    });

    it('should throw on negative number', () => {
      expect(() => {
        getUserPromptsByIds(db, [1], { limit: -1 });
      }).toThrow('Invalid limit');
    });

    it('should throw on NaN', () => {
      expect(() => {
        getUserPromptsByIds(db, [1], { limit: NaN });
      }).toThrow('Invalid limit');
    });
  });
});
