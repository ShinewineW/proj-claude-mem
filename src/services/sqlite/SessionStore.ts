import { Database } from 'bun:sqlite';
import { dirname } from 'path';
import { DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  SdkSessionRecord,
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  LatestPromptResult
} from '../../types/database.js';
import type { PendingMessageStore } from './PendingMessageStore.js';
import { computeObservationContentHash, findDuplicateObservation } from './observations/store.js';
import { parseFileList } from './observations/files.js';
import { computeSummaryContentHash, findDuplicateSummary } from './summaries/store.js';
import { assertValidLimit } from './query-utils.js';
import { MigrationRunner } from './migrations/runner.js';

/**
 * Session data store for SDK sessions, observations, and summaries
 * Provides simple, synchronous CRUD operations for session-based memory
 */
export class SessionStore {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ':memory:') {
      ensureDir(dirname(dbPath));
    }
    this.db = new Database(dbPath);

    // Set busy_timeout FIRST so the WAL switch, migrations, and every later
    // write wait up to 5s for a contended lock instead of failing fast with
    // SQLITE_BUSY ("database is locked"). Multiple processes share this file
    // (worker daemon + per-hook node processes + MCP search server), so brief
    // write collisions are normal; without a busy timeout they surface as hard
    // errors that crash the observer generator / strand summarize rows.
    this.db.run('PRAGMA busy_timeout = 5000');
    // Ensure optimized settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    // Cap WAL growth at 4MB per DB so the journal doesn't balloon unbounded
    // under sustained writes (multiple processes share the file). Upstream #1956.
    this.db.run('PRAGMA journal_size_limit = 4194304');
    this.db.run('PRAGMA temp_store = memory');

    // Delegate all migrations to MigrationRunner (single source of truth)
    const runner = new MigrationRunner(this.db);
    runner.runAllMigrations();
  }

  /**
   * Update the memory session ID for a session
   * Called by SDKAgent when it captures the session ID from the first SDK message
   * Also used to RESET to null on stale resume failures (worker-service.ts)
   */
  updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): void {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(memorySessionId, sessionDbId);
  }

  /**
   * Ensures memory_session_id is registered in sdk_sessions before FK-constrained INSERT.
   * This fixes Issue #846 where observations fail after worker restart because the
   * SDK generates a new memory_session_id but it's not registered in the parent table
   * before child records try to reference it.
   *
   * @param sessionDbId - The database ID of the session
   * @param memorySessionId - The memory session ID to ensure is registered
   */
  ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): void {
    const session = this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId) as { id: number; memory_session_id: string | null } | undefined;

    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }

    if (session.memory_session_id !== memorySessionId) {
      this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(memorySessionId, sessionDbId);

      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        oldId: session.memory_session_id,
        newId: memorySessionId
      });
    }
  }

  /**
   * Get recent session summaries for a project
   */
  getRecentSummaries(project: string, limit: number = 10): Array<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit);
  }

  /**
   * Get recent summaries with session info for context display
   */
  getRecentSummariesWithSessionInfo(project: string, limit: number = 3): Array<{
    memory_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit);
  }

  /**
   * Get recent observations for a project
   */
  getRecentObservations(project: string, limit: number = 20): Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit);
  }

  /**
   * Get recent observations across all projects (for web UI)
   */
  getAllRecentObservations(limit: number = 100): Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
      FROM observations
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  /**
   * Get recent summaries across all projects (for web UI)
   */
  getAllRecentSummaries(limit: number = 50): Array<{
    id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    project: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, request, investigated, learned, completed, next_steps,
             files_read, files_edited, notes, project, prompt_number,
             created_at, created_at_epoch
      FROM session_summaries
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  /**
   * Get recent user prompts across all sessions (for web UI)
   */
  getAllRecentUserPrompts(limit: number = 100): Array<{
    id: number;
    content_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.is_redacted = 0
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  /**
   * Get all unique projects from the database (for web UI project filter)
   */
  getAllProjects(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      ORDER BY project ASC
    `);

    const rows = stmt.all() as Array<{ project: string }>;
    return rows.map(row => row.project);
  }

  /**
   * Get latest user prompt with session info for a Claude session
   * Used for syncing prompts to Chroma during session initialization
   */
  getLatestUserPrompt(contentSessionId: string): {
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined {
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
        AND up.is_redacted = 0
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `);

    return stmt.get(contentSessionId) as LatestPromptResult | undefined;
  }

  /**
   * Get recent sessions with their status and summary info
   */
  getRecentSessionsWithStatus(project: string, limit: number = 3): Array<{
    memory_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }> {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `);

    return stmt.all(project, limit);
  }

  /**
   * Get observations for a specific session
   */
  getObservationsForSession(memorySessionId: string): Array<{
    title: string | null;
    subtitle: string | null;
    type: string;
    prompt_number: number | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `);

    return stmt.all(memorySessionId);
  }

  /**
   * Get recent observations for a session with narrative/facts/title content.
   * Used for pre-queue summary salvage when transcript lacks assistant text.
   * Returns most-recent-first, limited to preserve summary compactness.
   */
  getRecentObservationsForSession(
    memorySessionId: string,
    limit: number = 20,
  ): Array<{
    id: number;
    type: string;
    title: string | null;
    narrative: string | null;
    facts: string | null;
    prompt_number: number | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, type, title, narrative, facts, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(memorySessionId, limit) as Array<{
      id: number;
      type: string;
      title: string | null;
      narrative: string | null;
      facts: string | null;
      prompt_number: number | null;
    }>;
  }

  /**
   * Get a single observation by ID
   */
  getObservationById(id: number): ObservationRecord | null {
    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `);

    return stmt.get(id) as ObservationRecord | undefined || null;
  }

  /**
   * Get observations by array of IDs with ordering and limit
   */
  getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): ObservationRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';

    assertValidLimit(limit);

    // Build placeholders for IN clause
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    // Apply project filter
    if (project) {
      additionalConditions.push('project = ?');
      params.push(project);
    }

    // Apply type filter
    if (type) {
      if (Array.isArray(type)) {
        const typePlaceholders = type.map(() => '?').join(',');
        additionalConditions.push(`type IN (${typePlaceholders})`);
        params.push(...type);
      } else {
        additionalConditions.push('type = ?');
        params.push(type);
      }
    }

    // Apply concepts filter
    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptConditions = conceptsList.map(() =>
        'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)'
      );
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
    }

    // Apply files filter
    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      const fileConditions = filesList.map(() => {
        return '(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))';
      });
      filesList.forEach(file => {
        params.push(`%${file}%`, `%${file}%`);
      });
      additionalConditions.push(`(${fileConditions.join(' OR ')})`);
    }

    const whereClause = additionalConditions.length > 0
      ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}`
      : `WHERE id IN (${placeholders})`;

    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limit ? 'LIMIT ?' : ''}
    `);

    const allParams = limit ? [...params, limit] : params;
    return stmt.all(...allParams) as ObservationRecord[];
  }

  /**
   * Get summary for a specific session
   */
  getSummaryForSession(memorySessionId: string): {
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `);

    return stmt.get(memorySessionId) || null;
  }

  /**
   * Get aggregated files from all observations for a session
   */
  getFilesForSession(memorySessionId: string): {
    filesRead: string[];
    filesModified: string[];
  } {
    const stmt = this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `);

    const rows = stmt.all(memorySessionId) as Array<{
      files_read: string | null;
      files_modified: string | null;
    }>;

    const filesReadSet = new Set<string>();
    const filesModifiedSet = new Set<string>();

    for (const row of rows) {
      // Parse files_read (recovers bare-path strings; #1359)
      parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

      // Parse files_modified (recovers bare-path strings; #1359)
      parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
    }

    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet)
    };
  }

  /**
   * Get session by ID
   */
  getSessionById(id: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
    custom_title: string | null;
  } | null {
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return stmt.get(id) || null;
  }

  /**
   * Get SDK sessions by SDK session IDs
   * Used for exporting session metadata
   */
  getSdkSessionsBySessionIds(memorySessionIds: string[]): {
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    user_prompt: string;
    custom_title: string | null;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }[] {
    if (memorySessionIds.length === 0) return [];

    const placeholders = memorySessionIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `);

    return stmt.all(...memorySessionIds) as any[];
  }






  /**
   * Get current prompt number by counting user_prompts for this session
   *
   * Counts ALL rows (including is_redacted=1). Use only when assigning the
   * next prompt_number to a new prompt — see `getLatestRealPromptNumber` for
   * attribution-time lookups.
   */
  getPromptNumberFromUserPrompts(contentSessionId: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(contentSessionId) as { count: number };
    return result.count;
  }

  /**
   * Latest non-redacted prompt_number for attribution. Returns 0 if none.
   *
   * Use this when linking observations/summaries to a user turn — redacted
   * placeholder rows advance the counter but do not represent user intent.
   * See `prompts/get.ts: getLatestRealPromptNumber` for full rationale.
   */
  getLatestRealPromptNumber(contentSessionId: string): number {
    const result = this.db.prepare(`
      SELECT COALESCE(MAX(prompt_number), 0) AS pn
      FROM user_prompts
      WHERE content_session_id = ? AND is_redacted = 0
    `).get(contentSessionId) as { pn: number };
    return result.pn;
  }

  /**
   * Create a new SDK session (idempotent - returns existing session ID if already exists)
   *
   * CRITICAL ARCHITECTURE: Session ID Threading
   * ============================================
   * This function is the KEY to how claude-mem stays unified across hooks:
   *
   * - NEW hook calls: createSDKSession(session_id, project, prompt)
   * - SAVE hook calls: createSDKSession(session_id, '', '')
   * - Both use the SAME session_id from Claude Code's hook context
   *
   * IDEMPOTENT BEHAVIOR (INSERT OR IGNORE):
   * - Prompt #1: session_id not in database → INSERT creates new row
   * - Prompt #2+: session_id exists → INSERT ignored, fetch existing ID
   * - Result: Same database ID returned for all prompts in conversation
   *
   * Pure get-or-create: never modifies memory_session_id.
   * Multi-terminal isolation is handled by ON UPDATE CASCADE at the schema level.
   */
  createSDKSession(contentSessionId: string, project: string, userPrompt: string, customTitle?: string): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    // Session reuse: Return existing session ID if already created for this contentSessionId.
    const existing = this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE content_session_id = ?
    `).get(contentSessionId) as { id: number } | undefined;

    if (existing) {
      // Backfill project if session was created by another hook with empty project
      if (project) {
        this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(project, contentSessionId);
      }
      // Backfill custom_title if provided and not yet set
      if (customTitle) {
        this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(customTitle, contentSessionId);
      }
      return existing.id;
    }

    // New session - insert fresh row
    // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
    // response and stored via ensureMemorySessionIdRegistered(). CRITICAL: memory_session_id
    // must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!
    this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, project, userPrompt, customTitle || null, now.toISOString(), nowEpoch);

    // Return new ID
    const row = this.db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
      .get(contentSessionId) as { id: number };
    return row.id;
  }




  /**
   * Save a user prompt.
   *
   * @param isRedacted When true, marks the row so PrivacyCheckValidator skips
   *   downstream processing. Set by callers that detected the original prompt
   *   was fully wrapped in a recognized tag (e.g. `<private>`). Must NOT be set
   *   when prompt_text is empty for unrelated reasons (race condition, failed
   *   strip) — that's exactly the conflation this flag was added to fix.
   */
  saveUserPrompt(
    contentSessionId: string,
    promptNumber: number,
    promptText: string,
    isRedacted: boolean = false
  ): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, is_redacted)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch, isRedacted ? 1 : 0);
    return result.lastInsertRowid as number;
  }

  /**
   * Returns true iff the prompt was explicitly marked redacted at save time.
   * False for non-existent rows, race-condition empties, and normal prompts.
   */
  isUserPromptRedacted(contentSessionId: string, promptNumber: number): boolean {
    const stmt = this.db.prepare(`
      SELECT is_redacted
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);
    const result = stmt.get(contentSessionId, promptNumber) as { is_redacted: number } | undefined;
    return result?.is_redacted === 1;
  }

  /**
   * Get user prompt by session ID and prompt number
   * Returns the prompt text, or null if not found
   */
  getUserPrompt(contentSessionId: string, promptNumber: number): string | null {
    const stmt = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);

    const result = stmt.get(contentSessionId, promptNumber) as { prompt_text: string } | undefined;
    return result?.prompt_text ?? null;
  }

  /**
   * Get the user prompt row for a specific (contentSessionId, promptNumber)
   * pair. Used by SummaryLane to resolve the per-turn userPrompt so each
   * summary in a multi-turn session gets the CURRENT turn's request (not the
   * session-metadata first-turn prompt stored in sdk_sessions.user_prompt).
   */
  getUserPromptByContentSessionAndPromptNumber(
    contentSessionId: string,
    promptNumber: number,
  ): { prompt_text: string } | null {
    const stmt = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);
    return (stmt.get(contentSessionId, promptNumber) as { prompt_text: string } | undefined) ?? null;
  }

  /**
   * Get a single session summary by its SQLite id. SummaryLane re-reads the
   * persisted row after storeFreshSummaryForSession returns so downstream
   * (Chroma sync, SSE broadcast) is driven by the stored row, never the
   * (non-deterministic) LLM output.
   *
   * Schema note: `prompt_number`/`discovery_tokens` are NOT NULL in the
   * modern schema, but are declared as optional on SessionSummaryRecord for
   * backward-compatibility with legacy rows. Callers that need strict
   * non-null semantics should coerce explicitly (e.g., `?? null` before
   * passing to SSE payload shapes that accept `null`).
   */
  getSummaryById(id: number): SessionSummaryRecord | null {
    const stmt = this.db.prepare(`
      SELECT *
      FROM session_summaries
      WHERE id = ?
      LIMIT 1
    `);
    return (stmt.get(id) as SessionSummaryRecord | undefined) ?? null;
  }

  /**
   * Get observations for SummaryLane's fresh-query prompt, scoped by
   * content_session_id + prompt_number window. This is the SummaryLane
   * replacement for `getObservationsForSession(memory_session_id)` — using
   * content_session_id avoids the subtle bug where the observer captures a
   * new memory_session_id mid-flight (via ensureMemorySessionIdRegistered),
   * making the old per-memory-session scope lose observations written before
   * the id change.
   *
   * `queuedAtEpoch` is the summarize row's `created_at_epoch`, used as an
   * upper bound on `created_at_epoch` for the fallback branch where an
   * observation row has no prompt_number (NULL pre-migration data). Same
   * pattern as PendingMessageStore.getPendingObservationCountUpToPrompt.
   */
  getObservationsForContentSessionUpToPrompt(
    contentSessionId: string,
    promptNumber: number,
    queuedAtEpoch: number,
  ): Array<{ type: string; title: string | null; narrative: string | null; facts: string[] }> {
    const stmt = this.db.prepare(`
      SELECT type, title, narrative, facts
      FROM observations
      WHERE content_session_id = ?
        AND (
          (prompt_number IS NOT NULL AND prompt_number <= ?)
          OR (prompt_number IS NULL AND created_at_epoch <= ?)
        )
      ORDER BY id ASC
    `);
    const rows = stmt.all(contentSessionId, promptNumber, queuedAtEpoch) as Array<{
      type: string;
      title: string | null;
      narrative: string | null;
      facts: string | null;
    }>;
    return rows.map((r) => {
      let facts: string[] = [];
      if (r.facts) {
        try {
          const parsed = JSON.parse(r.facts);
          if (Array.isArray(parsed)) {
            facts = parsed.filter((f): f is string => typeof f === 'string');
          }
        } catch {
          // Malformed facts JSON — fall through to empty
        }
      }
      return { type: r.type, title: r.title, narrative: r.narrative, facts };
    });
  }

  /**
   * Store an observation (from SDK parsing)
   * Assumes session already exists (created by hook)
   * Performs content-hash deduplication: skips INSERT if an identical observation exists within 30s
   */
  storeObservation(
    memorySessionId: string,
    project: string,
    observation: {
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    contentSessionId: string | null = null
  ): { id: number; createdAtEpoch: number } {
    // Use override timestamp if provided (for processing backlog messages with original timestamps)
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    if (!project || project.trim() === '') {
      throw new Error('storeObservation: project parameter is required');
    }

    // Content-hash deduplication
    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
    const existing = findDuplicateObservation(this.db, contentHash, timestampEpoch);
    if (existing) {
      return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, content_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      memorySessionId,
      contentSessionId,
      project,
      observation.type,
      observation.title,
      observation.subtitle,
      JSON.stringify(observation.facts),
      observation.narrative,
      JSON.stringify(observation.concepts),
      JSON.stringify(observation.files_read),
      JSON.stringify(observation.files_modified),
      promptNumber || null,
      discoveryTokens,
      contentHash,
      timestampIso,
      timestampEpoch
    );

    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }

  /**
   * Store a session summary (from SDK parsing)
   * Assumes session already exists - will fail with FK error if not
   */
  /**
   * Insert a summary with content-hash dedup (30s window).
   * Shared by storeSummary, storeObservations, storeObservationsAndMarkComplete.
   */
  private insertSummaryDeduped(
    memorySessionId: string,
    project: string,
    summary: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null },
    promptNumber: number | null,
    discoveryTokens: number,
    timestampIso: string,
    timestampEpoch: number,
    contentSessionId: string | null = null
  ): { id: number; createdAtEpoch: number } {
    const contentHash = computeSummaryContentHash(memorySessionId, summary.request, summary.investigated);
    const existing = findDuplicateSummary(this.db, contentHash, timestampEpoch);
    if (existing) {
      return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
    }

    const result = this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, content_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memorySessionId, contentSessionId, project,
      summary.request, summary.investigated, summary.learned, summary.completed,
      summary.next_steps, summary.notes,
      promptNumber, discoveryTokens, timestampIso, timestampEpoch, contentHash
    );

    return { id: Number(result.lastInsertRowid), createdAtEpoch: timestampEpoch };
  }

  storeSummary(
    memorySessionId: string,
    project: string,
    summary: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    contentSessionId: string | null = null
  ): { id: number; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    return this.insertSummaryDeduped(memorySessionId, project, summary, promptNumber || null, discoveryTokens, timestampIso, timestampEpoch, contentSessionId);
  }

  /**
   * ATOMIC: Store observations + summary (no message tracking)
   *
   * Simplified version for use with claim-and-delete queue pattern.
   * Messages are deleted from queue immediately on claim, so there's no
   * message completion to track. This just stores observations and summary.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
  storeObservations(
    memorySessionId: string,
    project: string,
    observations: Array<{
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    contentSessionId: string | null = null
  ): { observationIds: number[]; summaryId: number | null; createdAtEpoch: number } {
    if (!project || project.trim() === '') {
      throw new Error('storeObservations: project parameter is required');
    }

    // Use override timestamp if provided
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Create transaction that wraps all operations
    const storeTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      // 1. Store all observations
      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, content_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const observation of observations) {
        const result = obsStmt.run(
          memorySessionId,
          contentSessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        observationIds.push(Number(result.lastInsertRowid));
      }

      // 2. Store summary if provided (with content-hash dedup)
      const summaryId = summary
        ? this.insertSummaryDeduped(memorySessionId, project, summary, promptNumber || null, discoveryTokens, timestampIso, timestampEpoch, contentSessionId).id
        : null;

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    // Execute the transaction and return results
    return storeTx();
  }

  /**
   * @deprecated Use storeObservations instead. This method is kept for backwards compatibility.
   *
   * ATOMIC: Store observations + summary + mark pending message as processed
   *
   * This method wraps observation storage, summary storage, and message completion
   * in a single database transaction to prevent race conditions. If the worker crashes
   * during processing, either all operations succeed together or all fail together.
   *
   * This fixes the observation duplication bug where observations were stored but
   * the message wasn't marked complete, causing reprocessing on crash recovery.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param messageId - Pending message ID to mark as processed
   * @param pendingStore - PendingMessageStore instance for marking complete
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
  storeObservationsAndMarkComplete(
    memorySessionId: string,
    project: string,
    observations: Array<{
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    messageId: number,
    _pendingStore: PendingMessageStore,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    contentSessionId: string | null = null
  ): { observationIds: number[]; summaryId?: number; createdAtEpoch: number } {
    if (!project || project.trim() === '') {
      throw new Error('storeObservationsAndMarkComplete: project parameter is required');
    }

    // Use override timestamp if provided
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Create transaction that wraps all operations
    const storeAndMarkTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      // 1. Store all observations
      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, content_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const observation of observations) {
        const result = obsStmt.run(
          memorySessionId,
          contentSessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        observationIds.push(Number(result.lastInsertRowid));
      }

      // 2. Store summary if provided (with content-hash dedup)
      const summaryId = summary
        ? this.insertSummaryDeduped(memorySessionId, project, summary, promptNumber || null, discoveryTokens, timestampIso, timestampEpoch, contentSessionId).id
        : undefined;

      // 3. Mark pending message as processed
      // This UPDATE is part of the same transaction, so if it fails,
      // observations and summary will be rolled back
      const updateStmt = this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `);
      const updateResult = updateStmt.run(timestampEpoch, messageId);
      // Guard against phantom completion: if the message vanished or is no longer
      // 'processing', 0 rows change. Throwing rolls back the whole transaction so
      // we never report success on observations that weren't really committed
      // against a live queue row. Upstream #65f2fd8c (kept as UPDATE per fork).
      if (updateResult.changes !== 1) {
        throw new Error(`storeObservationsAndMarkComplete: failed to complete pending message ${messageId}`);
      }

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    // Execute the transaction and return results
    return storeAndMarkTx();
  }



  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // There's no such thing as an "orphaned" session. Sessions are created by hooks
  // and managed by Claude Code's lifecycle. Worker restarts don't invalidate them.
  // Marking all active sessions as 'failed' on startup destroys the user's current work.

  /**
   * Get session summaries by IDs (for hybrid Chroma search)
   * Returns summaries in specified temporal order
   */
  getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): SessionSummaryRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';

    assertValidLimit(limit);

    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
    const whereClause = project
      ? `WHERE id IN (${placeholders}) AND project = ?`
      : `WHERE id IN (${placeholders})`;
    if (project) params.push(project);

    const stmt = this.db.prepare(`
      SELECT * FROM session_summaries
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limit ? 'LIMIT ?' : ''}
    `);

    const allParams = limit ? [...params, limit] : params;
    return stmt.all(...allParams) as SessionSummaryRecord[];
  }

  /**
   * Get user prompts by IDs (for hybrid Chroma search)
   * Returns prompts in specified temporal order
   */
  getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): UserPromptRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';

    assertValidLimit(limit);

    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
    const projectFilter = project ? 'AND s.project = ?' : '';
    if (project) params.push(project);

    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${placeholders}) ${projectFilter}
      ORDER BY up.created_at_epoch ${orderClause}
      ${limit ? 'LIMIT ?' : ''}
    `);

    const allParams = limit ? [...params, limit] : params;
    return stmt.all(...allParams) as UserPromptRecord[];
  }

  /**
   * Get a unified timeline of all records (observations, sessions, prompts) around an anchor point
   * @param anchorEpoch The anchor timestamp (epoch milliseconds)
   * @param depthBefore Number of records to retrieve before anchor (any type)
   * @param depthAfter Number of records to retrieve after anchor (any type)
   * @param project Optional project filter
   * @returns Object containing observations, sessions, and prompts for the specified window
   */
  getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }

  /**
   * Get timeline around a specific observation ID
   * Uses observation ID offsets to determine time boundaries, then fetches all record types in that window
   */
  getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    const projectFilter = project ? 'AND project = ?' : '';
    const projectParams = project ? [project] : [];

    let startEpoch: number;
    let endEpoch: number;

    if (anchorObservationId !== null) {
      // Get boundary observations by ID offset
      const beforeQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${projectFilter}
        ORDER BY id DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${projectFilter}
        ORDER BY id ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorObservationId, ...projectParams, depthBefore + 1) as Array<{id: number; created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorObservationId, ...projectParams, depthAfter + 1) as Array<{id: number; created_at_epoch: number}>;

        // Get the earliest and latest timestamps from boundary observations
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        logger.error('DB', 'Error getting boundary observations', undefined, { error: err, project });
        return { observations: [], sessions: [], prompts: [] };
      }
    } else {
      // For timestamp-based anchors, use time-based boundaries
      // Get observations to find the time window
      const beforeQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${projectFilter}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...projectParams, depthBefore) as Array<{created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...projectParams, depthAfter + 1) as Array<{created_at_epoch: number}>;

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        logger.error('DB', 'Error getting boundary timestamps', undefined, { error: err, project });
        return { observations: [], sessions: [], prompts: [] };
      }
    }

    // Now query ALL record types within the time window
    const obsQuery = `
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;

    const sessQuery = `
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;

    const promptQuery = `
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ?
        AND up.is_redacted = 0
        ${projectFilter.replace('project', 's.project')}
      ORDER BY up.created_at_epoch ASC
    `;

    const observations = this.db.prepare(obsQuery).all(startEpoch, endEpoch, ...projectParams) as ObservationRecord[];
    const sessions = this.db.prepare(sessQuery).all(startEpoch, endEpoch, ...projectParams) as SessionSummaryRecord[];
    const prompts = this.db.prepare(promptQuery).all(startEpoch, endEpoch, ...projectParams) as UserPromptRecord[];

    return {
      observations,
      sessions: sessions.map(s => ({
        id: s.id,
        memory_session_id: s.memory_session_id,
        project: s.project,
        request: s.request,
        completed: s.completed,
        next_steps: s.next_steps,
        created_at: s.created_at,
        created_at_epoch: s.created_at_epoch
      })),
      prompts: prompts.map(p => ({
        id: p.id,
        content_session_id: p.content_session_id,
        prompt_number: p.prompt_number,
        prompt_text: p.prompt_text,
        project: p.project,
        created_at: p.created_at,
        created_at_epoch: p.created_at_epoch
      }))
    };
  }

  /**
   * Get a single user prompt by ID
   */
  getPromptById(id: number): {
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `);

    return stmt.get(id) || null;
  }

  /**
   * Get multiple user prompts by IDs
   */
  getPromptsByIds(ids: number[]): Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${placeholders})
      ORDER BY p.created_at_epoch DESC
    `);

    return stmt.all(...ids) as Array<{
      id: number;
      content_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  /**
   * Get full session summary by ID (includes request_summary and learned_summary)
   */
  getSessionSummaryById(id: number): {
    id: number;
    memory_session_id: string | null;
    content_session_id: string;
    project: string;
    user_prompt: string;
    request_summary: string | null;
    learned_summary: string | null;
    status: string;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return stmt.get(id) || null;
  }

  /**
   * Mark session as failed in database.
   * Used when generator is abandoned (restart limit exceeded or unrecoverable error).
   * Called BEFORE removeSessionImmediate so the DB status is 'failed' not 'completed'.
   * Uses AND status='active' guard to avoid overwriting reaper's status.
   */
  markSessionFailed(sessionDbId: number): void {
    this.db.prepare(
      'UPDATE sdk_sessions SET status = ?, completed_at_epoch = ? WHERE id = ? AND status = ?'
    ).run('failed', Date.now(), sessionDbId, 'active');
  }

  /**
   * Get or create a manual session for storing user-created observations
   * Manual sessions use a predictable ID format: "manual-{project}"
   */
  getOrCreateManualSession(project: string): string {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = this.db.prepare(
      'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?'
    ).get(memorySessionId) as { memory_session_id: string } | undefined;

    if (existing) {
      return memorySessionId;
    }

    // Create new manual session
    const now = new Date();
    this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(memorySessionId, contentSessionId, project, now.toISOString(), now.getTime());

    logger.info('SESSION', 'Created manual session', { memorySessionId, project });

    return memorySessionId;
  }

  /**
   * Get the underlying SQLite Database handle.
   * Prefer this over direct `.db` access for a cleaner API boundary.
   */
  getDatabase(): Database {
    return this.db;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  // ===========================================
  // Import Methods (for import-memories script)
  // ===========================================

  /**
   * Import SDK session with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  importSdkSession(session: {
    content_session_id: string;
    memory_session_id: string;
    project: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): { imported: boolean; id: number } {
    // Check if session already exists
    const existing = this.db.prepare(
      'SELECT id FROM sdk_sessions WHERE content_session_id = ?'
    ).get(session.content_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      session.content_session_id,
      session.memory_session_id,
      session.project,
      session.user_prompt,
      session.started_at,
      session.started_at_epoch,
      session.completed_at,
      session.completed_at_epoch,
      session.status
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  /**
   * Import session summary with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  importSessionSummary(summary: {
    memory_session_id: string;
    project: string;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    // Check if summary already exists for this session
    const existing = this.db.prepare(
      'SELECT id FROM session_summaries WHERE memory_session_id = ?'
    ).get(summary.memory_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      summary.memory_session_id,
      summary.project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.files_read,
      summary.files_edited,
      summary.notes,
      summary.prompt_number,
      summary.discovery_tokens || 0,
      summary.created_at,
      summary.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  /**
   * Import observation with duplicate checking
   * Duplicates are identified by memory_session_id + title + created_at_epoch
   * Returns: { imported: boolean, id: number }
   */
  importObservation(obs: {
    memory_session_id: string;
    project: string;
    text: string | null;
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string | null;
    narrative: string | null;
    concepts: string | null;
    files_read: string | null;
    files_modified: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    // Check if observation already exists
    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(obs.memory_session_id, obs.title, obs.created_at_epoch) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      obs.memory_session_id,
      obs.project,
      obs.text,
      obs.type,
      obs.title,
      obs.subtitle,
      obs.facts,
      obs.narrative,
      obs.concepts,
      obs.files_read,
      obs.files_modified,
      obs.prompt_number,
      obs.discovery_tokens || 0,
      obs.created_at,
      obs.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  /**
   * Import user prompt with duplicate checking
   * Duplicates are identified by content_session_id + prompt_number
   * Returns: { imported: boolean, id: number }
   */
  importUserPrompt(prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    // Check if prompt already exists
    const existing = this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(prompt.content_session_id, prompt.prompt_number) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      prompt.content_session_id,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at,
      prompt.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }
}
