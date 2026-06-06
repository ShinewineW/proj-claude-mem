import { Database } from 'bun:sqlite';
import { execFileSync, execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { MigrationRunner } from './migrations/runner.js';

// SQLite configuration constants
const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024; // 256MB
const SQLITE_CACHE_SIZE_PAGES = 10_000;

/**
 * Check if Python 3 is available on the system.
 * Caches the result to avoid repeated shell lookups.
 */
let _python3Path: string | null | undefined = undefined;

export function hasPython3(): string | null {
  if (_python3Path !== undefined) return _python3Path;

  const candidates = ['/opt/homebrew/bin/python3', '/usr/bin/python3', '/usr/local/bin/python3'];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
      _python3Path = candidate;
      return _python3Path;
    } catch {
      // Try next candidate
    }
  }

  // Fallback: try PATH
  try {
    const which = process.platform === 'win32' ? 'where python3' : 'which python3';
    const result = execSync(which, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (result) {
      _python3Path = result.split('\n')[0].trim();
      return _python3Path;
    }
  } catch {
    // Not found
  }

  _python3Path = null;
  return null;
}

/**
 * Attempt to repair a malformed database schema by removing orphaned objects.
 *
 * When databases are synced between machines running different versions (e.g., via OneDrive),
 * newer schema objects may reference columns/tables that don't exist in the older version.
 * SQLite throws "malformed database schema (<object_name>)" on ALL queries.
 *
 * Uses Python3's sqlite3 module with writable_schema pragma to safely remove the orphaned
 * object, then resets schema_versions to trigger idempotent re-migration.
 *
 * @returns true if repair was attempted, false if no repair needed or Python unavailable
 */
export function repairMalformedSchema(dbPath: string, errorMessage: string): boolean {
  // Extract orphaned object name from error like: "malformed database schema (idx_foo)"
  const match = errorMessage.match(/malformed database schema \((\w+)\)/);
  if (!match) {
    logger.warn('DB', 'Cannot extract object name from malformed schema error', { errorMessage });
    return false;
  }

  const objectName = match[1];
  const python3 = hasPython3();
  if (!python3) {
    logger.error('DB', 'Python3 not available — cannot auto-repair malformed schema', {
      dbPath,
      objectName,
      hint: 'Install Python 3 or manually run: PRAGMA writable_schema=ON; DELETE FROM sqlite_master WHERE name=\'' + objectName + '\'; PRAGMA writable_schema=OFF;'
    });
    return false;
  }

  logger.warn('DB', `Attempting auto-repair of malformed schema object: ${objectName}`, { dbPath, objectName });

  const scriptPath = join(tmpdir(), `claude-mem-repair-${Date.now()}.py`);
  const script = `
import sqlite3, sys
db_path = sys.argv[1]
obj_name = sys.argv[2]
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("PRAGMA writable_schema = ON")
cur.execute("DELETE FROM sqlite_master WHERE name = ?", (obj_name,))
cur.execute("PRAGMA writable_schema = OFF")
# Reset schema versions to trigger re-migration
try:
    cur.execute("DELETE FROM schema_versions")
except:
    pass  # Table may not exist yet
conn.commit()
# VACUUM to reclaim orphaned pages left after schema object removal
cur.execute("VACUUM")
# Verify integrity
result = cur.execute("PRAGMA integrity_check").fetchone()
conn.close()
if result[0] != "ok":
    print(f"WARNING: integrity check after repair: {result[0]}", file=sys.stderr)
    sys.exit(1)
print(f"Repaired: removed {obj_name} from sqlite_master, reset schema_versions")
`;

  try {
    writeFileSync(scriptPath, script);
    const output = execFileSync(python3, [scriptPath, dbPath, objectName], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    logger.info('DB', `Schema repair succeeded: ${output.trim()}`, { dbPath, objectName });
    return true;
  } catch (error) {
    logger.error('DB', 'Schema repair failed', { dbPath, objectName }, error as Error);
    return false;
  } finally {
    try { unlinkSync(scriptPath); } catch { /* cleanup best-effort */ }
  }
}

/**
 * Probe that the on-disk schema is readable.
 *
 * A malformed `sqlite_master` (orphaned index, dropped column, corrupt CREATE
 * SQL) makes the very first statement throw — even a PRAGMA. Running a SELECT
 * against sqlite_master up front guarantees a malformed schema is detected
 * deterministically, so the constructor's existing repair path
 * (repairMalformedSchema) is reached even when the first real statement would
 * have been a PRAGMA. Throws the native "malformed database schema (...)"
 * error, which the caller pattern-matches.
 *
 * @internal Exported only so the schema-probe test can import it. Not part of
 *   the public Database.ts API surface (the only public export is the
 *   `ClaudeMemDatabase` class) — do NOT depend on this from production code.
 */
export function assertSchemaReadable(db: Database): void {
  db.query('SELECT count(*) FROM sqlite_master').get();
}

/**
 * ClaudeMemDatabase - New entry point for the sqlite module
 *
 * Replaces SessionStore as the database coordinator.
 * Sets up bun:sqlite with optimized settings and runs all migrations.
 *
 * Usage:
 *   const db = new ClaudeMemDatabase();  // uses default DB_PATH
 *   const db = new ClaudeMemDatabase('/path/to/db.sqlite');
 *   const db = new ClaudeMemDatabase(':memory:');  // for tests
 */
export class ClaudeMemDatabase {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    // Ensure data directory exists (skip for in-memory databases)
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    try {
      this.db = this.openAndConfigure(dbPath);

      // Run all migrations
      const migrationRunner = new MigrationRunner(this.db);
      migrationRunner.runAllMigrations();
    } catch (error) {
      const errorMessage = (error as Error).message || '';
      if (errorMessage.includes('malformed database schema') && dbPath !== ':memory:') {
        // Close the broken connection before repair to release file locks
        try { this.db.close(); } catch { /* already broken */ }
        logger.warn('DB', 'Detected malformed schema, attempting repair', { dbPath });
        const repaired = repairMalformedSchema(dbPath, errorMessage);
        if (repaired) {
          this.db = this.openAndConfigure(dbPath);
          const migrationRunner = new MigrationRunner(this.db);
          migrationRunner.runAllMigrations();
        } else {
          throw error;
        }
      } else {
        // Close the connection that was opened before the error
        try { this.db.close(); } catch { /* best effort */ }
        throw error;
      }
    }
  }

  /**
   * Open database and apply optimized PRAGMA settings.
   * Extracted to avoid duplication between normal and post-repair paths.
   */
  private openAndConfigure(dbPath: string): Database {
    const db = new Database(dbPath, { create: true, readwrite: true });
    // Probe schema readability BEFORE any PRAGMA: a malformed sqlite_master
    // makes even a PRAGMA throw, so this guarantees the constructor's repair
    // path is reached for malformed on-disk schemas. Upstream #2433 groundwork.
    assertSchemaReadable(db);
    // busy_timeout first: wait for contended locks rather than failing fast
    // with SQLITE_BUSY — see SessionStore constructor for the rationale.
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA temp_store = memory');
    db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);
    return db;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// Re-export bun:sqlite Database type
export { Database };

// Re-export MigrationRunner for external use
export { MigrationRunner } from './migrations/runner.js';

// Re-export all module functions for convenient imports
export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';