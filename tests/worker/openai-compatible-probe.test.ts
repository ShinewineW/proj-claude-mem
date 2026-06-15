import { test, expect } from 'bun:test';
import { probeOpenAICompatible } from '../../src/services/worker/openai-compatible-probe.js';

const okFetch = async () => new Response(
  JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

test('returns ok=true on HTTP 200', async () => {
  const r = await probeOpenAICompatible(
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-v4-flash' },
    { fetchImpl: okFetch },
  );
  expect(r.ok).toBe(true);
});

test('returns ok=false with status+message on HTTP error, sanitized', async () => {
  const errFetch = async () => new Response(
    JSON.stringify({ type: 'error', error: { type: 'CreditsError', message: 'Insufficient balance' } }),
    { status: 401 },
  );
  const r = await probeOpenAICompatible(
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-secret', model: 'm' },
    { fetchImpl: errFetch },
  );
  expect(r.ok).toBe(false);
  expect(r.status).toBe(401);
  expect(r.message).toContain('CreditsError');
  expect(JSON.stringify(r)).not.toContain('sk-secret'); // never echo the key
});

test('redacts a NON-sk-prefixed key echoed in the error body', async () => {
  const KEY = 'deepseek-rawkey-abcdef123456'; // no sk- prefix
  const errFetch = async () => new Response(
    JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 403 },
  );
  const r = await probeOpenAICompatible(
    { baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'm' },
    { fetchImpl: errFetch },
  );
  expect(r.ok).toBe(false);
  expect(JSON.stringify(r)).not.toContain(KEY); // exact-key redaction, not just sk-
});

test('returns ok=false when baseUrl is invalid (no fetch attempted)', async () => {
  let called = false;
  const r = await probeOpenAICompatible(
    { baseUrl: 'not-a-url', apiKey: 'k', model: 'm' },
    { fetchImpl: async () => { called = true; return okFetch(); } },
  );
  expect(r.ok).toBe(false);
  expect(called).toBe(false);
});
