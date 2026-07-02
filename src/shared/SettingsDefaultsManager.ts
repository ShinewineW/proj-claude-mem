/**
 * SettingsDefaultsManager
 *
 * Single source of truth for all default configuration values.
 * Provides methods to get defaults with optional environment variable overrides.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
// NOTE: Do NOT import logger here - it creates a circular dependency
// logger.ts depends on SettingsDefaultsManager for its initialization

export interface SettingsDefaults {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;
  CLAUDE_MEM_SKIP_TOOLS: string;
  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER: string; // 'claude' | 'openai'
  CLAUDE_MEM_OPENAI_API_KEY: string;
  CLAUDE_MEM_OPENAI_MODEL: string;
  CLAUDE_MEM_OPENAI_BASE_URL: string;
  // System Configuration
  CLAUDE_MEM_DATA_DIR: string;
  CLAUDE_MEM_LOG_LEVEL: string;
  CLAUDE_CODE_PATH: string;
  // Token Economics
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  // Display Configuration
  CLAUDE_MEM_CONTEXT_FULL_COUNT: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: string;
  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
  CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: string;
  // Process Management
  CLAUDE_MEM_MAX_CONCURRENT_AGENTS: string; // Max concurrent Claude SDK agent subprocesses (default: 4)
  CLAUDE_MEM_RESPONSE_WATCHDOG_MS: string; // Kill subprocess if no response within this time (default: 300000 = 5min)
  // Exclusion Settings
  CLAUDE_MEM_EXCLUDED_PROJECTS: string; // Comma-separated glob patterns for excluded project paths
  CLAUDE_MEM_FOLDER_MD_EXCLUDE: string; // JSON array of folder paths to exclude from CLAUDE.md generation
  // Chroma Vector Database Configuration
  CLAUDE_MEM_CHROMA_ENABLED: string; // 'true' | 'false' - set to 'false' for SQLite-only mode
  CLAUDE_MEM_CHROMA_MODE: string; // 'local' | 'remote'
  CLAUDE_MEM_CHROMA_HOST: string;
  CLAUDE_MEM_CHROMA_PORT: string;
  CLAUDE_MEM_CHROMA_SSL: string;
  // Future cloud support
  CLAUDE_MEM_CHROMA_API_KEY: string;
  CLAUDE_MEM_CHROMA_TENANT: string;
  CLAUDE_MEM_CHROMA_DATABASE: string;
  // Retention Policy
  CLAUDE_MEM_RETENTION_ENABLED: string; // 'true' | 'false'
  CLAUDE_MEM_RETENTION_DAYS: string; // grace period in days
  CLAUDE_MEM_RETENTION_SCORE_THRESHOLD: string; // minimum score to keep (0.0-1.0)
  CLAUDE_MEM_RETENTION_MAX_KEPT: string; // hard cap on >grace-period observations
  // Bypass Lane
  CLAUDE_MEM_BYPASS_COOLDOWN_MS: string; // Cooldown period before retrying tripped bypass lane (default: 20min)
  // SDK Token Optimization (Phase 1)
  CLAUDE_MEM_SKIP_TOOL_PATTERNS: string; // Comma-separated tool:glob pairs for pattern-based observation filtering
  CLAUDE_MEM_BATCH_MAX_SIZE: string; // Max observations in a single batch prompt (1-20)
  CLAUDE_MEM_OBS_MAX_FIELD_CHARS: string; // Max chars per tool_input/tool_output field before truncation
  // Pool Starvation Defense
  CLAUDE_MEM_POOL_COOLDOWN_MS: string;
  CLAUDE_MEM_MAX_POOL_RETRIES: string;
  CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS: string;
  CLAUDE_MEM_STALE_INIT_THRESHOLD_MS: string;
  CLAUDE_MEM_BACKPRESSURE_L1: string;
  CLAUDE_MEM_BACKPRESSURE_L2: string;
  CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE: string;
  // SDK Token Optimization (Phase 2 — Layer C)
  CLAUDE_MEM_MAX_HISTORY_LENGTH: string;    // Max conversation history messages before proactive reset
  CLAUDE_MEM_MAX_HISTORY_TOKENS: string;    // Max estimated tokens before proactive reset
  // SummaryLane adaptive observation cap
  CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS: string; // Default cap on obs embedded in fresh-summarize prompt (first step of adaptive sequence)
  // Session lifecycle guard
  CLAUDE_MEM_SESSION_MAX_AGE_MS: string; // Wall-clock age (ms) after which a session refuses new generators (#1590)
}

export class SettingsDefaultsManager {
  /**
   * Default values for all settings
   */
  private static readonly DEFAULTS: SettingsDefaults = {
    CLAUDE_MEM_MODEL: "claude-sonnet-5",
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: "50",
    CLAUDE_MEM_WORKER_PORT: "37777",
    CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_SKIP_TOOLS:
      "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion,Monitor,TaskUpdate,TaskCreate,TaskGet,TaskList,TaskStop,TaskOutput",
    // AI Provider Configuration
    CLAUDE_MEM_PROVIDER: "claude", // Default to Claude
    CLAUDE_MEM_OPENAI_API_KEY: "", // Empty by default, set via UI or OPENAI_API_KEY env
    CLAUDE_MEM_OPENAI_MODEL: "deepseek-v4-flash", // User-overridable; any OpenAI-compatible model id
    CLAUDE_MEM_OPENAI_BASE_URL: "", // Required to enable the openai bypass (blank = bypass disabled)
    // System Configuration
    CLAUDE_MEM_DATA_DIR: join(homedir(), ".claude-mem"),
    CLAUDE_MEM_LOG_LEVEL: "INFO",
    CLAUDE_CODE_PATH: "", // Empty means auto-detect via 'which claude'
    // Token Economics
    CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: "false",
    CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: "false",
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: "false",
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: "true",
    // Display Configuration
    CLAUDE_MEM_CONTEXT_FULL_COUNT: "0",
    CLAUDE_MEM_CONTEXT_FULL_FIELD: "narrative",
    CLAUDE_MEM_CONTEXT_SESSION_COUNT: "10",
    // Feature Toggles
    CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: "true",
    CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: "false",
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: "true",
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: "false",
    // Process Management
    CLAUDE_MEM_MAX_CONCURRENT_AGENTS: "4", // Max concurrent Claude SDK agent subprocesses (raised from 2: audit 2026-03-28 P0)
    CLAUDE_MEM_RESPONSE_WATCHDOG_MS: "300000", // 5 minutes — kill subprocess if no response
    // Exclusion Settings
    CLAUDE_MEM_EXCLUDED_PROJECTS: "", // Comma-separated glob patterns for excluded project paths
    CLAUDE_MEM_FOLDER_MD_EXCLUDE: "[]", // JSON array of folder paths to exclude from CLAUDE.md generation
    // Chroma Vector Database Configuration
    CLAUDE_MEM_CHROMA_ENABLED: "true", // Set to 'false' to disable Chroma and use SQLite-only search
    CLAUDE_MEM_CHROMA_MODE: "local", // 'local' uses persistent chroma-mcp via uvx, 'remote' connects to existing server
    CLAUDE_MEM_CHROMA_HOST: "127.0.0.1",
    CLAUDE_MEM_CHROMA_PORT: "8000",
    CLAUDE_MEM_CHROMA_SSL: "false",
    // Future cloud support (claude-mem pro)
    CLAUDE_MEM_CHROMA_API_KEY: "",
    CLAUDE_MEM_CHROMA_TENANT: "default_tenant",
    CLAUDE_MEM_CHROMA_DATABASE: "default_database",
    // Retention Policy
    CLAUDE_MEM_RETENTION_ENABLED: "true",
    CLAUDE_MEM_RETENTION_DAYS: "30",
    CLAUDE_MEM_RETENTION_SCORE_THRESHOLD: "0.3",
    CLAUDE_MEM_RETENTION_MAX_KEPT: "3000",
    // Bypass Lane
    CLAUDE_MEM_BYPASS_COOLDOWN_MS: "1200000", // 20 minutes
    // SDK Token Optimization (Phase 1)
    CLAUDE_MEM_SKIP_TOOL_PATTERNS:
      "Read:*SKILL.md,Read:*/.claude/rules/*,Read:*settings.json,Read:*hooks.json,Glob:*",
    CLAUDE_MEM_BATCH_MAX_SIZE: "5",
    CLAUDE_MEM_OBS_MAX_FIELD_CHARS: "8000",
    // Pool Starvation Defense
    CLAUDE_MEM_POOL_COOLDOWN_MS: "120000",
    CLAUDE_MEM_MAX_POOL_RETRIES: "5",
    CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS: "180000",
    CLAUDE_MEM_STALE_INIT_THRESHOLD_MS: "120000",
    CLAUDE_MEM_BACKPRESSURE_L1: "20",
    CLAUDE_MEM_BACKPRESSURE_L2: "50",
    CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE: "3",
    // SDK Token Optimization (Phase 2 — Layer C)
    CLAUDE_MEM_MAX_HISTORY_LENGTH: "50",
    CLAUDE_MEM_MAX_HISTORY_TOKENS: "100000",
    // SummaryLane: default cap at the first step of the adaptive sequence.
    // The runtime derives the rest by repeated halving, so the default 150
    // becomes [150, 75, 37, 18, 9, 4, 2, 1]. Setting values <= 0 or
    // non-numeric fall back to 150 defensively.
    CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS: "150",
    // Session lifecycle guard: 4 hours. Sessions older than this refuse new
    // generators and drain their queue, capping runaway API spend (#1590).
    CLAUDE_MEM_SESSION_MAX_AGE_MS: "14400000",
  };

  /**
   * Get all defaults as an object
   */
  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  /**
   * Get a default value from defaults (no environment variable override)
   */
  static get(key: keyof SettingsDefaults): string {
    return this.DEFAULTS[key];
  }

  /**
   * Get an integer default value
   */
  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  /**
   * Get a boolean default value
   * Handles both string 'true' and boolean true from JSON
   */
  static getBool(key: keyof SettingsDefaults): boolean {
    const value = this.get(key);
    return value === "true" || value === true;
  }

  /**
   * Apply environment variable overrides to settings
   * Environment variables take highest priority over file and defaults
   */
  private static applyEnvOverrides(
    settings: SettingsDefaults,
  ): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<
      keyof SettingsDefaults
    >) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  /**
   * Load settings from file with fallback to defaults
   * Returns merged settings with proper priority: process.env > settings file > defaults
   * Handles all errors (missing file, corrupted JSON, permissions) gracefully
   *
   * Configuration Priority:
   *   1. Environment variables (highest priority)
   *   2. Settings file (~/.claude-mem/settings.json)
   *   3. Default values (lowest priority)
   */
  // --- TTL cache (P3 optimization) ---
  private static cache: Map<string, { data: SettingsDefaults; ts: number }> = new Map();
  private static readonly CACHE_TTL_MS = 5000;

  /**
   * Invalidate the settings file cache.
   * Call after writing settings.json to ensure next read reflects changes.
   * @param settingsPath - specific path to invalidate, or omit to clear all
   */
  static invalidateCache(settingsPath?: string): void {
    if (settingsPath) {
      this.cache.delete(settingsPath);
    } else {
      this.cache.clear();
    }
  }

  static loadFromFile(settingsPath: string): SettingsDefaults {
    // TTL cache: avoid repeated readFileSync + JSON.parse on hot paths
    const now = Date.now();
    const cached = this.cache.get(settingsPath);
    if (cached && now - cached.ts < this.CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
          }
          chmodSync(dir, 0o700);
          // settings.json can hold API keys — create owner-only. The mode arg
          // applies only on creation (and is umask-masked); chmodSync also
          // tightens a pre-existing world-readable file.
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
          });
          chmodSync(settingsPath, 0o600);
          // Use console instead of logger to avoid circular dependency
          console.log(
            "[SETTINGS] Created settings file with defaults:",
            settingsPath,
          );
        } catch (error) {
          console.warn(
            "[SETTINGS] Failed to create settings file, using in-memory defaults:",
            settingsPath,
            error,
          );
        }
        // Still apply env var overrides even when file doesn't exist
        const result = this.applyEnvOverrides(defaults);
        this.cache.set(settingsPath, { data: result, ts: Date.now() });
        return result;
      }

      const settingsData = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(settingsData);

      // MIGRATION: Handle old nested schema { env: {...} }
      let flatSettings = settings;
      if (settings.env && typeof settings.env === "object") {
        // Migrate from nested to flat schema
        flatSettings = settings.env;

        // Auto-migrate the file to flat schema (keep it owner-only — it can
        // hold API keys; rewrites a pre-existing file so chmodSync after).
        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
          });
          chmodSync(settingsPath, 0o600);
          console.log(
            "[SETTINGS] Migrated settings file from nested to flat schema:",
            settingsPath,
          );
        } catch (error) {
          console.warn(
            "[SETTINGS] Failed to auto-migrate settings file:",
            settingsPath,
            error,
          );
          // Continue with in-memory migration even if write fails
        }
      }

      // Merge file settings with defaults (flat schema)
      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<
        keyof SettingsDefaults
      >) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      // Apply environment variable overrides (highest priority)
      const finalResult = this.applyEnvOverrides(result);
      this.cache.set(settingsPath, { data: finalResult, ts: Date.now() });
      return finalResult;
    } catch (error) {
      console.warn(
        "[SETTINGS] Failed to load settings, using defaults:",
        settingsPath,
        error,
      );
      // Still apply env var overrides even on error
      const fallbackResult = this.applyEnvOverrides(this.getAllDefaults());
      this.cache.set(settingsPath, { data: fallbackResult, ts: Date.now() });
      return fallbackResult;
    }
  }
}
