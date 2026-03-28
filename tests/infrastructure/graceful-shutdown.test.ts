import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';

// ---------------------------------------------------------------------------
// Mock ProcessManager to redirect PID file operations to a temp directory.
// GracefulShutdown.ts imports removePidFile and getChildProcesses from
// ProcessManager.js. We mock the entire module so no production paths are
// touched. Must be before the GracefulShutdown import.
// ---------------------------------------------------------------------------
const TEST_DIR = path.join(tmpdir(), `claude-mem-gs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const TEST_DATA_DIR = path.join(TEST_DIR, '.claude-mem');
const TEST_PID_FILE = path.join(TEST_DATA_DIR, 'worker.pid');

function testWritePidFile(info: { pid: number; port: number; startedAt: string }): void {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  writeFileSync(TEST_PID_FILE, JSON.stringify(info, null, 2));
}

function testRemovePidFile(): void {
  if (!existsSync(TEST_PID_FILE)) return;
  unlinkSync(TEST_PID_FILE);
}

mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  writePidFile: testWritePidFile,
  readPidFile: () => {
    if (!existsSync(TEST_PID_FILE)) return null;
    try {
      return JSON.parse(readFileSync(TEST_PID_FILE, 'utf-8'));
    } catch {
      return null;
    }
  },
  removePidFile: testRemovePidFile,
  getChildProcesses: async () => [],
  forceKillProcess: async () => {},
  waitForProcessesExit: async () => {},
}));

import {
  performGracefulShutdown,
  type GracefulShutdownConfig,
  type ShutdownableService,
  type CloseableClient,
  type CloseableDatabase,
} from '../../src/services/infrastructure/GracefulShutdown.js';

describe('GracefulShutdown', () => {
  const originalPlatform = process.platform;

  beforeAll(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Ensure clean state
    if (existsSync(TEST_PID_FILE)) {
      unlinkSync(TEST_PID_FILE);
    }

    // Ensure we're testing on non-Windows to avoid child process enumeration
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    // Clean up any PID file left by tests
    if (existsSync(TEST_PID_FILE)) {
      unlinkSync(TEST_PID_FILE);
    }

    // Restore platform
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  describe('performGracefulShutdown', () => {
    it('should call shutdown steps in correct order', async () => {
      const callOrder: string[] = [];

      const mockServer = {
        closeAllConnections: mock(() => {
          callOrder.push('closeAllConnections');
        }),
        close: mock((cb: (err?: Error) => void) => {
          callOrder.push('serverClose');
          cb();
        })
      } as unknown as http.Server;

      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {
          callOrder.push('sessionManager.shutdownAll');
        })
      };

      const mockMcpClient: CloseableClient = {
        close: mock(async () => {
          callOrder.push('mcpClient.close');
        })
      };

      const mockDbManager: CloseableDatabase = {
        close: mock(async () => {
          callOrder.push('dbManager.close');
        })
      };

      const mockChromaMcpManager = {
        stop: mock(async () => {
          callOrder.push('chromaMcpManager.stop');
        })
      };

      // Create a PID file so we can verify it's removed
      testWritePidFile({ pid: 12345, port: 37777, startedAt: new Date().toISOString() });
      expect(existsSync(TEST_PID_FILE)).toBe(true);

      const config: GracefulShutdownConfig = {
        server: mockServer,
        sessionManager: mockSessionManager,
        mcpClient: mockMcpClient,
        dbManager: mockDbManager,
        chromaMcpManager: mockChromaMcpManager
      };

      await performGracefulShutdown(config);

      // Verify order: PID removal happens first (synchronous), then server, then session, then MCP, then Chroma, then DB
      expect(callOrder).toContain('closeAllConnections');
      expect(callOrder).toContain('serverClose');
      expect(callOrder).toContain('sessionManager.shutdownAll');
      expect(callOrder).toContain('mcpClient.close');
      expect(callOrder).toContain('chromaMcpManager.stop');
      expect(callOrder).toContain('dbManager.close');

      // Verify server closes before session manager
      expect(callOrder.indexOf('serverClose')).toBeLessThan(callOrder.indexOf('sessionManager.shutdownAll'));

      // Verify session manager shuts down before MCP client
      expect(callOrder.indexOf('sessionManager.shutdownAll')).toBeLessThan(callOrder.indexOf('mcpClient.close'));

      // Verify MCP closes before database
      expect(callOrder.indexOf('mcpClient.close')).toBeLessThan(callOrder.indexOf('dbManager.close'));

      // Verify Chroma stops before DB closes
      expect(callOrder.indexOf('chromaMcpManager.stop')).toBeLessThan(callOrder.indexOf('dbManager.close'));
    });

    it('should remove PID file during shutdown', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      // Create PID file
      testWritePidFile({ pid: 99999, port: 37777, startedAt: new Date().toISOString() });
      expect(existsSync(TEST_PID_FILE)).toBe(true);

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      await performGracefulShutdown(config);

      // PID file should be removed
      expect(existsSync(TEST_PID_FILE)).toBe(false);
    });

    it('should handle missing optional services gracefully', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
        // mcpClient and dbManager are undefined
      };

      // Should not throw
      await expect(performGracefulShutdown(config)).resolves.toBeUndefined();

      // Session manager should still be called
      expect(mockSessionManager.shutdownAll).toHaveBeenCalled();
    });

    it('should handle null server gracefully', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      // Should not throw
      await expect(performGracefulShutdown(config)).resolves.toBeUndefined();
    });

    it('should call sessionManager.shutdownAll even without server', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      await performGracefulShutdown(config);

      expect(mockSessionManager.shutdownAll).toHaveBeenCalledTimes(1);
    });

    it('should stop chroma server before database close', async () => {
      const callOrder: string[] = [];

      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {
          callOrder.push('sessionManager');
        })
      };

      const mockMcpClient: CloseableClient = {
        close: mock(async () => {
          callOrder.push('mcpClient');
        })
      };

      const mockDbManager: CloseableDatabase = {
        close: mock(async () => {
          callOrder.push('dbManager');
        })
      };

      const mockChromaMcpManager = {
        stop: mock(async () => {
          callOrder.push('chromaMcpManager');
        })
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager,
        mcpClient: mockMcpClient,
        dbManager: mockDbManager,
        chromaMcpManager: mockChromaMcpManager
      };

      await performGracefulShutdown(config);

      expect(callOrder).toEqual(['sessionManager', 'mcpClient', 'chromaMcpManager', 'dbManager']);
    });

    it('should handle shutdown when PID file does not exist', async () => {
      // Ensure PID file doesn't exist
      testRemovePidFile();
      expect(existsSync(TEST_PID_FILE)).toBe(false);

      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      // Should not throw
      await expect(performGracefulShutdown(config)).resolves.toBeUndefined();
    });
  });
});
