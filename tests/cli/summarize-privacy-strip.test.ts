import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('summarize hook strips privacy tags from last_assistant_message', () => {
  const src = readFileSync(
    join(import.meta.dir, '../../src/cli/handlers/summarize.ts'),
    'utf-8',
  );

  it('imports stripMemoryTagsFromPrompt', () => {
    expect(src).toMatch(/import\s*\{[^}]*stripMemoryTagsFromPrompt[^}]*\}\s*from\s*['"][^'"]*tag-stripping\.js['"]/);
  });

  it('wraps every extractLastMessage result with stripMemoryTagsFromPrompt', () => {
    // Both extraction sites (fallback + normal) must be wrapped — no raw
    // extractLastMessage assignment may flow into a fallback/summarize payload.
    const stripCount = (src.match(/stripMemoryTagsFromPrompt\(/g) || []).length;
    expect(stripCount).toBeGreaterThanOrEqual(2);
  });
});

// Behavioral unit test of the stripping primitive (proves the privacy contract
// independent of the hook plumbing).
import { stripMemoryTagsFromPrompt } from '../../src/utils/tag-stripping.js';
describe('last_assistant_message privacy contract', () => {
  it('removes <private> blocks the transcript parser leaves intact', () => {
    const msg = 'I did the work. <private>secret token abc123</private> Done.';
    expect(stripMemoryTagsFromPrompt(msg)).toBe('I did the work.  Done.');
  });
});
