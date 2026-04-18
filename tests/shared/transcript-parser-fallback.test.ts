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

  it('walks past tool_use-only assistant messages to the latest message with text', () => {
    const tmpPath = '/tmp/tooluse-only-transcript-test-' + Date.now() + '.jsonl';
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'earlier commentary' }] } },
      { type: 'user', message: { content: 'tool result' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } },
      { type: 'user', message: { content: 'tool result' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { content: 'tool result' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } },
    ];
    writeFileSync(tmpPath, lines.map(l => JSON.stringify(l)).join('\n'));
    try {
      const result = extractLastMessage(tmpPath, 'assistant');
      expect(result).toBe('earlier commentary');
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it('returns empty when every assistant message is tool_use only', () => {
    const tmpPath = '/tmp/all-tooluse-transcript-test-' + Date.now() + '.jsonl';
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    ];
    writeFileSync(tmpPath, lines.map(l => JSON.stringify(l)).join('\n'));
    try {
      const result = extractLastMessage(tmpPath, 'assistant');
      expect(result).toBe('');
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it('skips system-reminder-only assistant messages when stripping enabled', () => {
    const tmpPath = '/tmp/reminder-only-transcript-test-' + Date.now() + '.jsonl';
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'real response content' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }] } },
    ];
    writeFileSync(tmpPath, lines.map(l => JSON.stringify(l)).join('\n'));
    try {
      const result = extractLastMessage(tmpPath, 'assistant', true);
      expect(result).toBe('real response content');
    } finally {
      unlinkSync(tmpPath);
    }
  });
});
