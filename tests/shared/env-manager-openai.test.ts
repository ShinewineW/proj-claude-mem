/**
 * Ensure EnvManager recognizes OPENAI_API_KEY as a managed credential, so
 * users can place the key in ~/.claude-mem/.env instead of settings.json.
 *
 * Type-level invariant: ClaudeMemEnv accepts OPENAI_API_KEY field.
 * Array-level invariant: MANAGED_CREDENTIAL_KEYS contains 'OPENAI_API_KEY'.
 * Source-level invariant: parseClaudeMemEnv + saveClaudeMemEnv wire the key
 *   through (these two functions enumerate keys by name, so a missing reference
 *   silently drops the credential at runtime).
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { MANAGED_CREDENTIAL_KEYS, type ClaudeMemEnv } from '../../src/shared/EnvManager.js';

describe('EnvManager — OPENAI_API_KEY support', () => {
  it('MANAGED_CREDENTIAL_KEYS includes OPENAI_API_KEY', () => {
    expect(MANAGED_CREDENTIAL_KEYS).toContain('OPENAI_API_KEY');
  });

  it('ClaudeMemEnv type permits OPENAI_API_KEY assignment (compile + runtime)', () => {
    const env: ClaudeMemEnv = { OPENAI_API_KEY: 'sk-test' };
    expect(env.OPENAI_API_KEY).toBe('sk-test');
  });

  it('loadClaudeMemEnv source mentions OPENAI_API_KEY (so parsed env file values reach callers)', () => {
    const src = readFileSync('src/shared/EnvManager.ts', 'utf-8');
    // Find the loadClaudeMemEnv body — it enumerates keys by name. Without an
    // OPENAI_API_KEY reference, parsed file values would never reach the returned object.
    const loadStart = src.indexOf('export function loadClaudeMemEnv');
    const loadBody = src.slice(loadStart, loadStart + 1500);
    expect(loadBody).toContain('OPENAI_API_KEY');
  });

  it('saveClaudeMemEnv source mentions OPENAI_API_KEY (so updates persist to file)', () => {
    const src = readFileSync('src/shared/EnvManager.ts', 'utf-8');
    const saveStart = src.indexOf('export function saveClaudeMemEnv');
    const saveBody = src.slice(saveStart, saveStart + 2000);
    expect(saveBody).toContain('OPENAI_API_KEY');
  });
});
