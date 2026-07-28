# Test Conventions

**Framework**: `bun:test` (native, no external deps). Run: `bun test`

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
**Gotcha**: `mock.module()` is IRREVERSIBLE — `mock.restore()` does NOT clear it. A test importing a module that other files `mock.module()` (ProcessRegistry, ChromaMcpManager, SessionStore, ChromaSync) passes in isolation but FAILS in the full suite. The FULL `bun test` (stable order) is the gate — a subset run like `bun test tests/sqlite/ tests/worker/` surfaces phantom pollution failures the full run does not.

**Confine your mocks [MUST]**: any file that `mock.module()`s a shared module must capture the real module first and re-register it in `afterAll`, so the stub cannot leak into files loaded later (bun loads test files lazily, so the restore lands before the next file's imports):
```typescript
import * as __real0 from '../../src/shared/paths.js';
const __REAL_MODULES: Array<[string, unknown]> = [['../../src/shared/paths.js', { ...__real0 }]];
afterAll(() => { for (const [spec, real] of __REAL_MODULES) mock.module(spec, () => real); });
mock.module('../../src/shared/paths.js', () => ({ /* partial stub */ }));
```
Applied to 26 files by `scripts/confine-test-mocks.py` (idempotent, guarded by a `__CONFINED_MOCKS__` marker; re-run it after adding a mock of `paths`, `SettingsDefaultsManager`, `project-filter`, `project-allowlist`, `project-name`, or `project-db`). This is what took the suite from 2232/70 to 2302/0 — the 70 failures were 11 project-isolation files poisoned by partial stubs, not broken tests. Alternatives when restoration doesn't fit: source-inspection (`readFileSync` the `.ts`), or inline a faithful copy (see `process-registry-killed.test.ts`).
**Gotcha**: `mock.module('worker-utils.js')` partial-stub silently fall-through. When a test stubs only `ensureWorkerRunning`/`getWorkerPort`, any NEW exported function (e.g. `fetchWithTimeout`) added later is NOT in the mock — production code that calls it falls through to the real implementation, which then hits the real `globalThis.fetch` (or whatever the test wired). Tests pinning exact `fetchCalls.length` will break invisibly when production starts using the new export. Mitigation: filter `fetchCalls` by URL suffix instead of count, OR extend the mock when adding new exports. Hit by F6 (`/api/sessions/resolve-prompt-number` GET added an extra fetch and broke the L6 nested-repo dbPath pin).

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
bun test
AFTER=$(ls -d $TMPDIR/test-* $TMPDIR/claude-mem-* 2>/dev/null | wc -l)
echo "Delta: $((AFTER - BEFORE))"  # Must be 0
```

**不要写字符串形态 pin** [MUST]: 曾有 19 个测试文件用 `readFileSync` 读 `.ts` 源码 + 字面量 count/regex 固定载荷代码的**字符串形态**（例：`writeFallbackEntry(` 出现次数必须 ≥3；SDKAgent.ts 不得含 `'buildSummaryPrompt'`）。这类断言会因 helper 提取 / dedupe / 无副作用重命名而误失败，行为真坏了却照样通过 —— 已于 2026-07-28 全部删除。要守的契约请写成调用产品代码的行为测试。

例外（读的不是源码文本，保留）：`tests/infrastructure/*` 读 `hooks.json` / `package.json` / 构建产物目录，属于真实分发契约；`logger-usage-standards.test.ts` 与 `test-filesystem-hygiene.test.ts` 是本文件规定的强制门禁。

**Audit test location**: `tests/audit/` 保留 file-to-prod Stage 3 产出的 property-based tests 作为长期回归覆盖（命名约定 `phaseN-<topic>.test.ts`）。

**Logger coverage gate**: Files under `src/services/worker/`, `src/services/sqlite/`, `src/services/sync/`, `src/hooks/`, `src/sdk/`, `src/servers/` must `import { logger }`. Enforced by `tests/logger-usage-standards.test.ts` — new files without logger import fail full suite. Current exclusions for pure function / coordinator modules: `stale-detection.ts`, `pool-cooldown-utils.ts`, `backpressure.ts`, `generator-action.ts`, `spawn-args-filter.ts`, `fresh-summarize-store.ts`, `fresh-summarize-deps.ts`, `obs-cap-policy.ts`, `SessionCompletionHandler.ts`, `global-semaphore.ts`.

## Structure

Tests mirror source: `src/services/sqlite/` → `tests/services/sqlite/` or `tests/sqlite/`. Each file is self-contained (no shared conftest/fixtures).

Key test directories: `tests/sqlite/` (DB), `tests/hooks/` (hook structure), `tests/shared/` (project isolation), `tests/worker/` (generator/pool/bypass), `tests/infrastructure/` (filesystem-hygiene, plugin distribution, process manager), `tests/services/` (routes, sync, transcripts). Note: `logger-usage-standards.test.ts` lives at `tests/` root, not under `tests/infrastructure/`.

## Run Commands

```bash
bun test ./tests/           # All tests (2186 pass, 0 fail; 236 files, 2026-07-28)
bun test tests/sqlite/      # Database tests
bun test tests/hooks/       # Hook structure tests
```
