# Claude-Mem: AI Development Instructions

Fork of [claude-mem](https://github.com/thedotmack/claude-mem) with per-project database isolation. Base: upstream v10.5.2. **Audited through upstream v13.4.0 (`dc2eef8e`, 2026-06-05)**; selectively ports 41 audit-confirmed v10.6.1→v13.4.0 fixes (security / data-integrity / reliability) — see `docs/PROVENANCE.md` for the per-commit upstream source + license index. **Next upstream sync starts incrementally from v13.4.0, not from scratch.** See workspace `.claude/CLAUDE.md` → "Upstream Sync Status" for the audit watermark + full divergence tracking.

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Bypass Lane** (`src/services/worker/BypassLane.ts`) - Parallel REST consumer for observations (Gemini/OpenCode Go), main channel always Claude SDK. OpenCode path sends `thinking:{type:"disabled"}` to suppress reasoning-model CoT, and classifies failures into `quota`/`auth`/`transient`/`client` buckets with tiered cooldowns (6h / 6h / 20min / no-trip).

**Fresh Summarize Path** (`src/services/worker/SummaryLane.ts`, `fresh-summarize.ts`, `fresh-summarize-store.ts`, `fresh-summarize-deps.ts`) - Summaries run on a fresh `query()` subprocess via the **global single-consumer `SummaryLane`**, which claims `type='summarize'` rows from `pending_messages` and calls `runFreshSummarizeQuery` (no resume, no observer priming) to bypass the observer-session role conditioning that empirically produced 0% valid `<summary>` XML in production. The Stop hook is fire-and-forget (~5ms); turn identity is `(content_session_id, prompt_number)`. The atomic store re-reads `memory_session_id` inside a transaction to avoid the FK race; salvage synthesis was removed entirely (no fabricated summaries). Full architecture → workspace `.claude/rules/architecture-details.md` § "Fresh SDK Query Summarize".

**SDK Observer/Summarize Lockdown** (`src/sdk/hardened-options.ts`) - Single source of truth for security-sensitive SDK options that lock observer and fresh-summarize sessions to no-tool-access (defense-in-depth: `tools:[]`, `allowedTools:[]`, `disallowedTools`, `permissionMode:'dontAsk'`, `canUseTool` deny-all backstop, cwd jail, `mcpServers:{}`, `settingSources:[]`).

**Database** (`src/services/sqlite/`) - Per-project SQLite3 at `<repo>/.claude/mem.db`, managed by `DbConnectionPool` (`src/shared/project-db.ts`). Falls back to global `~/.claude-mem/claude-mem.db` when no project context is available.

**Project Resolution** (`src/shared/project-allowlist.ts: resolveProjectContext()`) - Allowlist child-path matching (Priority 1) → git-root heuristic fallback (Priority 2). Hook guard injects `_projectContext` for all handlers.

**DB Path Resolution (legacy)** (`src/shared/paths.ts: resolveProjectDbPath()`) - Resolves per-project DB path: env override → git worktree parent → git root → cwd. All worktrees of the same repo share one database.

**Skills** (`plugin/skills/`) — 8 skills: `mem-search` (search past work), `make-plan` (phased implementation plans), `do` (execute plans via subagents), `mem-enable` / `mem-disable` (per-project opt-in toggle), `mem-timeline` (session history timeline), `mem-weekly-digests` (weekly activity digest), `smart-explore` (exploratory codebase analysis).

**Chroma** (`src/services/sync/ChromaSync.ts`) - Per-project vector embeddings for semantic search, collection naming: `cm__<name>_<8char-hash>`

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Privacy Tags
- `<private>content</private>` - User-level privacy control (manual, prevents storage)
- `<system_instruction>` / `<system-instruction>` tags — stripped to prevent Conductor-injected instructions from persisting

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
/opt/homebrew/bin/bun run build-and-sync   # Build, deploy to cache + marketplace discovery, restart worker
/opt/homebrew/bin/bun test                  # Run all tests (2163 pass, 0 fail)
```

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. The file is auto-created with defaults on first run.

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Plugin (cache)**: `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/` (1:1 mirror of plugin/, + node_modules)
- **Plugin (marketplace)**: `~/.claude/plugins/marketplaces/thedotmack/plugin/` (1:1 mirror of plugin/, CC reads hooks/skills/MCP from here)
- **Database (per-project)**: `<repo>/.claude/mem.db` (auto-gitignored)
- **Database (global fallback)**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Exit Code Strategy

Claude-mem hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

**Philosophy**: Worker/hook errors exit with code 0 to prevent Windows Terminal tab accumulation. The wrapper/plugin layer handles restart logic. ERROR-level logging is maintained for diagnostics.

## Important

No need to edit the changelog ever, it's generated automatically.
