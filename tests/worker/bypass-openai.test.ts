/**
 * OpenAI-compatible provider integration tests for BypassLane.
 *
 * Covers:
 * - resolveConfig: openai branch returns baseUrl/key/model; null on missing fields
 * - parseErrorBody: dual envelope (Anthropic-style + OpenAI-style)
 * - classifyFailure: HTTP status + envelope buckets → quota/auth/ratelimit/transient/client
 * - probe: sends thinking:{type:"disabled"} to the configured base URL
 * - callRestApi: sends thinking:disabled, attaches error.bypassCategory on failure
 * - Tiered cooldown: quota/auth → configured (30min/6h defaults), ratelimit/transient → default, client → no trip
 */
import { describe, it, expect, beforeEach, afterEach, mock, afterAll } from 'bun:test';

// Mutable settings so individual tests can drive resolveConfig down its null branches.
// mock.module() is irreversible and returns a fixed object per call, so the mock reads
// from this closure variable instead of hardcoding a single shape.
let mockSettings: Record<string, string> = {
  CLAUDE_MEM_PROVIDER: 'openai',
  CLAUDE_MEM_OPENAI_BASE_URL: 'https://api.deepseek.com',
  CLAUDE_MEM_OPENAI_API_KEY: 'sk-test',
  CLAUDE_MEM_OPENAI_MODEL: 'deepseek-v4-flash',
  CLAUDE_MEM_BYPASS_COOLDOWN_MS: '5000',
  CLAUDE_MEM_CHROMA_ENABLED: 'false',
};

// __CONFINED_MOCKS__: bun's mock.module() is process-wide and mock.restore() does
// NOT undo it, so a partial stub below would leak into every test file
// loaded after this one (project-isolation suites fail that way). Capture
// the real modules first and re-register them in afterAll so the stubs
// stay confined to this file.
import * as __real0 from '../../src/shared/paths.js';
import * as __real1 from '../../src/shared/SettingsDefaultsManager.js';
const __REAL_MODULES: Array<[string, unknown]> = [
  ['../../src/shared/paths.js', { ...__real0 }],
  ['../../src/shared/SettingsDefaultsManager.js', { ...__real1 }],
];
afterAll(() => {
  for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real);
});

mock.module('../../src/shared/paths.js', () => ({
  DATA_DIR: '/tmp/test-claude-mem',
  DB_PATH: '/tmp/test-claude-mem/claude-mem.db',
  USER_SETTINGS_PATH: '/tmp/test-settings.json',
  ensureDir: () => {},
  ensureAllDataDirs: () => {},
  resolveProjectDbPath: () => '/tmp/test-project/.claude/mem.db',
  resolveProjectRoot: () => '/tmp/test-project',
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    failure: () => {}, success: () => {}, formatTool: () => 'mock-tool',
  },
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => mockSettings,
    get: (key: string) => mockSettings[key] ?? '',
    getInt: (key: string) => parseInt(mockSettings[key] ?? '0', 10) || 0,
  },
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  getCredential: () => '',
}));

mock.module('../../src/services/worker/ProcessRegistry.js', () => ({
  getProcessBySession: () => undefined,
  ensureProcessExit: async () => {},
}));

import {
  BypassLane,
  parseBypassErrorBody,
  classifyBypassFailure,
  readIntBounded,
  DEFAULT_QUOTA_COOLDOWN_MS,
  DEFAULT_AUTH_COOLDOWN_MS,
} from '../../src/services/worker/BypassLane.js';

const DEFAULT_SETTINGS = {
  CLAUDE_MEM_PROVIDER: 'openai',
  CLAUDE_MEM_OPENAI_BASE_URL: 'https://api.deepseek.com',
  CLAUDE_MEM_OPENAI_API_KEY: 'sk-test',
  CLAUDE_MEM_OPENAI_MODEL: 'deepseek-v4-flash',
  CLAUDE_MEM_BYPASS_COOLDOWN_MS: '5000',
  CLAUDE_MEM_CHROMA_ENABLED: 'false',
};

