import { describe, it, expect } from 'bun:test';
import {
  buildHardenedSdkOptions,
  OBSERVER_DISALLOWED_TOOLS,
} from '../../src/sdk/hardened-options.js';
import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';

const BASE_INPUT = {
  source: 'Observer' as const,
  model: 'claude-sonnet-4-6',
  env: {} as NodeJS.ProcessEnv,
  pathToClaudeCodeExecutable: '/usr/bin/claude',
};

describe('Observer/Summarize SDK tool enforcement (hardened-options)', () => {
  it('sets tools to an empty array (disables ALL built-in tools)', () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
    expect(Array.isArray(opts.tools)).toBe(true);
    expect((opts.tools as unknown[]).length).toBe(0);
  });

  it('sets allowedTools to an empty array (nothing auto-approved)', () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
    expect(Array.isArray(opts.allowedTools)).toBe(true);
    expect((opts.allowedTools as unknown[]).length).toBe(0);
  });

  it('keeps the full disallowedTools deny-list (12 tools)', () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
    const denied = (opts.disallowedTools as string[]) ?? [];
    for (const tool of OBSERVER_DISALLOWED_TOOLS) {
      expect(denied).toContain(tool);
    }
    expect(denied.length).toBe(OBSERVER_DISALLOWED_TOOLS.length);
    expect(OBSERVER_DISALLOWED_TOOLS.length).toBe(12);
  });

  it("uses a non-interactive deny permissionMode (or omits it on older SDK)", () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
    // Step 0 decides: 'dontAsk' on 0.1.77+ that supports it, else undefined.
    expect(opts.permissionMode === undefined || opts.permissionMode === 'dontAsk').toBe(true);
  });

  it('never uses bypassPermissions', () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
    expect(opts.permissionMode).not.toBe('bypassPermissions');
  });

  it('isolates settings, MCP, and extra directories', () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
    expect(opts.mcpServers).toEqual({});
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.additionalDirectories).toEqual([]);
  });

  it('jails cwd to OBSERVER_SESSIONS_DIR by default and never to process.cwd()', () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
    expect(opts.cwd).toBe(OBSERVER_SESSIONS_DIR);
    expect(opts.cwd).not.toBe(process.cwd());
  });

  it('honors an explicit cwd override (fresh-summarize jail unchanged)', () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT, cwd: '/some/jail' });
    expect(opts.cwd).toBe('/some/jail');
  });

  it('exposes a canUseTool callback that denies every invocation', async () => {
    const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
    expect(typeof opts.canUseTool).toBe('function');
    const result = await (opts.canUseTool as (n: string, i: unknown) => Promise<{ behavior: string }>)(
      'Bash',
      { command: 'rm -rf /' },
    );
    expect(result.behavior).toBe('deny');
  });

  it('passes through model, env, executable, abortController, spawn wrapper', () => {
    const ac = new AbortController();
    const spawn = (() => undefined) as unknown;
    const opts = buildHardenedSdkOptions({
      ...BASE_INPUT,
      abortController: ac,
      spawnClaudeCodeProcess: spawn as never,
    });
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.pathToClaudeCodeExecutable).toBe('/usr/bin/claude');
    expect(opts.abortController).toBe(ac);
    expect(opts.spawnClaudeCodeProcess).toBe(spawn);
  });
});
