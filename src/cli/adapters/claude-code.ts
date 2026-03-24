import { resolve } from 'path';
import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

// Maps Claude Code stdin format (session_id, cwd, tool_name, etc.)
// SessionStart hooks receive no stdin, so we must handle undefined input gracefully
export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd: resolve(r.cwd ?? process.cwd()),
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path,
    };
  },
  formatOutput(result) {
    const r = result ?? ({} as HookResult);
    if (r.hookSpecificOutput) {
      const output: Record<string, unknown> = { hookSpecificOutput: r.hookSpecificOutput };
      if (r.systemMessage) {
        output.systemMessage = r.systemMessage;
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    if (r.systemMessage) output.systemMessage = r.systemMessage;
    return output;
  }
};
