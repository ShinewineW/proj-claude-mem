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

**Temp dirs**: `join(tmpdir(), \`test-${Date.now()}\`)` with `rmSync` in `afterEach`.

**Logger coverage gate**: Files under `src/services/worker/`, `src/services/sqlite/`, `src/hooks/`, `src/sdk/`, `src/servers/` must `import { logger }`. Enforced by `logger-usage-standards.test.ts` — new files without logger import fail full suite.

## Structure

Tests mirror source: `src/services/sqlite/` → `tests/services/sqlite/` or `tests/sqlite/`. Each file is self-contained (no shared conftest/fixtures).

## Run Commands

```bash
/opt/homebrew/bin/bun test                    # All tests
/opt/homebrew/bin/bun test tests/sqlite/      # Database tests
/opt/homebrew/bin/bun test tests/hooks/       # Hook structure tests
```
