import type { ResolvedProject } from '../shared/project-allowlist.js';

export interface NormalizedHookInput {
  sessionId: string;
  cwd: string;
  platform?: string;   // 'claude-code' or 'cursor'
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  transcriptPath?: string;
  // Cursor-specific fields
  filePath?: string;   // afterFileEdit
  edits?: unknown[];   // afterFileEdit
  _projectContext?: ResolvedProject;  // Injected by hook-command.ts guard
}

export interface HookResult {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  systemMessage?: string;
  exitCode?: number;
}

export interface PlatformAdapter {
  normalizeInput(raw: unknown): NormalizedHookInput;
  formatOutput(result: HookResult): unknown;
}

export interface EventHandler {
  execute(input: NormalizedHookInput): Promise<HookResult>;
}
