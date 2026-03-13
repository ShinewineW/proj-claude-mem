/**
 * Tests for observation route error propagation
 *
 * Verifies that infrastructure errors (e.g., getSessionStore throwing on invalid dbPath)
 * propagate as HTTP 500 instead of being masked as HTTP 200 with { stored: false }.
 *
 * The observation handler should rely on BaseRouteHandler.wrapHandler for error handling,
 * not catch-and-mask errors internally. This matches handleSummarizeByClaudeId which
 * already lets wrapHandler handle errors.
 *
 * Mock Justification:
 * - Logger spies: Suppress console output during tests
 * - Express req/res mocks: Required for testing route handler behavior
 */
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../src/utils/logger.js';
import { BaseRouteHandler } from '../../src/services/worker/http/BaseRouteHandler.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

/**
 * Concrete subclass to expose wrapHandler for testing
 */
class TestRouteHandler extends BaseRouteHandler {
  /**
   * Create a wrapped handler that throws an error on invocation.
   * Simulates what happens when getSessionStore or createSDKSession throws.
   */
  createThrowingHandler(error: Error) {
    return this.wrapHandler((_req: Request, _res: Response): void => {
      throw error;
    });
  }

  /**
   * Create a wrapped handler that catches errors and masks them as 200.
   * This is the CURRENT (broken) pattern in handleObservationsByClaudeId.
   */
  createMaskingHandler(error: Error) {
    return this.wrapHandler((_req: Request, res: Response): void => {
      try {
        throw error;
      } catch (e) {
        res.json({ stored: false, reason: (e as Error).message });
      }
    });
  }
}

function createMockReq(body: Record<string, unknown> = {}, path = '/test'): Request {
  return { body, path } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: null,
    headersSent: false,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      res.headersSent = true;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

describe('Observation error propagation', () => {
  let handler: TestRouteHandler;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
    handler = new TestRouteHandler();
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  describe('wrapHandler propagates errors as 500', () => {
    it('should return HTTP 500 when handler throws (e.g., getSessionStore failure)', () => {
      const dbError = new Error('Invalid dbPath: path traversal detected');
      const wrappedHandler = handler.createThrowingHandler(dbError);

      const req = createMockReq();
      const res = createMockRes();
      wrappedHandler(req, res);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'Invalid dbPath: path traversal detected' });
    });

    it('should return HTTP 500 with error message for DB errors', () => {
      const dbError = new Error('SQLITE_ERROR: no such table');
      const wrappedHandler = handler.createThrowingHandler(dbError);

      const req = createMockReq();
      const res = createMockRes();
      wrappedHandler(req, res);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'SQLITE_ERROR: no such table' });
    });
  });

  describe('masking handler returns 200 (broken behavior)', () => {
    it('should return HTTP 200 even for infrastructure errors — this is the bug', () => {
      const dbError = new Error('Invalid dbPath: path traversal detected');
      const wrappedHandler = handler.createMaskingHandler(dbError);

      const req = createMockReq();
      const res = createMockRes();
      wrappedHandler(req, res);

      // The masking handler returns 200 (default) with { stored: false }
      // This is WRONG — infrastructure errors should be 500
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ stored: false, reason: 'Invalid dbPath: path traversal detected' });
    });
  });
});
