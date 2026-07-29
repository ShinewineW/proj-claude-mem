import { describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { replayFallbackEntriesForWorker } from '../../src/services/worker/fallback-replay.js';

describe('WorkerService fallback summarize replay', () => {
  it('resolves legacy payload attribution and turn identity at the fallback timestamp', async () => {
    const fallbackDir = mkdtempSync(join(tmpdir(), 'claude-mem-fallback-replay-'));
    const store = new SessionStore(':memory:');

    try {
      const contentSessionId = 'cs-legacy-fallback';
      const dbPath = '/test/project/.claude/mem.db';
      const sessionDbId = store.createSDKSession(contentSessionId, 'project', 'first');
      const insertPrompt = store.db.prepare(`
        INSERT INTO user_prompts
          (content_session_id, prompt_number, prompt_text,
           created_at, created_at_epoch, is_redacted)
        VALUES (?, ?, ?, '', ?, ?)
      `);
      insertPrompt.run(contentSessionId, 1, 'real prompt', 1_000, 0);
      insertPrompt.run(contentSessionId, 2, '', 2_000, 1);
      insertPrompt.run(contentSessionId, 3, 'future prompt', 3_000, 0);

      const fallbackEntry = {
        type: 'summarize',
        sessionId: contentSessionId,
        cwd: '/test/project',
        dbPath,
        timestamp: 2_500,
        payload: {
          last_assistant_message: 'legacy payload without prompt or turn number',
        },
      } as const;
      const fallbackPath = join(fallbackDir, '2500-legacy.json');
      writeFileSync(fallbackPath, JSON.stringify(fallbackEntry));

      const queued: Array<{
        sessionDbId: number;
        input: {
          lastAssistantMessage?: string;
          promptNumber: number;
          turnNumber: number;
          queuedAtEpoch: number;
        };
        dbPath?: string;
      }> = [];
      const dbManager = {
        getSessionStore: (path?: string) => {
          expect(path).toBe(dbPath);
          return store;
        },
      };
      const sessionManager = {
        queueObservation: () => true,
        queueSummarize: (id, input, path) => {
          queued.push({ sessionDbId: id, input, dbPath: path });
          return { status: 'queued', obsCount: 0 };
        },
      };

      const fallbackQueue = {
        getDefaultFallbackDir: () => fallbackDir,
        readFallbackEntries: (dir: string) =>
          readdirSync(dir).map(file => {
            const filepath = join(dir, file);
            return {
              entry: JSON.parse(readFileSync(filepath, 'utf8')),
              filepath,
            };
          }),
        deleteFallbackFile: (filepath: string) => unlinkSync(filepath),
        cleanupStaleFallbacks: () => 0,
        writeFallbackEntry: () => {
          throw new Error('writeFallbackEntry is not used during replay');
        },
      } as typeof import('../../src/shared/fallback-queue.js');

      const replayed = await replayFallbackEntriesForWorker({
        dbManager,
        sessionManager,
        fallbackDir,
        fallbackQueue,
      });

      expect(replayed).toBe(1);
      expect(queued).toEqual([{
        sessionDbId,
        input: {
          lastAssistantMessage: 'legacy payload without prompt or turn number',
          promptNumber: 1,
          turnNumber: 2,
          queuedAtEpoch: 2_500,
        },
        dbPath,
      }]);
      expect(readdirSync(fallbackDir)).toEqual([]);
    } finally {
      store.db.close();
      rmSync(fallbackDir, { recursive: true, force: true });
    }
  });
});
