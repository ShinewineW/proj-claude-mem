import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Singleton enforcement regression coverage for issue #2313 (fork adaptation).
//
// Prior to the fix, ChromaMcpManager leaked its chroma-mcp subprocess tree on
// every reconnect / transport error, accumulating 20+ instances per session on
// Linux because the MCP SDK's transport.close() only signals the direct child.
// The fix routes every "abandon current transport" path through
// disposeCurrentSubprocess(), which tree-kills via killProcessTree() before
// nulling handles. (Fork has no src/supervisor/, so supervisor mocks dropped.)

let transportCount = 0;
const transportInstances: Array<FakeTransport> = [];

interface FakeChildProcess {
  pid: number;
  once: (event: string, _cb: (...args: unknown[]) => void) => FakeChildProcess;
  on: (event: string, _cb: (...args: unknown[]) => void) => FakeChildProcess;
}

class FakeTransport {
  static nextPid = 100_000;
  onclose: (() => void) | null = null;
  closed = false;
  // Mimic StdioClientTransport's internal `_process` field that the manager
  // pokes into via `(this.transport as unknown as { _process })._process`.
  _process: FakeChildProcess;

  constructor(_opts: { command: string; args: string[] }) {
    transportCount += 1;
    const pid = FakeTransport.nextPid++;
    const child: FakeChildProcess = {
      pid,
      once: function (this: FakeChildProcess) { return this; },
      on: function (this: FakeChildProcess) { return this; },
    };
    this._process = child;
    transportInstances.push(this);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeTransport,
}));

let connectImpl: () => Promise<void> = async () => {};
let callToolImpl: () => Promise<unknown> = async () => ({
  content: [{ type: 'text', text: '{}' }],
});

class FakeClient {
  closed = false;
  async connect(): Promise<void> {
    await connectImpl();
  }
  async callTool(): Promise<unknown> {
    return await callToolImpl();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: () => '',
    getInt: () => 0,
    loadFromFile: () => ({}),
  },
}));

// Fork paths.js only needs USER_SETTINGS_PATH (no paths.chroma()/combinedCerts()).
mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
  },
}));

// Track tree-kill invocations and the transport whose subprocess was killed.
const killTreeCalls: number[] = [];

// Replace child_process.execFile so the static killProcessTree implementation
// can be observed without actually shelling out. We feed pgrep an empty stdout
// (no descendants) so the only signal target is the root pid. The source
// imports from the bare 'child_process' specifier, so mock that exactly.
mock.module('child_process', () => {
  const original = require('node:child_process');
  return {
    ...original,
    execFile: (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: { stdout: string; stderr: string }) => void
    ) => {
      cb(null, { stdout: '', stderr: '' } as any);
    },
    execSync: () => '',
  };
});

// Stub process.kill so the tree-kill path can record targets without crashing
// the runner if a synthetic PID collides with a real process.
const realProcessKill = process.kill.bind(process);
const stubbedProcessKill = ((pid: number, _signal?: string | number) => {
  killTreeCalls.push(pid);
  return true;
}) as typeof process.kill;
process.kill = stubbedProcessKill;

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

function resetState(): void {
  transportCount = 0;
  transportInstances.length = 0;
  killTreeCalls.length = 0;
  connectImpl = async () => {};
  callToolImpl = async () => ({ content: [{ type: 'text', text: '{}' }] });
}

describe('ChromaMcpManager singleton enforcement (#2313)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    resetState();
  });

  it('serializes concurrent ensureConnected() calls into one spawn', async () => {
    const mgr = ChromaMcpManager.getInstance();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        mgr.callTool('chroma_list_collections', { limit: 1 })
      )
    );
    expect(transportCount).toBe(1);
  });

  it('kills the prior subprocess tree before a reconnect spawn', async () => {
    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);
    const firstPid = transportInstances[0]._process.pid;

    let invocations = 0;
    callToolImpl = async () => {
      invocations += 1;
      if (invocations === 1) {
        throw new Error('Connection closed');
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(transportInstances.length).toBe(2);
    expect(killTreeCalls).toContain(firstPid);
  });

  it('stop() disposes state including any pending connecting promise', async () => {
    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);
    const subprocessPid = transportInstances[0]._process.pid;

    await mgr.stop();
    expect(killTreeCalls).toContain(subprocessPid);

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(2);
  });
});

process.on('exit', () => {
  process.kill = realProcessKill;
});
