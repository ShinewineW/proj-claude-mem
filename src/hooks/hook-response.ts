/**
 * Standard hook response for all hooks.
 * Returns empty JSON — CC continues by default when no control fields are present.
 * Upstream 10e980cd: CC rejects unrecognized fields (continue, suppressOutput)
 * in Stop hooks, so we emit only recognized fields (systemMessage) or empty {}.
 *
 * Note: SessionStart uses context-hook.ts which constructs its own response
 * with hookSpecificOutput for context injection.
 */
export const STANDARD_HOOK_RESPONSE = JSON.stringify({});
