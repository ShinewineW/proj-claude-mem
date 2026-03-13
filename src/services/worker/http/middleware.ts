/**
 * HTTP Middleware for Worker Service
 *
 * Extracted from WorkerService.ts for better organization.
 * Handles request/response logging, CORS, JSON parsing, and static file serving.
 */

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import path from 'path';
import { getPackageRoot } from '../../../shared/paths.js';
import { isProjectEnabled } from '../../../shared/project-allowlist.js';
import { logger } from '../../../utils/logger.js';

/**
 * Create all middleware for the worker service
 * @param summarizeRequestBody - Function to summarize request bodies for logging
 * @returns Array of middleware functions
 */
export function createMiddleware(
  summarizeRequestBody: (method: string, path: string, body: any) => string
): RequestHandler[] {
  const middlewares: RequestHandler[] = [];

  // JSON parsing with 50mb limit
  middlewares.push(express.json({ limit: '50mb' }));

  // CORS - restrict to localhost origins only
  middlewares.push(cors({
    origin: (origin, callback) => {
      // Allow: requests without Origin header (hooks, curl, CLI tools)
      // Allow: localhost and 127.0.0.1 origins
      if (!origin ||
          origin.startsWith('http://localhost:') ||
          origin.startsWith('http://127.0.0.1:')) {
        callback(null, true);
      } else {
        callback(new Error('CORS not allowed'));
      }
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false
  }));

  // HTTP request/response logging
  middlewares.push((req: Request, res: Response, next: NextFunction) => {
    // Skip logging for static assets, health checks, and polling endpoints
    const staticExtensions = ['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.eot'];
    const isStaticAsset = staticExtensions.some(ext => req.path.endsWith(ext));
    const isPollingEndpoint = req.path === '/api/logs'; // Skip logs endpoint to avoid noise from auto-refresh
    if (req.path.startsWith('/health') || req.path === '/' || isStaticAsset || isPollingEndpoint) {
      return next();
    }

    const start = Date.now();
    const requestId = `${req.method}-${Date.now()}`;

    // Log incoming request with body summary
    const bodySummary = summarizeRequestBody(req.method, req.path, req.body);
    logger.info('HTTP', `→ ${req.method} ${req.path}`, { requestId }, bodySummary);

    // Capture response
    const originalSend = res.send.bind(res);
    res.send = function(body: any) {
      const duration = Date.now() - start;
      logger.info('HTTP', `← ${res.statusCode} ${req.path}`, { requestId, duration: `${duration}ms` });
      return originalSend(body);
    };

    next();
  });

  // Serve static files for web UI (viewer-bundle.js, logos, fonts, etc.)
  const packageRoot = getPackageRoot();
  const uiDir = path.join(packageRoot, 'plugin', 'ui');
  middlewares.push(express.static(uiDir));

  return middlewares;
}

/**
 * Middleware to require localhost-only access
 * Used for admin endpoints that should not be exposed when binding to 0.0.0.0
 */
export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  const clientIp = req.ip || req.connection.remoteAddress || '';
  const isLocalhost =
    clientIp === '127.0.0.1' ||
    clientIp === '::1' ||
    clientIp === '::ffff:127.0.0.1' ||
    clientIp === 'localhost';

  if (!isLocalhost) {
    logger.warn('SECURITY', 'Admin endpoint access denied - not localhost', {
      endpoint: req.path,
      clientIp,
      method: req.method
    });
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin endpoints are only accessible from localhost'
    });
    return;
  }

  next();
}

/**
 * Middleware to enforce per-project allowlist at the worker HTTP layer.
 * Defense-in-depth: even if CLI hook guard is bypassed, the worker rejects
 * requests targeting non-enabled projects.
 *
 * Behavior:
 * - Requests without dbPath are allowed (use global fallback, existing validateDbPath protects)
 * - Requests with dbPath for enabled projects are allowed
 * - Requests with dbPath for non-enabled projects are rejected with 403
 */
export function allowlistGuard(req: Request, res: Response, next: NextFunction): void {
  // Prefer body (POST), fall back to query (GET). Explicit type check avoids falsy coercion.
  const rawDbPath = req.body?.dbPath ?? req.query?.dbPath;
  const dbPath: string | undefined =
    typeof rawDbPath === 'string' && rawDbPath.length > 0 ? rawDbPath : undefined;
  if (!dbPath) {
    next();
    return;
  }

  // Derive project root from dbPath. Convention: <projectRoot>/.claude/mem.db
  const claudeDir = path.dirname(dbPath);
  if (path.basename(claudeDir) !== '.claude') {
    // Non-standard dbPath — only allow if CLAUDE_MEM_PROJECT_DB_PATH env override is set
    if (process.env.CLAUDE_MEM_PROJECT_DB_PATH === dbPath) {
      next();
      return;
    }
    logger.warn('SECURITY', 'Rejected non-standard dbPath without env override', {
      endpoint: req.path, dbPath
    });
    res.status(403).json({ error: 'Invalid dbPath format' });
    return;
  }
  const projectRoot = path.dirname(claudeDir);
  if (isProjectEnabled(projectRoot)) {
    next();
    return;
  }

  logger.warn('SECURITY', 'Allowlist guard rejected request for non-enabled project', {
    endpoint: req.path,
    method: req.method,
    projectRoot
  });
  res.status(403).json({
    error: 'Project not enabled',
    message: 'This project is not opted in for claude-mem recording. Use /mem-enable to opt in.'
  });
}

/**
 * Summarize request body for logging
 * Used to avoid logging sensitive data or large payloads
 */
export function summarizeRequestBody(method: string, path: string, body: any): string {
  if (!body || Object.keys(body).length === 0) return '';

  // Session init
  if (path.includes('/init')) {
    return '';
  }

  // Observations
  if (path.includes('/observations')) {
    const toolName = body.tool_name || '?';
    const toolInput = body.tool_input;
    const toolSummary = logger.formatTool(toolName, toolInput);
    return `tool=${toolSummary}`;
  }

  // Summarize request
  if (path.includes('/summarize')) {
    return 'requesting summary';
  }

  return '';
}
