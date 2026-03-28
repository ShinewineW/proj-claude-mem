import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { PendingMessageStore } from "../../src/services/sqlite/PendingMessageStore.js";

describe("JSON serialization pipeline", () => {
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

  test("enqueue stores string tool_input without double-encoding", () => {
    const toolInputStr = '{"file_path":"/foo.ts"}';
    const toolResponseStr = '"File contents here"';

    store.enqueue(1, "test-session", {
      type: "observation",
      tool_name: "Read",
      tool_input: toolInputStr,
      tool_response: toolResponseStr,
      cwd: "/project",
    });

    const row = db
      .prepare(
        "SELECT tool_input, tool_response FROM pending_messages WHERE id = 1",
      )
      .get() as any;
    expect(row.tool_input).toBe(toolInputStr);
    expect(row.tool_response).toBe(toolResponseStr);
  });

  test("enqueue handles object tool_input (non-hook callers)", () => {
    const toolInputObj = { file_path: "/foo.ts" };
    // Non-string tool_response gets JSON.stringify'd; string passes through as-is
    const toolResponseStr = '"some output"'; // JSON string (from cleanToolField)

    store.enqueue(1, "test-session", {
      type: "observation",
      tool_name: "Read",
      tool_input: toolInputObj,
      tool_response: toolResponseStr,
      cwd: "/project",
    });

    const row = db
      .prepare(
        "SELECT tool_input, tool_response FROM pending_messages WHERE id = 1",
      )
      .get() as any;
    expect(row.tool_input).toBe('{"file_path":"/foo.ts"}');
    expect(row.tool_response).toBe('"some output"');
  });

  test("toPendingMessage returns string tool_input without parsing", () => {
    const toolInputStr = '{"file_path":"/foo.ts"}';
    store.enqueue(1, "test-session", {
      type: "observation",
      tool_name: "Read",
      tool_input: toolInputStr,
      tool_response: '"output"',
      cwd: "/project",
    });

    const claimed = store.claimNextMessage(1);
    expect(claimed).not.toBeNull();

    const pending = store.toPendingMessage(claimed!);
    expect(typeof pending.tool_input).toBe("string");
    expect(pending.tool_input).toBe(toolInputStr);
  });

  test("full round-trip: enqueue string -> claim -> fields are usable JSON strings", () => {
    const originalInput = {
      file_path: "/project/src/index.ts",
      old_string: "foo",
      new_string: "bar",
    };
    const cleanedInput = JSON.stringify(originalInput);
    const cleanedResponse = JSON.stringify(
      "The file was updated successfully.",
    );

    store.enqueue(1, "test-session", {
      type: "observation",
      tool_name: "Edit",
      tool_input: cleanedInput,
      tool_response: cleanedResponse,
      cwd: "/project",
    });

    const claimed = store.claimNextMessage(1);
    expect(claimed).not.toBeNull();

    const pending = store.toPendingMessage(claimed!);
    const parsedInput = JSON.parse(pending.tool_input as string);
    expect(parsedInput.file_path).toBe("/project/src/index.ts");

    const parsedResponse = JSON.parse(pending.tool_response as string);
    expect(parsedResponse).toBe("The file was updated successfully.");
  });
});
