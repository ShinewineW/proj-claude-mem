/**
 * EnvManager - Centralized environment variable management for claude-mem
 *
 * Provides isolated credential storage in ~/.claude-mem/.env
 * This ensures claude-mem uses its own configured credentials,
 * not random ANTHROPIC_API_KEY values from project .env files.
 *
 * Issue #733: SDK was auto-discovering API keys from user's shell environment,
 * causing memory operations to bill personal API accounts instead of CLI subscription.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

// Path to claude-mem's centralized .env file
const DATA_DIR = join(homedir(), '.claude-mem');
export const ENV_FILE_PATH = join(DATA_DIR, '.env');

// Environment variables to STRIP from subprocess environment (blocklist approach)
// Only ANTHROPIC_API_KEY is stripped because it's the specific variable that causes
// Issue #733: project .env files set ANTHROPIC_API_KEY which the SDK auto-discovers,
// causing memory operations to bill personal API accounts instead of CLI subscription.
//
// All other env vars (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, system vars, etc.)
// are passed through to avoid breaking CLI authentication, proxies, and platform features.
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',  // Issue #733: Prevent auto-discovery from project .env files
  'CLAUDECODE',         // Prevent "cannot be launched inside another Claude Code session" error
  'CLAUDE_CODE_SESSION',  // Prevent nested session detection in child processes
  'MCP_SESSION_ID',       // Prevent MCP session ID inheritance
  // Issue #2357: parent-shell effort config forwarded by the SDK as the
  // Messages API `effort` param; models without effort support (Haiku 4.5,
  // Sonnet 4.5) reject with a permanent HTTP 400 that retries forever.
  // Safe because ENTRYPOINT/OAUTH are set explicitly AFTER the filter loop.
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
];

// Prefix blocklist — strips interop ports, session keys, etc.
// NOTE: CLAUDE_CODE_* prefix NOT blocked — ENTRYPOINT (set below) and OAUTH_TOKEN are needed
const BLOCKED_ENV_PREFIXES = ['CLAUDECODE_'];

// Credential keys that claude-mem manages
export const MANAGED_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENCODE_API_KEY',
];

export interface ClaudeMemEnv {
  // Credentials (optional - empty means use CLI billing for Claude)
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENCODE_API_KEY?: string;
}

/**
 * Parse a .env file content into key-value pairs
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse KEY=value format
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Serialize key-value pairs to .env file format
 */
