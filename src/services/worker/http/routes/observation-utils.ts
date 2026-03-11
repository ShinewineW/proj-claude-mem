/**
 * Observation Input Safety Utilities
 *
 * Provides safe JSON serialization with circular reference protection
 * and size limiting for tool_input and tool_response fields.
 */

import { stripMemoryTagsFromJson } from '../../../../utils/tag-stripping.js';

/**
 * Maximum size for tool_input or tool_response after JSON serialization.
 * 1MB is sufficient for any observation context; larger payloads are
 * truncated to prevent SQLite bloat and excessive Chroma vectorization.
 */
export const MAX_TOOL_FIELD_SIZE = 1_000_000; // 1MB

/**
 * Safely stringify a value with circular reference protection and size limit.
 * Returns '{}' for undefined/null input.
 */
export function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return '{"error":"[Circular or non-serializable input]"}';
  }
  if (json.length > MAX_TOOL_FIELD_SIZE) {
    return JSON.stringify({
      _truncated: true,
      _originalSize: json.length,
      _maxSize: MAX_TOOL_FIELD_SIZE,
    });
  }
  return json;
}

/**
 * Clean and safely serialize a tool field (input or response).
 * Combines safe serialization with memory tag stripping.
 */
export function cleanToolField(value: unknown): string {
  const json = safeStringify(value);
  return stripMemoryTagsFromJson(json);
}
