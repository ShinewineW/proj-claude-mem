import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Clean install verification tests.
 *
 * Validates that `bun run build-and-sync` produces a fully functional
 * plugin installation following the README steps.
 *
 * These tests run AFTER build-and-sync to verify the deployed artifacts.
 */

const home = os.homedir();
const MARKETPLACE_DIR = path.join(home, '.claude', 'plugins', 'marketplaces', 'thedotmack');
const KNOWN_MP_PATH = path.join(home, '.claude', 'plugins', 'known_marketplaces.json');
const INSTALLED_PATH = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
const SETTINGS_PATH = path.join(home, '.claude', 'settings.json');

function getPluginVersion(): string {
  const pluginJsonPath = path.join(MARKETPLACE_DIR, 'plugin', '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginJsonPath)) return 'unknown';
  return JSON.parse(readFileSync(pluginJsonPath, 'utf-8')).version;
}

function getCachePath(): string {
  return path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', getPluginVersion());
}

describe('Clean Install - Marketplace Directory', () => {
  it('should create marketplace directory', () => {
    expect(existsSync(MARKETPLACE_DIR)).toBe(true);
  });

  it('should have plugin subdirectory with hooks.json', () => {
    expect(existsSync(path.join(MARKETPLACE_DIR, 'plugin', 'hooks', 'hooks.json'))).toBe(true);
  });
});

describe('Clean Install - Cache Directory', () => {
  it('should create versioned cache directory', () => {
    expect(existsSync(getCachePath())).toBe(true);
  });

  it('should have worker-service.cjs in cache', () => {
    expect(existsSync(path.join(getCachePath(), 'scripts', 'worker-service.cjs'))).toBe(true);
  });

  it('should have .mcp.json in cache', () => {
    expect(existsSync(path.join(getCachePath(), '.mcp.json'))).toBe(true);
  });

  it('should have node_modules installed in cache', () => {
    expect(existsSync(path.join(getCachePath(), 'node_modules'))).toBe(true);
  });

  it('should have hooks.json in cache', () => {
    expect(existsSync(path.join(getCachePath(), 'hooks', 'hooks.json'))).toBe(true);
  });

  it('should have skills in cache', () => {
    expect(existsSync(path.join(getCachePath(), 'skills', 'mem-search', 'SKILL.md'))).toBe(true);
  });
});

describe('Clean Install - Plugin Registration', () => {
  it('should register thedotmack in known_marketplaces.json', () => {
    expect(existsSync(KNOWN_MP_PATH)).toBe(true);
    const known = JSON.parse(readFileSync(KNOWN_MP_PATH, 'utf-8'));
    expect(known).toHaveProperty('thedotmack');
    expect(known.thedotmack.installLocation).toBe(MARKETPLACE_DIR);
  });

  it('should register claude-mem@thedotmack in installed_plugins.json', () => {
    expect(existsSync(INSTALLED_PATH)).toBe(true);
    const installed = JSON.parse(readFileSync(INSTALLED_PATH, 'utf-8'));
    expect(installed.plugins).toHaveProperty('claude-mem@thedotmack');
    const entries = installed.plugins['claude-mem@thedotmack'];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].installPath).toBe(getCachePath());
    expect(entries[0].version).toBe(getPluginVersion());
  });

  it('should enable claude-mem@thedotmack in settings.json', () => {
    expect(existsSync(SETTINGS_PATH)).toBe(true);
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    expect(settings.enabledPlugins).toHaveProperty('claude-mem@thedotmack');
    expect(settings.enabledPlugins['claude-mem@thedotmack']).toBe(true);
  });
});

describe('Clean Install - hooks.json Validity', () => {
  it('should have valid JSON with only valid Claude Code event names', () => {
    const hooksPath = path.join(getCachePath(), 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const validEvents = [
      'SessionStart', 'InstructionsLoaded', 'UserPromptSubmit',
      'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
      'Notification', 'SubagentStart', 'SubagentStop', 'Stop',
      'TeammateIdle', 'TaskCompleted', 'ConfigChange',
      'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'SessionEnd',
    ];
    for (const eventName of Object.keys(parsed.hooks)) {
      expect(validEvents).toContain(eventName);
    }
  });

  it('should use direct ${CLAUDE_PLUGIN_ROOT} paths in all commands', () => {
    const hooksPath = path.join(getCachePath(), 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    for (const matchers of Object.values(parsed.hooks) as any[][]) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          if (hook.type === 'command') {
            // _R fallback pattern is intentional for Linux compatibility (#24529)
            expect(hook.command).toContain('_R=');
            expect(hook.command).toContain('${CLAUDE_PLUGIN_ROOT}');
          }
        }
      }
    }
  });

  it('should have all 4 required event hooks', () => {
    const hooksPath = path.join(getCachePath(), 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const events = Object.keys(parsed.hooks);
    expect(events).toContain('SessionStart');
    expect(events).toContain('UserPromptSubmit');
    expect(events).toContain('PostToolUse');
    expect(events).toContain('Stop');
  });
});

describe('Clean Install - sync-marketplace.cjs Uses npm', () => {
  it('should use npm install instead of bun install', () => {
    const syncScript = readFileSync(
      path.join(path.dirname(path.dirname(getCachePath())), '..', '..', 'marketplaces', 'thedotmack', 'scripts', 'sync-marketplace.cjs'),
      'utf-8'
    ).toString();
    // If the file doesn't exist in marketplace, check project source
    const projectSyncScript = existsSync(path.join(process.cwd(), 'scripts', 'sync-marketplace.cjs'))
      ? readFileSync(path.join(process.cwd(), 'scripts', 'sync-marketplace.cjs'), 'utf-8')
      : '';
    const script = projectSyncScript || syncScript;
    expect(script).toContain('npm install');
    expect(script).not.toMatch(/execSync\([^)]*bun install/);
  });
});
