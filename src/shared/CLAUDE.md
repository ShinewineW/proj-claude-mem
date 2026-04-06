# Shared Utilities

Foundational modules for per-project isolation, configuration, and hook/worker communication.

## Per-Project Isolation

| File | Purpose |
|------|---------|
| `paths.ts` | `resolveProjectDbPath(cwd)`: env → worktree parent → git root → cwd → `<root>/.claude/mem.db` |
| `project-db.ts` | `DbConnectionPool`: `Map<path, {store,search}>`, FIFO eviction at 10, auto `.gitignore` |
| `project-allowlist.ts` | Opt-in allowlist + `resolveProjectContext()` (Priority 1: allowlist child-path matching via `findContainingProject()`, Priority 2: git-root heuristic fallback). Lazy env var reading. **Pattern rule**: allowlist-sourced roots must use `path.join(root, '.claude', 'mem.db')`, never `resolveProjectDbPath()`. |
| `chroma-utils.ts` | `getCollectionName(dbPath)`: deterministic `cm__<name>_<8char-hash>` |

## Configuration

| File | Purpose |
|------|---------|
| `SettingsDefaultsManager.ts` | 56 unique `CLAUDE_MEM_*` settings, priority: env vars > settings.json > defaults. Phase 1 SDK optimization: `SKIP_TOOL_PATTERNS`, `BATCH_MAX_SIZE`, `OBS_MAX_FIELD_CHARS` |
| `EnvManager.ts` | Credential isolation in `~/.claude-mem/.env`. Blocklist approach strips project API keys. |

## Hook/Worker Communication

| File | Purpose |
|------|---------|
| `worker-utils.ts` | `ensureWorkerRunning()`, health check, auto-start, version matching |
| `hook-constants.ts` | Timeouts (DEFAULT 5min), exit codes (0/1/2/3), Windows multiplier |

## Utilities

| File | Purpose |
|------|---------|
| `timeline-formatting.ts` | Date formatting, `estimateTokens()`, `groupByDate()` |
| `transcript-parser.ts` | JSONL transcript extraction, `<system-reminder>` stripping |
| `path-utils.ts` | Path normalization, folder CLAUDE.md detection |
| `fallback-queue.ts` | Write/read/replay fallback entries (`~/.claude-mem/fallback/`) when worker is unreachable |
| `plugin-state.ts` | Check if plugin disabled in Claude Code settings |

## Key Design Principles

- Lazy env var reading (supports test overrides, avoids ES module hoisting trap)
- Blocklist env approach (inherit most, block `ANTHROPIC_API_KEY` + `CLAUDECODE`)
- Graceful degradation on errors (logged, never silent)
