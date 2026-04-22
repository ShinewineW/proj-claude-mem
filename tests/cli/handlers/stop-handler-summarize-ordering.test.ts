// BEHAVIORAL GUARD: protects against regressing Stop Hook Summarize Race.
// Separate file from stop-handler.test.ts per tests/CLAUDE.md mock.module pollution.

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('stop handler — summarize→complete ordering (P5 race guard)', () => {
  let tempDir: string;
  let transcriptPath: string;
  let summarizeAckSent = false;
  const fetchOrder: string[] = [];
  const origFetch = globalThis.fetch;

  beforeAll(() => {
    tempDir = join(tmpdir(), `stop-ordering-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    transcriptPath = join(tempDir, 'transcript.jsonl');
    writeFileSync(transcriptPath,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'test work done' }] } }) + '\n'
    );

    mock.module('../../../src/shared/worker-utils.js', () => ({
      ensureWorkerRunning: async () => true,
      getWorkerPort: () => 37777,
      fetchWithTimeout: async (url: string, _init?: any) => {
        const u = String(url);
        fetchOrder.push(u);
        if (u.includes('/resolve-prompt-number')) {
          return new Response(JSON.stringify({ prompt_number: 1 }), { status: 200 });
        }
        if (u.includes('/summarize')) {
          await new Promise(r => setTimeout(r, 10));
          summarizeAckSent = true;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }
    }));

    globalThis.fetch = (async (url: any, _init?: any) => {
      const u = String(url);
      fetchOrder.push(u);
      if (u.includes('/complete')) {
        expect(summarizeAckSent).toBe(true);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as any;
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('summarize POST is dispatched AND resolves before session-complete fires', async () => {
    const { stopHandler } = await import('../../../src/cli/handlers/stop.js');

    summarizeAckSent = false;
    fetchOrder.length = 0;

    await stopHandler.execute({
      sessionId: 'test-session',
      cwd: process.cwd(),
      transcriptPath,
      _projectContext: {
        projectRoot: process.cwd(),
        dbPath: join(tempDir, 'mem.db'),
        projectName: 'stop-test'
      },
      prompt: '',
      platform: 'claude-code'
    } as any);

    const sIdx = fetchOrder.findIndex(u => u.includes('/summarize'));
    const cIdx = fetchOrder.findIndex(u => u.includes('/complete'));
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeLessThan(cIdx);
    expect(summarizeAckSent).toBe(true);
  });
});
