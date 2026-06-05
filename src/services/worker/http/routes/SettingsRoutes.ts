/**
 * Settings Routes
 *
 * Handles settings management (read, update, validate).
 * Settings are stored in ~/.claude-mem/settings.json
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { clearPortCache } from '../../../../shared/worker-utils.js';

export class SettingsRoutes extends BaseRouteHandler {
  constructor() {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Settings endpoints
    app.get('/api/settings', this.handleGetSettings.bind(this));
    app.post('/api/settings', this.handleUpdateSettings.bind(this));
  }

  /**
   * Get environment settings (from ~/.claude-mem/settings.json)
   */
  private handleGetSettings = this.wrapHandler((req: Request, res: Response): void => {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    this.ensureSettingsFile(settingsPath);
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    res.json(settings);
  });

  /**
   * Update environment settings (in ~/.claude-mem/settings.json) with validation
   */
  private handleUpdateSettings = this.wrapHandler((req: Request, res: Response): void => {
    // Validate all settings
    const validation = this.validateSettings(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error
      });
      return;
    }

    // Read existing settings
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    this.ensureSettingsFile(settingsPath);
    let settings: any = {};

    if (existsSync(settingsPath)) {
      const settingsData = readFileSync(settingsPath, 'utf-8');
      try {
        settings = JSON.parse(settingsData);
      } catch (parseError) {
        logger.error('SETTINGS', 'Failed to parse settings file', { settingsPath }, parseError as Error);
        res.status(500).json({
          success: false,
          error: 'Settings file is corrupted. Delete ~/.claude-mem/settings.json to reset.'
        });
        return;
      }
    }

    // Update all settings from request body
    const settingKeys = [
      'CLAUDE_MEM_MODEL',
      'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
      'CLAUDE_MEM_WORKER_PORT',
      'CLAUDE_MEM_WORKER_HOST',
      // AI Provider Configuration
      'CLAUDE_MEM_PROVIDER',
      'CLAUDE_MEM_GEMINI_API_KEY',
      'CLAUDE_MEM_GEMINI_MODEL',
      'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED',
      // OpenCode Go Configuration
      'CLAUDE_MEM_OPENCODE_API_KEY',
      'CLAUDE_MEM_OPENCODE_MODEL',
      'CLAUDE_MEM_OPENCODE_MAX_CONTEXT_MESSAGES',
      'CLAUDE_MEM_OPENCODE_MAX_TOKENS',
      'CLAUDE_MEM_OPENCODE_BASE_URL',
      // System Configuration
      'CLAUDE_MEM_LOG_LEVEL',
      'CLAUDE_CODE_PATH',
      // Token Economics
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      // Display Configuration
      'CLAUDE_MEM_CONTEXT_FULL_COUNT',
      'CLAUDE_MEM_CONTEXT_FULL_FIELD',
      'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
      // Feature Toggles
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
      'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED',
      // SDK Token Optimization (Phase 1)
      'CLAUDE_MEM_SKIP_TOOL_PATTERNS',
      'CLAUDE_MEM_BATCH_MAX_SIZE',
      'CLAUDE_MEM_OBS_MAX_FIELD_CHARS',
      // Pool Starvation Defense
      'CLAUDE_MEM_POOL_COOLDOWN_MS',
      'CLAUDE_MEM_MAX_POOL_RETRIES',
      'CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS',
      'CLAUDE_MEM_STALE_INIT_THRESHOLD_MS',
      'CLAUDE_MEM_BACKPRESSURE_L1',
      'CLAUDE_MEM_BACKPRESSURE_L2',
      'CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE',
      // SDK Token Optimization (Phase 2)
      'CLAUDE_MEM_MAX_HISTORY_LENGTH',
      'CLAUDE_MEM_MAX_HISTORY_TOKENS',
      // SummaryLane adaptive observation cap
      'CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS',
      // Session lifecycle guard
      'CLAUDE_MEM_SESSION_MAX_AGE_MS',
    ];

    for (const key of settingKeys) {
      if (req.body[key] !== undefined) {
        settings[key] = req.body[key];
      }
    }

    // Write back. settings.json holds CLAUDE_MEM_*_API_KEY values, so restrict
    // to owner-only (same policy as ~/.claude-mem/.env). The writeFileSync mode
    // only applies on creation; chmodSync fixes pre-existing files. No-op on
    // Windows (ACL-controlled).
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(settingsPath, 0o600);

    // Clear port cache to force re-reading from updated settings
    clearPortCache();
    // Clear settings TTL cache so next loadFromFile() re-reads from disk
    SettingsDefaultsManager.invalidateCache(settingsPath);

    logger.info('WORKER', 'Settings updated');
    res.json({ success: true, message: 'Settings updated successfully' });
  });

  /**
   * Validate all settings from request body (single source of truth)
   */
  private validateSettings(settings: any): { valid: boolean; error?: string } {
    // Validate CLAUDE_MEM_PROVIDER
    if (settings.CLAUDE_MEM_PROVIDER) {
    const validProviders = ['claude', 'gemini', 'opencode'];
    if (!validProviders.includes(settings.CLAUDE_MEM_PROVIDER)) {
      return { valid: false, error: 'CLAUDE_MEM_PROVIDER must be "claude", "gemini", or "opencode"' };
      }
    }

    // Validate CLAUDE_MEM_GEMINI_MODEL
    if (settings.CLAUDE_MEM_GEMINI_MODEL) {
      const validGeminiModels = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3-flash-preview'];
      if (!validGeminiModels.includes(settings.CLAUDE_MEM_GEMINI_MODEL)) {
        return { valid: false, error: 'CLAUDE_MEM_GEMINI_MODEL must be one of: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-3-flash-preview' };
      }
    }

    // Validate CLAUDE_MEM_OPENCODE_BASE_URL — must be a valid http(s) URL when
    // set (blank = use the default OpenCode endpoint). The bypass lane sends the
    // OpenCode Bearer key + observation content here, so a non-http(s) / malformed
    // value is rejected rather than persisted (mirrors the resolver's guard).
    if (settings.CLAUDE_MEM_OPENCODE_BASE_URL && String(settings.CLAUDE_MEM_OPENCODE_BASE_URL).trim() !== '') {
      const candidate = String(settings.CLAUDE_MEM_OPENCODE_BASE_URL).trim();
      let parsed: URL | null = null;
      try {
        parsed = new URL(candidate);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
        return { valid: false, error: 'CLAUDE_MEM_OPENCODE_BASE_URL must be a valid http(s) URL' };
      }
    }

    // Validate CLAUDE_MEM_CONTEXT_OBSERVATIONS
    if (settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
      const obsCount = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
      if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200' };
      }
    }

    // Validate CLAUDE_MEM_WORKER_PORT
    if (settings.CLAUDE_MEM_WORKER_PORT) {
      const port = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535' };
      }
    }

    // Validate CLAUDE_MEM_WORKER_HOST (IP address or 0.0.0.0)
    if (settings.CLAUDE_MEM_WORKER_HOST) {
      const host = settings.CLAUDE_MEM_WORKER_HOST;
      // Allow localhost variants and valid IP patterns
      const validHostPattern = /^(127\.0\.0\.1|0\.0\.0\.0|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
      if (!validHostPattern.test(host)) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_HOST must be a valid IP address (e.g., 127.0.0.1, 0.0.0.0)' };
      }
    }

    // Validate CLAUDE_MEM_LOG_LEVEL
    if (settings.CLAUDE_MEM_LOG_LEVEL) {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'];
      if (!validLevels.includes(settings.CLAUDE_MEM_LOG_LEVEL.toUpperCase())) {
        return { valid: false, error: 'CLAUDE_MEM_LOG_LEVEL must be one of: DEBUG, INFO, WARN, ERROR, SILENT' };
      }
    }

    // Validate boolean string values
    const booleanSettings = [
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
    ];

    for (const key of booleanSettings) {
      if (settings[key] && !['true', 'false'].includes(settings[key])) {
        return { valid: false, error: `${key} must be "true" or "false"` };
      }
    }

    // Validate FULL_COUNT (0-20)
    if (settings.CLAUDE_MEM_CONTEXT_FULL_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_FULL_COUNT, 10);
      if (isNaN(count) || count < 0 || count > 20) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_COUNT must be between 0 and 20' };
      }
    }

    // Validate SESSION_COUNT (1-50)
    if (settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10);
      if (isNaN(count) || count < 1 || count > 50) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_SESSION_COUNT must be between 1 and 50' };
      }
    }

    // Validate FULL_FIELD
    if (settings.CLAUDE_MEM_CONTEXT_FULL_FIELD) {
      if (!['narrative', 'facts'].includes(settings.CLAUDE_MEM_CONTEXT_FULL_FIELD)) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_FIELD must be "narrative" or "facts"' };
      }
    }

    // Validate CLAUDE_MEM_SKIP_TOOL_PATTERNS (length + format sanity)
    if (settings.CLAUDE_MEM_SKIP_TOOL_PATTERNS) {
      const patterns = settings.CLAUDE_MEM_SKIP_TOOL_PATTERNS;
      if (patterns.length > 1000) {
        return { valid: false, error: 'CLAUDE_MEM_SKIP_TOOL_PATTERNS must be under 1000 characters' };
      }
      // Each entry must be Tool:glob format; reject individual globs over 100 chars
      const entries = patterns.split(',').map((s: string) => s.trim()).filter(Boolean);
      for (const entry of entries) {
        if (!entry.includes(':')) {
          return { valid: false, error: `CLAUDE_MEM_SKIP_TOOL_PATTERNS: malformed entry "${entry}" (must be Tool:glob)` };
        }
        const glob = entry.slice(entry.indexOf(':') + 1);
        if (glob.length > 100) {
          return { valid: false, error: `CLAUDE_MEM_SKIP_TOOL_PATTERNS: glob pattern too long (max 100 chars)` };
        }
      }
    }

    // Validate CLAUDE_MEM_BATCH_MAX_SIZE
    if (settings.CLAUDE_MEM_BATCH_MAX_SIZE) {
      const batchMax = parseInt(settings.CLAUDE_MEM_BATCH_MAX_SIZE, 10);
      if (isNaN(batchMax) || batchMax < 1 || batchMax > 20) {
        return { valid: false, error: 'CLAUDE_MEM_BATCH_MAX_SIZE must be between 1 and 20' };
      }
    }

    // Validate CLAUDE_MEM_OBS_MAX_FIELD_CHARS
    if (settings.CLAUDE_MEM_OBS_MAX_FIELD_CHARS) {
      const maxChars = parseInt(settings.CLAUDE_MEM_OBS_MAX_FIELD_CHARS, 10);
      if (isNaN(maxChars) || maxChars < 500 || maxChars > 100000) {
        return { valid: false, error: 'CLAUDE_MEM_OBS_MAX_FIELD_CHARS must be between 500 and 100000' };
      }
    }

    // Validate Pool Starvation Defense settings
    if (settings.CLAUDE_MEM_POOL_COOLDOWN_MS) {
      const val = parseInt(settings.CLAUDE_MEM_POOL_COOLDOWN_MS, 10);
      if (isNaN(val) || val < 10000 || val > 600000) {
        return { valid: false, error: 'CLAUDE_MEM_POOL_COOLDOWN_MS must be between 10000 and 600000' };
      }
    }
    if (settings.CLAUDE_MEM_MAX_POOL_RETRIES) {
      const val = parseInt(settings.CLAUDE_MEM_MAX_POOL_RETRIES, 10);
      if (isNaN(val) || val < 1 || val > 20) {
        return { valid: false, error: 'CLAUDE_MEM_MAX_POOL_RETRIES must be between 1 and 20' };
      }
    }
    if (settings.CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS) {
      const val = parseInt(settings.CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS, 10);
      if (isNaN(val) || val < 30000 || val > 600000) {
        return { valid: false, error: 'CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS must be between 30000 and 600000' };
      }
    }
    if (settings.CLAUDE_MEM_STALE_INIT_THRESHOLD_MS) {
      const val = parseInt(settings.CLAUDE_MEM_STALE_INIT_THRESHOLD_MS, 10);
      if (isNaN(val) || val < 30000 || val > 600000) {
        return { valid: false, error: 'CLAUDE_MEM_STALE_INIT_THRESHOLD_MS must be between 30000 and 600000' };
      }
    }
    if (settings.CLAUDE_MEM_BACKPRESSURE_L1) {
      const val = parseInt(settings.CLAUDE_MEM_BACKPRESSURE_L1, 10);
      if (isNaN(val) || val < 5 || val > 200) {
        return { valid: false, error: 'CLAUDE_MEM_BACKPRESSURE_L1 must be between 5 and 200' };
      }
    }
    if (settings.CLAUDE_MEM_BACKPRESSURE_L2) {
      const val = parseInt(settings.CLAUDE_MEM_BACKPRESSURE_L2, 10);
      if (isNaN(val) || val < 10 || val > 500) {
        return { valid: false, error: 'CLAUDE_MEM_BACKPRESSURE_L2 must be between 10 and 500' };
      }
    }
    if (settings.CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE) {
      const val = parseInt(settings.CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE, 10);
      if (isNaN(val) || val < 2 || val > 10) {
        return { valid: false, error: 'CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE must be between 2 and 10' };
      }
    }

    // Phase 2 Layer C validation
    if (settings.CLAUDE_MEM_MAX_HISTORY_LENGTH) {
      const val = parseInt(settings.CLAUDE_MEM_MAX_HISTORY_LENGTH, 10);
      if (isNaN(val) || val < 10 || val > 500) {
        return { valid: false, error: 'CLAUDE_MEM_MAX_HISTORY_LENGTH must be between 10 and 500' };
      }
    }
    if (settings.CLAUDE_MEM_MAX_HISTORY_TOKENS) {
      const val = parseInt(settings.CLAUDE_MEM_MAX_HISTORY_TOKENS, 10);
      if (isNaN(val) || val < 10000 || val > 500000) {
        return { valid: false, error: 'CLAUDE_MEM_MAX_HISTORY_TOKENS must be between 10000 and 500000' };
      }
    }

    if (settings.CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS) {
      const val = parseInt(settings.CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS, 10);
      if (isNaN(val) || val < 1 || val > 2000) {
        return {
          valid: false,
          error: 'CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS must be between 1 and 2000',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Ensure settings file exists, creating with defaults if missing
   */
  private ensureSettingsFile(settingsPath: string): void {
    if (!existsSync(settingsPath)) {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      // Ensure directory exists
      const dir = path.dirname(settingsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
      logger.info('SETTINGS', 'Created settings file with defaults', { settingsPath });
    }
  }
}
