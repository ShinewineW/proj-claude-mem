import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MigrationRunner } from "../../src/services/sqlite/migrations/runner.js";
import { SessionStore } from "../../src/services/sqlite/SessionStore.js";

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

describe("migration 25: retention_metadata table", () => {
  it("creates retention_metadata table", () => {
    const db = new Database(":memory:");
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='retention_metadata'"
    ).all() as any[];
    expect(tables).toHaveLength(1);

    const columns = db.query("PRAGMA table_info(retention_metadata)").all() as any[];
    const projectCol = columns.find((c: any) => c.name === "project");
    const epochCol = columns.find((c: any) => c.name === "last_cleanup_epoch");
    expect(projectCol).toBeDefined();
    expect(epochCol).toBeDefined();
    db.close();
  });

  it("migrates existing schema_versions sentinel data", () => {
    const db = new Database(":memory:");

    // Set up schema_versions table manually (before migrations)
    db.run("CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE NOT NULL, applied_at TEXT NOT NULL)");

    // Insert the old sentinel row
    const timestamps = { "proj-a": 1000000, "proj-b": 2000000 };
    db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (9999, ?)").run(JSON.stringify(timestamps));

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Sentinel row should be removed
    const sentinel = db.query("SELECT * FROM schema_versions WHERE version = 9999").all();
    expect(sentinel).toHaveLength(0);

    // Data should be migrated to retention_metadata
    const rows = db.query("SELECT * FROM retention_metadata ORDER BY project").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].project).toBe("proj-a");
    expect(rows[0].last_cleanup_epoch).toBe(1000000);
    expect(rows[1].project).toBe("proj-b");
    expect(rows[1].last_cleanup_epoch).toBe(2000000);
    db.close();
  });

  it("is idempotent — running twice does not error", () => {
    const db = new Database(":memory:");
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    runner.runAllMigrations();

    const versions = db.query("SELECT version FROM schema_versions WHERE version = 25").all();
    expect(versions).toHaveLength(1);
    db.close();
  });

  it("SessionStore also creates retention_metadata table", () => {
    const store = new SessionStore(":memory:");

    const tables = store.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='retention_metadata'"
    ).all() as any[];
    expect(tables).toHaveLength(1);

    const columns = store.db.query("PRAGMA table_info(retention_metadata)").all() as any[];
    const projectCol = columns.find((c: any) => c.name === "project");
    const epochCol = columns.find((c: any) => c.name === "last_cleanup_epoch");
    expect(projectCol).toBeDefined();
    expect(epochCol).toBeDefined();
    store.db.close();
  });
});
