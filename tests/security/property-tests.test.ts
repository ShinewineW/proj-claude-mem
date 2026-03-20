/**
 * Property-Based Tests — Audit Artifact
 *
 * Tests structural invariants that must hold for ALL inputs across 5 changed
 * modules introduced in commits 1ccf362c, fb23d213, 9c0731a0, ca48f4c2, dcf228b2.
 *
 * NOT for commit — audit artifact only.
 *
 * ── Known Real Bug Documented in this File ──
 * [BUG-F2] extractLastMessage(transcriptParser.ts, commit fb23d213):
 *   The "never throws" contract is VIOLATED for paths that exist as directories
 *   (e.g. '/'). `existsSync('/')` returns true, bypassing the early-return
 *   guard, then `readFileSync('/', 'utf-8')` throws EISDIR.
 *   See: tests P1-dir-throws and P2-dir-throws below.
 *   Fix: add `statSync(transcriptPath).isFile()` check before readFileSync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomString(len = 20): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz/._-0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * Generate path strings that are SAFE to call existsSync on and that do NOT
 * point to existing directories — restricts the domain to the inputs that the
 * fb23d213 fix actually handles.
 */
function randomSafePath(): string {
  const variants = [
    '',
    '/tmp/nonexist-' + Math.random().toString(36).slice(2) + '.jsonl',
    randomString(8) + '/' + randomString(8),
    randomString(30),
    '../../../nonexist-' + Math.random().toString(36).slice(2),
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

function forAll<T>(gen: () => T, prop: (val: T) => void, iterations = 100): void {
  for (let i = 0; i < iterations; i++) {
    prop(gen());
  }
}

// ---------------------------------------------------------------------------
// F1 — claudeCodeAdapter.formatOutput
// ---------------------------------------------------------------------------

describe('F1: claudeCodeAdapter.formatOutput — property invariants', () => {
  let formatOutput: (result: unknown) => Record<string, unknown>;

  beforeEach(async () => {
    const mod = await import('../../src/cli/adapters/claude-code.js');
    formatOutput = mod.claudeCodeAdapter.formatOutput.bind(mod.claudeCodeAdapter);
  });

  it('P1: output never contains "continue" key — fixed inputs', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      {},
      { continue: true },
      { suppressOutput: true },
      { continue: true, suppressOutput: false },
      { continue: false, suppressOutput: true, systemMessage: 'hi' },
      { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '' }, continue: true },
    ];
    for (const input of inputs) {
      const out = formatOutput(input) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(out, 'continue')).toBe(false);
    }
  });

  it('P1: output never contains "continue" key — random HookResult-shaped inputs', () => {
    forAll(
      () => ({
        continue: Math.random() > 0.5,
        suppressOutput: Math.random() > 0.5,
        systemMessage: Math.random() > 0.5 ? randomString(20) : undefined,
        hookSpecificOutput: Math.random() > 0.7
          ? { hookEventName: randomString(5), additionalContext: randomString(10) }
          : undefined,
        exitCode: Math.random() > 0.5 ? Math.floor(Math.random() * 3) : undefined,
      }),
      (input) => {
        const out = formatOutput(input) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(out, 'continue')).toBe(false);
      },
      200,
    );
  });

  it('P2: output never contains "suppressOutput" key — fixed inputs', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      {},
      { suppressOutput: true },
      { continue: true, suppressOutput: true },
    ];
    for (const input of inputs) {
      const out = formatOutput(input) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(out, 'suppressOutput')).toBe(false);
    }
  });

  it('P2: output never contains "suppressOutput" key — random inputs', () => {
    forAll(
      () => ({
        continue: Math.random() > 0.5,
        suppressOutput: Math.random() > 0.5,
        systemMessage: Math.random() > 0.5 ? randomString(20) : undefined,
      }),
      (input) => {
        const out = formatOutput(input) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(out, 'suppressOutput')).toBe(false);
      },
      200,
    );
  });

  it('P3: null/undefined input returns {}', () => {
    expect(formatOutput(null)).toEqual({});
    expect(formatOutput(undefined)).toEqual({});
  });

  it('P4: return value is always a plain non-null object (never null/array)', () => {
    forAll(
      () => Math.random() > 0.5 ? null : { systemMessage: randomString(10) },
      (input) => {
        const out = formatOutput(input);
        expect(out !== null && typeof out === 'object' && !Array.isArray(out)).toBe(true);
      },
      100,
    );
  });

  it('P5: output keys are always a subset of {hookSpecificOutput, systemMessage}', () => {
    const ALLOWED = new Set(['hookSpecificOutput', 'systemMessage']);
    forAll(
      () => ({
        continue: true,
        suppressOutput: true,
        systemMessage: Math.random() > 0.5 ? randomString(10) : undefined,
        hookSpecificOutput: Math.random() > 0.5
          ? { hookEventName: 'Stop', additionalContext: 'ctx' }
          : undefined,
        exitCode: 0,
        unknownField: randomString(5),
      }),
      (input) => {
        const out = formatOutput(input) as Record<string, unknown>;
        for (const key of Object.keys(out)) {
          expect(ALLOWED.has(key)).toBe(true);
        }
      },
      200,
    );
  });
});

