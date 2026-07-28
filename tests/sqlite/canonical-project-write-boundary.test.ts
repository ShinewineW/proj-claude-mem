/**
 * Write-boundary invariant: the `project` column is derived from the database
 * the row is written into, never from what the caller passed.
 *
 * Prior fixes corrected individual call sites (0d41d763 named observation-created
 * sessions from dbPath instead of cwd). That removes one divergence but leaves
 * the possibility open — any other caller, or any stale bundle still running an
 * older copy of the call site, can plant a phantom project again. These tests
 * pin the guarantee at the layer that actually performs the INSERT.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

let projectRoot: string;
let store: SessionStore;

const OBSERVATION = {
  type: 'discovery',
  title: 'title',
  subtitle: null,
  facts: ['f'],
  narrative: 'narrative',
  concepts: ['c'],
  files_read: [],
  files_modified: [],
};

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cm-write-boundary-'));
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  store = new SessionStore(join(projectRoot, '.claude', 'mem.db'));
});

afterEach(() => {
  store.db.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

function expectedName(): string {
  return projectRoot.split('/').pop()!;
}

describe('project name is derived from the database, not the caller', () => {
  it('overrides a divergent project on createSDKSession', () => {
    store.createSDKSession('content-1', 'some-other-project', 'prompt');

    const row = store.db
      .prepare('SELECT project FROM sdk_sessions WHERE content_session_id = ?')
      .get('content-1') as { project: string };

    expect(row.project).toBe(expectedName());
  });

  it('fills in a project the caller left empty', () => {
    store.createSDKSession('content-2', '', '');

    const row = store.db
      .prepare('SELECT project FROM sdk_sessions WHERE content_session_id = ?')
      .get('content-2') as { project: string };

    expect(row.project).toBe(expectedName());
  });

  it('overrides a divergent project on storeObservation', () => {
    store.createSDKSession('content-3', '', '');
    const session = store.db
      .prepare('SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = ?')
      .get('content-3') as { memory_session_id: string };

    store.storeObservation(session.memory_session_id, 'some-other-project', OBSERVATION);

    const row = store.db.prepare('SELECT project FROM observations').get() as { project: string };
    expect(row.project).toBe(expectedName());
  });

  it('leaves no divergent project value anywhere in the database', () => {
    store.createSDKSession('content-4', 'wrong-name', 'prompt');
    const session = store.db
      .prepare('SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = ?')
      .get('content-4') as { memory_session_id: string };
    store.storeObservation(session.memory_session_id, 'wrong-name', OBSERVATION);

    // This is the query the viewer's /api/projects uses to build its list —
    // it must yield exactly one name for a single-project database.
    const names = store.db
      .prepare('SELECT DISTINCT project FROM observations UNION SELECT DISTINCT project FROM sdk_sessions')
      .all() as Array<{ project: string }>;

    expect(names.map(r => r.project)).toEqual([expectedName()]);
  });
});
