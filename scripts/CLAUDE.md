# Scripts

Mix of build-generated outputs (`.cjs` via esbuild) and manually-maintained source scripts. Do NOT read built `.cjs` bundles in `plugin/scripts/` — read source in `src/` instead.

## Source Scripts (manually maintained)

| Script | Purpose | Safe to run manually? |
|--------|---------|----------------------|
| `smart-install.js` | Hook: ensure bun + uv installed, install deps if needed | Yes (idempotent) |
| `bun-runner.js` *(lives in `plugin/scripts/`, not here)* | Hook: start worker via bun runtime; hand-maintained directly in `plugin/scripts/` (see `plugin/README.md`) | Yes |
| `build-hooks.js` | Build: bundle TS → `plugin/scripts/{worker-service,hook-client,mcp-server,context-generator}.cjs` + viewer | Yes |
| `build-viewer.js` | Build: bundle React viewer → `plugin/ui/viewer.html` (called by build-hooks.js) | Yes |
| `sync-to-cache.cjs` | Deploy: rsync plugin/ to cache + marketplace, register in CC JSON files | Yes (idempotent) |
| `sync-marketplace.cjs` | Deploy: protected rsync to marketplace, write `.install-version` marker (skips on beta) | Yes |
| `verify-settings-alignment.ts` | Build guard: backend `SettingsDefaultsManager` vs frontend `DEFAULT_SETTINGS` drift (blocks build) | Yes |
| `confine-test-mocks.py` | Test hygiene: makes every `mock.module()` of a shared module capture the real module and re-register it in `afterAll`, so a partial stub cannot leak into files loaded later. Idempotent (`__CONFINED_MOCKS__` marker), skips call sites appearing only in comments. Re-run after mocking `paths`, `SettingsDefaultsManager`, `project-filter`, `project-allowlist`, `project-name`, or `project-db`. `--check` for a dry run. | Yes (idempotent) |
| `regenerate-claude-md.ts` | Regenerate per-folder CLAUDE.md from DB for current project (`--dry-run`, `--clean`) | Yes |
| `generate-changelog.js` | Generate CHANGELOG.md from GitHub releases | Yes |
| `bug-report/` | Collect diagnostics into a bug report (`cli.ts` entry) | Yes |

### Queue ops (worker API, port 37777)

| Script | Purpose | Safe to run manually? |
|--------|---------|----------------------|
| `check-pending-queue.ts` | Inspect/process pending observation queue (`--process`, `--limit N`) | Yes |
| `clear-failed-queue.ts` | Clear failed messages (`--all` clears every status, `--force` non-interactive) | Confirm before `--all`/`--force` |

### Memory import/export

| Script | Purpose | Safe to run manually? |
|--------|---------|----------------------|
| `export-memories.ts` | Export query-matched memories to portable JSON (`--project=name`) | Yes |
| `import-memories.ts` | Import memories from JSON via worker API with dedup | Yes |
| `../src/bin/import-xml-observations.ts` | Import observations from raw XML | Yes |

### Timestamp repair (one-off, target global DB)

| Script | Purpose |
|--------|---------|
| `investigate-timestamps.ts` | Read-only: report observation/timestamp state |
| `fix-all-timestamps.ts` | Repair all observations whose timestamp mismatches session start |
| `fix-corrupted-timestamps.ts` | Repair observations corrupted in the Dec 24 2025 orphan-queue window |

## Destructive Scripts (require confirmation)

| Script | Purpose |
|--------|---------|
| `wipe-chroma.cjs` | Delete all ChromaDB data (`~/.claude-mem/chroma/`); rebuildable from SQLite |
| `cleanup-duplicates.ts` | Remove duplicate observations (dry-run by default; `--execute` to delete) |

## Build Outputs (do not edit)

`build-hooks.js` (via esbuild) generates these bundles into `plugin/scripts/`:
`worker-service.cjs`, `hook-client.cjs`, `mcp-server.cjs`, `context-generator.cjs`.
Read the corresponding source instead: `src/services/worker-service.ts`, `src/cli/hook-client-entry.ts`, `src/servers/mcp-server.ts`, `src/services/context-generator.ts`.
