/**
 * Viewer Routes
 *
 * Handles health check, viewer UI, and SSE stream endpoints.
 * These are used by the web viewer UI at http://localhost:37777
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { getPackageRoot, resolveProjectDbPath } from '../../../../shared/paths.js';
import { listEnabledProjects } from '../../../../shared/project-allowlist.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class ViewerRoutes extends BaseRouteHandler {
  constructor(
    private sseBroadcaster: SSEBroadcaster,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Serve static UI assets (JS, CSS, fonts, etc.)
    const packageRoot = getPackageRoot();
    app.use(express.static(path.join(packageRoot, 'ui')));

    app.get('/health', this.handleHealth.bind(this));
    app.get('/', this.handleViewerUI.bind(this));
    app.get('/stream', this.handleSSEStream.bind(this));
  }

  /**
   * Health check endpoint
   */
  private handleHealth = this.wrapHandler((req: Request, res: Response): void => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  /**
   * Serve viewer UI
   */
  private handleViewerUI = this.wrapHandler((req: Request, res: Response): void => {
    const packageRoot = getPackageRoot();

    // Try cache structure first (ui/viewer.html), then marketplace structure (plugin/ui/viewer.html)
    const viewerPaths = [
      path.join(packageRoot, 'ui', 'viewer.html'),
      path.join(packageRoot, 'plugin', 'ui', 'viewer.html')
    ];

    const viewerPath = viewerPaths.find(p => existsSync(p));

    if (!viewerPath) {
      throw new Error('Viewer UI not found at any expected location');
    }

    const html = readFileSync(viewerPath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  /**
   * Aggregate project names from all enabled project databases.
   * Replaces the previous getSessionStore().getAllProjects() which queried
   * only the global/default DB, leaking cross-project data in the Viewer UI.
   */
  /** Cache for aggregated project list (30s TTL to avoid disk I/O on every SSE connect) */
  private cachedProjects: string[] | null = null;
  private cacheExpiry = 0;

  private getProjectsFromAllowlist(): string[] {
    if (this.cachedProjects && Date.now() < this.cacheExpiry) {
      return this.cachedProjects;
    }
    const projects = new Set<string>();
    const enabled = listEnabledProjects();
    for (const projectRoot of Object.keys(enabled)) {
      try {
        const dbPath = resolveProjectDbPath(projectRoot);
        const store = this.dbManager.getSessionStore(dbPath);
        for (const name of store.getAllProjects()) {
          projects.add(name);
        }
      } catch (err) {
        logger.debug('VIEWER', `Skipping inaccessible project DB for ${projectRoot}`, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    this.cachedProjects = [...projects];
    this.cacheExpiry = Date.now() + 30_000;
    return this.cachedProjects;
  }

  /**
   * SSE stream endpoint
   */
  private handleSSEStream = this.wrapHandler((req: Request, res: Response): void => {
    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to broadcaster
    this.sseBroadcaster.addClient(res);

    // Send initial state to this client only (not broadcast to all connected clients)
    const allProjects = this.getProjectsFromAllowlist();
    res.write(`data: ${JSON.stringify({
      type: 'initial_load',
      projects: allProjects,
      timestamp: Date.now()
    })}\n\n`);

    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork();
    res.write(`data: ${JSON.stringify({
      type: 'processing_status',
      isProcessing,
      queueDepth
    })}\n\n`);
  });
}