function serializeEnvFile(env: Record<string, string>): string {
  const lines: string[] = [
    '# claude-mem credentials',
    '# This file stores API keys for claude-mem memory agent',
    '# Edit this file or use claude-mem settings to configure',
    '',
  ];

  for (const [key, value] of Object.entries(env)) {
    if (value) {
      // Quote values that contain spaces or special characters
      const escaped = value.replace(/"/g, '\\"');
      const needsQuotes = /[\s#="]/.test(value);
      lines.push(`${key}=${needsQuotes ? `"${escaped}"` : escaped}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Load credentials from ~/.claude-mem/.env
 * Returns empty object if file doesn't exist (means use CLI billing)
 */
export function loadClaudeMemEnv(): ClaudeMemEnv {
  if (!existsSync(ENV_FILE_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(ENV_FILE_PATH, 'utf-8');
    const parsed = parseEnvFile(content);

    // Only return managed credential keys
    const result: ClaudeMemEnv = {};
    if (parsed.ANTHROPIC_API_KEY) result.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
    if (parsed.GEMINI_API_KEY) result.GEMINI_API_KEY = parsed.GEMINI_API_KEY;
    if (parsed.OPENCODE_API_KEY) result.OPENCODE_API_KEY = parsed.OPENCODE_API_KEY;

    return result;
  } catch (error) {
    logger.warn('ENV', 'Failed to load .env file', { path: ENV_FILE_PATH }, error as Error);
    return {};
  }
}

/**
 * Save credentials to ~/.claude-mem/.env
 */
export function saveClaudeMemEnv(env: ClaudeMemEnv): void {
  try {
    // Ensure directory exists with restricted permissions (owner only).
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    }
    // The mkdirSync `mode` option only applies at creation time; if DATA_DIR
    // already exists, that mode param is silently ignored. chmodSync therefore
    // explicitly tightens pre-existing dirs. Do NOT remove it thinking
    // mkdirSync's mode covers the existing-dir case — it does not.
    // No-op on Windows (permissions are ACL-controlled, not POSIX).
    chmodSync(DATA_DIR, 0o700);

    // Load existing to preserve any extra keys
    const existing = existsSync(ENV_FILE_PATH)
      ? parseEnvFile(readFileSync(ENV_FILE_PATH, 'utf-8'))
      : {};

    // Update with new values
    const updated: Record<string, string> = { ...existing };

    // Only update managed keys
    if (env.ANTHROPIC_API_KEY !== undefined) {
      if (env.ANTHROPIC_API_KEY) {
        updated.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
      } else {
        delete updated.ANTHROPIC_API_KEY;
      }
    }
    if (env.GEMINI_API_KEY !== undefined) {
      if (env.GEMINI_API_KEY) {
        updated.GEMINI_API_KEY = env.GEMINI_API_KEY;
      } else {
        delete updated.GEMINI_API_KEY;
      }
    }
    if (env.OPENCODE_API_KEY !== undefined) {
      if (env.OPENCODE_API_KEY) {
        updated.OPENCODE_API_KEY = env.OPENCODE_API_KEY;
      } else {
        delete updated.OPENCODE_API_KEY;
      }
    }

    writeFileSync(ENV_FILE_PATH, serializeEnvFile(updated), { encoding: 'utf-8', mode: 0o600 });
    // writeFileSync's `mode` only applies when the file is newly created
    // (O_CREAT); for a pre-existing .env it is silently ignored, so chmodSync
    // explicitly fixes pre-existing files. Required — do not drop. No-op on
    // Windows (ACL-controlled).
    chmodSync(ENV_FILE_PATH, 0o600);
  } catch (error) {
    logger.error('ENV', 'Failed to save .env file', { path: ENV_FILE_PATH }, error as Error);
    throw error;
  }
}

/**
 * Build a clean environment for spawning SDK subprocesses
 *
 * Uses a BLOCKLIST approach: inherits the full process environment but strips
 * only ANTHROPIC_API_KEY to prevent Issue #733 (accidental billing from project .env files).
 *
 * All other variables pass through, including:
 * - ANTHROPIC_AUTH_TOKEN (CLI subscription auth)
 * - ANTHROPIC_BASE_URL (custom proxy endpoints)
 * - Platform-specific vars (USERPROFILE, XDG_*, etc.)
 *
 * If claude-mem has an explicit ANTHROPIC_API_KEY in ~/.claude-mem/.env, it's re-injected
 * after stripping, so the managed credential takes precedence over any ambient value.
 *
 * @param includeCredentials - Whether to include API keys from ~/.claude-mem/.env (default: true)
 */
export function buildIsolatedEnv(includeCredentials: boolean = true): Record<string, string> {
  // 1. Start with full process environment
  const isolatedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_VARS.includes(key)) continue;
    if (BLOCKED_ENV_PREFIXES.some(p => key.startsWith(p))) continue;
    isolatedEnv[key] = value;
  }

  // 2. Override SDK entrypoint marker
  isolatedEnv.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';

  // 3. Re-inject managed credentials from claude-mem's .env file
  if (includeCredentials) {
    const credentials = loadClaudeMemEnv();

    // Only add ANTHROPIC_API_KEY if explicitly configured in claude-mem
    // If not configured, CLI billing will be used (via ANTHROPIC_AUTH_TOKEN passthrough)
    if (credentials.ANTHROPIC_API_KEY) {
      isolatedEnv.ANTHROPIC_API_KEY = credentials.ANTHROPIC_API_KEY;
    }
    // Note: GEMINI_API_KEY / OPENCODE_API_KEY pass through
    // from process.env, but claude-mem's .env takes precedence if configured
    if (credentials.GEMINI_API_KEY) {
      isolatedEnv.GEMINI_API_KEY = credentials.GEMINI_API_KEY;
    }
    if (credentials.OPENCODE_API_KEY) {
      isolatedEnv.OPENCODE_API_KEY = credentials.OPENCODE_API_KEY;
    }

    // 4. Pass through Claude CLI's OAuth token if available (fallback for CLI subscription billing)
    // When no ANTHROPIC_API_KEY is configured, the spawned CLI uses subscription billing
    // which requires either ~/.claude/.credentials.json or CLAUDE_CODE_OAUTH_TOKEN.
    // The worker inherits this token from the Claude Code session that started it.
    if (!isolatedEnv.ANTHROPIC_API_KEY && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  }

  return isolatedEnv;
}

/**
 * Get a specific credential from claude-mem's .env
 * Returns undefined if not set (which means use default/CLI billing)
 */
export function getCredential(key: keyof ClaudeMemEnv): string | undefined {
  const env = loadClaudeMemEnv();
  return env[key];
}

/**
 * Set a specific credential in claude-mem's .env
 * Pass empty string to remove the credential
 */
export function setCredential(key: keyof ClaudeMemEnv, value: string): void {
  const env = loadClaudeMemEnv();
  env[key] = value || undefined;
  saveClaudeMemEnv(env);
}

/**
 * Check if claude-mem has an Anthropic API key configured
 * If false, it means CLI billing should be used
 */
export function hasAnthropicApiKey(): boolean {
  const env = loadClaudeMemEnv();
  return !!env.ANTHROPIC_API_KEY;
}

/**
 * Get auth method description for logging
 */
export function getAuthMethodDescription(): string {
  if (hasAnthropicApiKey()) {
    return 'API key (from ~/.claude-mem/.env)';
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return 'Claude Code OAuth token (from parent process)';
  }
  return 'Claude Code CLI (subscription billing)';
}
