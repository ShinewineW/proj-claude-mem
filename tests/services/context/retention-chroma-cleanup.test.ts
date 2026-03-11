import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RetentionManager } from '../../../src/services/context/RetentionManager';

describe('RetentionManager Chroma integration', () => {
  test('cleanup returns deletedObservationIds for Chroma sync', () => {
    const db = new Database(':memory:');

    // Create required tables
    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY,
      memory_session_id TEXT,
      project TEXT,
      type TEXT,
      title TEXT,
      text TEXT,
      files_read TEXT,
      files_modified TEXT,
      created_at TEXT,
      created_at_epoch INTEGER,
      access_count INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY,
      content_session_id TEXT,
      memory_session_id TEXT,
      project TEXT,
      status TEXT DEFAULT 'active',
      started_at_epoch INTEGER
    )`);
    db.run(`CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY,
      content_session_id TEXT,
      prompt_number INTEGER,
      prompt_text TEXT,
      created_at_epoch INTEGER
    )`);
    db.run(`CREATE TABLE retention_metadata (
      project TEXT PRIMARY KEY,
      last_cleanup_epoch INTEGER
    )`);

    // Insert an old, low-score observation (change type = 0.4, very old)
    const oldEpoch = Date.now() - 200 * 24 * 60 * 60 * 1000; // 200 days ago
    db.run(`INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, status, started_at_epoch)
            VALUES (1, 'cs-1', 'ms-1', 'test-proj', 'completed', ${oldEpoch})`);
    db.run(`INSERT INTO observations (id, memory_session_id, project, type, title, created_at_epoch, access_count)
            VALUES (101, 'ms-1', 'test-proj', 'change', 'Old change', ${oldEpoch}, 0)`);

    const result = RetentionManager.cleanup(db, 'test-proj', {
      enabled: true,
      retentionDays: 30,
      scoreThreshold: 0.3,
      maxKept: 3000,
    });

    expect(result.deleted).toBe(1);
    expect(result.deletedObservationIds).toEqual([101]);

    db.close();
  });

  test('cleanup returns empty deletedObservationIds when nothing deleted', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, type TEXT,
      title TEXT, text TEXT, files_read TEXT, files_modified TEXT,
      created_at TEXT, created_at_epoch INTEGER, access_count INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE retention_metadata (project TEXT PRIMARY KEY, last_cleanup_epoch INTEGER)`);

    const result = RetentionManager.cleanup(db, 'test-proj', {
      enabled: true,
      retentionDays: 30,
      scoreThreshold: 0.3,
      maxKept: 3000,
    });

    expect(result.deleted).toBe(0);
    expect(result.deletedObservationIds).toEqual([]);

    db.close();
  });
});