describe('BypassLane — OpenAI-compatible provider', () => {
  beforeEach(() => {
    mockSettings = { ...DEFAULT_SETTINGS };
  });

  describe('resolveConfig: openai branch', () => {
    it('returns baseUrl + key + model from settings', () => {
      const lane = new BypassLane();
      const config = (lane as any).resolveConfig();
      expect(config).not.toBeNull();
      expect(config.baseUrl).toBe('https://api.deepseek.com');
      expect(config.apiKey).toBe('sk-test');
      expect(config.model).toBe('deepseek-v4-flash');
      expect(config.cooldownMs).toBe(5000);
    });

    it('returns null when base URL is blank', () => {
      mockSettings = { CLAUDE_MEM_PROVIDER: 'openai', CLAUDE_MEM_OPENAI_BASE_URL: '', CLAUDE_MEM_OPENAI_API_KEY: 'sk', CLAUDE_MEM_OPENAI_MODEL: 'm' };
      const lane = new BypassLane();
      expect((lane as any).resolveConfig()).toBeNull();
    });

    it('returns null when base URL is malformed', () => {
      mockSettings = { CLAUDE_MEM_PROVIDER: 'openai', CLAUDE_MEM_OPENAI_BASE_URL: 'not-a-url', CLAUDE_MEM_OPENAI_API_KEY: 'sk', CLAUDE_MEM_OPENAI_MODEL: 'm' };
      const lane = new BypassLane();
      expect((lane as any).resolveConfig()).toBeNull(); // covers resolveOpenAICompatibleChatCompletionsUrl early-reject
    });

    it('returns null when API key is missing', () => {
      mockSettings = { CLAUDE_MEM_PROVIDER: 'openai', CLAUDE_MEM_OPENAI_BASE_URL: 'https://api.deepseek.com', CLAUDE_MEM_OPENAI_API_KEY: '', CLAUDE_MEM_OPENAI_MODEL: 'm' };
      const lane = new BypassLane();
      expect((lane as any).resolveConfig()).toBeNull();
    });

    it('returns null when model is missing', () => {
      mockSettings = { CLAUDE_MEM_PROVIDER: 'openai', CLAUDE_MEM_OPENAI_BASE_URL: 'https://api.deepseek.com', CLAUDE_MEM_OPENAI_API_KEY: 'sk', CLAUDE_MEM_OPENAI_MODEL: '' };
      const lane = new BypassLane();
      expect((lane as any).resolveConfig()).toBeNull();
    });

    it('returns null when provider is claude', () => {
      mockSettings = { CLAUDE_MEM_PROVIDER: 'claude' };
      const lane = new BypassLane();
      expect((lane as any).resolveConfig()).toBeNull();
    });
  });

  describe('parseBypassErrorBody: dual envelope', () => {
    it('parses Anthropic-style envelope {type:"error", error:{type, message}}', () => {
      const body = JSON.stringify({
        type: 'error',
        error: { type: 'AuthError', message: 'Invalid API key.' },
      });
      const parsed = parseBypassErrorBody(body);
      expect(parsed.type).toBe('AuthError');
      expect(parsed.message).toBe('Invalid API key.');
    });

    it('parses OpenAI-style envelope {error:{type, code, message}}', () => {
      const body = JSON.stringify({
        error: {
          message: 'You exceeded your current quota',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
          param: null,
        },
        request_id: 'abc123',
      });
      const parsed = parseBypassErrorBody(body);
      expect(parsed.type).toBe('insufficient_quota');
      expect(parsed.code).toBe('insufficient_quota');
      expect(parsed.message).toContain('quota');
    });

    it('returns empty object for unparseable body', () => {
      expect(parseBypassErrorBody('not json at all')).toEqual({});
      expect(parseBypassErrorBody('')).toEqual({});
    });

    it('returns empty object for JSON without error envelope', () => {
      expect(parseBypassErrorBody('{"foo":"bar"}')).toEqual({});
    });
  });

  describe('classifyBypassFailure: status + envelope buckets', () => {
    it('classifies insufficient_quota code as quota (regardless of status)', () => {
      expect(classifyBypassFailure(500, { code: 'insufficient_quota' })).toBe('quota');
      expect(classifyBypassFailure(429, { type: 'insufficient_quota' })).toBe('quota');
    });

    it('classifies AuthError envelope as auth (regardless of status)', () => {
      // Real probe: invalid key returns 401 + AuthError
      expect(classifyBypassFailure(401, { type: 'AuthError' })).toBe('auth');
    });

    it('classifies ModelError envelope as client (not transient — our bug, not provider)', () => {
      // Real probe: fake model returns 401 + ModelError (status code unreliable!)
      expect(classifyBypassFailure(401, { type: 'ModelError' })).toBe('client');
    });

    it('classifies bare HTTP 429 as ratelimit (short cooldown, not quota)', () => {
      expect(classifyBypassFailure(429, {})).toBe('ratelimit');
    });

    it('classifies HTTP 402 as quota', () => {
      expect(classifyBypassFailure(402, {})).toBe('quota');
    });

    it('classifies HTTP 5xx as transient', () => {
      expect(classifyBypassFailure(500, {})).toBe('transient');
      expect(classifyBypassFailure(503, {})).toBe('transient');
    });

    it('classifies HTTP 400 as client (our bug)', () => {
      expect(classifyBypassFailure(400, {})).toBe('client');
    });

    it('classifies HTTP 401/403 (no envelope) as auth', () => {
      expect(classifyBypassFailure(401, {})).toBe('auth');
      expect(classifyBypassFailure(403, {})).toBe('auth');
    });
  });

  describe('openai probe payload', () => {
    let originalFetch: typeof globalThis.fetch;
    let capturedUrl: string | null = null;
    let capturedInit: RequestInit | null = null;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      capturedUrl = null;
      capturedInit = null;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('sends POST to the configured endpoint with thinking:disabled', async () => {
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as any;

      const lane = new BypassLane();
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-flash', cooldownMs: 1200000 };

      const result = await (lane as any).probeProvider();
      expect(result.ok).toBe(true);
      expect(capturedUrl).toContain('api.deepseek.com');
      expect(capturedUrl).toContain('/chat/completions');

      const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test');

      const body = JSON.parse(String(capturedInit?.body ?? '{}'));
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.max_tokens).toBe(10);
    });
  });

  describe('openai callRestApi: thinking field + bypassCategory attachment', () => {
    let originalFetch: typeof globalThis.fetch;
    let capturedBody: any = null;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      capturedBody = null;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('sends thinking:{type:"disabled"} on success path', async () => {
      globalThis.fetch = (async (_url: any, init: any) => {
        capturedBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '<observation><type>feature</type></observation>' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as any;

      const lane = new BypassLane();
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-flash', cooldownMs: 1200000 };

      const result = await (lane as any).callRestApi(
        'user prompt', 'system prompt', new AbortController().signal, [],
      );
      expect(result).toContain('<observation>');
      expect(capturedBody.thinking).toEqual({ type: 'disabled' });
      expect(capturedBody.model).toBe('deepseek-v4-flash');
    });

    it('throws Error with bypassCategory="quota" on HTTP 429 + insufficient_quota envelope', async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            error: { message: 'quota exceeded', type: 'insufficient_quota', code: 'insufficient_quota' },
          }),
          { status: 429 },
        )) as any;

      const lane = new BypassLane();
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 1200000 };

      let caught: any = null;
      try {
        await (lane as any).callRestApi('p', 's', new AbortController().signal, []);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as any).bypassCategory).toBe('quota');
    });

    it('throws Error with bypassCategory="auth" on HTTP 401 + AuthError envelope', async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Invalid API key.' } }),
          { status: 401 },
        )) as any;

      const lane = new BypassLane();
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 1200000 };

      let caught: any = null;
      try {
        await (lane as any).callRestApi('p', 's', new AbortController().signal, []);
      } catch (e) {
        caught = e;
      }
      expect((caught as any).bypassCategory).toBe('auth');
    });

    it('throws Error with bypassCategory="transient" on HTTP 500', async () => {
      globalThis.fetch = (async () =>
        new Response('Internal Server Error', { status: 500 })) as any;

      const lane = new BypassLane();
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 1200000 };

      let caught: any = null;
      try {
        await (lane as any).callRestApi('p', 's', new AbortController().signal, []);
      } catch (e) {
        caught = e;
      }
      expect((caught as any).bypassCategory).toBe('transient');
    });

    it('redacts the configured API key from the thrown error message', async () => {
      const SECRET = 'sk-secret-key-abcdef123456';
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({ error: { message: `bad request for ${SECRET}` } }),
          { status: 400 },
        )) as any;

      const lane = new BypassLane();
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: SECRET, model: 'deepseek-v4-flash', cooldownMs: 1200000 };

      let caught: any = null;
      try {
        await (lane as any).callRestApi('p', 's', new AbortController().signal, []);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(SECRET);
    });
  });

  describe('tiered cooldown via recordFailure', () => {
    it('quota default is 30 minutes (configurable)', () => {
      expect(DEFAULT_QUOTA_COOLDOWN_MS).toBe(30 * 60 * 1000);
    });

    it('auth default is 6 hours (configurable)', () => {
      expect(DEFAULT_AUTH_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);
    });

    it('client category does NOT trip the circuit breaker', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).consecutiveFailures = 2; // 1 more would normally trip

      // Failure with client category — should NOT increment consecutiveFailures
      // and NOT trip the breaker
      (lane as any).recordFailure('client');
      expect(lane.getState()).toBe('ACTIVE');
      expect((lane as any).consecutiveFailures).toBe(2);
    });

    it('quota category trips with the CONFIGURED quotaCooldownMs (not a constant)', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000, quotaCooldownMs: 1800000, authCooldownMs: 21600000, maxFailures: 3 };
      (lane as any).consecutiveFailures = 2;

      // Stub scheduleCooldownProbe to capture the cooldown duration
      let capturedCooldownMs: number | null = null;
      (lane as any).scheduleCooldownProbe = (ms?: number) => {
        capturedCooldownMs = ms ?? (lane as any).config?.cooldownMs ?? null;
      };

      (lane as any).recordFailure('quota');
      expect(lane.getState()).toBe('TRIPPED');
      expect(capturedCooldownMs).toBe(1800000); // the fixture's quotaCooldownMs
    });

    it('auth category trips with configured authCooldownMs', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000, quotaCooldownMs: 1800000, authCooldownMs: 7777, maxFailures: 3 };
      (lane as any).consecutiveFailures = 2;

      let capturedCooldownMs: number | null = null;
      (lane as any).scheduleCooldownProbe = (ms?: number) => {
        capturedCooldownMs = ms ?? (lane as any).config?.cooldownMs ?? null;
      };

      (lane as any).recordFailure('auth');
      expect(lane.getState()).toBe('TRIPPED');
      expect(capturedCooldownMs).toBe(7777);
    });

    it('ratelimit category falls through to default cooldownMs (short)', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000, quotaCooldownMs: 1800000, authCooldownMs: 21600000, maxFailures: 3 };
      (lane as any).consecutiveFailures = 2;

      let capturedCooldownMs: number | null = null;
      (lane as any).scheduleCooldownProbe = (ms?: number) => {
        capturedCooldownMs = ms ?? (lane as any).config?.cooldownMs ?? null;
      };

      (lane as any).recordFailure('ratelimit');
      expect(lane.getState()).toBe('TRIPPED');
      expect(capturedCooldownMs).toBe(5000); // NOT the quota/auth long cooldowns
    });

    it('maxFailures is honored when configured', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000, quotaCooldownMs: 1800000, authCooldownMs: 21600000, maxFailures: 2 };
      (lane as any).maxFailures = 2;
      (lane as any).scheduleCooldownProbe = () => {};

      (lane as any).recordFailure('transient');
      expect(lane.getState()).toBe('ACTIVE'); // 1 of 2 — not yet
      (lane as any).recordFailure('transient');
      expect(lane.getState()).toBe('TRIPPED'); // 2 of 2 — tripped
    });

    it('transient category uses default cooldownMs', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000 };
      (lane as any).consecutiveFailures = 2;

      let capturedCooldownMs: number | null = null;
      (lane as any).scheduleCooldownProbe = (ms?: number) => {
        capturedCooldownMs = ms ?? (lane as any).config?.cooldownMs ?? null;
      };

      (lane as any).recordFailure('transient');
      expect(lane.getState()).toBe('TRIPPED');
      expect(capturedCooldownMs).toBe(5000);
    });

    it('backwards-compatible: recordFailure() with no category uses default cooldownMs', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000 };
      (lane as any).consecutiveFailures = 2;

      let capturedCooldownMs: number | null = null;
      (lane as any).scheduleCooldownProbe = (ms?: number) => {
        capturedCooldownMs = ms ?? (lane as any).config?.cooldownMs ?? null;
      };

      (lane as any).recordFailure();
      expect(lane.getState()).toBe('TRIPPED');
      expect(capturedCooldownMs).toBe(5000);
    });
  });
});

describe('readIntBounded (strict bounded settings read)', () => {
  it('accepts in-range integers', () => {
    expect(readIntBounded('180000', 1200000, 60000, 86400000)).toBe(180000);
  });
  it('rejects trailing junk / non-integer / empty -> default', () => {
    expect(readIntBounded('60000junk', 7, 1, 100000)).toBe(7);
    expect(readIntBounded('1.5', 7, 1, 10)).toBe(7);
    expect(readIntBounded('', 7, 1, 10)).toBe(7);
    expect(readIntBounded(undefined, 7, 1, 10)).toBe(7);
  });
  it('rejects below-min and above-max -> default', () => {
    expect(readIntBounded('-1', 6, 1, 64)).toBe(6);
    expect(readIntBounded('0', 6, 1, 64)).toBe(6);
    expect(readIntBounded('65', 6, 1, 64)).toBe(6);
    expect(readIntBounded('999999999999', 1800000, 60000, 86400000)).toBe(1800000);
  });
  it('scientific notation parses consistently with validateSettings', () => {
    expect(readIntBounded('1e1', 6, 1, 64)).toBe(10); // Number('1e1')===10, integer, in range
  });
});
