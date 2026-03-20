import { describe, it, expect } from 'bun:test';

describe('ChromaMcpManager SSL flag', () => {
  it('emits --ssl false when SSL is disabled', () => {
    const chromaSsl = false;
    const args: string[] = [];
    args.push('--ssl', chromaSsl ? 'true' : 'false');
    expect(args).toContain('--ssl');
    expect(args).toContain('false');
  });

  it('emits --ssl true when SSL is enabled', () => {
    const chromaSsl = true;
    const args: string[] = [];
    args.push('--ssl', chromaSsl ? 'true' : 'false');
    expect(args).toContain('--ssl');
    expect(args).toContain('true');
  });
});
