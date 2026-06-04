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

export const DEFAULT_OPENCODE_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Resolve the chat-completions endpoint from an optional configured base URL.
 *
 * Rules:
 *   - unset/blank  -> defaultUrl (behavior unchanged)
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

  const normalized = trimmed.replace(/\/+$/, '');

  if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return normalized;
  }

  return `${normalized}${CHAT_COMPLETIONS_PATH}`;
}
