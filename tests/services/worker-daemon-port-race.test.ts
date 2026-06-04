import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Source-inspection tests for the worker startup port race (#1447).
 * When the MCP server and SessionStart hook both spawn a daemon concurrently,
 * the loser of the bind race must verify the winner is healthy and exit cleanly
 * instead of logging an ERROR. The race is non-deterministic, so we pin the guard
 * shape in source.
 */
const WORKER_SERVICE_PATH = join(import.meta.dir, '../../src/services/worker-service.ts');
const source = readFileSync(WORKER_SERVICE_PATH, 'utf-8');

describe('Worker daemon port-race guard (#1447)', () => {
  it('detects EADDRINUSE in the port-conflict check', () => {
    expect(source).toContain("code === 'EADDRINUSE'");
  });

  it('detects the port-in-use message via regex', () => {
    expect(source).toContain('/port.*in use|address.*in use/i.test(error.message)');
  });

  it('calls waitForHealth before exiting on a port conflict', () => {
    expect(source).toContain('isPortConflict && await waitForHealth(port,');
  });

  it('uses an async catch handler so it can await the health check', () => {
    expect(source).toContain('worker.start().catch(async (error) =>');
  });

  it('logs info (not failure) on the clean exit path', () => {
    expect(source).toContain("logger.info('SYSTEM', 'Duplicate daemon exiting");
  });
});
