import { describe, test, expect } from 'bun:test';
import { safeStringify, cleanToolField, MAX_TOOL_FIELD_SIZE } from '../../../src/services/worker/http/routes/observation-utils';

describe('Observation input safety', () => {
  test('safeStringify handles circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const result = safeStringify(obj);
    expect(result).toBe('{"error":"[Circular or non-serializable input]"}');
  });

  test('safeStringify handles normal objects', () => {
    const result = safeStringify({ key: 'value', num: 42 });
    expect(result).toBe('{"key":"value","num":42}');
  });

  test('safeStringify returns valid JSON envelope for oversized output', () => {
    const big = { data: 'x'.repeat(MAX_TOOL_FIELD_SIZE + 1000) };
    const result = safeStringify(big);
    expect(result.length).toBeLessThan(MAX_TOOL_FIELD_SIZE);
    const parsed = JSON.parse(result);
    expect(parsed._truncated).toBe(true);
    expect(parsed._originalSize).toBeGreaterThan(MAX_TOOL_FIELD_SIZE);
    expect(parsed._maxSize).toBe(MAX_TOOL_FIELD_SIZE);
  });

  test('safeStringify returns undefined as empty object', () => {
    expect(safeStringify(undefined)).toBe('{}');
  });

  test('safeStringify returns null as empty object', () => {
    expect(safeStringify(null)).toBe('{}');
  });

  test('cleanToolField strips memory tags and handles safety', () => {
    const result = cleanToolField({ key: 'value' });
    expect(result).toBe('{"key":"value"}');
  });

  test('cleanToolField handles undefined', () => {
    expect(cleanToolField(undefined)).toBe('{}');
  });
});
