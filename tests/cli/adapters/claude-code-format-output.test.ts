import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter.formatOutput', () => {
  it('returns empty object when result has no hookSpecificOutput or systemMessage', () => {
    const result = {} as any;
    const output = claudeCodeAdapter.formatOutput(result);
    expect(output).toEqual({});
    expect(output).not.toHaveProperty('continue');
    expect(output).not.toHaveProperty('suppressOutput');
  });

  it('returns only systemMessage when present without hookSpecificOutput', () => {
    const result = { systemMessage: 'test message' } as any;
    const output = claudeCodeAdapter.formatOutput(result);
    expect(output).toEqual({ systemMessage: 'test message' });
    expect(output).not.toHaveProperty('continue');
    expect(output).not.toHaveProperty('suppressOutput');
  });

  it('handles null result gracefully', () => {
    const output = claudeCodeAdapter.formatOutput(null as any);
    expect(output).toEqual({});
  });

  it('handles undefined result gracefully', () => {
    const output = claudeCodeAdapter.formatOutput(undefined as any);
    expect(output).toEqual({});
  });

  it('returns hookSpecificOutput when present', () => {
    const result = { hookSpecificOutput: { key: 'value' }, systemMessage: 'msg' } as any;
    const output = claudeCodeAdapter.formatOutput(result);
    expect(output).toEqual({ hookSpecificOutput: { key: 'value' }, systemMessage: 'msg' });
  });
});
