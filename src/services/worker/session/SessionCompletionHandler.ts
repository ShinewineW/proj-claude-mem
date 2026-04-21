/**
 * Session Completion Handler
 *
 * Semantic split:
 * - POST /api/sessions/:id/complete → completeByDbId → closeSession
 *   (~5ms, async summary via SummaryLane; Stop hook production path).
 * - DELETE /api/sessions/:id       → deleteByDbId → deleteSession
 *   (close + finalize, immediate cleanup; admin emergency path).
 *
 * closeSession internally broadcasts session_completed — the handler no
 * longer re-broadcasts. Double-broadcast would reach the viewer as two
 * independent events and leave state handlers racing each other.
 */

import { SessionManager } from '../SessionManager.js';
import { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';

export class SessionCompletionHandler {
  constructor(
    private sessionManager: SessionManager,
    private eventBroadcaster: SessionEventBroadcaster,
  ) {}

  /**
   * Stop-hook production path. Non-blocking close: marks DB completed,
   * broadcasts via SessionManager, retains in-memory session so SummaryLane
   * can still look it up. Returns ~5ms.
   */
  async completeByDbId(sessionDbId: number, dbPath?: string, _project?: string): Promise<void> {
    await this.sessionManager.closeSession(sessionDbId, dbPath);
  }

  /**
   * Admin DELETE path. closeSession + finalizeSession. In-flight summarize
   * rows remain in pending_messages and continue to be processed by
   * SummaryLane — the DB row persists (marked completed) so the summary
   * lands against the completed session.
   */
  async deleteByDbId(sessionDbId: number, dbPath?: string, _project?: string): Promise<void> {
    await this.sessionManager.deleteSession(sessionDbId, dbPath);
  }
}
