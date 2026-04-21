/**
 * Architectural pins for the fresh-query summarize path.
 *
 * These tests lock in the invariants that prevent accidental regression to
 * the observer-session summarize path (which produced 0% valid <summary>
 * XML over 24h of production — see attn_sink/0sum-investigation/NOTES.md).
 *
 * Style note: these are string-pinned source-level guards (same pattern as
 * tests/cli/handlers/task2-fallback-regression.test.ts). If you touch
 * SDKAgent.ts / SessionManager.ts / prompts.ts, read these pins first.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('fresh-summarize architectural pins', () => {
  describe('SDKAgent observer generator', () => {
    const src = read('src/services/worker/SDKAgent.ts');

    it('does NOT call buildSummaryPrompt in the observer generator', () => {
      // buildSummaryPrompt is the legacy observer-session summary prompt that
      // inherits observer conditioning. If you see this test failing, someone
      // probably wired it back in — the fresh path should use
      // buildFreshSummaryPrompt via runFreshSummarizeQuery instead.
      expect(src).not.toContain('buildSummaryPrompt(');
    });

    it('imports runFreshSummarizeQuery (guards that the fresh path exists)', () => {
      expect(src).toContain('runFreshSummarizeQuery');
      expect(src).toContain("from \"./fresh-summarize.js\"");
    });

    it('exposes runFreshSummarize as a method on SDKAgent', () => {
      // Guard that worker-service's setOnRunFreshSummarize callback target
      // still exists — deleting this method would silently disable summaries.
      expect(src).toMatch(/async runFreshSummarize\(/);
    });

    it('stores the summary via the atomic helper (FK-race safe)', () => {
      // runFreshSummarize MUST NOT call sessionStore.storeSummary directly
      // with a cached memory_session_id — see fresh-summarize-store.ts for
      // why this regresses to a FOREIGN KEY constraint failure. The
      // atomic helper re-fetches inside a transaction.
      expect(src).toContain('storeFreshSummaryForSession');
      // And the cached value must not sneak back in:
      expect(src).not.toContain('sessionStore.storeSummary(');
    });

    it('observer does not reference summarize message type (SummaryLane owns those rows)', () => {
      // Post-Chunk 4: Observer claims observation rows only. The SummaryLane
      // global consumer pulls summarize rows independently, so any defensive
      // drop-and-warn branch inside SDKAgent.createMessageGenerator is dead
      // code. Reintroducing `message.type === 'summarize'` checks here would
      // signal the architecture regressed to the observer-owned path.
      expect(src).not.toMatch(/message\.type\s*===\s*['"]summarize['"]/);
      expect(src).not.toContain('Dropping legacy summarize from pending_messages');
    });
  });

  describe('SessionManager.queueSummarize', () => {
    const src = read('src/services/worker/SessionManager.ts');

    it('does NOT enqueue pending_messages with type summarize', () => {
      // The method body must NOT contain `type: 'summarize'` as a literal
      // PendingMessage — that would re-enter the observer loop. We allow the
      // type check inside SDKAgent's legacy-drop branch, which lives in a
      // different file.
      const queueSummarizeBody = src
        .split('queueSummarize(')[1]
        ?.split('deleteSession(')[0] ?? '';
      // The only "summarize" references permitted are docstring / log
      // messages, never an object literal "type: 'summarize'".
      expect(queueSummarizeBody).not.toMatch(/type:\s*['"]summarize['"]/);
    });

    it('exposes hasPendingSummarize combining in-flight + queued checks', () => {
      expect(src).toMatch(/hasPendingSummarize\(\s*sessionDbId:\s*number/);
      expect(src).toContain('freshSummarizeInFlight');
    });

    it('exposes setOnRunFreshSummarize for worker-service wiring', () => {
      expect(src).toMatch(/setOnRunFreshSummarize\(/);
    });

    it('decrements the in-flight counter in .finally() (safe against thrown callbacks)', () => {
      // If we only decrement on success, a throwing handler would leak the
      // counter and the drain window would hang forever.
      expect(src).toMatch(/\.finally\(\s*\(\)\s*=>\s*\{[\s\S]*?freshSummarizeInFlight/);
    });

    it('deleteSession drain window uses the combined hasPendingSummarize', () => {
      // Guard that drain polls the in-flight counter, not just the DB.
      // The fix: this.hasPendingSummarize(sessionDbId, session.dbPath).
      expect(src).toContain('this.hasPendingSummarize(sessionDbId');
    });
  });

  describe('fresh-summarize module', () => {
    const src = read('src/services/worker/fresh-summarize.ts');

    it('always calls query() without a resume option', () => {
      // If someone adds "resume: ..." to options, that reintroduces the
      // observer-session history and the entire fix is undone.
      expect(src).not.toMatch(/resume:/);
    });

    it('uses buildFreshSummaryPrompt (NOT buildSummaryPrompt)', () => {
      expect(src).toContain('buildFreshSummaryPrompt');
      expect(src).not.toContain('buildSummaryPrompt');
    });

    it('rejects prose responses with status=parse_failed (no silent "success")', () => {
      // Guard: if someone changes the no-summary path to e.g. wrap prose in
      // a synthesized summary, we'll catch it here. The literal 'parse_failed'
      // must appear as a status value somewhere in the module.
      expect(src).toMatch(/['"]parse_failed['"]/);
    });
  });

  describe('worker-service wiring', () => {
    const src = read('src/services/worker-service.ts');

    it('installs setOnRunFreshSummarize → sdkAgent.runFreshSummarize', () => {
      expect(src).toContain('setOnRunFreshSummarize');
      expect(src).toContain('sdkAgent.runFreshSummarize');
    });
  });

  describe('prompt content contract', () => {
    const src = read('src/sdk/prompts.ts');

    it('buildFreshSummaryPrompt does NOT emit the literal <observation> token', () => {
      // This is the #1 regression risk: someone rewords the prompt and
      // accidentally includes "<observation>" literal in the instructions,
      // which re-primes the model.
      const fn = src.split('export function buildFreshSummaryPrompt')[1]
        ?.split('export function ')[0] ?? '';
      expect(fn).not.toContain('<observation>');
    });

    it('buildFreshSummaryPrompt does NOT reference observer_role or recording_focus', () => {
      const fn = src.split('export function buildFreshSummaryPrompt')[1]
        ?.split('export function ')[0] ?? '';
      expect(fn).not.toContain('observer_role');
      expect(fn).not.toContain('recording_focus');
    });

    it('does NOT re-export buildSummaryPrompt (legacy observer-session prompt)', () => {
      // buildSummaryPrompt was the mid-session "--- MODE SWITCH ---" prompt
      // that Claude's observer conditioning overrode. Removed in the
      // fresh-query refactor. Re-introducing it means someone reverted the
      // fix — fail loudly.
      expect(src).not.toMatch(/export\s+function\s+buildSummaryPrompt\b/);
    });
  });

  describe('ResponseProcessor dead-code guards', () => {
    const src = read('src/services/worker/agents/ResponseProcessor.ts');

    it('does NOT branch on currentSDKMessageKind === summarize (dead since fresh-path refactor)', () => {
      // After the fresh-query refactor the observer generator never yields
      // a summarize prompt, so the "kind" is never set to 'summarize'. Any
      // code branching on this is either dead weight or — worse — an
      // attempt to re-wire the observer session for summaries.
      // (Comments mentioning the phrase are fine; actual branch predicates
      // are not.)
      expect(src).not.toMatch(/if\s*\(\s*!summaryForStore\s*&&\s*session\.currentSDKMessageKind\s*===\s*['"]summarize['"]/);
    });

    it('does NOT contain the legacy Case 1 salvage log string', () => {
      // "SALVAGED summary from N observation(s)" was the Case 1 salvage
      // log message. Its absence is a canary for the whole branch being
      // gone.
      expect(src).not.toContain('SALVAGED summary from');
    });
  });
});
