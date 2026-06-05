import { Database } from 'bun:sqlite';
import { dirname } from 'path';
import { TableNameRow } from '../../types/database.js';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isDirectChild } from '../../shared/path-utils.js';
import {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
  SearchOptions,
  SearchFilters,
  DateRange,
  ObservationRow,
  UserPromptRow
} from './types.js';

/**
 * Search interface for session-based memory
 * Provides filter-only structured queries for sessions, observations, and user prompts
 * Vector search is handled by ChromaDB - this class only supports filtering without query text
 */
export class SessionSearch {
  private db: Database;

  constructor(dbPath?: string) {
    if (!dbPath) {
      ensureDir(DATA_DIR);
      dbPath = DB_PATH;
    } else {
      ensureDir(dirname(dbPath));
    }
    this.db = new Database(dbPath);
    // Wait for contended locks instead of failing fast with SQLITE_BUSY — see
    // SessionStore constructor for the shared-file rationale.
    this.db.run('PRAGMA busy_timeout = 5000');
    this.db.run('PRAGMA journal_mode = WAL');

    // Ensure FTS tables exist
    this.ensureFTSTables();
  }

  /**
   * Ensure FTS5 tables exist (backward compatibility only - no longer used for search)
   *
   * FTS5 tables are maintained for backward compatibility but not used for search.
   * Vector search (Chroma) is now the primary search mechanism.
   *
   * Retention Rationale:
   * - Prevents breaking existing installations with FTS5 tables
   * - Allows graceful migration path for users
   * - Tables maintained but search paths removed
   * - Triggers still fire to keep tables synchronized
   *
   * FTS5 may be unavailable on some platforms (e.g., Bun on Windows #791).
   * When unavailable, we skip FTS table creation — search falls back to
   * ChromaDB (vector) and LIKE queries (structured filters) which are unaffected.
   *
   * TODO: Remove FTS5 infrastructure in future major version (v7.0.0)
   */
  private ensureFTSTables(): void {
    // Check if FTS tables already exist
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as TableNameRow[];
    const hasFTS = tables.some(t => t.name === 'observations_fts' || t.name === 'session_summaries_fts');

    if (hasFTS) {
      // Already migrated
      return;
    }

    // Runtime check: verify FTS5 is available before attempting to create tables.
    // bun:sqlite on Windows may not include the FTS5 extension (#791).
    if (!this.isFts5Available()) {
      logger.warn('DB', 'FTS5 not available on this platform — skipping FTS table creation (search uses ChromaDB)');
      return;
    }

    logger.info('DB', 'Creating FTS5 tables');

    try {
      // Create observations_fts virtual table
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          title,
          subtitle,
          narrative,
          text,
          facts,
          concepts,
          content='observations',
          content_rowid='id'
        );
      `);

      // Populate with existing data
      this.db.run(`
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        SELECT id, title, subtitle, narrative, text, facts, concepts
        FROM observations;
      `);

      // Create triggers for observations
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
        END;

        CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        END;

        CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
        END;
      `);

