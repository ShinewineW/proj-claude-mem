import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  createUntrackedStderrTailSpawn,
  processRegistry,
} from '../../src/services/worker/ProcessRegistry.js';
import { logger } from '../../src/utils/logger.js';

describe('createUntrackedStderrTailSpawn', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('logs stderrTail on non-zero exit without registering the subprocess', async () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => {});
    spies.push(warnSpy, debugSpy);

    const beforeSize = processRegistry.size;
    const spawnFresh = createUntrackedStderrTailSpawn('fresh-test');
    const child = spawnFresh({
      command: process.execPath,
      args: ['-e', "console.error('fresh stderr detail'); process.exit(7);"],
      cwd: process.cwd(),
      env: process.env,
    }) as { on: (event: 'exit', cb: (code: number | null, signal: string | null) => void) => void };

    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    expect(exit.code).toBe(7);
    expect(processRegistry.size).toBe(beforeSize);

    const warnCall = warnSpy.mock.calls.find(
      (call) => call[0] === 'SDK_SPAWN' && String(call[1]).includes('[fresh-test] Claude process exited'),
    );
    expect(warnCall).toBeDefined();
    const data = warnCall?.[2] as { code?: number | null; stderrTail?: string };
    expect(data.code).toBe(7);
    expect(data.stderrTail).toContain('fresh stderr detail');
  });
});
