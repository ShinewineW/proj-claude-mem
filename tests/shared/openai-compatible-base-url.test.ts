import { describe, it, expect } from 'bun:test';
import { resolveOpenAICompatibleChatCompletionsUrl } from '../../src/shared/openai-compatible-base-url.js';

describe('resolveOpenAICompatibleChatCompletionsUrl', () => {
  it('appends /chat/completions to a base URL', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://api.deepseek.com'))
      .toBe('https://api.deepseek.com/chat/completions');
  });

  it('appends /chat/completions to a base URL with a path', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://api.deepseek.com/v1'))
      .toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('uses a full chat-completions URL verbatim', () => {
    const full = 'https://api.deepseek.com/v1/chat/completions';
    expect(resolveOpenAICompatibleChatCompletionsUrl(full)).toBe(full);
  });

  it('uses a full chat/completions URL verbatim (strips trailing slash)', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('https://x.ai/v1/chat/completions/'))
      .toBe('https://x.ai/v1/chat/completions');
  });

  it('normalizes trailing slashes before appending', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('http://localhost:1234/v1/'))
      .toBe('http://localhost:1234/v1/chat/completions');
  });

  it('returns null for blank / non-http(s) / hostless input', () => {
    expect(resolveOpenAICompatibleChatCompletionsUrl('')).toBeNull();
    expect(resolveOpenAICompatibleChatCompletionsUrl('   ')).toBeNull();
    expect(resolveOpenAICompatibleChatCompletionsUrl(undefined)).toBeNull();
    expect(resolveOpenAICompatibleChatCompletionsUrl(null)).toBeNull();
    expect(resolveOpenAICompatibleChatCompletionsUrl('file:///etc/passwd')).toBeNull();
    expect(resolveOpenAICompatibleChatCompletionsUrl('not a url')).toBeNull();
  });
});
