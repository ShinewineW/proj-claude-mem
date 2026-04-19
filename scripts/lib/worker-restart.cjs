/**
 * Shared helper: restart the claude-mem worker end-to-end.
 *
 * Replaces the old "fire /api/admin/restart and hope" pattern in
 * sync-to-cache.cjs and sync-marketplace.cjs — those printed
 * "Worker restart triggered" even when the daemon stayed dead
 * (the hook-side auto-start had a wrong path that silently failed).
 *
 * Flow: shutdown -> wait for port -> spawn via plugin/scripts/ ->
 * poll /api/health with one retry on port-race.
 *
 * Exported for use by scripts only (plain CommonJS).
 */

const http = require('http');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const MARKETPLACE_PLUGIN_PATH = path.join(
  os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin',
);

function triggerShutdown(port = 37777) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/admin/restart',
      method: 'POST', timeout: 3000,
    }, (res) => resolve(res.statusCode === 200));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function healthOk(port = 37777) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/health',
      method: 'GET', timeout: 1500,
    }, (res) => resolve(res.statusCode === 200));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function restartWorker({ port = 37777, log = console.log } = {}) {
  const shutdownOk = await triggerShutdown(port);
  log(shutdownOk ? '  · shutdown signal sent' : '  · worker not running (will spawn fresh)');

  // Let the port drain
  await new Promise(r => setTimeout(r, 1500));

  const bunRunner = path.join(MARKETPLACE_PLUGIN_PATH, 'scripts', 'bun-runner.js');
  const workerScript = path.join(MARKETPLACE_PLUGIN_PATH, 'scripts', 'worker-service.cjs');

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (await healthOk(port)) break;
    try {
      execFileSync('node', [bunRunner, workerScript, 'start'], {
        timeout: 15_000, stdio: 'pipe',
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const stderr = err.stderr ? err.stderr.toString().trim() : '';
      const tail = stderr ? ': ' + stderr.split('\n').slice(-2).join(' | ') : '';
      log('\x1b[33m' + `Spawn attempt ${attempt} failed (exit=${err.status})${tail}` + '\x1b[0m');
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await healthOk(port)) {
      log('\x1b[32m' + 'Worker is healthy' + '\x1b[0m');
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (lastErr) {
    log('\x1b[31m' + `Worker not healthy after spawn attempts: ${lastErr.message}` + '\x1b[0m');
  } else {
    log('\x1b[33m' + 'Worker spawned but /api/health did not respond in 10s' + '\x1b[0m');
  }
  return false;
}

module.exports = { restartWorker };
