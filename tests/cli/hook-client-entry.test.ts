import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';

describe('hook-client-entry', () => {
  it('source file exists', () => {
    expect(existsSync('src/cli/hook-client-entry.ts')).toBe(true);
  });

  it('imports only lightweight dependencies (no WorkerService)', () => {
    const source = readFileSync('src/cli/hook-client-entry.ts', 'utf-8');
    expect(source).not.toContain('WorkerService');
    expect(source).not.toContain('worker-service');
    expect(source).not.toContain('SDKAgent');
    expect(source).not.toContain('ChromaSync');
    expect(source).not.toContain('express');
    expect(source).toContain('hookCommand');
    expect(source).toContain('isPluginDisabledInClaudeSettings');
  });

  it('only accepts "hook" command', () => {
    const source = readFileSync('src/cli/hook-client-entry.ts', 'utf-8');
    expect(source).toContain("command !== 'hook'");
  });
});

describe('build-hooks.js hook-client entry point', () => {
  it('build config includes hook-client entry', () => {
    const buildScript = readFileSync('scripts/build-hooks.js', 'utf-8');
    expect(buildScript).toContain('hook-client-entry');
    expect(buildScript).toContain('hook-client.cjs');
  });
});
