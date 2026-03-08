/**
 * DbConnectionPool: Per-project SQLite connection management
 *
 * Manages a pool of SessionStore + SessionSearch instances keyed by dbPath.
 * Ensures each project gets its own physical SQLite file while sharing
 * the single Worker process.
 */

import { join, dirname, resolve } from 'path';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { SessionSearch } from '../services/sqlite/SessionSearch.js';
import { ensureDir } from './paths.js';
import { logger } from '../utils/logger.js';

interface PoolEntry {
  store: SessionStore;
  search: SessionSearch;
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

  closeAll(): void {
    for (const [dbPath, entry] of this.connections) {
      try {
        entry.store.close();
        entry.search.close();
      } catch (e) {
        logger.debug('POOL', `Error closing connection for ${dbPath}`, {}, e as Error);
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

    // Evict oldest if at capacity
    if (this.connections.size >= this.maxConnections) {
      const oldest = this.connections.keys().next().value!;
      const oldEntry = this.connections.get(oldest)!;
      oldEntry.store.close();
      oldEntry.search.close();
      this.connections.delete(oldest);
      if (oldest === this.lastActiveDbPath) {
        this.lastActiveDbPath = null;
      }
      logger.debug('POOL', 'Evicted connection', { evicted: oldest });
    }

    // Create directory and .gitignore on first open
    ensureDir(dirname(normalizedPath));
    const repoRoot = dirname(dirname(normalizedPath)); // dbPath = <repo>/.claude/mem.db
    ensureGitignore(repoRoot);

    const entry: PoolEntry = {
      store: new SessionStore(normalizedPath),
      search: new SessionSearch(normalizedPath),
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
    }
  } catch (e) {
    // Non-fatal: .gitignore update failure should not block DB operations
    logger.debug('POOL', 'Failed to update .gitignore', {}, e as Error);
  }
}
