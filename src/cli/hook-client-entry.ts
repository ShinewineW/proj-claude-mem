/**
 * hook-client-entry.ts — Lightweight hook-only entry point (P0)
 *
 * Independent esbuild bundle (~50KB) replacing the heavy service bundle for hooks.
 * No in-process fallback, no heavy dependencies.
 *
 * Dependency tree: ~17 explicit nodes, all using Node.js built-ins.
 * Zero npm dependencies. Does not reference Express, MCP SDK, vector sync, or bun:sqlite.
 */

import { isPluginDisabledInClaudeSettings } from '../shared/plugin-state.js';
import { hookCommand } from './hook-command.js';

async function main() {
  const command = process.argv[2];

  // Early exit if plugin disabled in Claude Code settings (#781)
  if (command === 'hook' && isPluginDisabledInClaudeSettings()) {
    process.exit(0);
  }

  if (command !== 'hook') {
    process.stderr.write('hook-client: only supports "hook" command\n');
    process.exit(1);
  }

  const platform = process.argv[3];
  const event = process.argv[4];
  if (!platform || !event) {
    process.exit(1);
  }

  await hookCommand(platform, event);
}

// CJS main-module detection
const _isMain = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module || !module.parent
  : false;

if (_isMain) {
  main().catch(() => process.exit(0));
}
