/**
 * Data Routes
 *
 * Handles data retrieval operations: observations, summaries, prompts, stats, processing status.
 * All endpoints use direct database access via service layer.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { homedir } from 'os';
import { getPackageRoot } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class DataRoutes extends BaseRouteHandler {
  private projectsCache: { data: unknown; expiresAt: number } | null = null;
  private static readonly PROJECTS_CACHE_TTL_MS = 30_000;

  constructor(
    private paginationHelper: PaginationHelper,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService,
    private startTime: number
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Pagination endpoints
    app.get('/api/observations', this.handleGetObservations.bind(this));
    app.get('/api/summaries', this.handleGetSummaries.bind(this));
    app.get('/api/prompts', this.handleGetPrompts.bind(this));

    // Fetch by ID endpoints
    app.get('/api/observation/:id', this.handleGetObservationById.bind(this));
    app.post('/api/observations/batch', this.handleGetObservationsByIds.bind(this));
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.post('/api/sdk-sessions/batch', this.handleGetSdkSessionsByIds.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));

    // Metadata endpoints
    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/stats/trend', this.handleGetStatsTrend.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));
    app.get('/api/recent', this.handleGetRecent.bind(this));

    // Processing status endpoints
    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));
    app.post('/api/processing', this.handleSetProcessing.bind(this));

    // Pending queue management endpoints
    app.get('/api/pending-queue', this.handleGetPendingQueue.bind(this));
    app.post('/api/pending-queue/process', this.handleProcessPendingQueue.bind(this));
    app.delete('/api/pending-queue/failed', this.handleClearFailedQueue.bind(this));
    app.delete('/api/pending-queue/all', this.handleClearAllQueue.bind(this));

    // Import endpoint
    app.post('/api/import', this.handleImport.bind(this));

    // Chroma collection management
    app.delete('/api/chroma-collection', this.handleDeleteChromaCollection.bind(this));
  }

  /**
   * Get paginated observations
   */
  private handleGetObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, dbPath } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getObservations(offset, limit, project, dbPath);
    res.json(result);
  });

  /**
   * Get paginated summaries
   */
  private handleGetSummaries = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, dbPath } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getSummaries(offset, limit, project, dbPath);
    res.json(result);
  });

  /**
   * Get paginated user prompts
   */
  private handleGetPrompts = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, dbPath } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getPrompts(offset, limit, project, dbPath);
    res.json(result);
  });

  /**
   * Get observation by ID
   * GET /api/observation/:id
   */
  private handleGetObservationById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const dbPath = (req.query.dbPath as string) || undefined;
    const store = this.dbManager.getSessionStore(dbPath);
    const observation = store.getObservationById(id);

    if (!observation) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    res.json(observation);
  });

  /**
   * Get observations by array of IDs
   * POST /api/observations/batch
   * Body: { ids: number[], orderBy?: 'date_desc' | 'date_asc', limit?: number, project?: string }
   */
  private handleGetObservationsByIds = this.wrapHandler((req: Request, res: Response): void => {
    let { ids, orderBy, limit, project } = req.body;

    // Coerce string-encoded arrays from MCP clients (e.g. "[1,2,3]" or "1,2,3")
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch { ids = ids.split(',').map(Number); }
    }

    if (!ids || !Array.isArray(ids)) {
      this.badRequest(res, 'ids must be an array of numbers');
      return;
    }

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    // Validate all IDs are numbers
    if (!ids.every(id => typeof id === 'number' && Number.isInteger(id))) {
      this.badRequest(res, 'All ids must be integers');
      return;
    }

    // Validate limit parameter
    if (limit !== undefined) {
      limit = Number(limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        this.badRequest(res, 'limit must be a positive integer <= 1000');
        return;
      }
    }

    const dbPath = (req.body.dbPath as string) || undefined;
    const store = this.dbManager.getSessionStore(dbPath);
    const observations = store.getObservationsByIds(ids, { orderBy, limit, project });

    res.json(observations);
  });

  /**
   * Get session by ID
   * GET /api/session/:id
   */
  private handleGetSessionById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const dbPath = (req.query.dbPath as string) || undefined;
    const store = this.dbManager.getSessionStore(dbPath);
    const sessions = store.getSessionSummariesByIds([id]);

    if (sessions.length === 0) {
      this.notFound(res, `Session #${id} not found`);
      return;
    }

    res.json(sessions[0]);
  });

  /**
   * Get SDK sessions by SDK session IDs
   * POST /api/sdk-sessions/batch
   * Body: { memorySessionIds: string[] }
   */
  private handleGetSdkSessionsByIds = this.wrapHandler((req: Request, res: Response): void => {
    let { memorySessionIds } = req.body;

    // Coerce string-encoded arrays from MCP clients (e.g. '["a","b"]' or "a,b")
    if (typeof memorySessionIds === 'string') {
      try { memorySessionIds = JSON.parse(memorySessionIds); } catch { memorySessionIds = memorySessionIds.split(',').map((s: string) => s.trim()); }
    }

    if (!Array.isArray(memorySessionIds)) {
      this.badRequest(res, 'memorySessionIds must be an array');
      return;
    }

    const dbPath = (req.body.dbPath as string) || undefined;
    const store = this.dbManager.getSessionStore(dbPath);
    const sessions = store.getSdkSessionsBySessionIds(memorySessionIds);
    res.json(sessions);
  });

  /**
   * Get user prompt by ID
   * GET /api/prompt/:id
   */
  private handleGetPromptById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const dbPath = (req.query.dbPath as string) || undefined;
    const store = this.dbManager.getSessionStore(dbPath);
    const prompts = store.getUserPromptsByIds([id]);

    if (prompts.length === 0) {
      this.notFound(res, `Prompt #${id} not found`);
      return;
    }

    res.json(prompts[0]);
  });

  /**
   * Get database statistics (with worker metadata)
   * Supports ?dbPath= to query a specific project database.
   */
  private handleGetStats = this.wrapHandler((req: Request, res: Response): void => {
    const requestDbPath = (req.query.dbPath as string) || undefined;
    const db = this.dbManager.getSessionStore(requestDbPath).db;

    // Read version from package.json
    const packageRoot = getPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    // Get database stats
    const totalObservations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
    const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
    const totalSummaries = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

    // Get database file size and path from the actual DB being queried
    const actualDbPath = requestDbPath || path.join(homedir(), '.claude-mem', 'claude-mem.db');
    let dbSize = 0;
    if (existsSync(actualDbPath)) {
      dbSize = statSync(actualDbPath).size;
    }

    // Worker metadata
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const activeSessions = this.sessionManager.getActiveSessionCount();
    const sseClients = this.sseBroadcaster.getClientCount();

    res.json({
      worker: {
        version,
        uptime,
        activeSessions,
        sseClients,
        port: getWorkerPort()
      },
      database: {
        path: actualDbPath,
        size: dbSize,
        observations: totalObservations.count,
        sessions: totalSessions.count,
        summaries: totalSummaries.count
      }
    });
  });

  /**
   * Get list of distinct projects from observations
   * GET /api/projects
   *
   * Per-project isolation: reads allowlist to discover all enabled project DBs,
   * queries each for distinct project names, and returns with dbPath for the frontend.
   */
  private handleGetProjects = this.wrapHandler((req: Request, res: Response): void => {
    const dbPath = req.query.dbPath as string | undefined;

    // If dbPath specified, query that specific DB
    if (dbPath) {
      const db = this.dbManager.getSessionStore(dbPath).db;
      const rows = db.prepare(`
        SELECT DISTINCT project
        FROM observations
        WHERE project IS NOT NULL AND project != ''
        GROUP BY project
        ORDER BY MAX(created_at_epoch) DESC
      `).all() as Array<{ project: string }>;
      res.json({ projects: rows.map(row => row.project) });
      return;
    }

    // No dbPath: aggregate from allowlist + global DB (with 30s cache)
    if (this.projectsCache && Date.now() < this.projectsCache.expiresAt) {
      res.json(this.projectsCache.data);
      return;
    }

    const allProjects: Array<{
      project: string;
      dbPath: string;
      projectRoot?: string;
      obsCount?: number;
      sumCount?: number;
      promptCount?: number;
      hasActiveSession?: boolean;
      latestItems?: Array<{ itemType: string; id: number; title?: string; text?: string; type?: string; prompt_text?: string; created_at_epoch: number }>;
    }> = [];

    // Pre-compute active project names for hasActiveSession enrichment
    const activeProjectNames = this.sessionManager.getActiveProjectNames();

    // 1. Query global DB (may contain legacy data before per-project isolation)
    try {
      const globalDb = this.dbManager.getSessionStore().db;
      const globalRows = globalDb.prepare(`
        SELECT DISTINCT project FROM observations
        WHERE project IS NOT NULL AND project != ''
        GROUP BY project ORDER BY MAX(created_at_epoch) DESC
      `).all() as Array<{ project: string }>;
      for (const row of globalRows) {
        allProjects.push({ project: row.project, dbPath: '' });
      }
    } catch (globalError) {
      logger.debug('DATA', 'Global DB query skipped (may be empty or missing tables)', {
        error: globalError instanceof Error ? globalError.message : String(globalError)
      });
    }

    // 2. Query each enabled project from allowlist
    try {
      const { listEnabledProjects } = require('../../../../shared/project-allowlist.js');
      const { resolveProjectDbPath } = require('../../../../shared/paths.js');
      const enabled = listEnabledProjects();
      for (const projectRoot of Object.keys(enabled)) {
        try {
          const projDbPath = resolveProjectDbPath(projectRoot);
          const projDb = this.dbManager.getSessionStore(projDbPath).db;

          // Try observations first, fall back to sdk_sessions for projects with no observations yet
          let rows = projDb.prepare(`
            SELECT DISTINCT project FROM observations
            WHERE project IS NOT NULL AND project != ''
            GROUP BY project ORDER BY MAX(created_at_epoch) DESC
          `).all() as Array<{ project: string }>;

          if (rows.length === 0) {
            rows = projDb.prepare(`
              SELECT DISTINCT project FROM sdk_sessions
              WHERE project IS NOT NULL AND project != ''
              ORDER BY project ASC
            `).all() as Array<{ project: string }>;
          }

          // Count queries for enrichment
          const obsCount = (projDb.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count;
          const sumCount = (projDb.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number }).count;
          const promptCount = (projDb.prepare('SELECT COUNT(*) as count FROM user_prompts').get() as { count: number }).count;

          // Query 1 latest non-ask (observation or summary) + 1 latest ask (prompt)
          const latestNonAsk = projDb.prepare(`
            SELECT 'observation' as itemType, id, title, text, type, created_at_epoch
            FROM observations ORDER BY created_at_epoch DESC LIMIT 1
          `).all() as Array<{ itemType: string; id: number; title: string; text: string; type: string; created_at_epoch: number }>;
          const latestSummary = projDb.prepare(`
            SELECT 'summary' as itemType, id, request as title, investigated as text, created_at_epoch
            FROM session_summaries ORDER BY created_at_epoch DESC LIMIT 1
          `).all() as Array<{ itemType: string; id: number; title: string; text: string; created_at_epoch: number }>;
          // Pick the most recent between observation and summary
          const nonAskCandidates = [...latestNonAsk, ...latestSummary]
            .sort((a, b) => b.created_at_epoch - a.created_at_epoch);
          const latestAsk = projDb.prepare(`
            SELECT 'prompt' as itemType, id, prompt_text, created_at_epoch
            FROM user_prompts ORDER BY created_at_epoch DESC LIMIT 1
          `).all() as Array<{ itemType: string; id: number; prompt_text: string; created_at_epoch: number }>;
          const latestItems = [
            ...(nonAskCandidates.length > 0 ? [nonAskCandidates[0]] : []),
            ...latestAsk,
          ];

          for (const row of rows) {
            if (!allProjects.some(p => p.project === row.project && p.dbPath === projDbPath)) {
              allProjects.push({
                project: row.project,
                dbPath: projDbPath,
                projectRoot,
                obsCount,
                sumCount,
                promptCount,
                hasActiveSession: activeProjectNames.has(row.project),
                latestItems
              });
            }
          }
        } catch (projError) {
          logger.warn('DATA', `Failed to query project DB for ${projectRoot}`, {
            error: projError instanceof Error ? projError.message : String(projError)
          });
        }
      }
    } catch (allowlistError) {
      logger.warn('DATA', 'Failed to scan allowlist for projects', {
        error: allowlistError instanceof Error ? allowlistError.message : String(allowlistError)
      });
    }

    // Return both flat list (backward compat) and enriched list
    const responseData = {
      projects: allProjects.map(p => p.project),
      projectDatabases: allProjects
    };
    this.projectsCache = { data: responseData, expiresAt: Date.now() + DataRoutes.PROJECTS_CACHE_TTL_MS };
    res.json(responseData);
  });

  /**
   * Get recent items across all enabled projects
   * GET /api/recent?limit=20
   *
   * Returns observations, summaries, and user_prompts merged and sorted by epoch desc.
   */
  private handleGetRecent = this.wrapHandler((req: Request, res: Response): void => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);

    const allItems: Array<{ itemType: string; project: string; [key: string]: unknown }> = [];

    try {
    const { listEnabledProjects } = require('../../../../shared/project-allowlist.js');
    const { resolveProjectDbPath } = require('../../../../shared/paths.js');
    const enabled = listEnabledProjects();

    for (const projectRoot of Object.keys(enabled)) {
      try {
        const projDbPath = resolveProjectDbPath(projectRoot);
        const projDb = this.dbManager.getSessionStore(projDbPath).db;

        const recentObs = projDb.prepare(`
          SELECT 'observation' as itemType, id, title, subtitle, narrative, text, facts, concepts,
                 files_read, files_modified, type, project, created_at, created_at_epoch,
                 memory_session_id, prompt_number
          FROM observations ORDER BY created_at_epoch DESC LIMIT ?
        `).all(limit) as Array<{ itemType: string; project: string; created_at_epoch: number }>;

        const recentSums = projDb.prepare(`
          SELECT 'summary' as itemType, id, memory_session_id as session_id, request, investigated,
                 learned, completed, next_steps, files_read, files_edited, notes, prompt_number,
                 project, created_at_epoch
          FROM session_summaries ORDER BY created_at_epoch DESC LIMIT ?
        `).all(limit) as Array<{ itemType: string; project: string; created_at_epoch: number }>;

        const recentPrompts = projDb.prepare(`
          SELECT 'prompt' as itemType, up.id, up.content_session_id, s.project, up.prompt_number,
                 up.prompt_text, up.created_at, up.created_at_epoch
          FROM user_prompts up
          JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
          ORDER BY up.created_at_epoch DESC LIMIT ?
        `).all(limit) as Array<{ itemType: string; project: string; created_at_epoch: number }>;

        allItems.push(...recentObs, ...recentSums, ...recentPrompts);
      } catch (projError) {
        logger.warn('DATA', `Failed to query recent items for ${projectRoot}`, {
          error: projError instanceof Error ? projError.message : String(projError)
        });
      }
    }
    } catch (allowlistError) {
      logger.warn('DATA', 'Failed to scan allowlist for recent items', {
        error: allowlistError instanceof Error ? allowlistError.message : String(allowlistError)
      });
    }

    // Sort by epoch desc and take top `limit`
    allItems.sort((a, b) => (b.created_at_epoch as number) - (a.created_at_epoch as number));
    const items = allItems.slice(0, limit);

    res.json({ items });
  });

  /**
   * Get activity trend stats across all enabled projects
   * GET /api/stats/trend?days=7
   *
   * Returns daily observation and summary counts for the specified time window.
   */
  private handleGetStatsTrend = this.wrapHandler((req: Request, res: Response): void => {
    const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 7, 1), 365);
    const sinceEpoch = Date.now() - days * 86400000;

    const obsMap = new Map<string, number>();
    const sumMap = new Map<string, number>();

    try {
      const { listEnabledProjects } = require('../../../../shared/project-allowlist.js');
      const { resolveProjectDbPath } = require('../../../../shared/paths.js');
      const enabled = listEnabledProjects();

      for (const projectRoot of Object.keys(enabled)) {
        try {
          const projDbPath = resolveProjectDbPath(projectRoot);
          const projDb = this.dbManager.getSessionStore(projDbPath).db;

          const obsTrend = projDb.prepare(`
            SELECT date(created_at) as day, COUNT(*) as count
            FROM observations WHERE created_at_epoch > ?
            GROUP BY date(created_at) ORDER BY day
          `).all(sinceEpoch) as Array<{ day: string; count: number }>;

          for (const row of obsTrend) {
            obsMap.set(row.day, (obsMap.get(row.day) || 0) + row.count);
          }

          const sumTrend = projDb.prepare(`
            SELECT date(created_at) as day, COUNT(*) as count
            FROM session_summaries WHERE created_at_epoch > ?
            GROUP BY date(created_at) ORDER BY day
          `).all(sinceEpoch) as Array<{ day: string; count: number }>;

          for (const row of sumTrend) {
            sumMap.set(row.day, (sumMap.get(row.day) || 0) + row.count);
          }
        } catch (projError) {
          logger.warn('DATA', `Failed to query trend data for ${projectRoot}`, {
            error: projError instanceof Error ? projError.message : String(projError)
          });
        }
      }
    } catch (allowlistError) {
      logger.warn('DATA', 'Failed to scan allowlist for trend data', {
        error: allowlistError instanceof Error ? allowlistError.message : String(allowlistError)
      });
    }

    const observations = [...obsMap.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));
    const summaries = [...sumMap.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));

    res.json({ observations, summaries });
  });

  /**
   * Get current processing status
   * GET /api/processing-status
   */
  private handleGetProcessingStatus = this.wrapHandler((req: Request, res: Response): void => {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    res.json({ isProcessing, queueDepth });
  });

  /**
   * Set processing status (called by hooks)
   * NOTE: This now broadcasts computed status based on active processing (ignores input)
   */
  private handleSetProcessing = this.wrapHandler((req: Request, res: Response): void => {
    // Broadcast current computed status (ignores manual input)
    this.workerService.broadcastProcessingStatus();

    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalQueueDepth();
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({ status: 'ok', isProcessing, queueDepth, activeSessions });
  });

  /**
   * Parse pagination parameters from request query
   */
  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string; dbPath?: string } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); // Max 100
    const project = req.query.project as string | undefined;
    const dbPath = req.query.dbPath as string | undefined;

    return { offset, limit, project, dbPath };
  }

  /**
   * Import memories from export file
   * POST /api/import
   * Body: { sessions: [], summaries: [], observations: [], prompts: [] }
   */
  private handleImport = this.wrapHandler((req: Request, res: Response): void => {
    const { sessions, summaries, observations, prompts } = req.body;

    const stats = {
      sessionsImported: 0,
      sessionsSkipped: 0,
      summariesImported: 0,
      summariesSkipped: 0,
      observationsImported: 0,
      observationsSkipped: 0,
      promptsImported: 0,
      promptsSkipped: 0
    };

    const dbPath = (req.body.dbPath as string) || undefined;
    const store = this.dbManager.getSessionStore(dbPath);

    // Import sessions first (dependency for everything else)
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        const result = store.importSdkSession(session);
        if (result.imported) {
          stats.sessionsImported++;
        } else {
          stats.sessionsSkipped++;
        }
      }
    }

    // Import summaries (depends on sessions)
    if (Array.isArray(summaries)) {
      for (const summary of summaries) {
        const result = store.importSessionSummary(summary);
        if (result.imported) {
          stats.summariesImported++;
        } else {
          stats.summariesSkipped++;
        }
      }
    }

    // Import observations (depends on sessions)
    if (Array.isArray(observations)) {
      for (const obs of observations) {
        const result = store.importObservation(obs);
        if (result.imported) {
          stats.observationsImported++;
        } else {
          stats.observationsSkipped++;
        }
      }
    }

    // Import prompts (depends on sessions)
    if (Array.isArray(prompts)) {
      for (const prompt of prompts) {
        const result = store.importUserPrompt(prompt);
        if (result.imported) {
          stats.promptsImported++;
        } else {
          stats.promptsSkipped++;
        }
      }
    }

    res.json({
      success: true,
      stats
    });
  });

  /**
   * Get pending queue contents
   * GET /api/pending-queue
   * Returns all pending, processing, and failed messages with optional recently processed
   */
  private handleGetPendingQueue = this.wrapHandler((req: Request, res: Response): void => {
    const { PendingMessageStore } = require('../../../sqlite/PendingMessageStore.js');
    const dbPath = (req.query.dbPath as string) || undefined;
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore(dbPath).db, 3);

    // Get queue contents (pending, processing, failed)
    const queueMessages = pendingStore.getQueueMessages();

    // Get recently processed (last 30 min, up to 20)
    const recentlyProcessed = pendingStore.getRecentlyProcessed(20, 30);

    // Get stuck message count (processing > 5 min)
    const stuckCount = pendingStore.getStuckCount(5 * 60 * 1000);

    // Get sessions with pending work
    const sessionsWithPending = pendingStore.getSessionsWithPendingMessages();

    res.json({
      queue: {
        messages: queueMessages,
        totalPending: queueMessages.filter((m: { status: string }) => m.status === 'pending').length,
        totalProcessing: queueMessages.filter((m: { status: string }) => m.status === 'processing').length,
        totalFailed: queueMessages.filter((m: { status: string }) => m.status === 'failed').length,
        stuckCount
      },
      recentlyProcessed,
      sessionsWithPendingWork: sessionsWithPending
    });
  });

  /**
   * Process pending queue
   * POST /api/pending-queue/process
   * Body: { sessionLimit?: number } - defaults to 10
   * Starts SDK agents for sessions with pending messages
   */
  private handleProcessPendingQueue = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionLimit = Math.min(
      Math.max(parseInt(req.body.sessionLimit, 10) || 10, 1),
      100 // Max 100 sessions at once
    );

    const result = await this.workerService.processPendingQueues(sessionLimit);

    res.json({
      success: true,
      ...result
    });
  });

  /**
   * Clear all failed messages from the queue
   * DELETE /api/pending-queue/failed
   * Returns the number of messages cleared
   */
  private handleClearFailedQueue = this.wrapHandler((req: Request, res: Response): void => {
    const { PendingMessageStore } = require('../../../sqlite/PendingMessageStore.js');
    const dbPath = (req.query.dbPath as string) || undefined;
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore(dbPath).db, 3);

    const clearedCount = pendingStore.clearFailed();

    logger.info('QUEUE', 'Cleared failed queue messages', { clearedCount });

    res.json({
      success: true,
      clearedCount
    });
  });

  /**
   * Delete a Chroma collection for a specific project database.
   * DELETE /api/chroma-collection?dbPath=...
   */
  private handleDeleteChromaCollection = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const dbPath = (req.query.dbPath as string) || undefined;
    if (!dbPath) {
      res.status(400).json({ success: false, error: 'dbPath query parameter is required' });
      return;
    }

    const deleted = await this.dbManager.removeChromaSync(dbPath, true);

    res.json({
      success: true,
      deleted,
      message: deleted ? 'Chroma collection deleted and cache cleared' : 'No cached ChromaSync found (collection may not exist)'
    });
  });

  /**
   * Clear all messages from the queue (pending, processing, and failed)
   * DELETE /api/pending-queue/all
   * Returns the number of messages cleared
   */
  private handleClearAllQueue = this.wrapHandler((req: Request, res: Response): void => {
    const { PendingMessageStore } = require('../../../sqlite/PendingMessageStore.js');
    const dbPath = (req.query.dbPath as string) || undefined;
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore(dbPath).db, 3);

    const clearedCount = pendingStore.clearAll();

    logger.warn('QUEUE', 'Cleared ALL queue messages (pending, processing, failed)', { clearedCount });

    res.json({
      success: true,
      clearedCount
    });
  });
}
