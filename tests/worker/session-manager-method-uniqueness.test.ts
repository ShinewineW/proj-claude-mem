/**
 * Source-level pin: SessionManager must declare each public method exactly
 * once. Duplicate declarations (e.g., getPendingMessageStore at both line ~122
 * and line ~1159 pre-cleanup) are a linter/TS-strict failure in waiting —
 * JavaScript silently keeps the last declaration and the first one becomes
 * quiet dead code. When the two diverge during a future edit, one caller
 * gets the updated behavior and one does not.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('SessionManager method uniqueness', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'worker', 'SessionManager.ts'),
    'utf-8',
  );

  it('getPendingMessageStore is declared exactly once', () => {
    // Match a full method declaration, not references (e.g. `this.getPendingMessageStore(...)`).
    // Accept either "public " prefix or bare member syntax.
    const declRegex = /^\s*(public\s+|private\s+|protected\s+)?getPendingMessageStore\s*\(/gm;
    const matches = [...src.matchAll(declRegex)];
    expect(matches.length).toBe(1);
  });
});
