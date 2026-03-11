# Shared Utilities

Foundational modules for per-project isolation, configuration, and hook/worker communication.

## Per-Project Isolation

| File | Purpose |
|------|---------|
| `paths.ts` | `resolveProjectDbPath(cwd)`: env → worktree parent → git root → cwd → `<root>/.claude/mem.db` |
| `project-db.ts` | `DbConnectionPool`: `Map<path, {store,search}>`, FIFO eviction at 10, auto `.gitignore` |
| `project-allowlist.ts` | Opt-in allowlist at `~/.claude-mem/enabled-projects.json`. Lazy env var reading. |
| `chroma-utils.ts` | `getCollectionName(dbPath)`: deterministic `cm__<name>_<8char-hash>` |

## Configuration

| File | Purpose |
|------|---------|
| `SettingsDefaultsManager.ts` | 40+ settings, priority: env vars > settings.json > defaults |
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
| `plugin-state.ts` | Check if plugin disabled in Claude Code settings |

## Key Design Principles

- Lazy env var reading (supports test overrides, avoids ES module hoisting trap)
- Blocklist env approach (inherit most, block `ANTHROPIC_API_KEY` + `CLAUDECODE`)
- Graceful degradation on errors (logged, never silent)
