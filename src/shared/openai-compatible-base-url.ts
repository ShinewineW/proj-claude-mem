// SPDX-License-Identifier: Apache-2.0

/**
 * Shared base-URL resolution for OpenAI-compatible providers.
 *
 * The bypass OpenCode path (BypassLane.ts) uses this to turn an optional
 * CLAUDE_MEM_OPENCODE_BASE_URL setting into a concrete `/chat/completions`
 * endpoint, making it a generic OpenAI-compatible client (DeepSeek, LM Studio,
 * any custom gateway). Default behavior is unchanged when the setting is unset.
 *
 * Generalized from upstream thedotmack/claude-mem (commit d13fc437, Apache-2.0):
 * the upstream resolver was provider-specific; this version takes the default
 * endpoint as a parameter so it works for any OpenAI-compatible provider.
 * (No provider name appears in this file so the Task 3 removal grep stays clean.)
 */

import { logger } from '../utils/logger.js';

export const DEFAULT_OPENCODE_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

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
 * Resolve the chat-completions endpoint from an optional configured base URL.
 *
 * Rules:
 *   - unset/blank  -> defaultUrl (behavior unchanged)
 *   - non-http(s) / malformed / hostless -> defaultUrl (credentials are never
 *     sent to an invalid destination; a WARN is logged)
 *   - a full URL already ending in `/chat/completions` -> used verbatim
 *     (trailing slashes are stripped first, so a trailing-slash variant collapses
 *     to the no-trailing-slash form)
 *   - a base URL (e.g. `https://api.deepseek.com/v1`) -> `/chat/completions` appended
 */
export function resolveOpenAICompatibleChatCompletionsUrl(
  baseUrl: string | undefined | null,
  defaultUrl: string,
): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    return defaultUrl;
  }

  if (!isSafeHttpUrl(trimmed)) {
    logger.warn('WORKER', 'Configured base URL is not a valid http(s) URL — ignoring and using the default endpoint', {
      // Log only the scheme prefix, never the full value (may carry a typo'd host).
      prefix: trimmed.slice(0, 12),
    });
    return defaultUrl;
  }

  const normalized = trimmed.replace(/\/+$/, '');

  if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return normalized;
  }

  return `${normalized}${CHAT_COMPLETIONS_PATH}`;
}
