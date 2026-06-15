/**
 * POST /api/bypass/test connectivity-probe endpoint.
 *
 * Test strategy (审计 confirmed): does NOT mock.module the probe helper —
 * probeOpenAICompatible is imported by both DataRoutes and BypassLane production
 * code, and mock.module is process-global + irreversible, so stubbing it would
 * break Task 2's real probe tests in the full suite. Instead:
 *   - 400 branch is synchronous → call the wrapped handler with a mock req/res.
 *   - ok/fail branches run a real express app (with express.json()) wired to a
 *     local Bun.serve stub as the baseUrl, so the real probe hits the stub.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import express from 'express';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';

// Stub deps — handleBypassTest uses none of them.
function makeRoutes(): DataRoutes {
  return new DataRoutes({} as any, {} as any, {} as any, {} as any, {} as any, 0);
}

describe('POST /api/bypass/test — 400 branch (sync)', () => {
  it('returns 400 {ok:false} when required fields are missing', () => {
    const routes: any = makeRoutes();
    const req: any = { body: {}, path: '/api/bypass/test' };
    let statusCode = 0;
    let jsonBody: any = null;
    const res: any = {
      status(code: number) { statusCode = code; return this; },
      json(body: any) { jsonBody = body; return this; },
    };
    routes.handleBypassTest(req, res);
    expect(statusCode).toBe(400);
    expect(jsonBody.ok).toBe(false);
  });
});

describe('POST /api/bypass/test — ok / fail branches (real app + stub server)', () => {
  const okStub = Bun.serve({
    port: 0,
    fetch: () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const failStub = Bun.serve({
    port: 0,
    fetch: () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'CreditsError', message: 'Insufficient balance' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
  });

  const app = express();
  app.use(express.json()); // production reads req.body via middleware.ts:25 — bare express() won't parse JSON
  makeRoutes().setupRoutes(app);
  const appServer = app.listen(0);
  const appPort = (appServer.address() as any).port;

  afterAll(() => {
    okStub.stop();
    failStub.stop();
    appServer.close();
  });

  it('returns {ok:true} when the endpoint responds 200', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/api/bypass/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${okStub.port}`, apiKey: 'sk', model: 'm' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns {ok:false,status:401} with sanitized message on endpoint error', async () => {
    const KEY = 'sk-secret-key-123456';
    const res = await fetch(`http://127.0.0.1:${appPort}/api/bypass/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${failStub.port}`, apiKey: KEY, model: 'm' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
    expect(body.message).toContain('CreditsError');
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
