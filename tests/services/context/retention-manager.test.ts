import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RetentionManager } from "../../../src/services/context/RetentionManager.js";
import type { RetentionConfig } from "../../../src/services/context/RetentionManager.js";

const DEFAULT_CONFIG: RetentionConfig = {
  enabled: true,
  retentionDays: 30,
  scoreThreshold: 0.3,
  maxKept: 500,
};

function setupTestDb(): Database {
  const db = new Database(":memory:");

  // Minimal schema for testing
  db.run(`CREATE TABLE IF NOT EXISTS schema_versions (
    id INTEGER PRIMARY KEY, version INTEGER UNIQUE, applied_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sdk_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE,
    memory_session_id TEXT,
    project TEXT,
    created_at TEXT,
    created_at_epoch INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT,
    project TEXT,
    type TEXT,
    title TEXT,
    narrative TEXT,
    concepts TEXT,
    created_at TEXT,
    created_at_epoch INTEGER,
    access_count INTEGER DEFAULT 0,
    FOREIGN KEY (memory_session_id) REFERENCES sdk_sessions(memory_session_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT,
    prompt_number INTEGER,
    prompt_text TEXT,
    created_at TEXT,
    created_at_epoch INTEGER,
    FOREIGN KEY (content_session_id) REFERENCES sdk_sessions(content_session_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT,
    project TEXT,
    request TEXT,
    created_at TEXT,
    created_at_epoch INTEGER,
    FOREIGN KEY (memory_session_id) REFERENCES sdk_sessions(memory_session_id)
  )`);

  return db;
}

function insertSession(db: Database, id: string, project: string): void {
  db.run(
    "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?)",
    [id, id, project, new Date().toISOString(), Date.now()]
  );
}

function insertObservation(
  db: Database,
  sessionId: string,
  project: string,
  type: string,
  ageDays: number,
  accessCount: number = 0
): number {
  const epoch = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, narrative, concepts, created_at, created_at_epoch, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(sessionId, project, type, `obs-${type}-${ageDays}d`, "text", '["how-it-works"]', new Date(epoch).toISOString(), epoch, accessCount);
  return (db.query("SELECT last_insert_rowid() as id").get() as any).id as number;
}

function insertPrompt(db: Database, sessionId: string, text: string): void {
  db.run(
    "INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch) VALUES (?, 1, ?, ?, ?)",
    [sessionId, text, new Date().toISOString(), Date.now()]
  );
}

function insertSummary(db: Database, sessionId: string, project: string): void {
  db.run(
    "INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch) VALUES (?, ?, 'summary', ?, ?)",
    [sessionId, project, new Date().toISOString(), Date.now()]
  );
}

