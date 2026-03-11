import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';

describe('DbConnectionPool eviction error handling', () => {
  let DbConnectionPool: typeof import('../../src/shared/project-db').DbConnectionPool;
  let pool: InstanceType<typeof DbConnectionPool>;
  const tmpDir = `/tmp/pool-evict-error-${Date.now()}`;

  beforeEach(async () => {
    const mod = await import('../../src/shared/project-db');
    DbConnectionPool = mod.DbConnectionPool;
    pool = new DbConnectionPool(2);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    pool?.closeAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('eviction completes even if store.close() throws', () => {
    const path1 = `${tmpDir}/p1/mem.db`;
    const path2 = `${tmpDir}/p2/mem.db`;
    const path3 = `${tmpDir}/p3/mem.db`;

    mkdirSync(`${tmpDir}/p1`, { recursive: true });
    mkdirSync(`${tmpDir}/p2`, { recursive: true });
    mkdirSync(`${tmpDir}/p3`, { recursive: true });

    pool.getStore(path1);
    pool.getStore(path2);

    // Sabotage oldest entry's store.close() to throw
    const entry = (pool as any).connections.get(require('path').resolve(path1));
    entry.store.close = () => { throw new Error('Simulated close failure'); };

    // Should NOT throw — eviction should handle the error
    pool.getStore(path3);

    expect(pool.getStore(path3)).toBeDefined();
    expect((pool as any).connections.has(require('path').resolve(path1))).toBe(false);
    expect((pool as any).connections.size).toBe(2);
  });

  test('eviction calls search.close() even if store.close() throws', () => {
    const path1 = `${tmpDir}/q1/mem.db`;
    const path2 = `${tmpDir}/q2/mem.db`;
    const path3 = `${tmpDir}/q3/mem.db`;

    mkdirSync(`${tmpDir}/q1`, { recursive: true });
    mkdirSync(`${tmpDir}/q2`, { recursive: true });
    mkdirSync(`${tmpDir}/q3`, { recursive: true });

    pool.getStore(path1);
    pool.getStore(path2);

    const entry = (pool as any).connections.get(require('path').resolve(path1));
    let searchCloseCalled = false;
    const origSearchClose = entry.search.close.bind(entry.search);
    entry.store.close = () => { throw new Error('Simulated close failure'); };
    entry.search.close = () => { searchCloseCalled = true; origSearchClose(); };

    pool.getStore(path3);
    expect(searchCloseCalled).toBe(true);
  });
});
