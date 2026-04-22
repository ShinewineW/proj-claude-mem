import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { PrivacyCheckValidator } from '../../src/services/worker/validation/PrivacyCheckValidator.js';
import { logger } from '../../src/utils/logger.js';

type QueueResult = { status: 'queued' | 'skipped'; obsCount: 0 };

function createMockReq({
  body = {},
  params = {},
  query = {},
}: {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, string>;
} = {}) {
  return { body, params, query, path: '/test' } as any;
}

function createMockRes() {
  const res: any = {
    _json: undefined,
    _status: 200,
    headersSent: false,
  };
  res.json = mock((payload: unknown) => {
    res._json = payload;
    res.headersSent = true;
    return res;
  });
  res.status = mock((code: number) => {
    res._status = code;
    return res;
  });
  return res;
}

function buildHarness(queueResult: QueueResult) {
  const queueSummarize = mock(() => queueResult);
  const pendingStore = {
    getPendingObservationCountUpToPrompt: mock(() => 0),
  };
  const sessionManager = {
    queueSummarize,
    getPendingMessageStore: mock(() => pendingStore),
    getSession: mock(() => ({ contentSessionId: 'cs-123', project: 'proj' })),
  };
  const sessionStore = {
    createSDKSession: mock(() => 42),
    getPromptNumberFromUserPrompts: mock(() => 1),
  };
  const dbManager = {
    getSessionStore: mock(() => sessionStore),
  };
  const eventBroadcaster = {
    broadcastSummarizeQueued: mock(() => {}),
    broadcastSessionCompleted: mock(() => {}),
  };
  const workerService = {
    broadcastProcessingStatus: mock(() => {}),
  };

  const routes = new SessionRoutes(
    sessionManager as any,
    dbManager as any,
    {} as any,
    eventBroadcaster as any,
    workerService as any,
  );

  const handlers = new Map<string, Function>();
  const app = {
    post: mock((path: string, handler: Function) => {
      handlers.set(`POST ${path}`, handler);
    }),
    get: mock((path: string, handler: Function) => {
      handlers.set(`GET ${path}`, handler);
    }),
    delete: mock((path: string, handler: Function) => {
      handlers.set(`DELETE ${path}`, handler);
    }),
  } as any;

  routes.setupRoutes(app);

  return {
    handlers,
    queueSummarize,
    eventBroadcaster,
  };
}

describe('SessionRoutes summarize dedupe signaling', () => {
  let loggerSpies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of loggerSpies) spy.mockRestore();
    mock.restore();
  });

  it('POST /sessions/:sessionDbId/summarize returns skipped and suppresses queued broadcast on dedupe', () => {
    const { handlers, eventBroadcaster } = buildHarness({ status: 'skipped', obsCount: 0 });
    const handler = handlers.get('POST /sessions/:sessionDbId/summarize');
    expect(handler).toBeDefined();

    const req = createMockReq({
      params: { sessionDbId: '42' },
      body: {
        last_assistant_message: 'done',
        prompt_number: 7,
        dbPath: '/tmp/proj/.claude/mem.db',
      },
    });
    const res = createMockRes();

    handler!(req, res);

    expect(eventBroadcaster.broadcastSummarizeQueued).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'skipped' });
  });

  it('POST /sessions/:sessionDbId/summarize still broadcasts when a new summarize is queued', () => {
    const { handlers, eventBroadcaster } = buildHarness({ status: 'queued', obsCount: 0 });
    const handler = handlers.get('POST /sessions/:sessionDbId/summarize');
    expect(handler).toBeDefined();

    const req = createMockReq({
      params: { sessionDbId: '42' },
      body: {
        last_assistant_message: 'done',
        prompt_number: 7,
        dbPath: '/tmp/proj/.claude/mem.db',
      },
    });
    const res = createMockRes();

    handler!(req, res);

    expect(eventBroadcaster.broadcastSummarizeQueued).toHaveBeenCalledTimes(1);
    expect(res._json).toEqual({ status: 'queued' });
  });

  it('POST /api/sessions/summarize returns skipped result and suppresses queued broadcast on dedupe', () => {
    const privacySpy = spyOn(PrivacyCheckValidator, 'checkUserPromptPrivacy').mockReturnValue('allowed');
    const { handlers, eventBroadcaster } = buildHarness({ status: 'skipped', obsCount: 0 });
    const handler = handlers.get('POST /api/sessions/summarize');
    expect(handler).toBeDefined();

    const req = createMockReq({
      body: {
        contentSessionId: 'cs-123',
        last_assistant_message: 'done',
        prompt_number: 7,
        dbPath: '/tmp/proj/.claude/mem.db',
      },
    });
    const res = createMockRes();

    handler!(req, res);

    expect(privacySpy).toHaveBeenCalledTimes(1);
    expect(eventBroadcaster.broadcastSummarizeQueued).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'skipped', obsCount: 0 });
  });

  it('POST /api/sessions/summarize still broadcasts when a new summarize is queued', () => {
    const privacySpy = spyOn(PrivacyCheckValidator, 'checkUserPromptPrivacy').mockReturnValue('allowed');
    const { handlers, eventBroadcaster } = buildHarness({ status: 'queued', obsCount: 0 });
    const handler = handlers.get('POST /api/sessions/summarize');
    expect(handler).toBeDefined();

    const req = createMockReq({
      body: {
        contentSessionId: 'cs-123',
        last_assistant_message: 'done',
        prompt_number: 7,
        dbPath: '/tmp/proj/.claude/mem.db',
      },
    });
    const res = createMockRes();

    handler!(req, res);

    expect(privacySpy).toHaveBeenCalledTimes(1);
    expect(eventBroadcaster.broadcastSummarizeQueued).toHaveBeenCalledTimes(1);
    expect(res._json).toEqual({ status: 'queued', obsCount: 0 });
  });
});
