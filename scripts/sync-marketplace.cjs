#!/usr/bin/env node
/**
 * Protected sync-marketplace script
 *
 * Prevents accidental rsync overwrite when installed plugin is on beta branch.
 * If on beta, the user should use the UI to update instead.
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function getGitignoreExcludes(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return '';

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(pattern => `--exclude=${JSON.stringify(pattern)}`)
    .join(' ');
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Running rsync would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use UI at http://localhost:37777 to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force rsync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

// Get version from plugin.json
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

// Normal rsync for main branch or fresh install
console.log('Syncing to marketplace...');
try {
  const rootDir = path.join(__dirname, '..');
  const gitignoreExcludes = getGitignoreExcludes(rootDir);

  execSync(
    `rsync -av --delete --exclude=.git --exclude=bun.lock --exclude=package-lock.json ${gitignoreExcludes} ./ ~/.claude/plugins/marketplaces/thedotmack/`,
    { stdio: 'inherit' }
  );

  console.log('Running npm install in marketplace...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/thedotmack/ && npm install',
    { stdio: 'inherit' }
  );

  // Write install version marker so smart-install.js skips redundant bun install
  // smart-install.js resolves ROOT from CLAUDE_PLUGIN_ROOT (plugin/ subdir), so marker goes there
  const markerPath = path.join(INSTALLED_PATH, 'plugin', '.install-version');
  const version_ = getPluginVersion();
  const bunVersion = (() => { try { return execSync('/opt/homebrew/bin/bun --version', { encoding: 'utf-8' }).trim(); } catch { return 'unknown'; } })();
  writeFileSync(markerPath, JSON.stringify({ version: version_, bun: bunVersion, installedAt: new Date().toISOString() }));
  console.log('Updated .install-version marker');

  // Ensure .mcp.json is present in marketplace (rsync skips it due to .gitignore exclude)
  const pluginMcpSrc = path.join(rootDir, 'plugin', '.mcp.json');
  const marketplaceMcpDst = path.join(INSTALLED_PATH, 'plugin', '.mcp.json');
  if (existsSync(pluginMcpSrc) && !existsSync(marketplaceMcpDst)) {
    copyFileSync(pluginMcpSrc, marketplaceMcpDst);
    console.log('Copied .mcp.json to marketplace plugin folder');
  }

  // Sync to cache folder with version
  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  // Ensure cache directory exists (rsync won't create nested parents)
  mkdirSync(CACHE_VERSION_PATH, { recursive: true });

  const pluginDir = path.join(rootDir, 'plugin');
  const pluginGitignoreExcludes = getGitignoreExcludes(pluginDir);

  console.log(`Syncing to cache folder (version ${version})...`);
  execSync(
    `rsync -av --delete --exclude=.git ${pluginGitignoreExcludes} plugin/ "${CACHE_VERSION_PATH}/"`,
    { stdio: 'inherit' }
  );

  // Install dependencies in cache directory so worker can resolve them
  console.log(`Running npm install in cache folder (version ${version})...`);
  execSync(`npm install`, { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });

  // Ensure .mcp.json is present in cache (rsync may skip dotfiles)
  const mcpJsonSrc = path.join(pluginDir, '.mcp.json');
  const mcpJsonDst = path.join(CACHE_VERSION_PATH, '.mcp.json');
  if (existsSync(mcpJsonSrc) && !existsSync(mcpJsonDst)) {
    copyFileSync(mcpJsonSrc, mcpJsonDst);
    console.log('Copied .mcp.json to cache folder');
  }

  // Register marketplace in known_marketplaces.json
  const knownMpPath = path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  try {
    let known = {};
    try { known = existsSync(knownMpPath) ? JSON.parse(readFileSync(knownMpPath, 'utf-8')) : {}; } catch { known = {}; }
    if (!known['thedotmack']) {
      known['thedotmack'] = {
        source: { source: 'directory', path: INSTALLED_PATH },
        installLocation: INSTALLED_PATH,
        lastUpdated: new Date().toISOString()
      };
      writeFileSync(knownMpPath, JSON.stringify(known, null, 2));
      console.log('Registered thedotmack marketplace in known_marketplaces.json');
    }
  } catch (e) {
    console.warn('Warning: Could not update known_marketplaces.json:', e.message);
  }

  // Register plugin in installed_plugins.json
  const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    let installed = { version: 2, plugins: {} };
    try { installed = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, 'utf-8')) : { version: 2, plugins: {} }; } catch { installed = { version: 2, plugins: {} }; }
    const pluginKey = 'claude-mem@thedotmack';
    const entry = {
      scope: 'user',
      installPath: CACHE_VERSION_PATH,
      version: version,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };
    // Update or add the plugin entry
    installed.plugins[pluginKey] = [entry];
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
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
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

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  // Trigger worker restart after file sync
  console.log('\n🔄 Triggering worker restart...');
  const http = require('http');
  const req = http.request({
    hostname: '127.0.0.1',
    port: 37777,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
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
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker restart timed out');
  });
  req.end();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}