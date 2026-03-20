import { describe, it, expect } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
import { extractLastMessage } from '../../src/shared/transcript-parser.js';

describe('extractLastMessage graceful fallback', () => {
  it('returns empty string for nonexistent transcript path', () => {
    const result = extractLastMessage('/tmp/nonexistent-transcript-test-' + Date.now() + '.jsonl', 'assistant');
    expect(result).toBe('');
  });

  it('returns empty string for null transcript path', () => {
    const result = extractLastMessage(null as any, 'assistant');
    expect(result).toBe('');
  });

  it('returns empty string for empty string path', () => {
    const result = extractLastMessage('', 'assistant');
    expect(result).toBe('');
  });

  it('returns empty string for empty file', () => {
    const tmpPath = '/tmp/empty-transcript-test-' + Date.now() + '.jsonl';
    writeFileSync(tmpPath, '');
    try {
      const result = extractLastMessage(tmpPath, 'assistant');
      expect(result).toBe('');
    } finally {
      unlinkSync(tmpPath);
    }
  });
});