describe("RetentionManager", () => {
  let db: Database;

  beforeEach(() => {
    db = setupTestDb();
  });

  describe("computeScore", () => {
    it("returns correct score for a recent decision with no access", () => {
      const score = RetentionManager.computeScore("decision", 35, 0);
      // 0.25*1.0 + 0.50*max(0, 1-(35-30)/150) + 0.25*0.0
      // = 0.25 + 0.50*0.9667 + 0 = 0.7333
      expect(score).toBeCloseTo(0.733, 2);
    });

    it("returns correct score for an old change with no access", () => {
      const score = RetentionManager.computeScore("change", 150, 0);
      // 0.25*0.4 + 0.50*max(0, 1-(150-30)/150) + 0.25*0.0
      // = 0.10 + 0.50*0.2 + 0 = 0.20
      expect(score).toBeCloseTo(0.20, 2);
    });

    it("access_count extends lifespan", () => {
      const withoutAccess = RetentionManager.computeScore("change", 150, 0);
      const withAccess = RetentionManager.computeScore("change", 150, 5);
      expect(withAccess).toBeGreaterThan(withoutAccess);
      expect(withAccess).toBeGreaterThan(0.3); // should survive
      expect(withoutAccess).toBeLessThan(0.3); // should be deleted
    });
  });

  describe("cleanup", () => {
    it("does nothing when disabled", () => {
      insertSession(db, "s1", "proj");
      insertObservation(db, "s1", "proj", "change", 200);

      const result = RetentionManager.cleanup(db, "proj", { ...DEFAULT_CONFIG, enabled: false });

      expect(result.deleted).toBe(0);
      const count = (db.query("SELECT COUNT(*) as c FROM observations").get() as any).c as number;
      expect(count).toBe(1);
    });

    it("does not delete observations within grace period", () => {
      insertSession(db, "s1", "proj");
      insertObservation(db, "s1", "proj", "change", 10); // 10 days old
      insertObservation(db, "s1", "proj", "change", 25); // 25 days old

      const result = RetentionManager.cleanup(db, "proj", DEFAULT_CONFIG);

      expect(result.deleted).toBe(0);
    });

    it("deletes low-score observations beyond grace period", () => {
      insertSession(db, "s1", "proj");
      insertObservation(db, "s1", "proj", "change", 150, 0); // score ~0.20, DELETE
      insertObservation(db, "s1", "proj", "decision", 35, 0); // score ~0.73, KEEP

      const result = RetentionManager.cleanup(db, "proj", DEFAULT_CONFIG);

      expect(result.deleted).toBe(1);
      expect(result.kept).toBe(1);
      const remaining = db.query("SELECT type FROM observations").all() as any[];
      expect(remaining[0].type).toBe("decision");
    });

    it("enforces hard cap on kept observations", () => {
      insertSession(db, "s1", "proj");
      // Insert 10 observations at 35 days (all high-score decisions)
      for (let i = 0; i < 10; i++) {
        insertObservation(db, "s1", "proj", "decision", 35 + i, 0);
      }

      const result = RetentionManager.cleanup(db, "proj", { ...DEFAULT_CONFIG, maxKept: 5 });

      // Should keep top 5 by score, delete 5
      expect(result.deleted).toBe(5);
      const count = (db.query("SELECT COUNT(*) as c FROM observations").get() as any).c as number;
      expect(count).toBe(5);
    });

    it("deletes orphaned prompts but preserves summaries", () => {
      insertSession(db, "s1", "proj");
      insertObservation(db, "s1", "proj", "change", 200, 0); // will be deleted
      insertPrompt(db, "s1", "hello");
      insertSummary(db, "s1", "proj");

      RetentionManager.cleanup(db, "proj", DEFAULT_CONFIG);

      const obsCount = (db.query("SELECT COUNT(*) as c FROM observations").get() as any).c as number;
      const promptCount = (db.query("SELECT COUNT(*) as c FROM user_prompts").get() as any).c as number;
      const summaryCount = (db.query("SELECT COUNT(*) as c FROM session_summaries").get() as any).c as number;

      expect(obsCount).toBe(0);
      expect(promptCount).toBe(0); // orphaned prompts deleted
      expect(summaryCount).toBe(1); // summary preserved
    });

    it("does not delete prompts when session still has other observations", () => {
      insertSession(db, "s1", "proj");
      insertObservation(db, "s1", "proj", "change", 200, 0);  // will be deleted
      insertObservation(db, "s1", "proj", "decision", 35, 0); // will be kept
      insertPrompt(db, "s1", "hello");

      RetentionManager.cleanup(db, "proj", DEFAULT_CONFIG);

      const promptCount = (db.query("SELECT COUNT(*) as c FROM user_prompts").get() as any).c as number;
      expect(promptCount).toBe(1); // prompts kept because session still has observations
    });

    it("only affects specified project", () => {
      insertSession(db, "s1", "proj-a");
      insertSession(db, "s2", "proj-b");
      insertObservation(db, "s1", "proj-a", "change", 200, 0);
      insertObservation(db, "s2", "proj-b", "change", 200, 0);

      RetentionManager.cleanup(db, "proj-a", DEFAULT_CONFIG);

      const countA = (db.query("SELECT COUNT(*) as c FROM observations WHERE project = 'proj-a'").get() as any).c as number;
      const countB = (db.query("SELECT COUNT(*) as c FROM observations WHERE project = 'proj-b'").get() as any).c as number;
      expect(countA).toBe(0); // deleted
      expect(countB).toBe(1); // untouched
    });
  });
});