      // Create session_summaries_fts virtual table
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
          request,
          investigated,
          learned,
          completed,
          next_steps,
          notes,
          content='session_summaries',
          content_rowid='id'
        );
      `);

      // Populate with existing data
      this.db.run(`
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        SELECT id, request, investigated, learned, completed, next_steps, notes
        FROM session_summaries;
      `);

      // Create triggers for session_summaries
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
        END;

        CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        END;

        CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
          INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
        END;
      `);

      logger.info('DB', 'FTS5 tables created successfully');
    } catch (error) {
      // FTS5 creation failed at runtime despite probe succeeding — degrade gracefully
      logger.warn('DB', 'FTS5 table creation failed — search will use ChromaDB and LIKE queries', {}, error as Error);
    }
  }

  /**
   * Probe whether the FTS5 extension is available in the current SQLite build.
   * Creates and immediately drops a temporary FTS5 table.
   */
  isFts5Available(): boolean {
    try {
      this.db.run('CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)');
      this.db.run('DROP TABLE _fts5_probe');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the populated FTS5 tables (observations_fts / session_summaries_fts)
   * exist for query-text fallback. Returns false on platforms where FTS5 was
   * unavailable at table-creation time (#791).
   */
  private hasFtsTables(): boolean {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observations_fts','session_summaries_fts')")
      .all() as TableNameRow[];
    return rows.length === 2;
  }

  /**
   * Build WHERE clause for structured filters
   */
  private buildFilterClause(
    filters: SearchFilters,
    params: any[],
    tableAlias: string = 'o'
  ): string {
    const conditions: string[] = [];

    // Project filter
    if (filters.project) {
      conditions.push(`${tableAlias}.project = ?`);
      params.push(filters.project);
    }

    // Type filter (for observations only)
    if (filters.type) {
      if (Array.isArray(filters.type)) {
        const placeholders = filters.type.map(() => '?').join(',');
        conditions.push(`${tableAlias}.type IN (${placeholders})`);
        params.push(...filters.type);
      } else {
        conditions.push(`${tableAlias}.type = ?`);
        params.push(filters.type);
      }
    }

    // Date range filter
    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        conditions.push(`${tableAlias}.created_at_epoch >= ?`);
        params.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        conditions.push(`${tableAlias}.created_at_epoch <= ?`);
        params.push(endEpoch);
      }
    }

    // Concepts filter (JSON array search)
    if (filters.concepts) {
      const concepts = Array.isArray(filters.concepts) ? filters.concepts : [filters.concepts];
      const conceptConditions = concepts.map(() => {
        return `EXISTS (SELECT 1 FROM json_each(${tableAlias}.concepts) WHERE value = ?)`;
      });
      if (conceptConditions.length > 0) {
        conditions.push(`(${conceptConditions.join(' OR ')})`);
        params.push(...concepts);
      }
    }

    // Files filter (JSON array search)
    if (filters.files) {
      const files = Array.isArray(filters.files) ? filters.files : [filters.files];
      const fileConditions = files.map(() => {
        return `(
          EXISTS (SELECT 1 FROM json_each(${tableAlias}.files_read) WHERE value LIKE ?)
          OR EXISTS (SELECT 1 FROM json_each(${tableAlias}.files_modified) WHERE value LIKE ?)
        )`;
      });
      if (fileConditions.length > 0) {
        conditions.push(`(${fileConditions.join(' OR ')})`);
        files.forEach(file => {
          params.push(`%${file}%`, `%${file}%`);
        });
      }
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '';
  }

  /**
   * Build ORDER BY clause
   */
  private buildOrderClause(orderBy: SearchOptions['orderBy'] = 'relevance', hasFTS: boolean = true, ftsTable: string = 'observations_fts'): string {
    switch (orderBy) {
      case 'relevance':
        return hasFTS ? `ORDER BY ${ftsTable}.rank ASC` : 'ORDER BY o.created_at_epoch DESC';
      case 'date_desc':
        return 'ORDER BY o.created_at_epoch DESC';
      case 'date_asc':
        return 'ORDER BY o.created_at_epoch ASC';
      default:
        return 'ORDER BY o.created_at_epoch DESC';
    }
  }

  /**
   * Search observations using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchObservations(query: string | undefined, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    // FILTER-ONLY PATH: When no query text, query table directly
    // This enables date filtering which Chroma cannot do (requires direct SQLite access)
    if (!query) {
      const filterClause = this.buildFilterClause(filters, params, 'o');
      if (!filterClause) {
        // No filter applies to this entity type (e.g. an observation-only filter
        // such as concept/type/file in a unified search) → no targeted matches.
        // Truly-empty requests are rejected upstream with 400 (SearchRoutes guards).
        return [];
      }

      const orderClause = this.buildOrderClause(orderBy, false);

      const sql = `
        SELECT o.*, o.discovery_tokens
        FROM observations o
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
    }

    // Query-text path: ChromaDB is the primary semantic engine. When it is
    // ABSENT, fall back to local FTS5 full-text search so text queries still work.
    if (!this.hasFtsTables()) {
      logger.warn('DB', 'Text search unavailable - no Chroma and no FTS5 tables');
      return [];
    }
    // SQL param order: query, ...filter, limit, offset (orderClause MUST add no params).
    const ftsParams: any[] = [query];
    const filterClause = this.buildFilterClause(filters, ftsParams, 'o');
    const whereExtra = filterClause ? `AND ${filterClause}` : '';
    const orderClause = this.buildOrderClause(orderBy, true, 'observations_fts');
    const ftsSql = `
      SELECT o.*, o.discovery_tokens
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
      ${whereExtra}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    ftsParams.push(limit, offset);
    try {
      return this.db.prepare(ftsSql).all(...ftsParams) as ObservationSearchResult[];
    } catch (error) {
      // FTS5 has its own query grammar, so ordinary user strings (e.g. foo"bar,
      // cache:miss, unbalanced quotes/operators) raise a SQLite syntax error.
      // Degrade to a best-effort LIKE scan instead of surfacing a 500.
      logger.warn('DB', 'FTS5 MATCH failed for query — falling back to LIKE', {}, error as Error);
      return this.likeFallbackObservations(query, { limit, offset, orderBy, ...filters });
    }
  }

  /**
   * Best-effort LIKE fallback for observation text search when an FTS5 MATCH
   * query is syntactically invalid. Scans the same fields FTS indexes.
   */
  private likeFallbackObservations(query: string, options: SearchOptions): ObservationSearchResult[] {
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;
    const params: any[] = [];
    const filterClause = this.buildFilterClause(filters, params, 'o');
    const whereExtra = filterClause ? `AND ${filterClause}` : '';
    const like = `%${query}%`;
    // relevance has no FTS rank in the fallback — order by recency.
    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY o.created_at_epoch ASC'
      : 'ORDER BY o.created_at_epoch DESC';
    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE (o.title LIKE ? OR o.subtitle LIKE ? OR o.narrative LIKE ? OR o.text LIKE ? OR o.facts LIKE ? OR o.concepts LIKE ?)
      ${whereExtra}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    const allParams = [like, like, like, like, like, like, ...params, limit, offset];
    return this.db.prepare(sql).all(...allParams) as ObservationSearchResult[];
  }

  /**
   * Search session summaries using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchSessions(query: string | undefined, options: SearchOptions = {}): SessionSummarySearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    // FILTER-ONLY PATH: When no query text, query session_summaries table directly
    if (!query) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, 's');
      if (!filterClause) {
        // No filter applies to this entity type (e.g. an observation-only filter
        // such as concept/type/file in a unified search) → no targeted matches.
        // Truly-empty requests are rejected upstream with 400 (SearchRoutes guards).
        return [];
      }

      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY s.created_at_epoch ASC'
        : 'ORDER BY s.created_at_epoch DESC';

      const sql = `
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as SessionSummarySearchResult[];
    }

    // Query-text path: fall back to FTS5 when ChromaDB is absent.
    if (!this.hasFtsTables()) {
      logger.warn('DB', 'Text search unavailable - no Chroma and no FTS5 tables');
      return [];
    }
    // SQL param order: query, ...filter, limit, offset (orderClause MUST add no params).
    const ftsParams: any[] = [query];
    const sessionFilterOptions = { ...filters };
    delete sessionFilterOptions.type;
    const filterClause = this.buildFilterClause(sessionFilterOptions, ftsParams, 's');
    const whereExtra = filterClause ? `AND ${filterClause}` : '';
    let orderClause: string;
    if (orderBy === 'date_asc') {
      orderClause = 'ORDER BY s.created_at_epoch ASC';
    } else if (orderBy === 'date_desc') {
      orderClause = 'ORDER BY s.created_at_epoch DESC';
    } else {
      orderClause = 'ORDER BY session_summaries_fts.rank ASC';
    }
    const ftsSql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries_fts
      JOIN session_summaries s ON s.id = session_summaries_fts.rowid
      WHERE session_summaries_fts MATCH ?
      ${whereExtra}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    ftsParams.push(limit, offset);
    try {
      return this.db.prepare(ftsSql).all(...ftsParams) as SessionSummarySearchResult[];
    } catch (error) {
      // Malformed FTS5 query (see searchObservations) — degrade to LIKE.
      logger.warn('DB', 'FTS5 MATCH failed for session query — falling back to LIKE', {}, error as Error);
      return this.likeFallbackSessions(query, { limit, offset, orderBy, ...filters });
    }
  }

  /**
   * Best-effort LIKE fallback for session-summary text search when an FTS5
   * MATCH query is syntactically invalid. Scans the same fields FTS indexes.
   */
  private likeFallbackSessions(query: string, options: SearchOptions): SessionSummarySearchResult[] {
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;
    const params: any[] = [];
    const sessionFilterOptions = { ...filters };
    delete sessionFilterOptions.type;
    const filterClause = this.buildFilterClause(sessionFilterOptions, params, 's');
    const whereExtra = filterClause ? `AND ${filterClause}` : '';
    const like = `%${query}%`;
    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY s.created_at_epoch ASC'
      : 'ORDER BY s.created_at_epoch DESC';
    const sql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE (s.request LIKE ? OR s.investigated LIKE ? OR s.learned LIKE ? OR s.completed LIKE ? OR s.next_steps LIKE ? OR s.notes LIKE ?)
      ${whereExtra}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    const allParams = [like, like, like, like, like, like, ...params, limit, offset];
    return this.db.prepare(sql).all(...allParams) as SessionSummarySearchResult[];
  }

  /**
   * Find observations by concept tag
   */
  findByConcept(concept: string, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    // Add concept to filters
    const conceptFilters = { ...filters, concepts: concept };
    const filterClause = this.buildFilterClause(conceptFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  /**
   * Check if an observation has any files that are direct children of the folder
   */
  private hasDirectChildFile(obs: ObservationSearchResult, folderPath: string): boolean {
    const checkFiles = (filesJson: string | null): boolean => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some(f => isDirectChild(f, folderPath));
        }
      } catch {}
      return false;
    };

    return checkFiles(obs.files_modified) || checkFiles(obs.files_read);
  }

  /**
   * Check if a session has any files that are direct children of the folder
   */
  private hasDirectChildFileSession(session: SessionSummarySearchResult, folderPath: string): boolean {
    const checkFiles = (filesJson: string | null): boolean => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some(f => isDirectChild(f, folderPath));
        }
      } catch {}
      return false;
    };

    return checkFiles(session.files_read) || checkFiles(session.files_edited);
  }

  /**
   * Find observations and summaries by file path
   * When isFolder=true, only returns results with files directly in the folder (not subfolders)
   */
  findByFile(filePath: string, options: SearchOptions = {}): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', isFolder = false, ...filters } = options;

    // Query more results if we're filtering to direct children
    const queryLimit = isFolder ? limit * 3 : limit;

    // Add file to filters
    const fileFilters = { ...filters, files: filePath };
    const filterClause = this.buildFilterClause(fileFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const observationsSql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(queryLimit, offset);

    let observations = this.db.prepare(observationsSql).all(...params) as ObservationSearchResult[];

    // Post-filter to direct children if isFolder mode
    if (isFolder) {
      observations = observations.filter(obs => this.hasDirectChildFile(obs, filePath)).slice(0, limit);
    }

    // For session summaries, search files_read and files_edited
    const sessionParams: any[] = [];
    const sessionFilters = { ...filters };
    delete sessionFilters.type; // Remove type filter for sessions

    const baseConditions: string[] = [];
    if (sessionFilters.project) {
      baseConditions.push('s.project = ?');
      sessionParams.push(sessionFilters.project);
    }

    if (sessionFilters.dateRange) {
      const { start, end } = sessionFilters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        baseConditions.push('s.created_at_epoch >= ?');
        sessionParams.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        baseConditions.push('s.created_at_epoch <= ?');
        sessionParams.push(endEpoch);
      }
    }

    // File condition
    baseConditions.push(`(
      EXISTS (SELECT 1 FROM json_each(s.files_read) WHERE value LIKE ?)
      OR EXISTS (SELECT 1 FROM json_each(s.files_edited) WHERE value LIKE ?)
    )`);
    sessionParams.push(`%${filePath}%`, `%${filePath}%`);

    const sessionsSql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;

    sessionParams.push(queryLimit, offset);

    let sessions = this.db.prepare(sessionsSql).all(...sessionParams) as SessionSummarySearchResult[];

    // Post-filter to direct children if isFolder mode
    if (isFolder) {
      sessions = sessions.filter(s => this.hasDirectChildFileSession(s, filePath)).slice(0, limit);
    }

    return { observations, sessions };
  }

  /**
   * Find observations by type
   */
  findByType(
    type: ObservationRow['type'] | ObservationRow['type'][],
    options: SearchOptions = {}
  ): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    // Add type to filters
    const typeFilters = { ...filters, type };
    const filterClause = this.buildFilterClause(typeFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  /**
   * Search user prompts using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchUserPrompts(query: string | undefined, options: SearchOptions = {}): UserPromptSearchResult[] {
    const params: any[] = [];
    const { limit = 20, offset = 0, orderBy = 'relevance', ...filters } = options;

    // Build filter conditions (join with sdk_sessions for project filtering)
    const baseConditions: string[] = [];
    if (filters.project) {
      baseConditions.push('s.project = ?');
      params.push(filters.project);
    }

    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        baseConditions.push('up.created_at_epoch >= ?');
        params.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        baseConditions.push('up.created_at_epoch <= ?');
        params.push(endEpoch);
      }
    }

    // FILTER-ONLY PATH: When no query text, query user_prompts table directly
    if (!query) {
      if (baseConditions.length === 0) {
        // No prompt-applicable filter (project/date) → no targeted matches.
        // Truly-empty requests are rejected upstream with 400 (SearchRoutes guards).
        return [];
      }

      // Search results never include redacted placeholders — they have no
      // content to match and would surface as blanks in the viewer.
      baseConditions.push('up.is_redacted = 0');
      const whereClause = `WHERE ${baseConditions.join(' AND ')}`;
      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY up.created_at_epoch ASC'
        : 'ORDER BY up.created_at_epoch DESC';

      const sql = `
        SELECT up.*
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
    }

    // Query-text path: user_prompts has no FTS table — fall back to LIKE on prompt_text
    // when ChromaDB is absent. Redacted placeholders are excluded (no content to match).
    // SQL param order: ...baseConditions, likeQuery, limit, offset (orderClause adds none).
    const likeConditions = [...baseConditions, 'up.is_redacted = 0', 'up.prompt_text LIKE ?'];
    params.push(`%${query}%`);
    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY up.created_at_epoch ASC'
      : 'ORDER BY up.created_at_epoch DESC';
    const likeSql = `
      SELECT up.*
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE ${likeConditions.join(' AND ')}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    return this.db.prepare(likeSql).all(...params) as UserPromptSearchResult[];
  }

  /**
   * Get all prompts for a session by content_session_id
   * Excludes redacted placeholders.
   */
  getUserPromptsBySession(contentSessionId: string): UserPromptRow[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        content_session_id,
        prompt_number,
        prompt_text,
        created_at,
        created_at_epoch
      FROM user_prompts
      WHERE content_session_id = ?
        AND is_redacted = 0
      ORDER BY prompt_number ASC
    `);

    return stmt.all(contentSessionId) as UserPromptRow[];
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
