/**
 * Architectural pins for the SummaryLane fresh-query summarize path.
 *
 * These tests lock in the invariants that prevent accidental regression to
 * the observer-session summarize path (which produced 0% valid <summary>
 * XML over 24h of production — see attn_sink/0sum-investigation/NOTES.md)
 * AND prevent regression to the pre-SummaryLane callback dispatch (which
 * relied on a per-session in-flight counter + salvage synthesis).
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

describe('summary-lane architectural pins', () => {
  describe('SDKAgent observer generator', () => {
    const src = read('src/services/worker/SDKAgent.ts');

    it('does NOT call buildSummaryPrompt in the observer generator', () => {
      expect(src).not.toContain('buildSummaryPrompt(');
    });

    it('imports runFreshSummarizeQuery (guards that the fresh path exists)', () => {
      expect(src).toContain('runFreshSummarizeQuery');
      expect(src).toContain("from \"./fresh-summarize.js\"");
    });

    it('stores the summary via the atomic helper (FK-race safe)', () => {
      expect(src).toContain('storeFreshSummaryForSession');
      expect(src).not.toContain('sessionStore.storeSummary(');
    });

    it('observer does not reference summarize message type (SummaryLane owns those rows)', () => {
      expect(src).not.toMatch(/message\.type\s*===\s*['"]summarize['"]/);
      expect(src).not.toContain('Dropping legacy summarize from pending_messages');
    });
  });

  describe('SessionManager.queueSummarize', () => {
    const src = read('src/services/worker/SessionManager.ts');

    it('enqueues pending_messages with type summarize (SummaryLane consumes)', () => {
      // queueSummarize now persists a summarize row into pending_messages so
      // SummaryLane (global single consumer) can claim it. The anti-literal
      // check is removed — SummaryLane's entire contract hinges on this row.
      expect(src).toMatch(/type:\s*['"]summarize['"]/);
    });

    it('queueSummarize signature uses the new input object (not legacy lastAssistantMessage string)', () => {
      // The new signature is queueSummarize(sessionDbId, { promptNumber, ... }, dbPath?)
      expect(src).toMatch(/queueSummarize\(\s*sessionDbId:\s*number,\s*input:/);
      expect(src).toContain('promptNumber:');
      expect(src).toContain('queuedAtEpoch:');
    });

    it('shouldDeduplicatePromptSummary exists for prompt-scoped dedupe', () => {
      expect(src).toContain('shouldDeduplicatePromptSummary');
    });

    it('exposes getPendingMessageStore for SummaryLane consumer access', () => {
      expect(src).toContain('getPendingMessageStore(');
    });

    it('no longer tracks in-flight fresh summarize counters (SummaryLane owns lifecycle)', () => {
      expect(src).not.toContain('freshSummarizeInFlight');
      expect(src).not.toContain('setOnRunFreshSummarize');
      expect(src).not.toContain('setOnSalvagedSummary');
    });

    it('no longer imports summarize-salvage (module deleted)', () => {
      expect(src).not.toContain("from './summarize-salvage.js'");
      expect(src).not.toContain('attemptEmptyTranscriptSalvage');
    });
  });

  describe('fresh-summarize module', () => {
    const src = read('src/services/worker/fresh-summarize.ts');

    it('always calls query() without a resume option', () => {
      expect(src).not.toMatch(/resume:/);
    });

    it('uses buildFreshSummaryPrompt (NOT buildSummaryPrompt)', () => {
      expect(src).toContain('buildFreshSummaryPrompt');
      expect(src).not.toContain('buildSummaryPrompt');
    });

    it('rejects prose responses with status=parse_failed (no silent "success")', () => {
      expect(src).toMatch(/['"]parse_failed['"]/);
    });
  });

  describe('worker-service wiring', () => {
    const src = read('src/services/worker-service.ts');

    it('no longer wires salvage or fresh-summarize callbacks', () => {
      expect(src).not.toContain('setOnSalvagedSummary');
      expect(src).not.toContain('setOnRunFreshSummarize');
    });

    it('replayFallbackEntries resolves prompt_number at replay time', () => {
      expect(src).toContain('user_prompts');
      expect(src).toContain('prompt_number');
    });
  });

  describe('prompt content contract', () => {
    const src = read('src/sdk/prompts.ts');

    it('buildFreshSummaryPrompt does NOT emit the literal <observation> token', () => {
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
      expect(src).not.toMatch(/export\s+function\s+buildSummaryPrompt\b/);
    });
  });

  describe('ResponseProcessor dead-code guards', () => {
    const src = read('src/services/worker/agents/ResponseProcessor.ts');

    it('does NOT branch on currentSDKMessageKind === summarize', () => {
      expect(src).not.toMatch(/if\s*\(\s*!summaryForStore\s*&&\s*session\.currentSDKMessageKind\s*===\s*['"]summarize['"]/);
    });

    it('does NOT contain the legacy Case 1 salvage log string', () => {
      expect(src).not.toContain('SALVAGED summary from');
    });
  });
});
