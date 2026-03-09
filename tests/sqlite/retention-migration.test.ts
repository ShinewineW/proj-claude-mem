import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MigrationRunner } from "../../src/services/sqlite/migrations/runner.js";

describe("migration 24: access_count column", () => {
  it("adds access_count column to observations table", () => {
    const db = new Database(":memory:");
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const columns = db.query("PRAGMA table_info(observations)").all() as any[];
    const col = columns.find((c: any) => c.name === "access_count");

    expect(col).toBeDefined();
    expect(col.dflt_value).toBe("0");
    db.close();
  });

  it("is idempotent — running twice does not error", () => {
    const db = new Database(":memory:");
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    runner.runAllMigrations(); // second run

    const versions = db.query("SELECT version FROM schema_versions WHERE version = 24").all();
    expect(versions).toHaveLength(1);
    db.close();
  });
});
