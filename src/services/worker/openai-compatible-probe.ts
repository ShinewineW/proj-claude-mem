import { resolveOpenAICompatibleChatCompletionsUrl } from '../../shared/openai-compatible-base-url.js';
import { logger } from '../../utils/logger.js';

export interface OpenAICompatProbeInput {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OpenAICompatProbeResult {
  ok: boolean;
  status?: number;
  message?: string;
}

/**
 * Redact a string for safe logging/return: removes the EXACT configured key
 * (providers vary — keys are not always `sk-` prefixed) AND any bearer-looking
 * token, then caps length. Exported so BypassLane.callRestApi reuses it.
 */
export function redactSecret(s: string, secret?: string): string {
  let out = s;
  // Floor of 4 (not 8): real keys are long, but a fat-fingered short test key
  // (e.g. "test123") must still be masked. <4 chars is skipped only to avoid a
  // 1–3 char "key" garbling ordinary prose. (Security audit Finding 3.)
  if (secret && secret.length >= 4) out = out.split(secret).join('***');
  return out.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 300);
}

/**
 * One-shot connectivity probe for an OpenAI-compatible endpoint. Independent of
 * BypassLane's circuit-breaker state — used by the viewer "Test" button and by
 * BypassLane.probeProvider(). `thinking:disabled` is sent to match the real
 * request shape (reasoning models like deepseek-v4-flash need it); see ADR 0003.
 */
export async function probeOpenAICompatible(
  input: OpenAICompatProbeInput,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenAICompatProbeResult> {
  const url = resolveOpenAICompatibleChatCompletionsUrl(input.baseUrl);
  if (!url) return { ok: false, message: 'Invalid or missing base URL' };
  if (!input.apiKey) return { ok: false, message: 'Missing API key' };
  if (!input.model) return { ok: false, message: 'Missing model' };

  const doFetch = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_tokens: 10,
        thinking: { type: 'disabled' },
      }),
      signal,
    });
    if (response.ok) return { ok: true, status: response.status };
    const body = redactSecret(await response.text(), input.apiKey);
    return { ok: false, status: response.status, message: body || response.statusText };
  } catch (error) {
    const isTimeout = error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError');
    const message = isTimeout ? 'timeout (15s)' : redactSecret(error instanceof Error ? error.message : 'unknown error', input.apiKey);
    logger.debug('BYPASS', 'probeOpenAICompatible failed', { message });
    return { ok: false, message };
  }
}