// ---------------------------------------------------------------------------
// F2 — extractLastMessage
// ---------------------------------------------------------------------------

describe('F2: extractLastMessage — property invariants (safe domain)', () => {
  let extractLastMessage: (path: string, role: 'user' | 'assistant', strip?: boolean) => string;

  beforeEach(async () => {
    const mod = await import('../../src/shared/transcript-parser.js');
    extractLastMessage = mod.extractLastMessage;
  });

  // --- Domain restricted to safe (non-existent, non-directory) paths ---

  it('P1: never throws for empty/null/undefined/nonexistent paths', () => {
    const safeInputs: unknown[] = [
      null,
      undefined,
      '',
      '/tmp/nonexist-prop-' + Date.now() + '.jsonl',
      'relative/nonexist.jsonl',
      '../also-nonexist.jsonl',
    ];
    for (const path of safeInputs) {
      expect(() => extractLastMessage(path as any, 'user')).not.toThrow();
      expect(() => extractLastMessage(path as any, 'assistant')).not.toThrow();
    }
  });

  it('P1: never throws — property over random safe (non-existent) paths', () => {
    forAll(
      randomSafePath,
      (path) => {
        expect(() => extractLastMessage(path as any, 'user')).not.toThrow();
        expect(() => extractLastMessage(path as any, 'assistant')).not.toThrow();
      },
      150,
    );
  });

  it('P2: always returns string for safe inputs', () => {
    const safeInputs: unknown[] = [
      null,
      undefined,
      '',
      '/tmp/nonexist-prop2-' + Date.now(),
    ];
    for (const path of safeInputs) {
      let result: unknown;
      expect(() => { result = extractLastMessage(path as any, 'user'); }).not.toThrow();
      expect(typeof result).toBe('string');
    }
  });

  it('P3: returns empty string for null/undefined/empty/nonexistent path', () => {
    expect(extractLastMessage(null as any, 'assistant')).toBe('');
    expect(extractLastMessage(undefined as any, 'assistant')).toBe('');
    expect(extractLastMessage('', 'user')).toBe('');
    expect(extractLastMessage('/tmp/nonexist-' + Date.now() + '.jsonl', 'user')).toBe('');
  });

  // --- [BUG-F2] FIXED: directory paths now return '' instead of throwing EISDIR ---

  it('[BUG-F2] FIXED: returns empty string when path is an existing directory', () => {
    // After fix: statSync check guards against directory paths
    expect(extractLastMessage('/', 'user')).toBe('');

    const tmpDir = join(tmpdir(), `prop-test-dir-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      expect(extractLastMessage(tmpDir, 'user')).toBe('');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- Valid JSONL content handling ---

  it('P4: does not throw on JSONL with malformed/partial lines', () => {
    const tmpDir = join(tmpdir(), `prop-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'malformed.jsonl');
    try {
      writeFileSync(tmpFile, [
        '{"type":"user","message":{"content":"hello"}}',
        'not valid json',
        '{broken',
        '{"type":"assistant","message":{"content":"response"}}',
        '',
      ].join('\n'));
      expect(() => extractLastMessage(tmpFile, 'assistant')).not.toThrow();
      expect(typeof extractLastMessage(tmpFile, 'assistant')).toBe('string');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('P5: correctly extracts string-type message content', () => {
    const tmpDir = join(tmpdir(), `prop-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'string-content.jsonl');
    try {
      writeFileSync(tmpFile,
        JSON.stringify({ type: 'user', message: { content: 'plain string content' } }) + '\n',
      );
      expect(extractLastMessage(tmpFile, 'user')).toBe('plain string content');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('P6: correctly extracts array-type message content', () => {
    const tmpDir = join(tmpdir(), `prop-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'array-content.jsonl');
    try {
      writeFileSync(tmpFile,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'part1' },
              { type: 'text', text: 'part2' },
            ],
          },
        }) + '\n',
      );
      const result = extractLastMessage(tmpFile, 'assistant');
      expect(result).toContain('part1');
      expect(result).toContain('part2');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F4 — resolveDataDir (via DATA_DIR export and inline cascade logic)
// ---------------------------------------------------------------------------

describe('F4: resolveDataDir — property invariants', () => {
  it('P1: DATA_DIR export is a non-empty string', async () => {
    const mod = await import('../../src/shared/paths.js');
    expect(typeof mod.DATA_DIR).toBe('string');
    expect(mod.DATA_DIR.length).toBeGreaterThan(0);
  });

  it('P2: cascade logic always returns a non-empty string for all tier combinations', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SettingsDefaultsManager } = require('../../src/shared/SettingsDefaultsManager.js');

    function resolveDataDir(
      env: Record<string, string | undefined>,
      settingsJson: Record<string, unknown> | null,
    ): string {
      if (env.CLAUDE_MEM_DATA_DIR) return env.CLAUDE_MEM_DATA_DIR;
      if (settingsJson) {
        const val =
          (settingsJson.CLAUDE_MEM_DATA_DIR as string | undefined) ??
          ((settingsJson.settings as Record<string, string> | undefined)?.CLAUDE_MEM_DATA_DIR);
        if (val) return val;
      }
      return SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    }

    const cases: Array<[Record<string, string | undefined>, Record<string, unknown> | null]> = [
      [{ CLAUDE_MEM_DATA_DIR: '/env-path' }, { CLAUDE_MEM_DATA_DIR: '/settings-path' }],
      [{ CLAUDE_MEM_DATA_DIR: '/env-only' }, null],
      [{}, { CLAUDE_MEM_DATA_DIR: '/settings-only' }],
      [{}, { settings: { CLAUDE_MEM_DATA_DIR: '/nested-settings' } }],
      [{}, {}],
      [{}, null],
    ];

    for (const [env, settings] of cases) {
      const result = resolveDataDir(env, settings);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('P3: SettingsDefaultsManager CLAUDE_MEM_DATA_DIR default is non-empty and contains .claude-mem', async () => {
    const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
    const fallback = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    expect(typeof fallback).toBe('string');
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).toContain('.claude-mem');
  });
});

// ---------------------------------------------------------------------------
// F6 — buildIsolatedEnv
// ---------------------------------------------------------------------------

describe('F6: buildIsolatedEnv — property invariants', () => {
  let buildIsolatedEnv: (includeCredentials?: boolean) => Record<string, string>;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    const mod = await import('../../src/shared/EnvManager.js');
    buildIsolatedEnv = mod.buildIsolatedEnv;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Clear the savedEnv accumulator
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  });

  function setEnv(key: string, value: string) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  it('P1: no CLAUDECODE_* key ever appears in output — known vars', () => {
    const injected = [
      'CLAUDECODE_INTEROP_PORT',
      'CLAUDECODE_SESSION_KEY',
      'CLAUDECODE_FOO',
      'CLAUDECODE_BAR_BAZ',
      'CLAUDECODE_123',
    ];
    for (const k of injected) setEnv(k, 'should-be-blocked');

    forAll(
      () => Math.random() > 0.5,
      (includeCredentials) => {
        const env = buildIsolatedEnv(includeCredentials);
        for (const key of Object.keys(env)) {
          expect(key.startsWith('CLAUDECODE_')).toBe(false);
        }
      },
      50,
    );
  });

  it('P1: no CLAUDECODE_* key ever appears in output — fuzz random key names', () => {
    const fuzzKeys: string[] = [];
    for (let i = 0; i < 20; i++) {
      const key = 'CLAUDECODE_' + randomString(6).replace(/[^A-Za-z0-9_]/g, 'X').toUpperCase();
      fuzzKeys.push(key);
      setEnv(key, 'fuzz-value-' + i);
    }

    const env = buildIsolatedEnv(false);
    for (const key of fuzzKeys) {
      expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
    }
  });

  it('P2: CLAUDE_CODE_ENTRYPOINT is always "sdk-ts" regardless of includeCredentials', () => {
    forAll(
      () => Math.random() > 0.5,
      (includeCredentials) => {
        const env = buildIsolatedEnv(includeCredentials);
        expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
      },
      100,
    );
  });

  it('P3: CLAUDECODE_ENTRYPOINT (prefixed) does not survive into output', () => {
    // A key with the CLAUDECODE_ prefix must be stripped even if its suffix
    // resembles a legitimate key name
    setEnv('CLAUDECODE_ENTRYPOINT', 'malicious');

    const env = buildIsolatedEnv(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'CLAUDECODE_ENTRYPOINT')).toBe(false);
    // The managed key (different prefix) must still be present
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
  });

  it('P4: ANTHROPIC_API_KEY from process.env is always stripped (Issue #733)', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-ambient-key-from-project-env');

    const env = buildIsolatedEnv(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY')).toBe(false);
  });

  it('P5: CLAUDE_CODE_SESSION is always stripped', () => {
    setEnv('CLAUDE_CODE_SESSION', 'nested-session-id');

    const env = buildIsolatedEnv(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CODE_SESSION')).toBe(false);
  });

  it('P6: MCP_SESSION_ID is always stripped', () => {
    setEnv('MCP_SESSION_ID', 'mcp-session-123');

    const env = buildIsolatedEnv(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'MCP_SESSION_ID')).toBe(false);
  });

  it('P7: CLAUDECODE exact match is always stripped', () => {
    setEnv('CLAUDECODE', 'value');

    const env = buildIsolatedEnv(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'CLAUDECODE')).toBe(false);
  });

  it('P8: PATH is always preserved (critical for subprocess execution)', () => {
    const env = buildIsolatedEnv(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'PATH')).toBe(true);
    expect(typeof env.PATH).toBe('string');
    expect((env.PATH as string).length).toBeGreaterThan(0);
  });

  it('P9: output values are all strings — no undefined values leak through', () => {
    const env = buildIsolatedEnv(false);
    for (const [, v] of Object.entries(env)) {
      expect(typeof v).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// F3 — smart-install.js last-line JSON contract (exec-based)
// ---------------------------------------------------------------------------

describe('F3: smart-install.js — stdout last line is always valid JSON', () => {
  const WORKTREE_ROOT = join(__dirname, '../..');
  const SCRIPT = join(WORKTREE_ROOT, 'plugin/scripts/smart-install.js');

  it('last stdout line parses as JSON', () => {
    const stdout = execSync(`node ${SCRIPT}`, {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: WORKTREE_ROOT },
      timeout: 60_000,
    });

    const lines = stdout.trim().split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const lastLine = lines[lines.length - 1];
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(lastLine); }).not.toThrow();
    expect(parsed !== null && typeof parsed === 'object').toBe(true);
  });

  it('JSON output has continue=true and suppressOutput=true', () => {
    const stdout = execSync(`node ${SCRIPT}`, {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: WORKTREE_ROOT },
      timeout: 60_000,
    });

    const lines = stdout.trim().split('\n').filter(l => l.trim().length > 0);
    const parsed = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;

    expect(parsed.continue).toBe(true);
    expect(parsed.suppressOutput).toBe(true);
  });

  it('script exits 0 when deps already installed', () => {
    expect(() => {
      execSync(`node ${SCRIPT}`, {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: WORKTREE_ROOT },
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }).not.toThrow();
  });
});
