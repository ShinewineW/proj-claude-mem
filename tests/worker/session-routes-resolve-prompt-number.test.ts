/**
 * F5: GET /api/sessions/resolve-prompt-number endpoint contract.
 *
 * Hook-side prompt_number resolution: Stop hook calls this endpoint to learn
 * the turn being summarized, then passes prompt_number verbatim to
 * POST /api/sessions/summarize. This makes the hook the authoritative source
 * for the turn key, instead of relying on server-side fallback.
 *
 * Fallback still works if hook omits prompt_number (back-compat).
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('F5: resolve-prompt-number endpoint', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'worker', 'http', 'routes', 'SessionRoutes.ts'),
    'utf-8',
  );

  it('SessionRoutes registers GET /api/sessions/resolve-prompt-number', () => {
    expect(src).toContain("'/api/sessions/resolve-prompt-number'");
    expect(src).toMatch(/app\.get\(\s*['"]\/api\/sessions\/resolve-prompt-number['"]/);
  });

  it('handler reads contentSessionId from query and returns prompt_number JSON', () => {
    // Find the handler definition, not the route binding. Handler is declared
    // as `private handleResolvePromptNumber = this.wrapHandler(...)`; the
    // first occurrence is the .bind(this) in setupRoutes.
    const idx = src.indexOf('handleResolvePromptNumber = this.wrapHandler');
    expect(idx).toBeGreaterThanOrEqual(0);
    const handlerBody = src.slice(idx, idx + 2000);
    expect(handlerBody).toContain('req.query');
    expect(handlerBody).toContain('contentSessionId');
    expect(handlerBody).toContain('getPromptNumberFromUserPrompts');
    expect(handlerBody).toContain('prompt_number');
  });

  it('handler returns 400 when contentSessionId missing', () => {
    const idx = src.indexOf('handleResolvePromptNumber = this.wrapHandler');
    const handlerBody = src.slice(idx, idx + 2000);
    // Must guard against missing contentSessionId (sts 400).
    expect(handlerBody).toMatch(/status\(\s*400\s*\)/);
  });
});

describe('F5: summarize hook wiring', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'cli', 'handlers', 'summarize.ts'),
    'utf-8',
  );

  it('summarize handler calls resolve-prompt-number before POSTing summarize', () => {
    expect(src).toContain('/api/sessions/resolve-prompt-number');
  });

  it('summarize handler includes prompt_number in POST body when resolved', () => {
    // Source pin — the POST body must reference prompt_number alongside
    // contentSessionId + last_assistant_message.
    expect(src).toContain('prompt_number');
  });

  it('summarize handler writes fallback without prompt_number on resolve failure (CodeX-P1)', () => {
    // Durability contract: a worker-side resolve failure must not drop the
    // summarize request — write fallback so replay can resolve later.
    expect(src).toContain('writeFallbackEntry');
    // The handler must call writeFallbackEntry on BOTH !workerReady AND
    // resolve-failure paths; count the occurrences as a smoke test.
    const writeCount = (src.match(/writeFallbackEntry\(/g) || []).length;
    expect(writeCount).toBeGreaterThanOrEqual(2);
  });
});
