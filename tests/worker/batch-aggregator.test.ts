import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { PendingMessageStore } from "../../src/services/sqlite/PendingMessageStore.js";

describe("claimNextObservationBatch", () => {
  let db: Database;
  let store: PendingMessageStore;

  beforeEach(() => {
    db = new Database(":memory:");
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
    db.exec(
      "INSERT INTO sdk_sessions (content_session_id, project) VALUES ('test-session', 'test')",
    );
    store = new PendingMessageStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertObs(promptNumber: number | null, toolName: string = "Read") {
    db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, tool_name, prompt_number, status, created_at_epoch)
      VALUES (1, 'test-session', 'observation', '${toolName}', ${promptNumber === null ? "NULL" : promptNumber}, 'pending', ${Date.now()})`);
  }

  function insertSummarize() {
    db.exec(`INSERT INTO pending_messages (session_db_id, content_session_id, message_type, prompt_number, status, created_at_epoch)
      VALUES (1, 'test-session', 'summarize', NULL, 'pending', ${Date.now()})`);
  }

  test("claims up to maxCount pending observations for same prompt_number", () => {
    insertObs(5);
    insertObs(5);
    insertObs(5);
    insertObs(5);
    const batch = store.claimNextObservationBatch(1, 5, 3);
    expect(batch.length).toBe(3);
    batch.forEach((b) => {
      expect(b.message_type).toBe("observation");
      expect(b.prompt_number).toBe(5);
    });
  });

  test("preserves FIFO order within prompt group", () => {
    insertObs(5, "Read");
    insertObs(5, "Edit");
    insertObs(5, "Bash");
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(3);
    expect(batch[0].tool_name).toBe("Read");
    expect(batch[1].tool_name).toBe("Edit");
    expect(batch[2].tool_name).toBe("Bash");
  });

  test("does not claim summarize messages", () => {
    insertObs(5);
    insertSummarize();
    insertObs(5);
    // Only the first obs (before summarize boundary)
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(1);
  });

  test("does not cross into the next prompt_number", () => {
    insertObs(5);
    insertObs(5);
    insertObs(6);
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(2);
    batch.forEach((b) => expect(b.prompt_number).toBe(5));
  });

  test("does not claim already-processing rows", () => {
    insertObs(5);
    // Mark first as processing
    db.exec("UPDATE pending_messages SET status = 'processing' WHERE id = 1");
    insertObs(5);
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(1);
    expect(batch[0].id).toBe(2);
  });

  test("leaves rows with prompt_number IS NULL unclaimed", () => {
    insertObs(null);
    insertObs(5);
    // NULL prompt row is a FIFO boundary — batch for pn=5 should not claim anything
    // because the NULL row comes first and acts as a boundary
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(0);
  });

  test("FIFO boundary: does not skip over interleaved summarize", () => {
    // obs(id=1,pn=5) → summarize(id=2) → obs(id=3,pn=5)
    insertObs(5);
    insertSummarize();
    insertObs(5);
    // First obs is claimable, but id=3 is beyond summarize boundary
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(1);
    expect(batch[0].id).toBe(1);
  });

  test("FIFO boundary: claims contiguous tail before a summarize", () => {
    // obs(id=1,pn=5) → obs(id=2,pn=5) → summarize(id=3) → obs(id=4,pn=5)
    insertObs(5);
    insertObs(5);
    insertSummarize();
    insertObs(5);
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(2);
    expect(batch[0].id).toBe(1);
    expect(batch[1].id).toBe(2);
  });

  test("FIFO boundary: does not skip over NULL prompt_number row", () => {
    // obs(id=1,pn=5) → obs(id=2,pn=NULL) → obs(id=3,pn=5)
    insertObs(5);
    insertObs(null);
    insertObs(5);
    const batch = store.claimNextObservationBatch(1, 5, 10);
    // id=2 (NULL pn) is a FIFO boundary — only id=1 is claimable
    expect(batch.length).toBe(1);
    expect(batch[0].id).toBe(1);
  });

  test("FIFO boundary: does not skip over processing summarize", () => {
    // obs(id=1,pn=5) → summarize(id=2,status=processing) → obs(id=3,pn=5)
    insertObs(5);
    insertSummarize();
    insertObs(5);
    // Mark summarize as processing (being handled by main channel)
    db.exec("UPDATE pending_messages SET status = 'processing' WHERE id = 2");
    const batch = store.claimNextObservationBatch(1, 5, 10);
    // Should still respect the processing summarize as a boundary
    expect(batch.length).toBe(1);
    expect(batch[0].id).toBe(1);
  });

  test("returns empty array when no matching rows", () => {
    insertObs(6);
    const batch = store.claimNextObservationBatch(1, 5, 10);
    expect(batch.length).toBe(0);
  });

  test("marks claimed rows as processing", () => {
    insertObs(5);
    insertObs(5);
    store.claimNextObservationBatch(1, 5, 10);
    const remaining = store.getAllPending(1);
    expect(remaining.length).toBe(0); // no more pending
    const all = db
      .prepare("SELECT * FROM pending_messages WHERE status = 'processing'")
      .all() as any[];
    expect(all.length).toBe(2);
  });
});
