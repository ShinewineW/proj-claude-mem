#!/usr/bin/env node
/**
 * sync-to-cache — Deploy built plugin directly to Claude Code cache.
 *
 * Replaces sync-marketplace.cjs by skipping the marketplace intermediate step.
 * Claude Code loads plugins from the cache path registered in installed_plugins.json.
 *
 * Flow: rsync plugin/ → cache → npm install → register → restart worker
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } = require('fs');
const path = require('path');
const os = require('os');

const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

try {
  const rootDir = path.join(__dirname, '..');
  const pluginDir = path.join(rootDir, 'plugin');
  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  // Ensure cache directory exists
  mkdirSync(CACHE_VERSION_PATH, { recursive: true });

  // Rsync plugin/ → cache (no .gitignore excludes needed — plugin/ has no .gitignore)
  console.log(`Syncing plugin/ to cache (version ${version})...`);
  execSync(
    `rsync -av --delete --exclude=.git --exclude=node_modules plugin/ "${CACHE_VERSION_PATH}/"`,
    { cwd: rootDir, stdio: 'inherit' }
  );

  // Install dependencies in cache
  console.log(`Running npm install in cache folder (version ${version})...`);
  execSync('npm install', { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });

  // Write install version marker
  const bunVersion = (() => {
    try { return execSync('/opt/homebrew/bin/bun --version', { encoding: 'utf-8' }).trim(); }
    catch { return 'unknown'; }
  })();
  const markerPath = path.join(CACHE_VERSION_PATH, '.install-version');
  writeFileSync(markerPath, JSON.stringify({
    version: version,
    bun: bunVersion,
    installedAt: new Date().toISOString(),
  }));
  console.log('Updated .install-version marker in cache');

  // Ensure .mcp.json is present (rsync may skip dotfiles)
  const mcpJsonSrc = path.join(pluginDir, '.mcp.json');
  const mcpJsonDst = path.join(CACHE_VERSION_PATH, '.mcp.json');
  if (existsSync(mcpJsonSrc)) {
    copyFileSync(mcpJsonSrc, mcpJsonDst);
  }

  // Register plugin in installed_plugins.json
  const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    let installed = { version: 2, plugins: {} };
    try {
      installed = existsSync(installedPath)
        ? JSON.parse(readFileSync(installedPath, 'utf-8'))
        : { version: 2, plugins: {} };
    } catch { installed = { version: 2, plugins: {} }; }

    const pluginKey = 'claude-mem@thedotmack';
    installed.plugins[pluginKey] = [{
      scope: 'user',
      installPath: CACHE_VERSION_PATH,
      version: version,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }];
    writeFileSync(installedPath, JSON.stringify(installed, null, 2));
    console.log(`Registered ${pluginKey} in installed_plugins.json`);
  } catch (e) {
    console.warn('Warning: Could not update installed_plugins.json:', e.message);
  }

  // Ensure plugin is enabled in settings.json
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      let settings;
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); }
      catch { settings = {}; }
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      if (!settings.enabledPlugins['claude-mem@thedotmack']) {
        settings.enabledPlugins['claude-mem@thedotmack'] = true;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('Enabled claude-mem@thedotmack in settings.json');
      }
    }
  } catch (e) {
    console.warn('Warning: Could not update settings.json:', e.message);
  }

  console.log('\x1b[32m%s\x1b[0m', 'Sync to cache complete!');

  // Trigger worker restart
  console.log('\n🔄 Triggering worker restart...');
  const http = require('http');
  const workerPort = 37777;

  const req = http.request({
    hostname: '127.0.0.1',
    port: workerPort,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 3000,
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', '✓ Worker restart triggered');
    } else {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker not running, will start on next hook');
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker restart timed out (hung worker?)');
  });
  req.end();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
