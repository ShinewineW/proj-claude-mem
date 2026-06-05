/**
 * Tag Stripping Utilities
 *
 * Implements the dual-tag system for meta-observation control:
 * 1. <claude-mem-context> - System-level tag for auto-injected observations
 *    (prevents recursive storage when context injection is active)
 * 2. <private> - User-level tag for manual privacy control
 *    (allows users to mark content they don't want persisted)
 *
 * EDGE PROCESSING PATTERN: Filter at hook layer before sending to worker/storage.
 * This keeps the worker service simple and follows one-way data stream.
 */

import { logger } from './logger.js';

/**
 * Regex to match <system-reminder> tags and their content.
 *
 * @remarks Exported PURELY for reuse by transcript parsers that strip
 * system-reminder at read-time; it is an internal implementation detail of the
 * stripping module, not a stable public API. Treat as `@internal`. Carries the
 * `/g` flag — see the lastIndex caveat at the stripTagsInternal call site.
 */
export const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Maximum number of tags allowed in a single content block
 * This protects against ReDoS (Regular Expression Denial of Service) attacks
 * where malicious input with many nested/unclosed tags could cause catastrophic backtracking
 */
const MAX_TAG_COUNT = 100;

/**
 * Count total number of opening tags in content
 * Used for ReDoS protection before regex processing
 */
function countTags(content: string): number {
  const privateCount = (content.match(/<private>/g) || []).length;
  const contextCount = (content.match(/<claude-mem-context>/g) || []).length;
  const sysInstructionCount = (content.match(/<system_instruction>/g) || []).length;
  const sysInstructionHyphenCount = (content.match(/<system-instruction>/g) || []).length;
  const taskNotificationCount = (content.match(/<task-notification>/g) || []).length;
  const systemReminderCount = (content.match(/<system-reminder>/g) || []).length;
  const persistedOutputCount = (content.match(/<persisted-output>/g) || []).length;
  return privateCount + contextCount + sysInstructionCount + sysInstructionHyphenCount + taskNotificationCount + systemReminderCount + persistedOutputCount;
}

/**
 * Internal function to strip memory tags from content
 * Shared logic extracted from both JSON and prompt stripping functions
 */
function stripTagsInternal(content: string): string {
  // ReDoS protection: limit tag count before regex processing
  const tagCount = countTags(content);
  if (tagCount > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
      tagCount,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: content.length
    });
    // Still process but log the anomaly
  }

  return content
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/g, '')
    .replace(/<system-instruction>[\s\S]*?<\/system-instruction>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(SYSTEM_REMINDER_REGEX, '')
    .replace(/<persisted-output>[\s\S]*?<\/persisted-output>/g, '')
    .trim();
}

/**
 * Strip memory tags from JSON-serialized content (tool inputs/responses)
 *
 * @param content - Stringified JSON content from tool_input or tool_response
 * @returns Cleaned content with tags removed, or '{}' if invalid
 */
export function stripMemoryTagsFromJson(content: string): string {
  return stripTagsInternal(content);
}

/**
 * Strip memory tags from user prompt content
 *
 * @param content - Raw user prompt text
 * @returns Cleaned content with tags removed
 */
export function stripMemoryTagsFromPrompt(content: string): string {
  return stripTagsInternal(content);
}

/**
 * Possible reasons a prompt ended up fully redacted (i.e., emptied) by tag stripping.
 *
 * Distinguishes user-intentional redaction (`<private>`) from system-injected noise
 * (`<system-instruction>`, `<task-notification>`, `<claude-mem-context>`). Legacy code
 * conflated all of these as "private" by checking for empty strings, which caused
 * session-wide skip-loops when Conductor or background-task notifications wrapped an
 * entire prompt — and also misclassified DB race conditions (failed inserts, worker
 * restart) as privacy events.
 */
export type RedactionReason =
  | 'private'
  | 'system_instruction'
  | 'task_notification'
  | 'claude_mem_context'
  | 'unknown';

export interface StripResult {
  /** Content after tag stripping (may be ''). */
  stripped: string;
  /** True iff original was non-empty but stripping reduced it to empty — i.e. some recognized tag wrapped the entire prompt. */
  wasRedacted: boolean;
  /** Which tag dominated the redaction. Only meaningful when wasRedacted=true. */
  redactionReason?: RedactionReason;
}

/**
 * Strip memory tags from a user prompt and report whether the content was
 * entirely redacted, plus which tag caused it. Save paths use the flag to
 * mark redacted prompts explicitly instead of letting downstream code re-infer
 * "is this private?" from an empty string (which is ambiguous with race
 * conditions and failed inserts).
 */
export function stripMemoryTagsFromPromptDetailed(content: string): StripResult {
  const originalNonEmpty = content.trim().length > 0;
  const stripped = stripTagsInternal(content);
  const wasRedacted = originalNonEmpty && stripped.length === 0;

  let redactionReason: RedactionReason | undefined;
  if (wasRedacted) {
    if (/<private>[\s\S]*?<\/private>/.test(content)) {
      redactionReason = 'private';
    } else if (/<system[-_]instruction>[\s\S]*?<\/system[-_]instruction>/i.test(content)) {
      redactionReason = 'system_instruction';
    } else if (/<task-notification>[\s\S]*?<\/task-notification>/.test(content)) {
      redactionReason = 'task_notification';
    } else if (/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/.test(content)) {
      redactionReason = 'claude_mem_context';
    } else {
      redactionReason = 'unknown';
    }
  }

  return { stripped, wasRedacted, redactionReason };
}
