/**
 * OpenCode Go provider integration tests for BypassLane.
 *
 * Covers Q1-Q14 decision tree:
 * - resolveConfig: opencode branch returns provider/key/model
 * - parseErrorBody: dual envelope (Anthropic-style + OpenAI-style)
 * - classifyFailure: HTTP status + envelope buckets → quota/auth/transient/client
 * - probe: sends thinking:{type:"disabled"}, no HTTP-Referer/X-Title
 * - callRestApi: sends thinking:disabled, attaches error.bypassCategory on failure
 * - Tiered cooldown: quota/auth → 6h, transient → default, client → no trip
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

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
    loadFromFile: () => ({
      CLAUDE_MEM_PROVIDER: 'opencode',
      CLAUDE_MEM_OPENCODE_API_KEY: 'sk-test-opencode-key',
      CLAUDE_MEM_OPENCODE_MODEL: 'deepseek-v4-flash',
      CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false',
      CLAUDE_MEM_BYPASS_COOLDOWN_MS: '5000',
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
    }),
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_BYPASS_COOLDOWN_MS') return '5000';
      return '';
    },
    getInt: (key: string) => (key === 'CLAUDE_MEM_BYPASS_COOLDOWN_MS' ? 5000 : 0),
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
  QUOTA_COOLDOWN_MS,
  AUTH_COOLDOWN_MS,
} from '../../src/services/worker/BypassLane.js';

describe('BypassLane — OpenCode Go provider', () => {
  describe('resolveConfig: opencode branch', () => {
    it('returns provider=opencode with key + model from settings', () => {
      const lane = new BypassLane();
      const config = (lane as any).resolveConfig();
      expect(config).not.toBeNull();
      expect(config.provider).toBe('opencode');
      expect(config.apiKey).toBe('sk-test-opencode-key');
      expect(config.model).toBe('deepseek-v4-flash');
      expect(config.cooldownMs).toBe(5000);
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
      // Real OpenCode probe: invalid key returns 401 + AuthError
      expect(classifyBypassFailure(401, { type: 'AuthError' })).toBe('auth');
    });

    it('classifies ModelError envelope as client (not transient — our bug, not provider)', () => {
      // Real OpenCode probe: fake model returns 401 + ModelError (status code unreliable!)
      expect(classifyBypassFailure(401, { type: 'ModelError' })).toBe('client');
    });

    it('classifies HTTP 429 as quota when no envelope hint', () => {
      expect(classifyBypassFailure(429, {})).toBe('quota');
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

  describe('opencode probe payload', () => {
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

    it('sends POST to OpenCode endpoint with thinking:disabled and no referer/title headers', async () => {
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as any;

      const lane = new BypassLane();
      (lane as any).config = {
        provider: 'opencode',
        apiKey: 'sk-test-opencode-key',
        model: 'deepseek-v4-flash',
        cooldownMs: 5000,
      };

      const result = await (lane as any).probeProvider();
      expect(result.ok).toBe(true);
      expect(capturedUrl).toContain('opencode.ai');
      expect(capturedUrl).toContain('/chat/completions');

      const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test-opencode-key');
      // referer/title headers must NOT be sent
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();

      const body = JSON.parse(String(capturedInit?.body ?? '{}'));
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.max_tokens).toBe(10);
    });
  });

  describe('opencode callRestApi: thinking field + bypassCategory attachment', () => {
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
      (lane as any).config = {
        provider: 'opencode',
        apiKey: 'sk-test-opencode-key',
        model: 'deepseek-v4-flash',
        cooldownMs: 5000,
      };

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
      (lane as any).config = {
        provider: 'opencode', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000,
      };

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
      (lane as any).config = {
        provider: 'opencode', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000,
      };

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
      (lane as any).config = {
        provider: 'opencode', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000,
      };

      let caught: any = null;
      try {
        await (lane as any).callRestApi('p', 's', new AbortController().signal, []);
      } catch (e) {
        caught = e;
      }
      expect((caught as any).bypassCategory).toBe('transient');
    });
  });

  describe('tiered cooldown via recordFailure', () => {
    it('quota category uses QUOTA_COOLDOWN_MS (6 hours)', () => {
      expect(QUOTA_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);
    });

    it('auth category uses AUTH_COOLDOWN_MS (6 hours)', () => {
      expect(AUTH_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);
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

    it('quota category trips with long cooldown', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).config = {
        provider: 'opencode', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000,
      };
      (lane as any).consecutiveFailures = 2;

      // Stub scheduleCooldownProbe to capture the cooldown duration
      let capturedCooldownMs: number | null = null;
      (lane as any).scheduleCooldownProbe = (ms?: number) => {
        capturedCooldownMs = ms ?? (lane as any).config?.cooldownMs ?? null;
      };

      (lane as any).recordFailure('quota');
      expect(lane.getState()).toBe('TRIPPED');
      expect(capturedCooldownMs).toBe(QUOTA_COOLDOWN_MS);
    });

    it('transient category uses default cooldownMs', () => {
      const lane = new BypassLane();
      (lane as any).state = 'ACTIVE';
      (lane as any).config = {
        provider: 'opencode', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000,
      };
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
      (lane as any).config = {
        provider: 'opencode', apiKey: 'k', model: 'deepseek-v4-flash', cooldownMs: 5000,
      };
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
