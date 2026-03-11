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

**Logger suppression**: `spyOn(logger, 'info').mockImplementation(() => {})` in `beforeEach`, restore in `afterEach`.

**Env vars**: Set BEFORE importing the module under test (ES module hoisting).

**Temp dirs**: `join(tmpdir(), \`test-${Date.now()}\`)` with `rmSync` in `afterEach`.

## Structure

Tests mirror source: `src/services/sqlite/` → `tests/services/sqlite/` or `tests/sqlite/`. Each file is self-contained (no shared conftest/fixtures).

## Run Commands

```bash
/opt/homebrew/bin/bun test                    # All tests
/opt/homebrew/bin/bun test tests/sqlite/      # Database tests
/opt/homebrew/bin/bun test tests/hooks/       # Hook structure tests
```
