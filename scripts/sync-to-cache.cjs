#!/usr/bin/env node
/**
 * sync-to-cache — Deploy built plugin to Claude Code cache + marketplace.
 *
 * Official plugins keep marketplace and cache as 1:1 mirrors.
 * CC reads discovery + MCP from marketplace, runs everything from cache.
 * ${CLAUDE_PLUGIN_ROOT} resolves to cache path at runtime.
 *
 * Flow: rsync plugin/ → cache + marketplace → npm install (cache) → register → restart worker
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } = require('fs');
const path = require('path');
const os = require('os');

const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
const MARKETPLACE_ROOT = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const MARKETPLACE_PLUGIN_PATH = path.join(MARKETPLACE_ROOT, 'plugin');

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

  // Compute git commit SHA for plugin integrity registration
  const gitSha = (() => {
    try { return execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf-8' }).trim(); }
    catch { return 'unknown'; }
  })();

  // ── Step 1: Rsync plugin/ to both cache and marketplace ─────────────────
  // Official pattern: marketplace = cache = identical copies of plugin content.
  mkdirSync(CACHE_VERSION_PATH, { recursive: true });
  mkdirSync(MARKETPLACE_PLUGIN_PATH, { recursive: true });

  console.log(`Syncing plugin/ to cache + marketplace (version ${version})...`);
  execSync(
    `rsync -av --delete --exclude=.git --exclude=node_modules plugin/ "${CACHE_VERSION_PATH}/"`,
    { cwd: rootDir, stdio: 'inherit' }
  );
  execSync(
    `rsync -av --delete --exclude=.git --exclude=node_modules plugin/ "${MARKETPLACE_PLUGIN_PATH}/"`,
    { cwd: rootDir, stdio: 'inherit' }
  );

  // ── Step 2: npm install in cache only (marketplace doesn't need node_modules) ──
  console.log(`Running npm install in cache folder (version ${version})...`);
  execSync('npm install', { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });

  // Write install version marker
  const bunVersion = (() => {
    try { return execSync('/opt/homebrew/bin/bun --version', { encoding: 'utf-8' }).trim(); }
    catch { return 'unknown'; }
  })();
  writeFileSync(path.join(CACHE_VERSION_PATH, '.install-version'), JSON.stringify({
    version: version,
    bun: bunVersion,
    installedAt: new Date().toISOString(),
  }));

  // Ensure .mcp.json is present in cache (rsync may skip dotfiles)
  const mcpJsonSrc = path.join(pluginDir, '.mcp.json');
  const mcpJsonDst = path.join(CACHE_VERSION_PATH, '.mcp.json');
  if (existsSync(mcpJsonSrc)) {
    copyFileSync(mcpJsonSrc, mcpJsonDst);
  }

  // ── Step 3: Marketplace discovery registry ──────────────────────────────
  // marketplace.json — static registry at marketplace root level
  const mktManifestDir = path.join(MARKETPLACE_ROOT, '.claude-plugin');
  const mktManifestPath = path.join(mktManifestDir, 'marketplace.json');
  mkdirSync(mktManifestDir, { recursive: true });
  if (!existsSync(mktManifestPath)) {
    writeFileSync(mktManifestPath, JSON.stringify({
      name: 'thedotmack',
      owner: { name: 'ShinewineW' },
      metadata: {
        description: 'claude-mem fork with per-project isolation',
        homepage: 'https://github.com/ShinewineW/proj-claude-mem',
      },
      plugins: [{
        name: 'claude-mem',
        source: './plugin',
        description: 'Persistent memory system for Claude Code',
      }],
    }, null, 2));
  }
  console.log('Marketplace + cache synced at', MARKETPLACE_ROOT);

  // ── Step 4: Register in JSON config files ───────────────────────────────

  // installed_plugins.json
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
      gitCommitSha: gitSha,
    }];
    writeFileSync(installedPath, JSON.stringify(installed, null, 2));
    console.log(`Registered ${pluginKey} in installed_plugins.json`);
  } catch (e) {
    console.warn('Warning: Could not update installed_plugins.json:', e.message);
  }

  // settings.json — enable plugin
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

  // known_marketplaces.json
  const knownMarketplacesPath = path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  try {
    let known = {};
    try {
      known = existsSync(knownMarketplacesPath)
        ? JSON.parse(readFileSync(knownMarketplacesPath, 'utf-8'))
        : {};
    } catch { known = {}; }
    if (typeof known !== 'object' || Array.isArray(known)) known = {};
    known['thedotmack'] = {
      source: {
        source: 'github',
        repo: 'ShinewineW/proj-claude-mem',
      },
      installLocation: MARKETPLACE_ROOT,
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(knownMarketplacesPath, JSON.stringify(known, null, 2));
    console.log('Registered thedotmack in known_marketplaces.json');
  } catch (e) {
    console.warn('Warning: Could not update known_marketplaces.json:', e.message);
  }

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  // ── Step 5: Restart worker and verify it comes back ─────────────────────
  // The /api/admin/restart endpoint just shuts the worker down; revival
  // previously relied on the next hook firing tryStartWorker(). We now
  // actively start and health-poll so `build-and-sync` is a complete cycle.
  console.log('\nRestarting worker...');
  const http = require('http');
  const { execFileSync } = require('child_process');

  function triggerShutdown() {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 37777,
        path: '/api/admin/restart',
        method: 'POST',
        timeout: 3000,
      }, (res) => resolve(res.statusCode === 200));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  function healthOk() {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port: 37777, path: '/api/health',
        method: 'GET', timeout: 1500,
      }, (res) => resolve(res.statusCode === 200));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  (async () => {
    const shutdownOk = await triggerShutdown();
    if (shutdownOk) {
      console.log('  · shutdown signal sent');
    } else {
      console.log('  · worker not running (will spawn fresh)');
    }

    // Wait for port to free after shutdown
    await new Promise(r => setTimeout(r, 1500));

    const bunRunner = path.join(MARKETPLACE_PLUGIN_PATH, 'scripts', 'bun-runner.js');
    const workerScript = path.join(MARKETPLACE_PLUGIN_PATH, 'scripts', 'worker-service.cjs');

    // Up to 2 spawn attempts; `start` can race with a shutting-down daemon.
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (await healthOk()) break;
      try {
        execFileSync('node', [bunRunner, workerScript, 'start'], {
          timeout: 15_000, stdio: 'pipe',
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const stderr = err.stderr ? err.stderr.toString().trim() : '';
        console.log('\x1b[33m%s\x1b[0m',
          `Spawn attempt ${attempt} failed (exit=${err.status})${stderr ? ': ' + stderr.split('\n').slice(-2).join(' | ') : ''}`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await healthOk()) {
        console.log('\x1b[32m%s\x1b[0m', 'Worker is healthy');
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (lastErr) {
      console.log('\x1b[31m%s\x1b[0m', `Worker not healthy after spawn attempts: ${lastErr.message}`);
    } else {
      console.log('\x1b[33m%s\x1b[0m', 'Worker spawned but /api/health did not respond in 10s');
    }
  })();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
