// SPDX-License-Identifier: Apache-2.0
// The "no-tools" enforcement modeled here derives from upstream
// thedotmack/claude-mem@ce13c887 (Apache-2.0), combined with fork-original
// per-project cwd-jail / settings-isolation wiring. See docs/reference/provenance.md.
/**
 * Single source of truth for the SECURITY-SENSITIVE SDK options that lock the
 * Observer and fresh-summarize sessions down to "no tool access".
 *
 * The memory agent's prompts assert "you have no tools". Historically that was
 * enforced ONLY by `disallowedTools` — a future SDK built-in tool would slip
 * the net. This helper makes the guarantee true at the config layer with
 * defense-in-depth (no single option is load-bearing):
 *   - tools: []           disables ALL built-in tools
 *   - allowedTools: []    nothing auto-approved
 *   - disallowedTools     explicit per-tool deny list (suspenders)
 *   - permissionMode      'dontAsk' = deny unless pre-approved (nothing is)
 *   - canUseTool          deny EVERY invocation + WARN log (backstop)
 *   - cwd jail + mcpServers:{} + settingSources:[] + strictMcpConfig
 *     + additionalDirectories:[] — no settings/MCP inheritance, no fs escape
 *
 * NDJSON audit log (upstream observer-audit.ts) intentionally SKIPPED — the
 * WARN log is the live trail.
 *
 * Returns Record<string, unknown> (not the SDK Options type) so the module
 * does not hard-depend on the SDK's PermissionMode enum across versions.
 */

import { OBSERVER_SESSIONS_DIR } from '../shared/paths.js';
import { logger } from '../utils/logger.js';

/** Explicit deny-list. `tools: []` already disables all built-ins; this is
 *  the redundant "suspenders" layer and documents intent for reviewers. */
export const OBSERVER_DISALLOWED_TOOLS = [
  'Bash',            // Prevent infinite loops
  'Read',            // No file reading
  'Write',           // No file writing
  'Edit',            // No file editing
  'Grep',            // No code searching
  'Glob',            // No file pattern matching
  'WebFetch',        // No web fetching
  'WebSearch',       // No web searching
  'Task',            // No spawning sub-agents
  'NotebookEdit',    // No notebook editing
  'AskUserQuestion', // No asking questions
  'TodoWrite',       // No todo management
] as const;

export interface HardenedSdkOptionsInput {
  /** Which call site is constructing options — flows into the WARN log. */
  source: 'Observer' | 'Summarize';
  /** Carried into the WARN log for post-incident correlation. */
  sessionDbId?: number;
  contentSessionId?: string;

  // Pass-through fields the caller still owns:
  model: string;
  env: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable: string;
  /** Defaults to OBSERVER_SESSIONS_DIR. Never falls back to process.cwd(). */
  cwd?: string;
  abortController?: AbortController;
  resume?: string;
  /** SDK SpawnFactory wrapper (PID-capturing / stderr-tail). */
  spawnClaudeCodeProcess?: unknown;
}

/**
 * Build the fully hardened SDK options for an Observer / fresh-summarize
 * query() call. Both call sites MUST go through this helper so the lockdown
 * cannot drift between them.
 */
export function buildHardenedSdkOptions(
  input: HardenedSdkOptionsInput,
): Record<string, unknown> {
  const canUseTool = async (toolName: string, _toolInput: unknown) => {
    // Logged under the 'SYSTEM' component (the closest member of the logger's
    // Component union; there is no dedicated 'SECURITY' member). Records that a
    // tool-use attempt was denied for post-incident correlation.
    logger.warn('SYSTEM', `Blocked tool use by ${input.source}: ${toolName}`, {
      sessionDbId: input.sessionDbId,
      contentSessionId: input.contentSessionId,
      source: input.source,
      tool_name: toolName,
    });
    return {
      behavior: 'deny' as const,
      message: `${input.source} is forbidden from tool use (claude-mem hard lockdown).`,
    };
  };

  return {
    model: input.model,
    cwd: input.cwd ?? OBSERVER_SESSIONS_DIR,
    env: input.env,
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    ...(input.abortController ? { abortController: input.abortController } : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.spawnClaudeCodeProcess
      ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess }
      : {}),

    // === Tool lockdown (defense-in-depth) ===
    tools: [],
    allowedTools: [],
    disallowedTools: [...OBSERVER_DISALLOWED_TOOLS],
    // Step 0 (2026-06-05, sdk 0.1.77): 'dontAsk' present in PermissionMode → kept.
    // Verified: node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.d.ts
    // PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'delegate' | 'dontAsk'
    permissionMode: 'dontAsk',
    canUseTool,

    // === Filesystem / settings / MCP isolation ===
    additionalDirectories: [],
    mcpServers: {},
    settingSources: [],
    strictMcpConfig: true,
  };
}
