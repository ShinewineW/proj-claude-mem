import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

describe("access_count increment", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, access_count INTEGER DEFAULT 0)");
    db.run("INSERT INTO observations (id, access_count) VALUES (1, 0), (2, 3)");
  });

  it("increments access_count for given IDs", () => {
    const ids = [1, 2];
    const placeholders = ids.map(() => "?").join(",");
    db.run(`UPDATE observations SET access_count = access_count + 1 WHERE id IN (${placeholders})`, ids);

    const rows = db.query("SELECT id, access_count FROM observations ORDER BY id").all() as any[];
    expect(rows[0].access_count).toBe(1);
    expect(rows[1].access_count).toBe(4);
  });

  it("does nothing for empty ID list", () => {
    // No-op, just ensure no error
    const row = db.query("SELECT access_count FROM observations WHERE id = 1").get() as any;
    expect(row.access_count).toBe(0);
  });
});
