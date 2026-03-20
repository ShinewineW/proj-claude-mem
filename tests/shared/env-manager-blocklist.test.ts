import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { buildIsolatedEnv } from '../../src/shared/EnvManager.js';

describe('buildIsolatedEnv blocklist expansion', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const testVars = [
    'CLAUDECODE_INTEROP_PORT',
    'CLAUDECODE_SESSION_KEY',
    'CLAUDE_CODE_SESSION',
    'MCP_SESSION_ID',
  ];

  beforeEach(() => {
    for (const key of testVars) {
      savedEnv[key] = process.env[key];
      process.env[key] = 'test-value';
    }
  });

  afterEach(() => {
    for (const key of testVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('strips CLAUDECODE_* prefixed vars', () => {
    const env = buildIsolatedEnv(false);
    expect(env).not.toHaveProperty('CLAUDECODE_INTEROP_PORT');
    expect(env).not.toHaveProperty('CLAUDECODE_SESSION_KEY');
  });

  it('strips CLAUDE_CODE_SESSION exact match', () => {
    const env = buildIsolatedEnv(false);
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION');
  });

  it('strips MCP_SESSION_ID exact match', () => {
    const env = buildIsolatedEnv(false);
    expect(env).not.toHaveProperty('MCP_SESSION_ID');
  });

  it('preserves CLAUDE_CODE_ENTRYPOINT (re-injected by EnvManager)', () => {
    const env = buildIsolatedEnv(false);
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
  });

  it('still blocks CLAUDECODE exact match', () => {
    process.env.CLAUDECODE = 'should-be-blocked';
    const env = buildIsolatedEnv(false);
    expect(env).not.toHaveProperty('CLAUDECODE');
    delete process.env.CLAUDECODE;
  });

  it('preserves normal env vars like PATH', () => {
    const env = buildIsolatedEnv(false);
    expect(env).toHaveProperty('PATH');
  });
});
