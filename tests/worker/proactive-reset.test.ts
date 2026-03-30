import { describe, test, expect } from 'bun:test';
import { shouldProactiveReset } from '../../src/services/worker/generator-action.js';

describe('shouldProactiveReset', () => {
  test('triggers when history length exceeds threshold', () => {
    const history = Array.from({ length: 51 }, () => ({ content: 'short' }));
    expect(shouldProactiveReset(51, history, 50, 100000)).toBe(true);
  });

  test('does not trigger when history length is at threshold', () => {
    const history = Array.from({ length: 50 }, () => ({ content: 'short' }));
    expect(shouldProactiveReset(50, history, 50, 100000)).toBe(false);
  });

  test('triggers when estimated tokens exceed threshold', () => {
    // Each message ~2500 chars = ~625 tokens. 200 messages = ~125K tokens > 100K
    const history = Array.from({ length: 200 }, () => ({ content: 'x'.repeat(2500) }));
    expect(shouldProactiveReset(200, history, 500, 100000)).toBe(true);
  });

  test('does not trigger when both below threshold', () => {
    const history = Array.from({ length: 10 }, () => ({ content: 'hello world' }));
    expect(shouldProactiveReset(10, history, 50, 100000)).toBe(false);
  });

  test('length trigger fires before token estimation', () => {
    const history = Array.from({ length: 51 }, () => ({ content: 'hi' }));
    expect(shouldProactiveReset(51, history, 50, 100000)).toBe(true);
  });

  test('handles empty content gracefully', () => {
    const history = Array.from({ length: 10 }, () => ({ content: undefined as any }));
    expect(shouldProactiveReset(10, history, 50, 100000)).toBe(false);
  });
});
