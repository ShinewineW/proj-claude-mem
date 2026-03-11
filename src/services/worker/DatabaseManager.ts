/**
 * DatabaseManager: Pool-backed database connection manager
 *
 * Responsibility:
 * - Delegate to DbConnectionPool for per-project SQLite connections
 * - Provide centralized access to SessionStore and SessionSearch
 * - ChromaSync integration
 *
 * All getter methods accept an optional dbPath parameter:
 * - With dbPath: returns connection for that specific project DB
 * - Without dbPath: falls back to defaultDbPath or last-active connection
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { getCollectionName } from '../../shared/chroma-utils.js';
import { DbConnectionPool } from '../../shared/project-db.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

/**
 * Validate dbPath from HTTP requests to prevent path traversal attacks.
 *
 * Rules:
 * - undefined is allowed (triggers fallback chain)
 * - Must be an absolute path (starts with /)
 * - Must not contain '..' (path traversal)
 * - Must end with 'mem.db' (standard database filename)
 *
 * Raises:
 *   Error: If dbPath violates any validation rule.
 */
export function validateDbPath(dbPath: string | undefined | null): void {
  if (dbPath === undefined || dbPath === null) return;

  if (dbPath === '' || !dbPath.startsWith('/')) {
    throw new Error(`Invalid dbPath: must be an absolute path, got "${dbPath}"`);
  }

  if (dbPath.includes('..')) {
    throw new Error(`Invalid dbPath: path traversal (..) is not allowed, got "${dbPath}"`);
  }

  if (!dbPath.endsWith('mem.db')) {
    throw new Error(`Invalid dbPath: must end with mem.db, got "${dbPath}"`);
  }
}

export class DatabaseManager {
  // No eviction needed: bounded by enabled projects count (typically <10),
  // unlike DbConnectionPool which handles arbitrary file paths.
  private chromaSyncMap: Map<string, ChromaSync> = new Map();
  private chromaEnabled: boolean = false;
  private pool: DbConnectionPool;
  private defaultDbPath: string | null = null;

  constructor(pool?: DbConnectionPool) {
    this.pool = pool || new DbConnectionPool();
  }

  /**
   * Initialize database manager (Chroma + default DB connection).
   *
   * DB connections are lazy via pool, but we eagerly open the default
   * connection so that callers without a dbPath always have a fallback.
   *
   * Args:
   *   defaultDbPath: Path to the global/default database file.
   */
  async initialize(defaultDbPath?: string): Promise<void> {
    if (defaultDbPath) {
      this.defaultDbPath = defaultDbPath;
      // Eagerly open default connection so no-arg getters work immediately
      this.pool.getStore(defaultDbPath);
    }

    // Initialize Chroma enabled flag (lazy per-project ChromaSync creation in getChromaSync)
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    this.chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (!this.chromaEnabled) {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    logger.info('DB', 'Database initialized');
  }

  /**
   * Close all database connections and cleanup resources.
   */
  async close(): Promise<void> {
    // Close all ChromaSync instances (MCP connection lifecycle managed by ChromaMcpManager)
    for (const [, sync] of this.chromaSyncMap) {
      await sync.close();
    }
    this.chromaSyncMap.clear();

    this.pool.closeAll();
    logger.info('DB', 'Database closed');
  }

  /**
   * Get SessionStore -- optionally for a specific project DB.
   *
   * Without dbPath, returns the default or last-active store.
   */
  getSessionStore(dbPath?: string): SessionStore {
    validateDbPath(dbPath);
    if (dbPath) return this.pool.getStore(dbPath);
    if (this.defaultDbPath) return this.pool.getStore(this.defaultDbPath);
    const lastActive = this.pool.getLastActiveStore();
    if (lastActive) return lastActive;
    throw new Error('No database connection available');
  }

  /**
   * Get SessionSearch -- optionally for a specific project DB.
   *
   * Without dbPath, returns the default or last-active search.
   */
  getSessionSearch(dbPath?: string): SessionSearch {
    validateDbPath(dbPath);
    if (dbPath) return this.pool.getSearch(dbPath);
    if (this.defaultDbPath) return this.pool.getSearch(this.defaultDbPath);
    const lastActive = this.pool.getLastActiveSearch();
    if (lastActive) return lastActive;
    throw new Error('No database connection available');
  }

  /**
   * Get ChromaSync instance for a specific project DB (returns null if Chroma is disabled).
   *
   * Lazily creates and caches ChromaSync instances keyed by collection name.
   * Falls back to defaultDbPath when no dbPath is provided.
   */
  getChromaSync(dbPath?: string): ChromaSync | null {
    if (!this.chromaEnabled) return null;
    validateDbPath(dbPath);

    const resolvedPath = dbPath || this.defaultDbPath;
    if (!resolvedPath) return null;

    const collectionName = getCollectionName(resolvedPath);
    let sync = this.chromaSyncMap.get(collectionName);
    if (!sync) {
      sync = new ChromaSync(collectionName);
      this.chromaSyncMap.set(collectionName, sync);
    }
    return sync;
  }

  /**
   * Get the underlying connection pool.
   */
  getPool(): DbConnectionPool {
    return this.pool;
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // Worker restarts don't make sessions orphaned. Sessions are managed by hooks
  // and exist independently of worker state.

  /**
   * Get session by ID (throws if not found).
   */
  getSessionById(sessionDbId: number, dbPath?: string): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } {
    const session = this.getSessionStore(dbPath).getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
