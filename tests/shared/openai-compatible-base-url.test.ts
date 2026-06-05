import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_OPENCODE_API_URL,
  resolveOpenAICompatibleChatCompletionsUrl,
} from '../../src/shared/openai-compatible-base-url.js';

describe('resolveOpenAICompatibleChatCompletionsUrl', () => {
  it('returns the provided default when base URL is unset/blank', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('', DEFAULT_OPENCODE_API_URL)).toBe(DEFAULT_OPENCODE_API_URL);
    expect(resolveOpenAICompatibleChatCompletionsUrl(undefined, DEFAULT_OPENCODE_API_URL)).toBe(DEFAULT_OPENCODE_API_URL);
    expect(resolveOpenAICompatibleChatCompletionsUrl('   ', DEFAULT_OPENCODE_API_URL)).toBe(DEFAULT_OPENCODE_API_URL);
  });

  it('uses a full chat-completions URL verbatim', () => {
    const full = 'https://api.deepseek.com/v1/chat/completions';
    expect(resolveOpenAICompatibleChatCompletionsUrl(full, DEFAULT_OPENCODE_API_URL)).toBe(full);
  });

  it('strips a trailing slash from a full chat-completions URL', () => {
    // Documents the normalization branch: trailing slash is stripped before the
    // ".../chat/completions" suffix check, so the result has no trailing slash.
    const fullWithSlash = 'https://api.deepseek.com/v1/chat/completions/';
    expect(resolveOpenAICompatibleChatCompletionsUrl(fullWithSlash, DEFAULT_OPENCODE_API_URL))
      .toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('appends /chat/completions to a base URL', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://api.deepseek.com/v1', DEFAULT_OPENCODE_API_URL))
      .toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('normalizes trailing slashes before appending', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('http://localhost:1234/v1/', DEFAULT_OPENCODE_API_URL))
      .toBe('http://localhost:1234/v1/chat/completions');
  });

  it('exports the OpenCode Go default endpoint', () => {
    expect(DEFAULT_OPENCODE_API_URL).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });
});
