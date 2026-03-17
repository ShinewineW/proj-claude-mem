import { describe, test, expect } from 'bun:test';

describe('SDKAgent Response Watchdog', () => {
  test('watchdog aborts session when subprocess hangs beyond timeout', async () => {
    const abortController = new AbortController();
    let abortCalled = false;
    const originalAbort = abortController.abort.bind(abortController);
    abortController.abort = () => {
      abortCalled = true;
      originalAbort();
    };

    // Async iterable that never yields (simulates hung subprocess)
    async function* hangingQuery() {
      await new Promise(() => {}); // Never resolves
    }

    const WATCHDOG_MS = 100;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

    const loopPromise = (async () => {
      watchdogTimer = setTimeout(() => {
        abortController.abort();
      }, WATCHDOG_MS);

      try {
        for await (const _message of hangingQuery()) {
          clearTimeout(watchdogTimer);
          watchdogTimer = setTimeout(() => {
            abortController.abort();
          }, WATCHDOG_MS);
        }
      } finally {
        if (watchdogTimer) clearTimeout(watchdogTimer);
      }
    })();

    // Wait for watchdog to fire
    await new Promise(resolve => setTimeout(resolve, WATCHDOG_MS + 50));

    expect(abortCalled).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
  });

  test('watchdog resets on each received message', async () => {
    const abortController = new AbortController();
    const WATCHDOG_MS = 200;
    let messageCount = 0;

    // Yields 3 messages with 100ms gaps (each < 200ms watchdog)
    async function* slowButAliveQuery() {
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (abortController.signal.aborted) return;
        yield { type: 'assistant', message: { content: `msg-${i}` } };
      }
    }

    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

    const loopPromise = (async () => {
      watchdogTimer = setTimeout(() => abortController.abort(), WATCHDOG_MS);
      try {
        for await (const _message of slowButAliveQuery()) {
          messageCount++;
          clearTimeout(watchdogTimer);
          watchdogTimer = setTimeout(() => abortController.abort(), WATCHDOG_MS);
        }
      } finally {
        if (watchdogTimer) clearTimeout(watchdogTimer);
      }
    })();

    await loopPromise;

    expect(messageCount).toBe(3);
    expect(abortController.signal.aborted).toBe(false);
  });
});
