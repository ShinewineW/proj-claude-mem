/**
 * F6: transcripts/processor.ts queueSummary prompt_number + fallback contract.
 *
 * Source-level pins (the handler is ~50 lines; writing a full stub
 * environment for the TranscriptProcessor event loop is out of scope
 * for this follow-up). We verify:
 *   1. Uses /api/sessions/resolve-prompt-number to pre-resolve.
 *   2. POST body may include prompt_number (when resolved).
 *   3. Writes fallback on failure paths — !workerReady, non-OK response,
 *      AND fetch error —
 *      matching Stop hook durability contract (CodeX-P1).
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('F6: transcripts/processor.ts queueSummary contract', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'src', 'services', 'transcripts', 'processor.ts'),
    'utf-8',
  );

  it('imports writeFallbackEntry for durability', () => {
    expect(src).toContain("writeFallbackEntry");
  });

  it('queueSummary references /api/sessions/resolve-prompt-number', () => {
    expect(src).toContain('/api/sessions/resolve-prompt-number');
  });

  it('queueSummary includes prompt_number conditional in POST body', () => {
    // Pin the variable/reference pattern. Either a body.prompt_number
    // assignment or inline spread with prompt_number must appear.
    expect(src).toContain('prompt_number');
  });

  it('queueSummary writes fallback when worker is down (not just silent return)', () => {
    // The handler must no longer drop on `!workerReady`. Find the queueSummary
    // body and assert it reaches writeFallbackEntry before returning.
    const startIdx = src.indexOf('private async queueSummary');
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = src.indexOf('\n  private ', startIdx + 1);
    const body = src.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 3000);
    expect(body).toContain('writeFallbackEntry');
  });

  it('queueSummary writes fallback on fetch error path (not just silent log)', () => {
    const startIdx = src.indexOf('private async queueSummary');
    const endIdx = src.indexOf('\n  private ', startIdx + 1);
    const body = src.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 3000);
    // Count fallback writes inside queueSummary; expect >=3 (worker-down,
    // non-OK response, and catch).
    const count = (body.match(/writeFallbackEntry\(/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('queueSummary writes fallback on non-OK summarize response', () => {
    const startIdx = src.indexOf('private async queueSummary');
    const endIdx = src.indexOf('\n  private ', startIdx + 1);
    const body = src.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 3000);
    expect(body).toContain('if (!response.ok)');
    expect(body).toContain('Summary request returned non-OK, writing fallback');
  });

  it('queueSummary falls back immediately when prompt-number resolve fails', () => {
    const startIdx = src.indexOf('private async queueSummary');
    const endIdx = src.indexOf('\n  private ', startIdx + 1);
    const body = src.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 3000);
    expect(body).toContain('if (promptNumber === null)');
    expect(body).toContain('Summary prompt-number resolve failed, writing fallback');
  });
});
