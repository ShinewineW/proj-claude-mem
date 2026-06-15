// SPDX-License-Identifier: Apache-2.0

/**
 * Shared base-URL resolution for OpenAI-compatible providers.
 *
 * The bypass openai path (BypassLane.ts) uses this to turn the required
 * CLAUDE_MEM_OPENAI_BASE_URL setting into a concrete `/chat/completions`
 * endpoint, making it a generic OpenAI-compatible client (DeepSeek, LM Studio,
 * any custom gateway). The base URL is required: blank/invalid input returns
 * null, which the caller treats as "bypass not configured".
 */

import { logger } from '../utils/logger.js';

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Whether a configured base URL is safe to send the provider API key + content
 * to: it must parse as a URL with an http:/https: protocol and a non-empty host.
 * Anything else (file:, ftp:, ws:, javascript:, missing host, garbage) is
 * rejected so a fat-fingered or attacker-supplied value can't exfiltrate the
 * Bearer credentials / observation payload to an arbitrary destination.
 */
function isSafeHttpUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return parsed.hostname.length > 0;
}

/**
 * Resolve the chat-completions endpoint from a user-supplied base URL.
 * Returns null when the input is blank, malformed, or not http(s) — the
 * caller treats null as "bypass not configured" (base URL is required).
 */
export function resolveOpenAICompatibleChatCompletionsUrl(
  baseUrl: string | undefined | null,
): string | null {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed || !isSafeHttpUrl(trimmed)) {
    if (trimmed) {
      logger.warn('WORKER', 'Configured base URL is not a valid http(s) URL — bypass disabled', {
        prefix: trimmed.slice(0, 12),
      });
    }
    return null;
  }
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return normalized;
  }
  return `${normalized}${CHAT_COMPLETIONS_PATH}`;
}
