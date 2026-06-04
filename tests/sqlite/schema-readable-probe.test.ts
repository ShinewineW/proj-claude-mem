/**
 * Schema-readability probe (assertSchemaReadable) regression.
 * A malformed sqlite_master makes even the first PRAGMA throw, so the probe
 * must run a SELECT against sqlite_master BEFORE any PRAGMA to detect it.
 *
 * bun:sqlite refuses INSERT INTO sqlite_master (even with writable_schema=ON),
 * so we corrupt the schema by patching the on-disk CREATE-TABLE SQL bytes with
 * a same-length malformed variant — this surfaces as "malformed database
 * schema (...)" the moment sqlite_master is parsed.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, readFileSync, writeFileSync } from 'fs';
import { assertSchemaReadable } from '../../src/services/sqlite/Database.js';

describe('assertSchemaReadable', () => {
  let dbPath: string;

  afterEach(() => {
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + '-wal', { force: true });
      rmSync(dbPath + '-shm', { force: true });
    }
  });

  it('does not throw on a healthy database', () => {
    dbPath = join(tmpdir(), `schema-probe-ok-${Date.now()}.db`);
    const db = new Database(dbPath, { create: true, readwrite: true });
    db.run('CREATE TABLE t (id INTEGER)');
    expect(() => assertSchemaReadable(db)).not.toThrow();
    db.close();
  });

  it('throws a malformed-schema error when sqlite_master SQL is corrupt', () => {
    dbPath = join(tmpdir(), `schema-probe-bad-${Date.now()}.db`);
    const setup = new Database(dbPath, { create: true, readwrite: true });
    // Distinct table name so we can locate its CREATE SQL in the raw file.
    setup.run('CREATE TABLE marker_table_aaaa (id INTEGER)');
    setup.close();

    // Patch the on-disk CREATE-TABLE SQL with a SAME-LENGTH malformed variant
    // so page offsets stay valid but sqlite_master fails to parse.
    const buf = readFileSync(dbPath);
    const orig = Buffer.from('CREATE TABLE marker_table_aaaa (id INTEGER)');
    const bad = Buffer.from('CREATE TABLE marker_table_aaaa (id INTEGERX');
    const idx = buf.indexOf(orig);
    expect(idx).toBeGreaterThan(-1);
    expect(bad.length).toBe(orig.length);
    bad.copy(buf, idx);
    writeFileSync(dbPath, buf);

    const db = new Database(dbPath, { create: true, readwrite: true });
    expect(() => assertSchemaReadable(db)).toThrow(/malformed database schema/);
    db.close();
  });
});
