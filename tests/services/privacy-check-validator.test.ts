/**
 * Tests for PrivacyCheckValidator — ensures observations are not silently dropped
 * when user prompt is missing (e.g., after compaction or worker restart).
 *
 * Bug: Prior to fix, missing prompt was treated as "private" prompt,
 * causing all observations after compaction to be silently skipped.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PrivacyCheckValidator } from '../../src/services/worker/validation/PrivacyCheckValidator.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('PrivacyCheckValidator', () => {
  let store: SessionStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'privacy-test-'));
    const dbPath = join(tmpDir, 'test.db');
    store = new SessionStore(dbPath);

    // Create a session
    store.createSDKSession('test-session-1', 'test-project', 'hello world');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns prompt text when prompt exists and is public', () => {
    // Save a public prompt
    store.saveUserPrompt('test-session-1', 1, 'What is the weather?');

    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, 'test-session-1', 1, 'observation', 1
    );

    expect(result).toBe('What is the weather?');
  });

  test('returns null when prompt was entirely private (empty after tag stripping)', () => {
    // Save an empty prompt (privacy tags were stripped, leaving nothing)
    store.saveUserPrompt('test-session-1', 1, '');

    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, 'test-session-1', 1, 'observation', 1
    );

    expect(result).toBeNull();
  });

  test('returns null when prompt is whitespace-only (entirely private)', () => {
    store.saveUserPrompt('test-session-1', 1, '   \n  ');

    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, 'test-session-1', 1, 'observation', 1
    );

    expect(result).toBeNull();
  });

  test('returns placeholder when prompt not found — NOT treated as private (compaction fix)', () => {
    // No prompt saved for prompt_number=1
    // This simulates the post-compaction scenario where UserPromptSubmit
    // hasn't fired yet but PostToolUse already has

    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, 'test-session-1', 1, 'observation', 1
    );

    // CRITICAL: Must NOT return null — observations should not be dropped
    expect(result).not.toBeNull();
    expect(result).toBe(PrivacyCheckValidator.PROMPT_NOT_FOUND_PLACEHOLDER);
  });

  test('returns placeholder when promptNumber is 0 (no prompts saved — compaction fix)', () => {
    // After compaction with a new session ID, getPromptNumberFromUserPrompts returns 0
    // getUserPrompt(session, 0) returns null — no prompt with number 0 exists

    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, 'unknown-session', 0, 'observation', 999
    );

    // CRITICAL: Must NOT return null — this is the exact bug that caused data loss
    expect(result).not.toBeNull();
    expect(result).toBe(PrivacyCheckValidator.PROMPT_NOT_FOUND_PLACEHOLDER);
  });

  test('returns placeholder for unknown session ID (session ID changed after compaction)', () => {
    // Session exists but with different contentSessionId
    // This simulates when Claude Code changes session_id after compaction
    store.saveUserPrompt('test-session-1', 1, 'original prompt');

    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, 'different-session-id', 1, 'observation', 1
    );

    // The different session has no prompts — should return placeholder, not null
    expect(result).not.toBeNull();
    expect(result).toBe(PrivacyCheckValidator.PROMPT_NOT_FOUND_PLACEHOLDER);
  });

  test('works correctly for summarize operation type', () => {
    // Missing prompt should also not block summarize
    const result = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, 'test-session-1', 99, 'summarize', 1
    );

    expect(result).not.toBeNull();
    expect(result).toBe(PrivacyCheckValidator.PROMPT_NOT_FOUND_PLACEHOLDER);
  });
});
