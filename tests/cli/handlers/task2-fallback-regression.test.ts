import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('Task 2 — fallback + throttle regression guards', () => {
  it('summarize.ts writes fallback on !workerReady (Task 2 core fix)', () => {
    const src = readFileSync('src/cli/handlers/summarize.ts', 'utf-8');
    expect(src).toContain("import { writeFallbackEntry }");

    const fallbackCalls = (src.match(/writeFallbackEntry\s*\(/g) || []).length;
    expect(fallbackCalls).toBeGreaterThanOrEqual(3);

    const workerReadyBlock = src.match(/if\s*\(\s*!\s*workerReady\s*\)\s*\{[^}]*\}/);
    expect(workerReadyBlock).not.toBeNull();
    expect(workerReadyBlock![0]).toContain('writeFallbackEntry');

    expect(src).toContain('extractLastMessage(');
    expect(src).toContain('fetchWithTimeout(');
  });

  it('file-edit.ts writes fallback on all three failure branches', () => {
    const src = readFileSync('src/cli/handlers/file-edit.ts', 'utf-8');
    expect(src).toContain("import { writeFallbackEntry }");
    const fallbackCalls = (src.match(/writeFallbackEntry\s*\(/g) || []).length;
    expect(fallbackCalls).toBeGreaterThanOrEqual(3);
    expect(src).toContain('fetchWithTimeout(');
  });

  it('checkWorkerVersion() is 60s throttled and log-only (no restart POST)', () => {
    const src = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    expect(src).toContain('checkWorkerVersion');
    expect(src).toMatch(/VERSION_CHECK_INTERVAL_MS\s*=\s*60[_\d]*000/);
    expect(src).toMatch(/lastVersionCheckAt/);
    expect(src).not.toMatch(/\/api\/admin\/(restart|shutdown)/);
    expect(src).not.toMatch(/method:\s*['"]POST['"][^}]*restart/);
    expect(src).toContain("logger.warn('HOOK'");
  });

  it('observation.ts does not call ensureWorkerRunning on the hot path', () => {
    const src = readFileSync('src/cli/handlers/observation.ts', 'utf-8');
    expect(src).not.toMatch(/await\s+ensureWorkerRunning\s*\(/);
    expect(src).toContain('fetchWithTimeout(');
    expect(src).toContain('writeFallbackEntry(');
  });
});
