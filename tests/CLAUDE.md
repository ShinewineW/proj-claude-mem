# Test Conventions

**Framework**: `bun:test` (native, no external deps). Run: `/opt/homebrew/bin/bun test`

## Patterns

**In-memory SQLite** (preferred over mocks for DB logic):
```typescript
db = new Database(':memory:');
new MigrationRunner(db).runAllMigrations();
```

**mock.module()** — process-level, must be called BEFORE imports:
```typescript
mock.module('../../src/shared/paths.js', () => ({ resolveProjectDbPath: () => '/test/mem.db' }));
```
**Gotcha**: Pollutes all test files in same process. Only mock leaf deps (paths.ts, SettingsDefaultsManager), never mock handler modules.
**Gotcha**: NEVER `mock.module('fs')` — it's a builtin module used by infrastructure tests (filesystem-hygiene etc.). Mocking it process-wide causes bun test to hang on full-suite runs. Use parameter injection instead (e.g., `cleanupGhostSessionsInDb(dbPaths, existsFn)`).
**Gotcha**: SettingsDefaultsManager is mocked by 15+ test files. New tests that verify settings defaults must use file-based assertions (`readFileSync` on `.ts` source) instead of importing the module — it may return incomplete stubs in full-suite runs.

**Logger suppression**: `spyOn(logger, 'info').mockImplementation(() => {})` in `beforeEach`, restore in `afterEach`.

**Env vars**: Set BEFORE importing the module under test (ES module hoisting).

**Env var cleanup**: Module-level `process.env.X = ...` MUST be restored in `afterAll`:
```typescript
const orig = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = testDataDir;
afterAll(() => { orig === undefined ? delete process.env.CLAUDE_MEM_DATA_DIR : process.env.CLAUDE_MEM_DATA_DIR = orig; });
```
bun runs all test files in the same process — leaked env vars break `SettingsDefaultsManager` tests.

**Temp dirs**: `join(tmpdir(), \`test-${Date.now()}\`)` with `rmSync` in `afterAll`.
**Gotcha**: Every `mkdirSync(dir)` MUST have a matching `rmSync(dir, { recursive: true, force: true })` in `afterAll` for the **same variable**. Having `rmSync` on a different path (e.g., a file inside the dir) does NOT count — the directory itself leaks. Enforced by `test-filesystem-hygiene.test.ts`.
**Gotcha**: Never use `homedir()` for test write paths — always `tmpdir()`. Never write to production paths (`~/.claude-mem/`). Enforced by `test-filesystem-hygiene.test.ts`.

**Runtime leak verification**: Static guards can have false negatives. After modifying test cleanup logic, verify with a before/after tmpdir count:
```bash
BEFORE=$(ls -d $TMPDIR/test-* $TMPDIR/claude-mem-* 2>/dev/null | wc -l)
/opt/homebrew/bin/bun test
AFTER=$(ls -d $TMPDIR/test-* $TMPDIR/claude-mem-* 2>/dev/null | wc -l)
echo "Delta: $((AFTER - BEFORE))"  # Must be 0
```

**Logger coverage gate**: Files under `src/services/worker/`, `src/services/sqlite/`, `src/hooks/`, `src/sdk/`, `src/servers/` must `import { logger }`. Enforced by `logger-usage-standards.test.ts` — new files without logger import fail full suite. Current exclusions for pure function modules: `stale-detection.ts`, `pool-cooldown-utils.ts`, `backpressure.ts`, `generator-action.ts`.

## Structure

Tests mirror source: `src/services/sqlite/` → `tests/services/sqlite/` or `tests/sqlite/`. Each file is self-contained (no shared conftest/fixtures).

Key test directories: `tests/sqlite/` (DB), `tests/hooks/` (hook structure), `tests/shared/` (project isolation), `tests/worker/` (generator/pool/bypass), `tests/infrastructure/` (filesystem-hygiene, logger-usage-standards), `tests/services/` (routes, sync, transcripts).

## Run Commands

```bash
/opt/homebrew/bin/bun test                    # All tests (1596 pass, 3 fail pre-existing)
/opt/homebrew/bin/bun test tests/sqlite/      # Database tests
/opt/homebrew/bin/bun test tests/hooks/       # Hook structure tests
```
