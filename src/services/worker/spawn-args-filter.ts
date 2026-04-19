/**
 * Pair-aware filter for Agent SDK spawn args.
 *
 * The Claude Agent SDK emits `["--setting-sources", ""]` when settingSources
 * defaults to []. The CLI (Claude Code 2.1.109+) rejects the empty value as
 * an invalid setting source. If we naively filter out ONLY the empty string,
 * we leave the flag orphaned — and the CLI's argparse then consumes the
 * next flag (`--permission-mode`) as the --setting-sources value, producing:
 *
 *   Error processing --setting-sources: Invalid setting source:
 *   --permission-mode. Valid options are: user, project, local
 *
 * The correct fix is pair-aware: when an empty string follows a `--flag`,
 * drop both. Lone empty strings (not preceded by a flag) are dropped too
 * since they're never meaningful positional arguments in this context.
 */
export function filterEmptyFlagPairs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '') {
      // Empty string: if the last emitted arg is a `--flag`, pop it.
      const last = out[out.length - 1];
      if (typeof last === 'string' && last.startsWith('--')) {
        out.pop();
      }
      // Regardless, skip the empty string itself.
      continue;
    }
    out.push(a);
  }
  return out;
}
