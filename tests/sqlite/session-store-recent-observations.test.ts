/**
 * SessionStore.getRecentObservationsForSession tests.
 *
 * Used by the pre-queue summary salvage path in SessionRoutes: when the Stop
 * hook's transcript yields no assistant text, we fall back to synthesizing a
 * summary from the N most recent observations of the session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('SessionStore.getRecentObservationsForSession', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function seedSession(memoryId: string): void {
    const sessionDbId = store.createSDKSession('content-' + memoryId, 'test-project', 'summary me');
    store.ensureMemorySessionIdRegistered(sessionDbId, memoryId);
  }

  it('returns empty array when session has no observations', () => {
    seedSession('empty-session');
    const result = store.getRecentObservationsForSession('empty-session');
    expect(result).toEqual([]);
  });

  it('returns recent observations ordered newest-first with full fields', () => {
    seedSession('active-session');
    for (let i = 0; i < 3; i++) {
      store.storeObservations(
        'active-session',
        'test-project',
        [{
          type: i === 2 ? 'feature' : 'discovery',
          title: `title-${i}`,
          subtitle: null,
          facts: [`fact-${i}-a`, `fact-${i}-b`],
          narrative: `narrative ${i}`,
          concepts: [],
          files_read: [],
          files_modified: [],
        }],
        null,
        i + 1,
        0,
        1_700_000_000_000 + i * 1_000,
      );
    }

    const result = store.getRecentObservationsForSession('active-session', 20);
    expect(result).toHaveLength(3);
    expect(result[0].title).toBe('title-2');
    expect(result[0].type).toBe('feature');
    expect(result[1].title).toBe('title-1');
    expect(result[2].title).toBe('title-0');
    // facts stored as JSON string
    expect(typeof result[0].facts).toBe('string');
    const parsed = JSON.parse(result[0].facts as string);
    expect(parsed).toEqual(['fact-2-a', 'fact-2-b']);
  });

  it('respects the limit parameter', () => {
    seedSession('big-session');
    for (let i = 0; i < 30; i++) {
      store.storeObservations(
        'big-session',
        'test-project',
        [{
          type: 'discovery',
          title: `obs-${i}`,
          subtitle: null,
          facts: [],
          narrative: null,
          concepts: [],
          files_read: [],
          files_modified: [],
        }],
        null,
        i + 1,
        0,
        1_700_000_000_000 + i * 1_000,
      );
    }

    const result = store.getRecentObservationsForSession('big-session', 5);
    expect(result).toHaveLength(5);
    // newest-first: obs-29, obs-28, ...
    expect(result.map(r => r.title)).toEqual(['obs-29', 'obs-28', 'obs-27', 'obs-26', 'obs-25']);
  });

  it('only returns observations for the requested memory session', () => {
    seedSession('session-a');
    seedSession('session-b');
    store.storeObservations('session-a', 'test-project', [{
      type: 'discovery', title: 'A-only', subtitle: null,
      facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
    }], null, 1, 0);
    store.storeObservations('session-b', 'test-project', [{
      type: 'discovery', title: 'B-only', subtitle: null,
      facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
    }], null, 1, 0);

    const aResults = store.getRecentObservationsForSession('session-a');
    const bResults = store.getRecentObservationsForSession('session-b');
    expect(aResults.map(r => r.title)).toEqual(['A-only']);
    expect(bResults.map(r => r.title)).toEqual(['B-only']);
  });
});
