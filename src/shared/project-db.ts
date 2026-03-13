/**
 * DbConnectionPool: Per-project SQLite connection management
 *
 * Manages a pool of SessionStore + SessionSearch instances keyed by dbPath.
 * Ensures each project gets its own physical SQLite file while sharing
 * the single Worker process.
 */

import { join, dirname, basename, resolve } from 'path';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { SessionSearch } from '../services/sqlite/SessionSearch.js';
import { ensureDir } from './paths.js';
import { logger } from '../utils/logger.js';

interface PoolEntry {
  store: SessionStore;
  search: SessionSearch;
  activeOps: number;
}

export class DbConnectionPool {
  private connections = new Map<string, PoolEntry>();
  private lastActiveDbPath: string | null = null;
  private readonly maxConnections: number;

  constructor(maxConnections = 10) {
    this.maxConnections = maxConnections;
  }

  /**
   * Get or create a SessionStore for the given dbPath.
   * Synchronous -- SessionStore constructor is sync.
   */
  getStore(dbPath: string): SessionStore {
    return this.getOrCreate(dbPath).store;
  }

  /**
   * Get or create a SessionSearch for the given dbPath.
   */
  getSearch(dbPath: string): SessionSearch {
    return this.getOrCreate(dbPath).search;
  }

  getLastActiveDbPath(): string | null {
    return this.lastActiveDbPath;
  }

  /**
   * Get the last active store (for Viewer UI fallback).
   */
  getLastActiveStore(): SessionStore | null {
    if (!this.lastActiveDbPath) return null;
    return this.connections.get(this.lastActiveDbPath)?.store ?? null;
  }

  getLastActiveSearch(): SessionSearch | null {
    if (!this.lastActiveDbPath) return null;
    return this.connections.get(this.lastActiveDbPath)?.search ?? null;
  }

  connectionCount(): number {
    return this.connections.size;
  }

  acquireRef(dbPath: string): void {
    const normalizedPath = resolve(dbPath);
    const entry = this.connections.get(normalizedPath);
    if (entry) {
      entry.activeOps++;
    }
  }

  releaseRef(dbPath: string): void {
    const normalizedPath = resolve(dbPath);
    const entry = this.connections.get(normalizedPath);
    if (entry && entry.activeOps > 0) {
      entry.activeOps--;
    }
  }

  closeAll(): void {
    for (const [dbPath, entry] of this.connections) {
      try {
        entry.store.close();
      } catch (e) {
        logger.debug('POOL', `Error closing store for ${dbPath}`, {}, e as Error);
      }
      try {
        entry.search.close();
      } catch (e) {
        logger.debug('POOL', `Error closing search for ${dbPath}`, {}, e as Error);
      }
    }
    this.connections.clear();
    this.lastActiveDbPath = null;
  }

  private getOrCreate(dbPath: string): PoolEntry {
    const normalizedPath = resolve(dbPath);
    const existing = this.connections.get(normalizedPath);
    if (existing) {
      this.lastActiveDbPath = normalizedPath;
      return existing;
    }

    // Evict oldest idle connection if at capacity
    if (this.connections.size >= this.maxConnections) {
      // Find oldest idle connection (activeOps === 0)
      let evictKey: string | null = null;
      for (const [key, entry] of this.connections) {
        if (entry.activeOps === 0) {
          evictKey = key;
          break; // Map iteration order = insertion order = oldest first
        }
      }

      if (!evictKey) {
        throw new Error(
          `Connection pool full (${this.maxConnections}): all connections are active. ` +
          `Cannot open new connection for ${normalizedPath}`
        );
      }

      const oldEntry = this.connections.get(evictKey)!;
      try {
        oldEntry.store.close();
      } catch (e) {
        logger.debug('POOL', `Error closing store during eviction for ${evictKey}`, {}, e as Error);
      }
      try {
        oldEntry.search.close();
      } catch (e) {
        logger.debug('POOL', `Error closing search during eviction for ${evictKey}`, {}, e as Error);
      }
      this.connections.delete(evictKey);
      if (evictKey === this.lastActiveDbPath) {
        this.lastActiveDbPath = null;
      }
      logger.debug('POOL', 'Evicted idle connection', { evicted: evictKey });
    }

    // Create directory and .gitignore on first open
    ensureDir(dirname(normalizedPath));
    // Only manage .gitignore when path follows <repo>/.claude/mem.db convention
    // (skip for env override paths like /custom/path/mem.db)
    if (basename(dirname(normalizedPath)) === '.claude') {
      const repoRoot = dirname(dirname(normalizedPath));
      ensureGitignore(repoRoot);
    }

    const entry: PoolEntry = {
      store: new SessionStore(normalizedPath),
      search: new SessionSearch(normalizedPath),
      activeOps: 0,
    };
    this.connections.set(normalizedPath, entry);
    this.lastActiveDbPath = normalizedPath;

    logger.info('POOL', 'Opened project DB', { dbPath: normalizedPath });
    return entry;
  }
}

/**
 * Ensure .claude/mem.db* is in the repo's .gitignore (covers WAL/SHM files).
 */
export function ensureGitignore(repoRoot: string): void {
  const gitignorePath = join(repoRoot, '.gitignore');
  const entry = '.claude/mem.db*';

  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf8');
      const lines = content.split('\n').map(l => l.trim());
      if (!lines.some(line => line === entry)) {
        appendFileSync(gitignorePath, `\n# claude-mem project memory\n${entry}\n`);
      }
    } else {
      writeFileSync(gitignorePath, `# claude-mem project memory\n${entry}\n`);
    }
  } catch (e) {
    // Non-fatal: .gitignore update failure should not block DB operations
    logger.debug('POOL', 'Failed to update .gitignore', {}, e as Error);
  }
}
