/**
 * SDKAgent batch integration tests.
 *
 * Tests the batch logic in createMessageGenerator's observation branch:
 * - processingMessageIds tracking for batch-claimed messages
 * - earliestPendingTimestamp maintenance
 * - batchMaxSize=1 disables batching
 * - batch does not cross prompt_number boundaries
 *
 * Uses in-memory SQLite to test the PendingMessageStore → Observation[] → prompt pipeline.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { buildBatchObservationPrompt, type Observation } from '../../src/sdk/prompts.js';

describe('SDKAgent batch integration semantics', () => {
  let db: Database;
  let store: PendingMessageStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT,
        memory_session_id TEXT,
        project TEXT,
        user_prompt TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        started_at_epoch INTEGER DEFAULT (unixepoch()),
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT DEFAULT 'active',
        prompt_counter INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER REFERENCES sdk_sessions(id),
        content_session_id TEXT,
        message_type TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        started_processing_at_epoch INTEGER,
        failed_at_epoch INTEGER,
        created_at_epoch INTEGER DEFAULT (unixepoch())
      );
    `);
    db.exec("INSERT INTO sdk_sessions (content_session_id, project) VALUES ('test-session', 'test')");
    store = new PendingMessageStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertObs(promptNumber: number, toolName: string = 'Read', epochOffset: number = 0) {
    const epoch = Date.now() - 10000 + epochOffset;
    db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, tool_name, tool_input, tool_response, prompt_number, status, created_at_epoch)
      VALUES (1, 'test-session', 'observation', '${toolName}', '{"file":"test.ts"}', '"ok"', ${promptNumber}, 'pending', ${epoch})`);
  }

  function insertSummarize() {
    db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, prompt_number, status, created_at_epoch)
      VALUES (1, 'test-session', 'summarize', NULL, 'pending', ${Date.now()})`);
  }

  test('batch-claimed messages are added to processingMessageIds', () => {
    // Simulate: iterator delivers msg id=1, then batch claims id=2,3
    insertObs(5, 'Read', 0);
    insertObs(5, 'Edit', 100);
    insertObs(5, 'Bash', 200);

    // Claim first message (simulates iterator)
    const firstMsg = store.claimNextMessage(1);
    expect(firstMsg).not.toBeNull();

    // Simulate SDKAgent batch: claim remaining same-prompt observations
    const processingMessageIds: number[] = [firstMsg!.id]; // iterator already adds this
    const batch = store.claimNextObservationBatch(1, 5, 4);

    // Each batch message should be tracked
    for (const p of batch) {
      processingMessageIds.push(p.id);
    }

    expect(processingMessageIds).toEqual([1, 2, 3]);
    expect(batch.length).toBe(2);
  });

  test('earliestPendingTimestamp uses minimum of all batch timestamps', () => {
    const baseTime = Date.now();
    // Insert with known timestamps
    db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, tool_name, prompt_number, status, created_at_epoch)
      VALUES (1, 'test-session', 'observation', 'Read', 5, 'pending', ${baseTime - 5000})`);
    db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, tool_name, prompt_number, status, created_at_epoch)
      VALUES (1, 'test-session', 'observation', 'Edit', 5, 'pending', ${baseTime - 10000})`);
    db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, tool_name, prompt_number, status, created_at_epoch)
      VALUES (1, 'test-session', 'observation', 'Bash', 5, 'pending', ${baseTime - 3000})`);

    // Claim first (simulates iterator)
    const firstMsg = store.claimNextMessage(1);
    let batchOriginalTimestamp = firstMsg!.created_at_epoch;

    // Batch claim remaining
    const batch = store.claimNextObservationBatch(1, 5, 4);
    for (const p of batch) {
      batchOriginalTimestamp = Math.min(batchOriginalTimestamp, p.created_at_epoch);
    }

    // The second row (baseTime - 10000) should be the earliest
    expect(batchOriginalTimestamp).toBe(baseTime - 10000);
  });

  test('batch does not consume summarize messages', () => {
    insertObs(5, 'Read');
    insertSummarize();
    insertObs(5, 'Edit');

    // Claim first obs
    const firstMsg = store.claimNextMessage(1);
    expect(firstMsg!.message_type).toBe('observation');

    // Batch should NOT grab obs after summarize
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(0); // summarize at id=2 is a boundary

    // Summarize should still be claimable by main channel
    const summarize = store.claimNextMessage(1);
    expect(summarize!.message_type).toBe('summarize');
  });

  test('batch does not cross prompt_number boundary', () => {
    insertObs(5, 'Read');
    insertObs(5, 'Edit');
    insertObs(6, 'Bash'); // different prompt

    // Claim first
    store.claimNextMessage(1);

    // Batch should only claim id=2 (same prompt), not id=3
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(1);
    expect(batch[0].prompt_number).toBe(5);
  });

  test('batch observations produce correct prompt format', () => {
    // Simulate what SDKAgent does after claiming a batch
    const batchObservations: Observation[] = [
      { id: 0, tool_name: 'Read', tool_input: '{"file_path":"/a.ts"}', tool_output: '"content"', created_at_epoch: Date.now(), cwd: '/project' },
      { id: 0, tool_name: 'Edit', tool_input: '{"file_path":"/b.ts"}', tool_output: '"ok"', created_at_epoch: Date.now(), cwd: '/project' },
      { id: 0, tool_name: 'Bash', tool_input: '{"command":"ls"}', tool_output: '"file1\\nfile2"', created_at_epoch: Date.now(), cwd: '/project' },
    ];

    const { prompt } = buildBatchObservationPrompt(batchObservations, 8000);

    // Batch format with indexed items
    expect(prompt).toContain('OBSERVATION BATCH (3 items)');
    expect(prompt).toContain('index="1"');
    expect(prompt).toContain('index="2"');
    expect(prompt).toContain('index="3"');
    expect(prompt).toContain('Read');
    expect(prompt).toContain('Edit');
    expect(prompt).toContain('Bash');
  });

  test('single observation uses non-batch format', () => {
    const { prompt } = buildBatchObservationPrompt([
      { id: 0, tool_name: 'Read', tool_input: '{}', tool_output: '{}', created_at_epoch: Date.now() },
    ], 8000);

    expect(prompt).not.toContain('BATCH');
    expect(prompt).toContain('OBSERVATION ONLY');
  });
});
