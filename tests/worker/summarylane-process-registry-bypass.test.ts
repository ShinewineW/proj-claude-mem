/**
 * Architectural pin: SummaryLane must NOT register the fresh-summarize
 * Claude subprocess into the session ProcessRegistry.
 *
 * Why (spec §2, commit 2fd487bf on wangjiazhe's machine — not yet pushed):
 *   Registering fresh-summarize's subprocess under `input.sessionDbId` lets
 *   the observer pool's `waitForSlot → isProcessStale` reclaim it when the
 *   host session has been idle >30s. The fresh subprocess gets SIGKILL'd
 *   mid-flight → `collectedText === ''` → `status=no_text`.
 *
 *   The host session is often ALREADY `completed` when summarize runs (Stop
 *   hook triggered summarize at session close), so "observer idle" is the
 *   steady-state — every fresh subprocess would be killed within 30s.
 *
 *   Fix: pass `spawnClaudeCodeProcess: undefined` so the Agent SDK uses its
 *   built-in spawn (no PID tracking). Shutdown cancellation still works via
 *   `input.signal → buildFreshSummarizeDeps` → AbortController. The 5-min
 *   orphan reaper remains as the ultimate safety net.
 *
 * This bug was observed on this local machine too — tests/worker logs
 * 2026-04-22 09:05 show `signal=SIGKILL` on session-164 subprocesses during
 * pool reclaim. Bug is orthogonal to the stream-json parser rejection
 * (which is a different failure mode) but both are present.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('SummaryLane: fresh subprocess is NOT registered in ProcessRegistry', () => {
  const src = read('src/services/worker/SummaryLane.ts');

  it('buildDeps does NOT pass createPidCapturingSpawn() as spawnClaudeCodeProcess', () => {
    // Regression guard: if you re-wire createPidCapturingSpawn into the
    // fresh summarize deps, the observer pool's stale-slot reclaim will
    // SIGKILL the fresh subprocess within 30s of the host session closing.
    // Use `spawnClaudeCodeProcess: undefined` (or omit the key) to keep
    // fresh subprocesses out of ProcessRegistry.
    expect(src).not.toMatch(
      /spawnClaudeCodeProcess:\s*createPidCapturingSpawn\s*\(/,
    );
  });

  it('buildDeps explicitly sets spawnClaudeCodeProcess to undefined', () => {
    // Positive pin: the current mitigation must remain in place. Any future
    // refactor that removes this line without replacing the protection will
    // trip this test — forcing the author to read the comment above.
    expect(src).toMatch(/spawnClaudeCodeProcess:\s*undefined/);
  });
});
