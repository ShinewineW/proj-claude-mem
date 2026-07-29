# 彻底解绑 Bypass 与 SDK 的 OB 通路 — 实施计划

> **日期**: 2026-07-17
> **状态**: 活跃
> **作者**: wangjiazhe(+ Claude Opus 4.8)
> **基准版本**: `proj-claude-mem@b741d043`
> **目的**: 让 bypass 与 SDK observer 成为地位对等、同等竞争的观测消费者 —— 解除 bypass 对 SDK 播种的依赖,在缩减 SDK 的同时让 bypass 承担大部分 OB 流量。
> 范围: `proj-claude-mem` / worker 子系统(SDKAgent、SessionManager、SessionStore、BypassLane、observer-anchor、SettingsDefaultsManager)

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development(推荐)或 executing-plans 逐任务实施本计划。所有步骤用 checkbox(`- [ ]`)追踪。

**Goal:** 用一个"锚类型驱动"的模型解除 bypass 对 SDK 播种 `memory_session_id` 的依赖,使两条通路在同一队列上对等竞争,bypass 靠并发数承担多数 OB。

**Architecture:** 把 `memory_session_id` 从"SDK 私有的 resume 句柄兼 FK 锚"拆成两种可区分的锚:legacy 模式仍由 SDK 播种(带 resume),新模式由 claude-mem 在**会话建行时**派发一个带前缀的稳定锚 `cm-<uuid>`(**无 resume**)。一个**不进 viewer UI、不可经设置 API 写入**(GET `/api/settings` 返回全量合并 defaults,该键会**只读回显** —— 已接受,评审 R1-2)的总闸 `CLAUDE_MEM_OBSERVER_RESUME`(默认 `false`=新模式;读取优先级 env var > settings.json > 默认)**只在会话出生时读一次**决定派发哪种锚;此后所有行为(是否 resume、是否可被 SDK id 覆盖、是否加载回内存、是否可被清空)都由**锚的类型**(`cm-` 前缀)驱动、与当前 flag 值无关。这样切换开关/重启只影响新会话,零迁移、零转换状态机。

**Tech Stack:** TypeScript(ESM,`.js` 扩展名 import)、`bun:test`、better-sqlite3、Express、Claude Agent SDK `query()`。构建 `bun run build-and-sync`。

---

## 关键架构事实(实现者必读)

1. **竞争消费者,非负载均衡**(`BypassLane.ts:11-13`):SDK observer 与 bypass 抢同一张 `pending_messages` 队列的 observation 行,原子 `UPDATE ... status='processing'` 先落地者赢。SDK 批认领(`claimNextObservationBatch`,一次最多 `BATCH_MAX_SIZE`=5),bypass 单认领(`claimNextObservation`),故现状 SDK ~84% / bypass ~16%。
2. **bypass 的播种依赖**(要解除的核心):`BypassLane.consumeLoop` 的 gate(`BypassLane.ts:570-573`,判断在 `:570`)在 `session.memorySessionId` 上 —— 为 null 就退避,不认领。legacy 下该 id 由 SDK 从 `system:init` 播种。
3. **致命点:内存会话默认丢弃 DB 锚**(`SessionManager.ts:248-253`,Issue #817):`initializeSession` 恒把内存 `memorySessionId` 置 `null`(防 stale SDK-id resume 崩溃),**不从 DB 加载**。若不修此处,即便 DB 有 `cm-` 锚,内存也是 null,bypass 的 gate 永久阻塞。**本计划 Task 4 专门修它**——只加载 `cm-` 锚(稳定、永不 resume,不受 #817 影响),SDK-id 锚仍置 null。
4. **summary 不受影响**:summary 走 fresh query(`fresh-summarize.ts:11-13,150-151`,无 resume、无 observer 历史),按 `content_session_id + prompt_number` 取归属范围内的观测,不依赖 resume,也不靠 `memory_session_id` 检索。后续 migration 34 已将唯一 turn 身份拆为 `content_session_id + turn_number`;`prompt_number` 仅保留归属语义。
5. **FK 有 `ON UPDATE CASCADE`**(`migrations/runner.ts:108,131`)。稳定的 `cm-` 锚永不 mutate → 该级联在新模式下永不触发,顺带消除 legacy 那个 ~200ms FK-race 窗口。
6. **flag 只读一次(非创建式读取,评审 R11-2 deep)**:`CLAUDE_MEM_OBSERVER_RESUME` 仅在 `createSDKSession`(会话建行)经 `mintInitialAnchor()` 读一次;其余所有缝(SessionManager 加载、SDKAgent 两个守卫、三处清锚站点守卫)全是 `isWorkerAnchor()` 驱动,不读 flag。该读取是 `observer-anchor.ts` 内**自包含、非创建式**的:优先级 **env var > settings.json(只读,flat 或 legacy `{env:{…}}`)> 硬编码默认 `false`**,**不经 `SettingsDefaultsManager.loadFromFile`**。原因:`loadFromFile` 在文件缺失时 `writeFileSync`+`chmodSync` 创建、legacy 迁移时改写 —— 建行侧调用它会在 clean/CI 环境写真实 `~/.claude-mem`(**15 个在进程内用 `store.createSDKSession` 的既有测试**都会触发),且它被 15+ 测试 `mock.module`(泄漏 stub 可能污染建行读取)。自包含读取避开这两者,也不再有 `loadFromFile` 的 5s TTL 陈旧窗口(建行是每会话一次、非热循环,下一新会话即读到新值)。
7. **数值旋钮独立于总闸**:pool(`MAX_CONCURRENT_AGENTS`)、C(`BYPASS_CONCURRENCY`)、batch(`BATCH_MAX_SIZE`)、G(`BYPASS_MAX_CONSUMERS`)是既有独立设置,新模式的"比例"靠调它们实现(Task 6 机器 settings.json),不进总闸语义。
8. **总闸半径(评审 Q1,用户确认)**:默认 OFF 对 `provider=claude`(未启用 bypass)的部署**同样生效** —— observer 一并无状态化。该类部署无 bypass 收益,但净赚稳定性(消灭 stale-resume 崩溃类 + CASCADE 竞态);**有意不与 provider 配置耦合**,保持单一判定源。
9. **`memory_session_id` 写入点全量清单(评审 R1-1 审计)**:运行时共 6 处写 —— ① `SessionStore.createSDKSession`(建行,Task 3 改为 `mintInitialAnchor()`);② `SDKAgent.ts:305` `ensureMemorySessionIdRegistered`(被 `shouldPersistSDKSessionId` 把守,Task 2 加 cm- 守卫);③ `ResponseProcessor.ts:165` `ensureMemorySessionIdRegistered(session.memorySessionId)`(写回自身当前值,幂等,无需守卫);④ `SDKAgent.ts:371` context-overflow 清 NULL;⑤ `SessionRoutes.ts:283` stale-resume 清 NULL;⑥ `worker-service.ts:802` stale-resume 清 NULL。**④⑤⑥ 是 R1-1 修复对象**(Task 2 统一改经 `isWorkerAnchor` 驱动的 `resetSessionAnchorForFreshStart` 唯一清锚辅助函数:cm- 锚不清、legacy 行为不变,评审 R2-1)。注意 ⑤⑥ 的触发条件含宽泛的 `'aborted by user'` 子串匹配(watchdog abort 亦命中),不守卫则新模式下任意 abort 都可能清掉 cm- 锚。`fresh-summarize-store` / `bypass-observation-store` 只在事务内重读、不写锚。

## 测试约定(务必遵守)

- 框架 `bun:test`;全量 gate 是 `bun test ./tests/`(**只扫 `./tests/`**,根级 `bun test` 会连带扫 `attn_sink/` 的上游克隆产生无关失败)。
- **基线与"无新增失败"判据(评审 R3 实测)**:在 `b741d043` 本机全量跑出 2185 pass / 70 fail —— 全部为**既有的顺序依赖型跨文件污染**(`mock.module` 泄漏 + 共享机器状态;每个失败 suite 单独跑均 100% pass,已验证 `settings-defaults-manager.test.ts` 单跑 38/38)。处理沿用上一项目先例(`attn_sink/baseline-test-failures-205b9101.txt`)。**失败行必须先剥离 Bun 的动态耗时后缀**(`[1.20ms]`/`[1.20s]`),否则每行都因耗时抖动被 diff 判为变化(评审 R4-2)。规范化命令(基线生成与每次对比**必须同一条**):
```bash
bun test ./tests/ 2>&1 | grep '^(fail)' | sed -E 's/ \[[0-9.]+m?s\]$//' | sort
```
**开工前**先 `... > attn_sink/baseline-test-failures-b741d043.txt` 记录基线(已生成,70 行,已规范化);每个 Task 的全量 gate = 上述命令输出与基线 **diff 为空**,且本计划**新增/修改的测试文件单独跑 100% pass**。**基线抖动裁决(评审 R8 实测:污染集本身不稳定,同一 HEAD 可跑出 70/71 行)**:diff 出现新增失败行时,逐个单独跑该测试文件 —— 若**单跑 100% pass 且该文件不在本计划触及清单**,判为既有污染抖动、记录后放行;若单跑失败、或文件属于本计划新增/修改/触及,判为回归,必须修复后重跑。不试图在本计划内修既有污染(YAGNI,独立问题另开工)。
- **`SettingsDefaultsManager` 被 15+ 文件 `mock.module`**:任何"校验默认值"的测试**不得 import 该模块**,改用 `readFileSync('src/shared/SettingsDefaultsManager.ts')` 源码断言。
- `CLAUDE_MEM_OBSERVER_RESUME` 默认 `"false"`=新模式(OFF);纯函数(`isWorkerAnchor`/`mintWorkerAnchor`/`mintInitialAnchor`/`observerResumeEnabled`/`shouldClearStaleAnchorOnResumeFailure`/`shouldPersistSDKSessionId`/`shouldResumeSDKSession`/`resetSessionAnchorForFreshStart`)可直接 import 测试(传显式 settings 对象)。**flag 敏感的建行集成用例一律 spawn 干净 bun 子进程执行**(评审 R2-2 + R11-2 deep:同进程既有 `mock.module` 泄漏、又会碰机器 settings.json / 真实 `~/.claude-mem`;建行读取虽已是非创建式、不经 `loadFromFile`,子进程 + 一次性 `CLAUDE_MEM_DATA_DIR` 仍是唯一密闭方式),flag 由 env 或临时 settings.json 显式注入、临时目录 `finally` 清理(评审 R1-6,防跨文件污染与真实目录写入)。
- `src/services/worker/` 下逻辑用 `import { logger }`;新纯模块放 `src/shared/`(与 SettingsDefaultsManager/paths 同层)。

## 文件清单

| 文件 | 职责 / 改动 |
|------|-------------|
| `src/shared/observer-anchor.ts` | 【新】纯模块:`WORKER_ANCHOR_PREFIX`、`isWorkerAnchor`、`mintWorkerAnchor`、`observerResumeEnabled`、`mintInitialAnchor`、`shouldClearStaleAnchorOnResumeFailure`、`resetSessionAnchorForFreshStart`(Task 1) |
| `src/shared/SettingsDefaultsManager.ts` | 【改】接口 + 默认加 `CLAUDE_MEM_OBSERVER_RESUME`(Task 1) |
| `src/services/worker/SDKAgent.ts` | 【改】`shouldResume` 抽取为导出纯函数 `shouldResumeSDKSession`(含 `!isWorkerAnchor` 守卫);`shouldPersistSDKSessionId` 加守卫;overflow 清锚站点加守卫(Task 2) |
| `src/services/worker/http/routes/SessionRoutes.ts` | 【改】stale-resume 清锚站点改用 `shouldClearStaleAnchorOnResumeFailure`(Task 2) |
| `src/services/worker-service.ts` | 【改】stale-resume 清锚站点改用 `shouldClearStaleAnchorOnResumeFailure`(Task 2) |
| `src/services/sqlite/SessionStore.ts` | 【改】`createSDKSession` 建行时用 `mintInitialAnchor()` 取代硬编码 `NULL`(Task 3) |
| `src/services/worker/SessionManager.ts` | 【改】`initializeSession` 加载 `cm-` 锚回内存(Task 4,致命点) |
| `src/services/worker/agents/ResponseProcessor.ts` | 【改】STORED 日志加内联 `lane=sdk`(Task 5) |
| `src/services/worker/BypassLane.ts` | 【改】成功日志加内联 `lane=bypass`+`obsCount`;失败分支死信化 `DEAD_LETTER`(Task 5) |
| `~/.claude-mem/settings.json`(机器,非仓库) | 【改】pool=3 / C=4 / batch=2 / G=6(Task 6) |
| `tests/shared/observer-anchor.test.ts` | 【新】Task 1 |
| `tests/shared/observer-resume-flag-defaults.test.ts` | 【新】Task 1 默认值 + UI 隔离源码断言 |
| `tests/worker/sdk-agent-anchor-guards.test.ts` | 【新】Task 2 |
| `tests/sqlite/create-sdk-session-anchor.test.ts` | 【新】Task 3 |
| `tests/worker/session-manager-anchor-load.test.ts` | 【新】Task 4 |
| `tests/worker/lane-attribution-log.test.ts` | 【新】Task 5 源码断言 |

---

## Chunk 1: 锚模型基座(Task 1–2)

### Task 1: `observer-anchor.ts` 纯模块 + 总闸设置键

**Files:**
- Create: `src/shared/observer-anchor.ts`
- Modify: `src/shared/SettingsDefaultsManager.ts:44`(接口,Process Management 区)、`:127`(默认块)
- Test: `tests/shared/observer-anchor.test.ts`(新)、`tests/shared/observer-resume-flag-defaults.test.ts`(新)

**背景(已核实)**:`USER_SETTINGS_PATH` 从 `src/shared/paths.ts:59` 导出。`randomUUID` 从 `'crypto'` 取(Bun/Node 均支持)。`src/shared/` 已有 `paths.ts`/`SettingsDefaultsManager.ts` 同层文件。**flag 读取不走 `SettingsDefaultsManager.loadFromFile`(评审 R11-2 deep)**:后者在文件缺失时会创建(`:268-288` `writeFileSync`+`chmodSync`)、legacy 迁移时会改写(`:307-331`),且被 15+ 测试 `mock.module` —— 建行侧调用会污染真实目录/受 mock 泄漏影响。故本模块自带非创建式 `existsSync`+`readFileSync` 读取(env > settings.json 只读 > 默认 `false`),`fs` 从 node 内建 import。`SettingsDefaultsManager` 仍新增该键(接口 + DEFAULTS,供 GET `/api/settings` 只读回显与默认单一来源),但不在建行热路径被调用。

- [ ] **Step 1: 写失败测试**(新建 `tests/shared/observer-anchor.test.ts`)

```typescript
import { describe, test, expect } from "bun:test";
import {
  WORKER_ANCHOR_PREFIX,
  isWorkerAnchor,
  mintWorkerAnchor,
  observerResumeEnabled,
  mintInitialAnchor,
  shouldClearStaleAnchorOnResumeFailure,
  resetSessionAnchorForFreshStart,
} from "../../src/shared/observer-anchor.js";

describe("observer-anchor", () => {
  test("prefix is 'cm-'", () => {
    expect(WORKER_ANCHOR_PREFIX).toBe("cm-");
  });

  test("isWorkerAnchor recognizes cm- ids only", () => {
    expect(isWorkerAnchor("cm-abc")).toBe(true);
    expect(isWorkerAnchor("cm-" + "0".repeat(36))).toBe(true);
    expect(isWorkerAnchor("550e8400-e29b-41d4-a716-446655440000")).toBe(false); // real SDK id
    expect(isWorkerAnchor("manual-proj")).toBe(false);
    expect(isWorkerAnchor(null)).toBe(false);
    expect(isWorkerAnchor(undefined)).toBe(false);
    expect(isWorkerAnchor("")).toBe(false);
  });

  test("mintWorkerAnchor returns a cm- prefixed, unique, non-empty id", () => {
    const a = mintWorkerAnchor();
    const b = mintWorkerAnchor();
    expect(isWorkerAnchor(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan("cm-".length + 10);
  });

  test("observerResumeEnabled: 'true' => true, anything else => false", () => {
    expect(observerResumeEnabled({ CLAUDE_MEM_OBSERVER_RESUME: "true" })).toBe(true);
    expect(observerResumeEnabled({ CLAUDE_MEM_OBSERVER_RESUME: "false" })).toBe(false);
    expect(observerResumeEnabled({ CLAUDE_MEM_OBSERVER_RESUME: "" })).toBe(false);
    expect(observerResumeEnabled({})).toBe(false);
  });

  test("mintInitialAnchor: resume ON => null (SDK seeds); OFF => cm- anchor", () => {
    expect(mintInitialAnchor({ CLAUDE_MEM_OBSERVER_RESUME: "true" })).toBeNull();
    const off = mintInitialAnchor({ CLAUDE_MEM_OBSERVER_RESUME: "false" });
    expect(isWorkerAnchor(off)).toBe(true);
  });

  test("shouldClearStaleAnchorOnResumeFailure: only legacy SDK-id anchors are clearable", () => {
    expect(shouldClearStaleAnchorOnResumeFailure("No conversation found with session ID x", "sdk-id")).toBe(true);
    expect(shouldClearStaleAnchorOnResumeFailure("Request aborted by user", "sdk-id")).toBe(true);
    // cm- worker anchor is never resumed, hence never stale — must NOT be cleared,
    // even on the broad 'aborted by user' match (watchdog aborts hit it too).
    expect(shouldClearStaleAnchorOnResumeFailure("No conversation found", "cm-abc")).toBe(false);
    expect(shouldClearStaleAnchorOnResumeFailure("aborted by user", "cm-abc")).toBe(false);
    expect(shouldClearStaleAnchorOnResumeFailure("some other error", "sdk-id")).toBe(false);
    expect(shouldClearStaleAnchorOnResumeFailure("No conversation found", null)).toBe(false);
    expect(shouldClearStaleAnchorOnResumeFailure("No conversation found", undefined)).toBe(false);
  });

  test("resetSessionAnchorForFreshStart: keeps cm- (no store call), clears legacy, always forceInit", () => {
    const calls: Array<[number, string | null]> = [];
    const store = { updateMemorySessionId: (id: number, v: string | null) => { calls.push([id, v]); } };

    const cm = { sessionDbId: 1, memorySessionId: "cm-x", forceInit: false };
    expect(resetSessionAnchorForFreshStart(store, cm)).toBe(false);
    expect(cm.memorySessionId).toBe("cm-x");
    expect(cm.forceInit).toBe(true);
    expect(calls.length).toBe(0); // DB never touched for a worker anchor

    const legacy = { sessionDbId: 2, memorySessionId: "sdk-id", forceInit: false };
    expect(resetSessionAnchorForFreshStart(store, legacy)).toBe(true);
    expect(legacy.memorySessionId).toBeNull();
    expect(legacy.forceInit).toBe(true);
    expect(calls).toEqual([[2, null]]);

    const empty = { sessionDbId: 3, memorySessionId: null, forceInit: false };
    expect(resetSessionAnchorForFreshStart(store, empty)).toBe(false);
    expect(empty.forceInit).toBe(true);
    expect(calls.length).toBe(1); // nothing to clear → no extra call
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/shared/observer-anchor.test.ts`
Expected: FAIL —「Cannot find module '../../src/shared/observer-anchor.js'」。

- [ ] **Step 3: 实现纯模块**(新建 `src/shared/observer-anchor.ts`,完整内容)

```typescript
/**
 * Observer-anchor identity helpers (single source of truth for the
 * bypass/SDK decoupling). `memory_session_id` can be one of:
 *   - null            → legacy: SDK will seed its own resume id on system:init
 *   - a raw UUID / …  → legacy: SDK's own session id (resume handle + FK anchor)
 *   - "cm-<uuid>"     → NEW mode: claude-mem-minted STABLE anchor, never resumed,
 *                       never overwritten. Lets bypass store observations without
 *                       waiting for an SDK seed.
 *
 * The master switch CLAUDE_MEM_OBSERVER_RESUME is read ONCE at session birth
 * (mintInitialAnchor); every downstream decision is driven by isWorkerAnchor()
 * on the persisted anchor, so flipping the switch only affects NEW sessions.
 */
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { USER_SETTINGS_PATH } from "./paths.js";

export const WORKER_ANCHOR_PREFIX = "cm-";

// Default for the master switch. MUST match
// SettingsDefaultsManager.DEFAULTS.CLAUDE_MEM_OBSERVER_RESUME ("false");
// pinned by tests/shared/observer-resume-flag-defaults.test.ts.
const OBSERVER_RESUME_DEFAULT = false;

/** True iff `id` is a claude-mem-minted worker anchor (cm- prefix). */
export function isWorkerAnchor(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(WORKER_ANCHOR_PREFIX);
}

/** Mint a fresh stable worker anchor. Guaranteed != any contentSessionId
 *  (raw UUID, no prefix) and != any SDK / manual- id. */
export function mintWorkerAnchor(): string {
  return `${WORKER_ANCHOR_PREFIX}${randomUUID()}`;
}

/** Non-creating, `loadFromFile`-free flag read for the session-birth hot path
 *  (评审 R11-2 deep / R13-3). `createSDKSession → mintInitialAnchor()` runs in
 *  **15 in-process test files** + the production hot path, so this read must NOT:
 *    - create the settings file as a birth side effect
 *      (`SettingsDefaultsManager.loadFromFile` `writeFileSync`+`chmodSync` when the
 *      file is missing, and rewrites it on legacy-nested migration → real
 *      `~/.claude-mem` mutation in clean/CI envs), nor
 *    - call any `SettingsDefaultsManager` method at read time (it is `mock.module`'d
 *      by other test files; a leaked partial stub could crash or skew this call —
 *      the very cross-file pollution the subprocess probe was built to dodge).
 *  Precise scope (评审 R13-3): this is not "fully mock-independent" — the module
 *  still transitively imports `SettingsDefaultsManager` via `paths.ts`, but only
 *  for the `USER_SETTINGS_PATH` *string constant* (frozen at module load); the
 *  read itself invokes no `SettingsDefaultsManager` method, only `fs`.
 *  Precedence mirrors `loadFromFile`: env var > settings.json (READ-ONLY, flat or
 *  legacy `{env:{…}}`) > hardcoded default. Session birth is once-per-conversation,
 *  not a hot loop, so dropping the 5s TTL cache is fine (and removes the old
 *  "settings edit invisible for ≤5s" caveat — the next new session reads fresh). */
function readObserverResumeFlag(): boolean {
  const env = process.env.CLAUDE_MEM_OBSERVER_RESUME;
  if (env !== undefined) return env === "true";
  try {
    if (existsSync(USER_SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, "utf-8"));
      // flat schema, or legacy nested { env: {...} } (matches loadFromFile)
      const flat = raw?.env && typeof raw.env === "object" ? raw.env : raw;
      const v = flat?.CLAUDE_MEM_OBSERVER_RESUME;
      if (v !== undefined) return v === "true";
    }
  } catch {
    /* missing/malformed settings → default (never throws on the birth path) */
  }
  return OBSERVER_RESUME_DEFAULT;
}

/** Whether the legacy resumable observer is enabled. With an explicit settings
 *  object → pure (used by unit tests). With no arg → the non-creating env >
 *  settings.json > default read above. Default false (= new decoupled mode).
 *  Not in viewer UI, not writable via POST /api/settings; GET /api/settings
 *  echoes it read-only (R1-2). */
export function observerResumeEnabled(settings?: {
  CLAUDE_MEM_OBSERVER_RESUME?: string;
}): boolean {
  if (settings) return settings.CLAUDE_MEM_OBSERVER_RESUME === "true";
  return readObserverResumeFlag();
}

/** Initial memory_session_id for a brand-new session row:
 *  null in legacy (resume ON, SDK seeds), a cm- anchor in new mode (resume OFF). */
export function mintInitialAnchor(settings?: {
  CLAUDE_MEM_OBSERVER_RESUME?: string;
}): string | null {
  return observerResumeEnabled(settings) ? null : mintWorkerAnchor();
}

/** True when a resume-failure error should clear the session's anchor.
 *  Extracted from the legacy stale-resume detection (SessionRoutes /
 *  WorkerService generator catch): only a real SDK-id anchor can be stale.
 *  A cm- worker anchor is never resumed, hence never stale — clearing it
 *  would orphan the FK anchor bypass/observer store under (评审 R1-1).
 *  NOTE: the 'aborted by user' substring is broad (watchdog aborts match),
 *  which is exactly why cm- anchors must be excluded here. */
export function shouldClearStaleAnchorOnResumeFailure(
  errorMessage: string,
  memorySessionId: string | null | undefined,
): boolean {
  return (
    (errorMessage.includes("aborted by user") ||
      errorMessage.includes("No conversation found")) &&
    !!memorySessionId &&
    !isWorkerAnchor(memorySessionId)
  );
}

/** THE production clear routine for overflow / stale-resume fresh starts
 *  (评审 R2-1: single behavioral choke point, wired into all three sites).
 *  Clears the anchor ONLY when it is a clearable legacy SDK id; a cm- worker
 *  anchor is preserved in both DB and memory (never resumed → never stale;
 *  clearing it would CASCADE-NULL the NOT NULL FK column of child rows).
 *  Always sets forceInit so the next spawn starts a fresh SDK subprocess.
 *  Returns true iff the anchor was cleared. */
export function resetSessionAnchorForFreshStart(
  store: { updateMemorySessionId(sessionDbId: number, id: string | null): void },
  session: { sessionDbId: number; memorySessionId: string | null; forceInit?: boolean },
): boolean {
  session.forceInit = true;
  if (session.memorySessionId && !isWorkerAnchor(session.memorySessionId)) {
    store.updateMemorySessionId(session.sessionDbId, null);
    session.memorySessionId = null;
    return true;
  }
  return false;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/shared/observer-anchor.test.ts`
Expected: PASS(全部用例)。

- [ ] **Step 5: 加设置键**(`SettingsDefaultsManager.ts`)

接口块 —— 在 `:44` `CLAUDE_MEM_MAX_CONCURRENT_AGENTS: string; ...` 那一行**之后**插入:
```typescript
  CLAUDE_MEM_OBSERVER_RESUME: string; // Master switch. NOT in viewer UI, NOT writable via POST /api/settings (absent from settingKeys whitelist); GET /api/settings echoes it read-only. Hand-edit settings.json or env var (priority env > file > default). "true"=legacy resumable observer + SDK-seeded id; "false"(default)=new decoupled mode (stateless observer, claude-mem-minted cm- anchor).
```

默认块 —— 在 `:127` `CLAUDE_MEM_MAX_CONCURRENT_AGENTS: "4", ...` 那一行**之后**插入:
```typescript
    CLAUDE_MEM_OBSERVER_RESUME: "false", // default = new decoupled mode
```

- [ ] **Step 6: 写默认值 + UI 隔离源码断言测试**(新建 `tests/shared/observer-resume-flag-defaults.test.ts`)

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

const DEFAULTS = readFileSync("src/shared/SettingsDefaultsManager.ts", "utf-8");

describe("CLAUDE_MEM_OBSERVER_RESUME defaults + UI isolation", () => {
  test("default is \"false\" (new decoupled mode)", () => {
    expect(DEFAULTS).toContain('CLAUDE_MEM_OBSERVER_RESUME: "false"');
  });

  test("flag has no UI exposure: absent from viewer settings constants", () => {
    // Deliberately NOT wired into the viewer (b741d043 wired the OTHER bypass
    // keys; this master switch stays a hand-edit-only escape hatch).
    const constants = readFileSync("src/ui/viewer/constants/settings.ts", "utf-8");
    expect(constants).not.toContain("CLAUDE_MEM_OBSERVER_RESUME");
  });

  test("flag is NOT in the POST /api/settings persistence whitelist", () => {
    // NOTE (评审 R1-2): GET /api/settings returns the FULL merged defaults via
    // SettingsDefaultsManager.loadFromFile(), so the key IS read-visible there —
    // that indirect, read-only exposure is accepted. What this test locks down
    // is the write path: the key must never enter the POST settingKeys whitelist
    // (SettingsRoutes.ts hardcodes that list, so a plain string assertion works).
    const routes = readFileSync(
      "src/services/worker/http/routes/SettingsRoutes.ts",
      "utf-8",
    );
    expect(routes).not.toContain("CLAUDE_MEM_OBSERVER_RESUME");
  });
});
```

- [ ] **Step 7: 运行 + 全量无回归**

Run: `bun test tests/shared/observer-anchor.test.ts tests/shared/observer-resume-flag-defaults.test.ts && bun test ./tests/`
Expected: 新测试 PASS;全量无新增失败(对照基线,见测试约定;基线文件不存在则先按测试约定生成)。

- [ ] **Step 8: 提交**

```bash
git add src/shared/observer-anchor.ts src/shared/SettingsDefaultsManager.ts tests/shared/observer-anchor.test.ts tests/shared/observer-resume-flag-defaults.test.ts
git commit -m "feat(observer): add observer-anchor module + CLAUDE_MEM_OBSERVER_RESUME master switch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2: 守卫先行 —— SDKAgent 双守卫 + 三处清锚站点(cm- 锚永不 resume / 永不覆盖 / 永不清空)

**Files:**
- Modify: `src/services/worker/SDKAgent.ts:59-72`(`shouldPersistSDKSessionId`)、`:117-121`(`shouldResume` 抽取为导出纯函数 `shouldResumeSDKSession`)、`:356-376`(context-overflow 清锚站点)、`:196-207`(M1 告警)、`:298` 块后(D1 debug)
- Modify: `src/services/worker/http/routes/SessionRoutes.ts:276-287`(stale-resume 清锚站点)
- Modify: `src/services/worker-service.ts:793-805`(stale-resume 清锚站点)
- Test: `tests/worker/sdk-agent-anchor-guards.test.ts`(新)
- Test: `tests/worker/context-overflow-reset.test.ts`(改,评审 R3-1:overflow wiring 源码断言从 raw clear 改为 helper 调用 —— **必然**被 Step 3(e) 打破,非"若冲突")

**背景(已核实)**:`shouldPersistSDKSessionId`(`:59`,已导出纯函数)决定是否用 SDK 返回的 `message.session_id` 覆盖当前锚(→ `:300` 的赋值 + `ensureMemorySessionIdRegistered`)。`shouldResume`(`:117-121`)是内联布尔 —— **本 Task 把它抽取为导出纯函数 `shouldResumeSDKSession` 并直接测试(评审 R1-3:replica 测试与生产代码零连接,是假阳性;必须测真函数)**。另有三处清锚站点(关键架构事实 #9 ④⑤⑥)会无条件把 `memory_session_id` 清为 NULL —— 必须对 cm- 锚跳过清空(评审 R1-1),否则:锚失稳 → bypass gate 重新阻塞 → 下一次 SDK init 播种自身 id、会话退化为 legacy;且对已有 FK 子行的会话,父键置 NULL 经 `ON UPDATE CASCADE` 会把子行 `memory_session_id`(NOT NULL)一并置 NULL 而直接报错。全部改动**纯 `isWorkerAnchor` 驱动、不读 flag**,在 cm- 锚存在之前均为 no-op。

> ✅ **部署顺序安全(取代旧"原子部署单元"警告,评审 R1-4)**:新顺序 Task 2(守卫)→ Task 3(派发)→ Task 4(加载)保证**每个提交单独可部署**:守卫先行时系统中尚无 cm- 锚,守卫是纯 no-op;Task 3 派发后内存锚仍为 null(SessionManager 尚未加载),SDK 照旧播种自身 id 覆盖 DB 里的 cm- 锚(评审 R11-3 订正:此窗口内 SummaryLane 见 DB 锚非空**可能已写入 summary 子行**,并非"锚下无子行";但 `memory_session_id` 上的 **`ON UPDATE CASCADE`** 会在 SDK 覆盖锚时同步迁移这些子行 FK,故仍安全 —— legacy 等价的保证来自 **CASCADE**,而非子行缺席);Task 4 加载落地时守卫已全部就位。**任意前缀提交序列都安全**,不再依赖"禁止提前 build-and-sync"的软约束(cherry-pick / 中间提交检出同样安全)。

- [ ] **Step 1: 写失败测试**(新建 `tests/worker/sdk-agent-anchor-guards.test.ts`)

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import {
  shouldPersistSDKSessionId,
  shouldResumeSDKSession,
} from "../../src/services/worker/SDKAgent.js";
import { resetSessionAnchorForFreshStart } from "../../src/shared/observer-anchor.js";
import { SessionStore } from "../../src/services/sqlite/SessionStore.js";

describe("shouldPersistSDKSessionId — never overwrite a cm- worker anchor", () => {
  const sdkInit = { type: "system", subtype: "init", session_id: "sdk-real-id" };

  test("cm- anchor is NEVER overwritten by an SDK id", () => {
    expect(shouldPersistSDKSessionId(sdkInit, "cm-stable")).toBe(false);
  });

  test("legacy NULL anchor still adopts the SDK init id (unchanged)", () => {
    expect(shouldPersistSDKSessionId(sdkInit, null)).toBe(true);
  });

  test("legacy SDK-id anchor still updates to a new SDK id (unchanged)", () => {
    expect(shouldPersistSDKSessionId(sdkInit, "old-sdk-id")).toBe(true);
  });

  test("ephemeral hook_* messages still rejected (unchanged)", () => {
    expect(
      shouldPersistSDKSessionId(
        { type: "system", subtype: "hook_started", session_id: "ephemeral" },
        null,
      ),
    ).toBe(false);
  });
});

describe("shouldResumeSDKSession — production function (评审 R1-3: no replica)", () => {
  test("cm- anchor never resumes even on a continuation prompt", () => {
    expect(shouldResumeSDKSession({ memorySessionId: "cm-x", lastPromptNumber: 5 })).toBe(false);
  });

  test("a real SDK-id anchor resumes on a continuation prompt (legacy unchanged)", () => {
    expect(shouldResumeSDKSession({ memorySessionId: "sdk-real", lastPromptNumber: 5 })).toBe(true);
  });

  test("first prompt never resumes regardless of anchor", () => {
    expect(shouldResumeSDKSession({ memorySessionId: "sdk-real", lastPromptNumber: 1 })).toBe(false);
  });

  test("forceInit / proactiveReset still veto resume (legacy unchanged)", () => {
    expect(shouldResumeSDKSession({ memorySessionId: "sdk-real", lastPromptNumber: 5, forceInit: true })).toBe(false);
    expect(shouldResumeSDKSession({ memorySessionId: "sdk-real", lastPromptNumber: 5, proactiveReset: true })).toBe(false);
  });

  test("null anchor never resumes", () => {
    expect(shouldResumeSDKSession({ memorySessionId: null, lastPromptNumber: 5 })).toBe(false);
  });
});

describe("resetSessionAnchorForFreshStart — behavioral, real SessionStore + FK children (评审 R2-1)", () => {
  function makeStoreWithSession(anchor: string) {
    const store = new SessionStore(":memory:"); // real migrations → real schema + FK
    const now = Date.now();
    const sid = store.getDatabase().prepare(
      "INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, memory_session_id) VALUES (?,?,?,?,?,?)"
    ).run(`content-${anchor}`, "proj", "hi", new Date(now).toISOString(), now, anchor).lastInsertRowid as number;
    return { store, sid };
  }

  test("cm- anchor + existing FK child row: DB parent/child and memory untouched, no exception", () => {
    const { store, sid } = makeStoreWithSession("cm-stable");
    const now = Date.now();
    store.getDatabase().prepare(
      "INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch) VALUES (?,?,?,?,?,?)"
    ).run("cm-stable", "proj", "obs body", "discovery", new Date(now).toISOString(), now);

    const session: any = { sessionDbId: sid, memorySessionId: "cm-stable", forceInit: false };
    const cleared = resetSessionAnchorForFreshStart(store, session); // must not throw
    expect(cleared).toBe(false);
    expect(session.memorySessionId).toBe("cm-stable"); // memory anchor preserved
    expect(session.forceInit).toBe(true);              // fresh start still forced
    const parent = store.getDatabase().prepare("SELECT memory_session_id FROM sdk_sessions WHERE id = ?").get(sid) as any;
    expect(parent.memory_session_id).toBe("cm-stable"); // DB anchor preserved
    const child = store.getDatabase().prepare("SELECT memory_session_id FROM observations").get() as any;
    expect(child.memory_session_id).toBe("cm-stable");  // no CASCADE re-point
  });

  test("legacy SDK-id anchor: cleared in DB and memory, forceInit set (unchanged behavior)", () => {
    const { store, sid } = makeStoreWithSession("sdk-stale-id");
    const session: any = { sessionDbId: sid, memorySessionId: "sdk-stale-id", forceInit: false };
    const cleared = resetSessionAnchorForFreshStart(store, session);
    expect(cleared).toBe(true);
    expect(session.memorySessionId).toBeNull();
    expect(session.forceInit).toBe(true);
    const parent = store.getDatabase().prepare("SELECT memory_session_id FROM sdk_sessions WHERE id = ?").get(sid) as any;
    expect(parent.memory_session_id).toBeNull();
  });
});

describe("anchor-clearing sites wired through the tested helper (评审 R1-1/R2-1 wiring assertions)", () => {
  // Behavior is pinned by the real-store tests above; these assertions pin the
  // WIRING: all three production sites must route through the helper, so the
  // behavioral tests actually cover the production paths.
  test("context-overflow site calls resetSessionAnchorForFreshStart", () => {
    const src = readFileSync("src/services/worker/SDKAgent.ts", "utf-8");
    const at = src.indexOf("Context overflow detected");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 1500)).toContain("resetSessionAnchorForFreshStart(");
    // and the raw clear must be gone from the overflow branch:
    expect(src.slice(at, at + 1500)).not.toContain("updateMemorySessionId(session.sessionDbId, null)");
  });

  test("stale-resume sites gate on shouldClearStaleAnchorOnResumeFailure and clear via the helper", () => {
    for (const f of [
      "src/services/worker/http/routes/SessionRoutes.ts",
      "src/services/worker-service.ts",
    ]) {
      const src = readFileSync(f, "utf-8");
      expect(src).toContain("shouldClearStaleAnchorOnResumeFailure(errorMessage, session.memorySessionId)");
      expect(src).toContain("resetSessionAnchorForFreshStart(");
      expect(src).not.toContain("updateMemorySessionId(session.sessionDbId, null)");
    }
  });
});
```

> 既有 `tests/sdk-agent-resume.test.ts` 里的本地 replica `shouldPassResumeParameter` 是历史测试,不承载本计划的安全不变量,不动(YAGNI);本计划的不变量全部由上面的**真函数**测试承载。

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/worker/sdk-agent-anchor-guards.test.ts`
Expected: FAIL —「shouldResumeSDKSession is not a function」(尚未导出)+「cm- anchor is NEVER overwritten」得到 true(当前无守卫)。

- [ ] **Step 3: 实现 SDKAgent**(`SDKAgent.ts`)

顶部 import 区补(与 `:52` `import { shouldProactiveReset } from "./generator-action.js";` 同区):
```typescript
import { isWorkerAnchor, resetSessionAnchorForFreshStart } from "../../shared/observer-anchor.js";
```

**(a) persist 守卫** —— `shouldPersistSDKSessionId`(`:63` 函数体最前,`if (!message.session_id ...)` 判断**之前**加守卫)。

OLD(`:63-65`):
```typescript
  if (!message.session_id || message.session_id === currentMemorySessionId) {
    return false;
  }
```
NEW:
```typescript
  // A cm- worker anchor is stable and must NEVER be overwritten by the SDK's own
  // session id (doing so would re-point observations via ON UPDATE CASCADE and
  // re-open the FK-race the new mode eliminates). Mode-independent guard.
  if (isWorkerAnchor(currentMemorySessionId)) {
    return false;
  }
  if (!message.session_id || message.session_id === currentMemorySessionId) {
    return false;
  }
```

**(b) resume 决策抽取为导出纯函数**(评审 R1-3)。在 `shouldPersistSDKSessionId` 之后(模块层)新增:
```typescript
/** Resume decision for the observer SDK session (extracted for direct testing,
 *  评审 R1-3). A cm- worker anchor is stateless and NEVER resumes, regardless
 *  of mode; the legacy conditions are unchanged. Keep this the ONLY resume
 *  decision point — startSession must call it, never inline the logic. */
export function shouldResumeSDKSession(session: {
  memorySessionId: string | null;
  lastPromptNumber: number;
  forceInit?: boolean;
  proactiveReset?: boolean;
}): boolean {
  return (
    !!session.memorySessionId &&
    session.lastPromptNumber > 1 &&
    !session.forceInit &&
    !session.proactiveReset &&                 // Layer C: proactive reset prevents resume
    !isWorkerAnchor(session.memorySessionId)   // cm- anchor: never resume (mode-independent)
  );
}
```

`startSession` 内替换内联布尔。OLD(`:116-121`):
```typescript
    const hasRealMemorySessionId = !!session.memorySessionId;
    const shouldResume =
      hasRealMemorySessionId &&
      session.lastPromptNumber > 1 &&
      !session.forceInit &&
      !session.proactiveReset;  // Layer C: proactive reset prevents resume
```
NEW:
```typescript
    const hasRealMemorySessionId = !!session.memorySessionId;
    const shouldResume = shouldResumeSDKSession(session);
```
(`hasRealMemorySessionId` 在下方日志与 M1 处仍被使用,保留。)

**(c) M1:同区收敛 INIT-skip 的误导告警**(`:196-207`)。cm- 锚不是 stale、也没"SDK context lost",否则每个 OFF 会话首轮都会喷一条吓人的 WARN。

OLD(`:197`):
```typescript
      const hasStaleMemoryId = hasRealMemorySessionId;
```
NEW:
```typescript
      // A cm- worker anchor is a deliberate stable anchor, NOT a stale SDK id —
      // exclude it so OFF-mode sessions don't emit a spurious "SDK context was lost" WARN.
      const hasStaleMemoryId = hasRealMemorySessionId && !isWorkerAnchor(session.memorySessionId);
```

**(d) D1:守卫拒收时的 debug 踪迹**(评审 NOTE:新模式下 MEMORY_ID_CAPTURED/CHANGED 永不触发,SDK 真实 session id 全程零记录,`OBSERVER_SESSIONS_DIR` 的 transcript 无法回联会话)。在 `:298` `if (shouldPersistSDKSessionId(...)) { ... }` 的**配对闭括号**(块内含 MEMORY_ID_CAPTURED/CHANGED 日志)之后追加 else-if,只在 `system:init` 打、避免刷屏:

```typescript
        } else if (
          isWorkerAnchor(session.memorySessionId) &&
          message.session_id &&
          message.type === "system" &&
          (message as { subtype?: string }).subtype === "init"
        ) {
          // cm- anchor kept: record the SDK's own id at debug for transcript correlation.
          logger.debug("SDK", `SDK id observed, stable worker anchor kept | sessionDbId=${session.sessionDbId} | sdkSessionId=${message.session_id} | anchor=${session.memorySessionId}`);
        }
```

**(e) overflow 清锚站点守卫**(`:356-376`,评审 R1-1 ④)。OLD:
```typescript
            this.dbManager
              .getSessionStore(session.dbPath)
              .updateMemorySessionId(session.sessionDbId, null);
            session.memorySessionId = null;
            session.forceInit = true;
            session.abortController.abort();
            return;
```
NEW(评审 R2-1:改走 Task 1 的唯一清锚辅助函数,行为由真实 SessionStore 测试钉住):
```typescript
            // Route through THE production clear helper (评审 R2-1). Legacy SDK-id
            // anchor: resuming it would overflow forever — helper nulls it (#2088).
            // A cm- worker anchor is kept (评审 R1-1): it is never resumed, so the
            // poisoned SDK context cannot recur through it, and clearing it would
            // orphan the FK anchor bypass/observer store under (CASCADE would even
            // NULL child rows' NOT NULL column). forceInit is set inside the helper
            // either way, so the next spawn is a fresh subprocess.
            resetSessionAnchorForFreshStart(
              this.dbManager.getSessionStore(session.dbPath),
              session,
            );
            session.abortController.abort();
            return;
```

- [ ] **Step 4: 实现两处 stale-resume 清锚站点**(评审 R1-1 ⑤⑥ + R2-1:守卫改用 `shouldClearStaleAnchorOnResumeFailure`,清锚体改走 `resetSessionAnchorForFreshStart` —— 与 overflow 站点共用同一条被真实-store 测试钉住的路径)

`src/services/worker/http/routes/SessionRoutes.ts` —— import 区补:
```typescript
import { shouldClearStaleAnchorOnResumeFailure, resetSessionAnchorForFreshStart } from '../../../../shared/observer-anchor.js';
```
OLD(`:275-287`):
```typescript
        // Stale-resume detection (symmetric with WorkerService .catch())
        const errorMessage = error instanceof Error ? error.message : String(error);
        if ((errorMessage.includes('aborted by user') || errorMessage.includes('No conversation found'))
            && session.memorySessionId) {
          logger.warn('SESSION', 'Stale resume detected, forcing fresh init', {
            sessionDbId: session.sessionDbId, staleMemorySessionId: session.memorySessionId,
          });
          try {
            this.dbManager.getSessionStore(session.dbPath).updateMemorySessionId(session.sessionDbId, null);
          } catch {} // Best-effort DB update
          session.memorySessionId = null;
          session.forceInit = true;
        }
```
NEW:
```typescript
        // Stale-resume detection (symmetric with WorkerService .catch())
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (shouldClearStaleAnchorOnResumeFailure(errorMessage, session.memorySessionId)) {
          logger.warn('SESSION', 'Stale resume detected, forcing fresh init', {
            sessionDbId: session.sessionDbId, staleMemorySessionId: session.memorySessionId,
          });
          try {
            // Guard is true → anchor is a clearable legacy SDK id → helper clears it
            // (DB + memory) and sets forceInit (评审 R2-1: single choke point).
            resetSessionAnchorForFreshStart(this.dbManager.getSessionStore(session.dbPath), session);
          } catch {} // Best-effort DB update — on failure the anchor stays consistent (kept in both DB and memory); forceInit is already set by the helper
        }
```

`src/services/worker-service.ts` —— import 区补(评审 R3-2:该文件在 `src/services/` 下,相对路径是 `../shared/`,与文件内既有 `../shared/` import 同风格):
```typescript
import { shouldClearStaleAnchorOnResumeFailure, resetSessionAnchorForFreshStart } from '../shared/observer-anchor.js';
```

OLD(`:793-805`):
```typescript
        // Detect stale resume failures - SDK session context was lost
        if ((errorMessage.includes('aborted by user') || errorMessage.includes('No conversation found'))
            && session.memorySessionId) {
          logger.warn('SDK', 'Detected stale resume failure, clearing memorySessionId for fresh start', {
            sessionId: session.sessionDbId,
            memorySessionId: session.memorySessionId,
            errorMessage
          });
          // Clear stale memorySessionId and force fresh init on next attempt
          this.dbManager.getSessionStore(session.dbPath).updateMemorySessionId(session.sessionDbId, null);
          session.memorySessionId = null;
          session.forceInit = true;
        }
```
NEW:
```typescript
        // Detect stale resume failures - SDK session context was lost
        if (shouldClearStaleAnchorOnResumeFailure(errorMessage, session.memorySessionId)) {
          logger.warn('SDK', 'Detected stale resume failure, clearing memorySessionId for fresh start', {
            sessionId: session.sessionDbId,
            memorySessionId: session.memorySessionId,
            errorMessage
          });
          // Clear stale memorySessionId and force fresh init on next attempt
          // (评审 R2-1: routed through the single production clear helper).
          resetSessionAnchorForFreshStart(this.dbManager.getSessionStore(session.dbPath), session);
        }
```
(两处 WARN 日志文本保持不动;守卫为 false 时整块跳过,cm- 锚保留。**已接受的微小行为差**:SessionRoutes 的 best-effort 分支里,若 DB 更新抛异常,旧代码仍会把内存锚清空(DB/内存失步);新代码经 helper 先写 DB、成功后才清内存,失败时两侧一致保留 —— 更安全,且两种情形下 forceInit 均已置位、下一次启动都不 resume,最终由 SDK 播种新 id 收敛,行为等价。)

- [ ] **Step 4b: 更新既有 overflow wiring 测试**(评审 R3-1 + R4-1:该 describe 的**两个**源码断言都被 Step 3(e) **必然**打破 —— `session.forceInit = true;` 在 SDKAgent 中唯一出现点就是被 helper 取代的 overflow 分支 `:373`,raw clear 同理)

OLD(`tests/worker/context-overflow-reset.test.ts:36-47`,整个 describe):
```typescript
describe('context-overflow reset wiring (source)', () => {
  const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/SDKAgent.ts'), 'utf-8');
  it('forces a fresh start in the context-overflow branch', () => {
    expect(SRC).toContain('session.forceInit = true;');
  });
  it('nulls memorySessionId in the DB on overflow', () => {
    // shape-insensitive: collapse whitespace before matching the multi-line call.
    const flat = SRC.replace(/\s+/g, '');
    expect(flat).toContain('.updateMemorySessionId(session.sessionDbId,null)'.replace(/\s+/g, ''));
  });
});
```
NEW:
```typescript
describe('context-overflow reset wiring (source)', () => {
  const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/SDKAgent.ts'), 'utf-8');
  it('routes the overflow fresh-start through resetSessionAnchorForFreshStart', () => {
    // forceInit + the conditional anchor clear both live inside the helper now
    // (评审 R2-1/R4-1): the overflow branch must call it, and the raw null-clear
    // must be gone from SDKAgent entirely.
    const flat = SRC.replace(/\s+/g, '');
    expect(flat).toContain('resetSessionAnchorForFreshStart(');
    expect(flat).not.toContain('.updateMemorySessionId(session.sessionDbId,null)');
  });
});
```
(同文件上方的纯对象用例设置 `forceInit`/`memorySessionId=null`,不受影响,不动。行为本身 —— forceInit 置位、cm- 保留、legacy 清空 —— 由 `sdk-agent-anchor-guards.test.ts` 的真实-store 行为测试钉住,源码断言只负责 wiring。)

- [ ] **Step 5: 运行确认通过**

Run: `bun test tests/worker/sdk-agent-anchor-guards.test.ts tests/worker/context-overflow-reset.test.ts && bun test tests/shared/observer-anchor.test.ts`
Expected: PASS。

- [ ] **Step 6: grep 回归检查**

Run: `grep -rn "shouldPersistSDKSessionId\|shouldResumeSDKSession\|shouldClearStaleAnchorOnResumeFailure\|resetSessionAnchorForFreshStart\|updateMemorySessionId" src/ tests/ --include=*.ts | grep -v node_modules`
Expected(评审 R2-1):`src/` 中裸调 `updateMemorySessionId(session.sessionDbId, null)` 为 **0 处** —— 三个站点(SDKAgent overflow / SessionRoutes / worker-service)全部改经 `resetSessionAnchorForFreshStart`,清 NULL 的运行时路径只剩 observer-anchor.ts 内那一行(SDK-id 覆盖写入 `ensureMemorySessionIdRegistered` 不在此列,行为不变);`shouldResumeSDKSession` 生产调用点仅 `startSession`;无其他调用方假设旧返回语义。

- [ ] **Step 7: 全量 + 提交**

Run: `bun test ./tests/`
Expected: 无新增失败(对照基线,见测试约定;此时尚无任何 cm- 锚产生,全部守卫为 no-op)。
```bash
git add src/services/worker/SDKAgent.ts src/services/worker/http/routes/SessionRoutes.ts src/services/worker-service.ts tests/worker/sdk-agent-anchor-guards.test.ts tests/worker/context-overflow-reset.test.ts
git commit -m "feat(observer): cm- anchor guards — never resume, never overwrite, never clear (safe no-op before anchors exist)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 2: 派发与加载(Task 3–4)

### Task 3: 会话建行时派发 `cm-` 锚

**Files:**
- Modify: `src/services/sqlite/SessionStore.ts:669-677`(`createSDKSession` 的 INSERT 块)
- Test: `tests/sqlite/create-sdk-session-anchor.test.ts`(新)
- Test: `tests/session_id_usage_validation.test.ts`(改,评审 R3-1:Resume Safety 用例断言建行锚为 NULL 且"非 NULL 即可 resume" —— 新模式下**必然**失败,改为模式无关断言)
- Test: `tests/fk-constraint-fix.test.ts`(改,评审 R3-1:建行 NULL 断言**必然**失败,改为 `null || isWorkerAnchor`;后续 `ensureMemorySessionIdRegistered` 直调不受影响 —— 该 store 方法对不同值无条件覆盖,`SessionStore.ts:84-87`,守卫只在 SDKAgent 层)
- Test: `tests/worker/summary-lane.test.ts`(改,评审 R9-1:`skip path` 用例(`:256-297`)靠 `createSDKSession()` 落 **NULL** 锚来触发 SummaryLane 的 skip 分支(`SummaryLane.ts:259` `if (!sessionRow || !sessionRow.memory_session_id)`)。默认 OFF 后建行改吐 `cm-` 锚 → skip 不再触发 → `counters.skipped >= 1`、`broadcasts.length === 0`、`session_summaries` 空这三条断言**必然**失败(且该用例当前 PASS、不在 70 行基线内)。修复:建行后显式 `store.updateMemorySessionId(sessionDbId, null)` 还原 skip 前提。同文件 `seedSession`(`:138`)建行后即 `ensureMemorySessionIdRegistered(…, 'mem-abc')` 覆盖,success-path / drain-timeout 用例不受影响)

**背景(已核实)**:`createSDKSession`(`SessionStore.ts:642`,构造签名 `constructor(dbPath: string = DB_PATH)` —— 接收路径字符串、自开连接;`:memory:` 会跑真迁移建出真实 `sdk_sessions` 表,`getDatabase()` 取底层句柄)是运行时唯一活跃的建行入口(所有路由 `SessionRoutes.ts:861/930/1049/1110` 调它),且**幂等**(按 content_session_id 查重,存在即返回)。当前 INSERT 硬编码 `memory_session_id = NULL`(`VALUES (?, NULL, ?, ...)` 那行)。`src/services/sqlite/sessions/create.ts` 里另有一个 db-first 的独立函数 `createSDKSession(db, …)`(与本 store 方法同名的函数式变体,经 `Sessions.ts:11` `export *` re-export;评审 R9-2 事实订正:先前误记为 `createSession`,`src/` 内并无该名函数),但运行时路由不走它、经核实无生产调用方 —— 本计划不动它(YAGNI;如未来它上热路径需同样处理)。

- [ ] **Step 1: 写失败测试**(新建 `tests/sqlite/create-sdk-session-anchor.test.ts`)

> 用仓库通行的 SessionStore 夹具 `new SessionStore(':memory:')`(跑真迁移、建真实 `sdk_sessions` 表)。默认(OFF)分支断言锚是 `cm-` 前缀;**ON(legacy)分支同样在此验集成落库为 NULL**(评审 R1-6:回退路径不能只靠 Task 1 的 `mintInitialAnchor` 单测)。
> **Hermeticity(评审 C2 + R1-6 + R2-2 + R11-2 deep)**:建行的 flag 读取走 `observer-anchor.ts` 的**非创建式** `readObserverResumeFlag()`(env > settings.json 只读[flat/legacy `{env:{…}}`] > 默认 `false`;**不调 `SettingsDefaultsManager.loadFromFile`**,故不创建/改写文件、无 5s TTL)。但 `SettingsDefaultsManager` 仍被 15+ 测试 `mock.module`,且机器 settings.json / 真实 `~/.claude-mem` 会干扰进程内断言,故 flag 敏感用例仍**各自 spawn 一个干净 bun 子进程**:子进程无 `mock.module`、`CLAUDE_MEM_DATA_DIR` 指向一次性临时目录(绝不碰真实目录),flag 由 `spawnSync` env 或临时 settings.json 显式注入,对父进程零污染、也不受父进程污染。**幂等性用例已并入子进程 probe(不再在进程内建行,评审 R11-2)**;probe 参数化覆盖 env 覆盖、settings.json 读取(flat/legacy)、env 压过文件、以及"文件缺失→默认且不创建"各分支(评审 R13-2)。

```typescript
import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isWorkerAnchor } from "../../src/shared/observer-anchor.js";
import { SessionStore } from "../../src/services/sqlite/SessionStore.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

// Each probe runs createSDKSession in a FRESH bun subprocess — the only way to
// test the birth-time flag read hermetically: immune to the cross-file
// mock.module leakage that pollutes the parent test process, with the flag /
// DATA_DIR pinned deterministically via the subprocess env (评审 R2-2).
//
// NOTE (评审 R11-2 deep): session birth reads the flag via observer-anchor's own
// NON-CREATING read (env > settings.json READ-ONLY > default) — it does NOT call
// SettingsDefaultsManager.loadFromFile, so it never creates or rewrites a
// settings file. The throwaway CLAUDE_MEM_DATA_DIR below is therefore pure
// isolation (never touch the real ~/.claude-mem), not a workaround for
// loadFromFile's creation side effect. A sentinel prefix isolates the probe's
// JSON from any incidental stdout.
const SENTINEL = "CM_PROBE_JSON:";
const PROBE = `
const { SessionStore } = await import(process.env.REPO_ROOT + "/src/services/sqlite/SessionStore.js");
const store = new SessionStore(":memory:"); // runs real migrations → real sdk_sessions
const id1 = store.createSDKSession("content-sub", "proj", "hi");
const a1 = store.getDatabase().prepare("SELECT memory_session_id AS m FROM sdk_sessions WHERE id = ?").get(id1).m;
const id2 = store.createSDKSession("content-sub", "proj", "hi");
const a2 = store.getDatabase().prepare("SELECT memory_session_id AS m FROM sdk_sessions WHERE id = ?").get(id2).m;
console.log("${SENTINEL}" + JSON.stringify({ id1, id2, a1, a2 }));
`;

interface ProbeResult {
  id1: number; id2: number; a1: string | null; a2: string | null;
  settingsCreated: boolean; // did the birth read create <dataDir>/settings.json?
}

// Run the birth probe in a subprocess against a throwaway DATA_DIR.
//   flagEnv:      value for CLAUDE_MEM_OBSERVER_RESUME env (omit = unset → file/default branch)
//   settingsFile: if given, pre-write <dataDir>/settings.json with this content
//                 (exercises the settings.json read branch — the manual-toggle production path)
function probe(opts: { flagEnv?: string; settingsFile?: string } = {}): ProbeResult {
  const dataDir = mkdtempSync(join(tmpdir(), "cm-anchor-probe-"));
  if (opts.settingsFile !== undefined) {
    writeFileSync(join(dataDir, "settings.json"), opts.settingsFile, "utf-8");
  }
  const env: Record<string, string> = { ...process.env, REPO_ROOT, CLAUDE_MEM_DATA_DIR: dataDir };
  delete env.CLAUDE_MEM_OBSERVER_RESUME; // start unset; only set when flagEnv is given
  if (opts.flagEnv !== undefined) env.CLAUDE_MEM_OBSERVER_RESUME = opts.flagEnv;
  try {
    const res = spawnSync({ cmd: [process.execPath, "-e", PROBE], env, stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) throw new Error(`anchor probe failed: ${res.stderr.toString()}`);
    const line = res.stdout.toString().split("\n").find((l) => l.startsWith(SENTINEL));
    if (!line) throw new Error(`anchor probe: no ${SENTINEL} line in stdout: ${res.stdout.toString()}`);
    const parsed = JSON.parse(line.slice(SENTINEL.length));
    // Read existence BEFORE the finally cleanup deletes the dir.
    const settingsCreated = existsSync(join(dataDir, "settings.json"));
    return { ...parsed, settingsCreated };
  } finally {
    rmSync(dataDir, { recursive: true, force: true }); // hygiene: mkdtemp ↔ rmSync
  }
}

describe("createSDKSession anchor minting (subprocess-hermetic, 评审 R2-2 / R11-2 / R13-2)", () => {
  // --- env-var branch (highest precedence) ---
  test("new mode (env flag=false): new row gets a cm- worker anchor", () => {
    expect(isWorkerAnchor(probe({ flagEnv: "false" }).a1)).toBe(true);
  });

  test("legacy (env flag=true): new row keeps NULL anchor — SDK will seed (评审 R1-6)", () => {
    expect(probe({ flagEnv: "true" }).a1).toBeNull();
  });

  // --- settings.json branch (评审 R13-2: the real manual-toggle production path) ---
  test("settings.json flat 'true' (no env) → legacy NULL anchor", () => {
    const r = probe({ settingsFile: JSON.stringify({ CLAUDE_MEM_OBSERVER_RESUME: "true" }) });
    expect(r.a1).toBeNull();
  });

  test("settings.json legacy nested { env: { …'true' } } (no env) → legacy NULL anchor", () => {
    const r = probe({ settingsFile: JSON.stringify({ env: { CLAUDE_MEM_OBSERVER_RESUME: "true" } }) });
    expect(r.a1).toBeNull();
  });

  test("settings.json 'false' (no env) → new-mode cm- anchor", () => {
    const r = probe({ settingsFile: JSON.stringify({ CLAUDE_MEM_OBSERVER_RESUME: "false" }) });
    expect(isWorkerAnchor(r.a1)).toBe(true);
  });

  test("env var outranks settings.json (env 'true' beats file 'false') → NULL", () => {
    const r = probe({ flagEnv: "true", settingsFile: JSON.stringify({ CLAUDE_MEM_OBSERVER_RESUME: "false" }) });
    expect(r.a1).toBeNull();
  });

  // --- idempotency (folded into the hermetic probe, 评审 R11-2: it already calls
  //     createSDKSession TWICE, so no in-process call that would hit the settings read) ---
  test("idempotent: second call returns same id, anchor unchanged", () => {
    const r = probe({ flagEnv: "false" });
    expect(r.id2).toBe(r.id1);
    expect(r.a2).toBe(r.a1);
    expect(isWorkerAnchor(r.a1)).toBe(true);
  });

  // --- non-creating guarantee (评审 R11-2 deep / R13): the crux of the 15-caller fix ---
  test("non-creating read: missing settings.json is NOT created at session birth", () => {
    // Empty temp DATA_DIR + no env + no seed → the "file missing → default(false)"
    // branch. Birth mints a cm- anchor AND must not create <dataDir>/settings.json
    // (guards real ~/.claude-mem across the 15 in-process store.createSDKSession callers).
    const r = probe({});
    expect(isWorkerAnchor(r.a1)).toBe(true);
    expect(r.settingsCreated).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/sqlite/create-sdk-session-anchor.test.ts`
Expected: FAIL —「isWorkerAnchor(null)」得到 false(当前建行是 NULL)。

- [ ] **Step 3: 实现**(`SessionStore.ts`)

顶部 import 区补(与文件既有 import 同风格):
```typescript
import { mintInitialAnchor } from "../../shared/observer-anchor.js";
```

替换 `createSDKSession` 的新行 INSERT 块。

OLD(`:668-676` 附近):
```typescript
    // New session - insert fresh row
    // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
    // response and stored via ensureMemorySessionIdRegistered(). CRITICAL: memory_session_id
    // must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!
    this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, project, userPrompt, customTitle || null, now.toISOString(), nowEpoch);
```
NEW:
```typescript
    // New session - insert fresh row.
    // Legacy (resume ON): memory_session_id starts NULL; SDKAgent captures the SDK's
    //   own id from system:init and stores it via ensureMemorySessionIdRegistered().
    // New mode (resume OFF): mint a stable "cm-<uuid>" anchor NOW so bypass can store
    //   observations without waiting for an SDK seed. The switch is read here ONLY;
    //   all downstream behavior keys off isWorkerAnchor(memory_session_id).
    // CRITICAL: memory_session_id must NEVER equal contentSessionId — that would inject
    //   memory messages into the user's transcript (cm- prefix guarantees inequality).
    const initialAnchor = mintInitialAnchor();
    this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, initialAnchor, project, userPrompt, customTitle || null, now.toISOString(), nowEpoch);
```

- [ ] **Step 3b: 更新两个必然失败的既有测试**(评审 R3-1 —— 均改为模式无关断言,保留原测试意图)

`tests/session_id_usage_validation.test.ts` —— import 区补:
```typescript
import { isWorkerAnchor } from '../src/shared/observer-anchor.js';
import { shouldResumeSDKSession } from '../src/services/worker/SDKAgent.js';
```
OLD(`:79-95` Resume Safety 用例):
```typescript
    it('should prevent resume when memorySessionId is NULL (not yet captured)', () => {
      const contentSessionId = 'new-session-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'First prompt');

      const session = store.getSessionById(sessionDbId);

      // CRITICAL: Before SDK returns real session ID, memory_session_id must be NULL
      expect(session?.memory_session_id).toBeNull();

      // hasRealMemorySessionId check: only resume when non-NULL
      const hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(false);

      // Resume options should be empty (no resume parameter)
      const resumeOptions = hasRealMemorySessionId ? { resume: session?.memory_session_id } : {};
      expect(resumeOptions).toEqual({});
    });
```
NEW(模式无关:legacy 建行是 NULL、新模式是 cm- 锚,两者都**永不**是可 resume 的 raw SDK id):
```typescript
    it('creation-time anchor is never resumable (NULL in legacy, cm- worker anchor in new mode)', () => {
      const contentSessionId = 'new-session-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'First prompt');

      const session = store.getSessionById(sessionDbId);
      const anchor = session?.memory_session_id ?? null;

      // Mode-agnostic invariant: a freshly created row NEVER holds a raw SDK id —
      // it is NULL (legacy: SDK seeds later) or a cm- worker anchor (new mode).
      expect(anchor === null || isWorkerAnchor(anchor)).toBe(true);

      // Resume safety, via the REAL production decision function: whatever the
      // mode, the creation-time anchor must not resume (even past prompt #1).
      expect(shouldResumeSDKSession({ memorySessionId: anchor, lastPromptNumber: 2 })).toBe(false);
    });
```

`tests/fk-constraint-fix.test.ts` —— import 区补:
```typescript
import { isWorkerAnchor } from '../src/shared/observer-anchor.js';
```
OLD(`:37-42` 附近):
```typescript
    // Create session with NULL memory_session_id (simulates initial creation)
    const sessionDbId = store.createSDKSession('test-content-id', 'test-project', 'test prompt');

    // Verify memory_session_id starts as NULL
    const beforeSession = store.getSessionById(sessionDbId);
    expect(beforeSession?.memory_session_id).toBeNull();
```
NEW:
```typescript
    // Create session (initial creation: NULL anchor in legacy, cm- worker anchor in new mode)
    const sessionDbId = store.createSDKSession('test-content-id', 'test-project', 'test prompt');

    // Verify the row never starts with a raw SDK id (mode-agnostic)
    const beforeSession = store.getSessionById(sessionDbId);
    const before = beforeSession?.memory_session_id ?? null;
    expect(before === null || isWorkerAnchor(before)).toBe(true);
```
(其余流程不动:`ensureMemorySessionIdRegistered` 是 store 层直调,对不同值无条件覆盖(`SessionStore.ts:84-87`),cm- 锚在该层可被覆盖是**预期行为** —— 不覆盖守卫在 SDKAgent 层(Task 2),此测试验证的正是 store 层 FK 注册语义。)

`tests/session_id_usage_validation.test.ts` 还有**另外两个**必然失败的建行-NULL 断言(评审 R4-1:`:105`、`:151`、`:156`),同样改模式无关、保留原意图:

OLD(`:97-105` 附近,'should allow resume only after memorySessionId is captured' 用例开头):
```typescript
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt');

      // Before capture
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();
```
NEW:
```typescript
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt');

      // Before capture: never a raw SDK id (NULL in legacy, cm- worker anchor in new mode)
      let session = store.getSessionById(sessionDbId);
      const preCapture = session?.memory_session_id ?? null;
      expect(preCapture === null || isWorkerAnchor(preCapture)).toBe(true);
```
(该用例其余部分不动:`updateMemorySessionId` 直调是 store 层写入,capture 后的断言与模式无关。)

OLD(`:143-157` 附近,'should NOT reset memorySessionId when it is still NULL (first prompt scenario)' 用例):
```typescript
    it('should NOT reset memorySessionId when it is still NULL (first prompt scenario)', () => {
      // When memory_session_id is NULL, createSDKSession should NOT reset it
      // This is the normal first-prompt scenario where SDKAgent hasn't captured the ID yet
      const contentSessionId = 'new-session';

      // First createSDKSession - creates row with NULL memory_session_id
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 1');
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();

      // Second createSDKSession (before SDK has returned) - should still be NULL, no reset needed
      store.createSDKSession(contentSessionId, 'test-project', 'Prompt 2');
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();
    });
```
NEW(意图不变:createSDKSession 是纯 get-or-create,**永不重置**已有锚):
```typescript
    it('should NOT reset the creation-time anchor on repeat calls (first prompt scenario)', () => {
      // Before SDK capture the anchor is NULL (legacy) or a cm- worker anchor
      // (new mode) — either way createSDKSession must never reset or remint it.
      const contentSessionId = 'new-session';

      // First createSDKSession - creates row with the mode's initial anchor
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 1');
      let session = store.getSessionById(sessionDbId);
      const initialAnchor = session?.memory_session_id ?? null;
      expect(initialAnchor === null || isWorkerAnchor(initialAnchor)).toBe(true);

      // Second createSDKSession (before SDK has returned) - anchor unchanged, no reset/remint
      store.createSDKSession(contentSessionId, 'test-project', 'Prompt 2');
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id ?? null).toBe(initialAnchor);
    });
```
> 相对路径注意:上面这两个测试文件在 `tests/` 根(非子目录),故 import 前缀是 `../src/...` 而非 `../../src/...`。

- [ ] **Step 3c: 修复 `tests/worker/summary-lane.test.ts` 的 skip-path 用例**(评审 R9-1 —— 建行改吐 `cm-` 锚后 skip 分支不再触发,显式落 NULL 还原前提;无需新增 import,`updateMemorySessionId` 已在 store 实例上)

OLD(`:260-262`,`skip path` 用例开头):
```typescript
    const contentSessionId = 'content-no-mem';
    const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'p');
    // memory_session_id remains NULL.
```
NEW(模式无关:无论建行吐 NULL(legacy)还是 `cm-` 锚(new),都强制归 NULL 以命中"无 memory_session_id → skip"分支):
```typescript
    const contentSessionId = 'content-no-mem';
    const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'p');
    // New mode mints a cm- anchor at creation; force NULL to exercise the
    // "no memory_session_id" skip branch this test targets (mode-agnostic).
    store.updateMemorySessionId(sessionDbId, null);
```
(同文件 `seedSession` 建行后即 `ensureMemorySessionIdRegistered(…, 'mem-abc')`,`success path` / `drain timeout` 用例的锚被显式覆盖,不受影响 —— 无需改动。)

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/sqlite/create-sdk-session-anchor.test.ts tests/session_id_usage_validation.test.ts tests/fk-constraint-fix.test.ts tests/worker/summary-lane.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量 + 提交**

Run: `bun test ./tests/`
Expected: 无新增失败(对照基线,见测试约定)。
```bash
git add src/services/sqlite/SessionStore.ts tests/sqlite/create-sdk-session-anchor.test.ts tests/session_id_usage_validation.test.ts tests/fk-constraint-fix.test.ts tests/worker/summary-lane.test.ts
git commit -m "feat(observer): mint cm- worker anchor at session creation in new mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `SessionManager` 加载 `cm-` 锚回内存(致命点)

**Files:**
- Modify: `src/services/worker/SessionManager.ts:256`(`initializeSession` 里 `memorySessionId: null` 那行;`:248-253` 是其上方的 #817 注释块)
- Test: `tests/worker/session-manager-anchor-load.test.ts`(新)

**背景(已核实,关键架构事实 #3)**:`initializeSession` 恒置 `memorySessionId: null`(Issue #817 防 stale SDK-id resume 崩溃)。新模式必须让 `cm-` 锚被加载回内存,否则 bypass gate(`BypassLane.ts:570`)与 observer 存储断言(`ResponseProcessor.ts:155`)都因 null 失败。`cm-` 锚永不被 resume、永不被覆盖、永不被清空(Task 2 守卫,已先行部署),故加载它不会触发 #817 的崩溃;SDK-id 锚仍置 null(行为不变)。**此改动纯 `isWorkerAnchor` 驱动,不读 flag。** 同函数内还有两处以"恒丢弃"为前提的日志需同步修正:上方 `:221-228` 的 #817 WARN(L2)与下方 `:282` 附近的 debug 元数据(L1)。

- [ ] **Step 1: 写失败测试**(新建 `tests/worker/session-manager-anchor-load.test.ts`)

> 纯逻辑夹具:直接验证"给定 DB 锚 → 内存初值"的决策函数语义。若 `initializeSession` 难以隔离构造(它依赖 dbManager),则抽取一个纯 helper `resolveInitialInMemoryAnchor(dbMemorySessionId)` 到 SessionManager 并测它,`initializeSession` 调用之。以下测试针对该 helper。

```typescript
import { describe, test, expect } from "bun:test";
import { resolveInitialInMemoryAnchor } from "../../src/services/worker/SessionManager.js";

describe("resolveInitialInMemoryAnchor (Issue #817 + cm- anchor load)", () => {
  test("loads a cm- worker anchor from DB (stable, needed by bypass)", () => {
    expect(resolveInitialInMemoryAnchor("cm-1234")).toBe("cm-1234");
  });

  test("nulls a real SDK-id anchor (stale-resume prevention, unchanged)", () => {
    expect(resolveInitialInMemoryAnchor("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
  });

  test("nulls when DB has no anchor", () => {
    expect(resolveInitialInMemoryAnchor(null)).toBeNull();
    expect(resolveInitialInMemoryAnchor(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/worker/session-manager-anchor-load.test.ts`
Expected: FAIL —「resolveInitialInMemoryAnchor is not a function」。

- [ ] **Step 3: 实现**(`SessionManager.ts`)

顶部 import 区补:
```typescript
import { isWorkerAnchor } from "../../shared/observer-anchor.js";
```

在 `SessionManager` 类**之外**(模块层,文件顶部 import 之后)新增导出纯函数:
```typescript
/**
 * Decide the in-memory memory_session_id when (re)initializing a session.
 * - cm- worker anchor  → load it (stable, never resumed; bypass/observer store under it).
 * - real SDK-id / null → null (Issue #817: stale SDK id would crash on resume).
 */
export function resolveInitialInMemoryAnchor(
  dbMemorySessionId: string | null | undefined,
): string | null {
  return isWorkerAnchor(dbMemorySessionId) ? (dbMemorySessionId as string) : null;
}
```

在 `initializeSession` 里替换那行(`:256`)。

OLD:
```typescript
      memorySessionId: null,  // Always start fresh - SDK will capture new ID
```
NEW:
```typescript
      // cm- worker anchor is loaded back (stable, never resumed → immune to Issue #817);
      // a real SDK-id anchor is still nulled to prevent "No conversation found" on resume.
      memorySessionId: resolveInitialInMemoryAnchor(dbSession.memory_session_id),
```

**L1:同区修下方 `:282` 附近失真的 debug 元数据**(现固定打 "(cleared...)",但 cm- 锚是被加载的)。

OLD(`:282` 附近,debug 元数据对象内):
```typescript
      memorySessionId: '(cleared - will capture fresh from SDK)',
```
NEW:
```typescript
      memorySessionId: session.memorySessionId
        ? `(loaded stable anchor ${session.memorySessionId})`
        : '(cleared - will capture fresh from SDK)',
```

**L2:同区修上方 `:221-228` 的 #817 WARN**。现条件是 `if (dbSession.memory_session_id)` 就喷 "Discarding stale memory_session_id",但新模式下 cm- 锚是**被加载而非丢弃** —— 不修则每次 re-init 都发一条内容为假的 WARNING(级别滥用)。只改 if 条件 + 注释,WARN 体不动:

OLD(`:221-222`):
```typescript
    // Log warning if we're discarding a stale memory_session_id (Issue #817)
    if (dbSession.memory_session_id) {
```
NEW:
```typescript
    // Log warning if we're discarding a stale memory_session_id (Issue #817).
    // A cm- worker anchor is NOT stale — it is loaded back below (new mode),
    // so only warn when a real SDK-id anchor is actually being discarded.
    if (dbSession.memory_session_id && !isWorkerAnchor(dbSession.memory_session_id)) {
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/worker/session-manager-anchor-load.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量 + 提交**

Run: `bun test ./tests/`
Expected: 无新增失败(对照基线,见测试约定。注意 #817 相关既有测试:它们用真实 SDK-id/null 锚,`resolveInitialInMemoryAnchor` 对它们仍返回 null,行为不变;若有测试直接断言"init 后 memorySessionId 恒 null",需按语义更新为"仅非 cm- 锚为 null")。
```bash
git add src/services/worker/SessionManager.ts tests/worker/session-manager-anchor-load.test.ts
git commit -m "fix(observer): load cm- worker anchor into memory so bypass isn't gated (was Issue #817 blanket null)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 3: 验收基建 + 数值调优(Task 5–6)

### Task 5: 每条 OB 入库打 `lane=` 内联日志(验收度量 + 死信可见性)

**Files:**
- Modify: `src/services/worker/agents/ResponseProcessor.ts:214`(SDK 侧 STORED 行)、`src/services/worker/BypassLane.ts:604`(bypass 侧成功行)、`BypassLane.ts:656/:808`(`processObservation` 返回 obsCount)、`BypassLane.ts:617-622`(失败分支死信化,Q3)
- Test: `tests/worker/lane-attribution-log.test.ts`(新,源码断言)

**背景(已核实,含 F5.1 logger 约束)**:两侧入库日志格式不一 —— SDK 是 `logger.info('DB', 'STORED | ...')`(内联 message,任何级别可见),bypass 是 `logger.info("BYPASS", "Observation processed", {metadata})`(细节埋 metadata,INFO 级 >3 键不渲染)。故 `lane=` **必须放进 message 字符串**(不是 metadata)。验收命令见 Task 6 Step 4(obsCount 求和的 awk)。**粒度(评审 C1,已修正)**:两侧单位不同 —— SDK 一行 = 一次响应(覆盖至多 batch 条消息),bypass 一行 = 一条消息;**行数直接对比会偏向 bypass 至多 ~batch 倍**(batch=2 时,行占比 75% 可能只对应真实观测占比 60%)。故两侧 message 字符串都带 `obsCount`,验收按 **obsCount 求和**计占比(Task 6 Step 4 的 awk 命令);阈值 60% 维持(batch=2 / C=4 的期望 ≈2/3,留有余量)。另含 Q3 死信可见性:bypass 失败分支消费 `markFailed` 返回值,killing blow 打 `DEAD_LETTER` 而非撒谎的 "marking for retry"。

- [ ] **Step 1: 写失败测试**(新建 `tests/worker/lane-attribution-log.test.ts`)

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

describe("per-lane store attribution log tags (inline in message, F5.1-safe)", () => {
  test("SDK store log carries inline lane=sdk", () => {
    const src = readFileSync("src/services/worker/agents/ResponseProcessor.ts", "utf-8");
    expect(src).toContain("lane=sdk");
    expect(src).toMatch(/STORED \| lane=sdk/);
  });

  test("bypass success log carries inline lane=bypass + obsCount in the message string", () => {
    const src = readFileSync("src/services/worker/BypassLane.ts", "utf-8");
    expect(src).toMatch(/STORED \| lane=bypass/);
    expect(src).toMatch(/lane=bypass[^`]*obsCount=/);
  });

  test("bypass dead-letter drop is visible (Q3): DEAD_LETTER branch on finalStatus=failed", () => {
    const src = readFileSync("src/services/worker/BypassLane.ts", "utf-8");
    expect(src).toContain("DEAD_LETTER");
    expect(src).toContain('finalStatus === "failed"');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/worker/lane-attribution-log.test.ts`
Expected: FAIL — 两侧源码尚无 `lane=` 标记。

- [ ] **Step 3a: 实现 SDK 侧**(`ResponseProcessor.ts:214`)

OLD:
```typescript
  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
```
NEW:
```typescript
  logger.info('DB', `STORED | lane=sdk | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
```

- [ ] **Step 3b: 实现 bypass 侧**(`BypassLane.ts`,三处联动:`processObservation` 返回 obsCount + 成功日志进 message 字符串)

(1) `processObservation` 签名(`:656` 附近):
OLD:
```typescript
  ): Promise<{ truncatedFields: number }> {
```
NEW:
```typescript
  ): Promise<{ truncatedFields: number; obsCount: number }> {
```

(2) `processObservation` 末尾 return(`:808` 附近;`result` 是 `storeBypassObservationsForSession` 的非空返回,`observationIds` 在作用域内):
OLD:
```typescript
    return { truncatedFields };
```
NEW:
```typescript
    return { truncatedFields, obsCount: result.observationIds.length };
```

(3) consumeLoop 成功日志(`:604`):
OLD:
```typescript
              logger.info("BYPASS", "Observation processed", {
                messageId: message.id,
                sessionDbId: session.sessionDbId,
                endpoint: this.config ? new URL(this.config.baseUrl).host : null,
                truncatedFields: obsStats.truncatedFields,
              });
```
NEW:
```typescript
              logger.info("BYPASS", `STORED | lane=bypass | sessionDbId=${session.sessionDbId} | messageId=${message.id} | obsCount=${obsStats.obsCount}`, {
                messageId: message.id,
                sessionDbId: session.sessionDbId,
                endpoint: this.config ? new URL(this.config.baseUrl).host : null,
                truncatedFields: obsStats.truncatedFields,
              });
```

- [ ] **Step 3c: bypass 失败分支死信化**(`BypassLane.ts:617-622`,评审 Q3 —— 消费 `markFailed` 返回值 `{finalStatus, retryCount}`,killing blow 不再谎报 "marking for retry";紧随其后的 `notifyMessageAvailable` 一行不动)

OLD:
```typescript
              logger.warn("BYPASS", "Processing failed, marking for retry", {
                messageId: message.id,
                category: category ?? "unknown",
                error: error instanceof Error ? error.message : String(error),
              });
              pendingStore.markFailed(message.id);
```
NEW:
```typescript
              const failResult = pendingStore.markFailed(message.id);
              if (failResult.finalStatus === "failed") {
                // Killing blow: the row is now dead-lettered, permanently dropped.
                // Make the drop visible (评审 Q3) — the old unconditional
                // "marking for retry" text lied on this final call.
                logger.warn("BYPASS", `DEAD_LETTER | observation dropped after max retries | messageId=${message.id} | retryCount=${failResult.retryCount} | category=${category ?? "unknown"}`, {
                  messageId: message.id,
                  sessionDbId: session.sessionDbId,
                  error: error instanceof Error ? error.message : String(error),
                });
              } else {
                logger.warn("BYPASS", "Processing failed, marking for retry", {
                  messageId: message.id,
                  category: category ?? "unknown",
                  error: error instanceof Error ? error.message : String(error),
                });
              }
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/worker/lane-attribution-log.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量 + 提交**

Run: `bun test ./tests/`
Expected: 无新增失败(对照基线,见测试约定。注意:若有测试断言 bypass 旧日志文本 "Observation processed"、无条件的 "Processing failed, marking for retry",或 `processObservation` 旧返回形状 `{truncatedFields}`,按新文本/新分支/新形状更新)。
```bash
git add src/services/worker/agents/ResponseProcessor.ts src/services/worker/BypassLane.ts tests/worker/lane-attribution-log.test.ts
git commit -m "feat(telemetry): lane=sdk|bypass + obsCount store attribution; DEAD_LETTER visibility for bypass drops

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6: 机器 settings.json 数值调优(pool/C/batch)

**Files:**
- Modify: **有效** `settings.json`(机器,非仓库 —— 无测试,手动核验。**路径必须运行时解析**,评审 R6-1:`USER_SETTINGS_PATH = <DATA_DIR>/settings.json`,而 `resolveDataDir()`(`paths.ts:28-45`)按 env `CLAUDE_MEM_DATA_DIR` > homedir 引导文件(`~/.claude-mem/settings.json`)内的 `CLAUDE_MEM_DATA_DIR` 键 > 默认 三级解析 —— 有效文件**可能不是** shell 展开的 `~/.claude-mem/settings.json`。本 pod 实例:引导文件是符号链接且含 `CLAUDE_MEM_DATA_DIR=/home/shinewine/.claude-mem`,有效文件为 `/home/shinewine/.claude-mem/settings.json`)

**背景**:比例旋钮独立于总闸(关键架构事实 #7)。新模式起步值:pool=3、C=4、batch=2、G=6、transient cooldown=180000(3min,**评审 Q5 决定值**:transient 类快速归队符合 bypass 主力定位;长尾故障由 quota(30min)/auth(6h)专属冷却分流;恢复探测走 `probeOpenAICompatible` 合成调用,不烧真实消息的 retry 次数)。数值**现状执行时从有效文件读取确认**,不采信 spec 撰写时的快照(评审 R6-1:实测同一 fork 在不同机器上现值不同,如本 pod 为 pool=4 / C=1 / batch=5 / cooldown=1200000)。

> **Bypass 启用前提(评审 R6-1,硬前置)**:`BypassLane` 仅在 `CLAUDE_MEM_PROVIDER="openai"` 且 `CLAUDE_MEM_OPENAI_BASE_URL`/`_API_KEY` 配置齐全时启用(`BypassLane.ts:214` 一带)。若执行机缺这些配置(如本 pod 当前 provider=claude、URL/key 均空),Task 1–5 与"新模式生效性"验证(cm- 锚落库)**不受影响**,但 Step 4 的 bypass 占比/失败率验收**无法在本机完成** —— 该验收项显式标记"待 bypass 凭据配置后执行",凭据由用户提供(不入仓库、不虚构、不用占位符跑假数据)。

> **M3 已接受风险(pool=3)**:pool 从 5 降到 3 在 bypass **健康**时安全(OFF 态解绑消掉了冷启动压力,SDK 本就是少数派)。但 bypass **熔断**时 SDK 成唯一消费者,仅 3 个 slot 扛全部会话突发 → 排空变慢、可能触发 backpressure(L1=20/L2=50)丢低价值观测。**决策(用户已确认,评审 Q4):接受此风险**,不预留额外余量 —— 由 Task 6 Step 4 的失败率/trips 手动监控兜底,真出问题时手动临时回调 pool。

- [ ] **Step 0: 解析有效路径 + 读取现状**(评审 R6-1)

Run(仓库根执行;打印有效路径):
```bash
bun -e 'const p = await import("./src/shared/paths.ts"); console.log(p.USER_SETTINGS_PATH)'
```
Run(确认 worker 进程 env 无更高优先级覆盖;输出应为空或与文件一致):
```bash
tr "\0" "\n" < /proc/$(pgrep -f worker-service | head -1)/environ | grep -E "CLAUDE_MEM_(DATA_DIR|OBSERVER_RESUME)" || echo "no env override"
```
再 `grep` 该有效文件读取 pool/C/batch/G/cooldown/provider 现值,记录到执行日志。

- [ ] **Step 1: 编辑【有效】settings.json**(Step 0 解析出的路径,非硬编码 `~`)

把以下键设为(不存在则新增,存在则改值):
```json
  "CLAUDE_MEM_MAX_CONCURRENT_AGENTS": "3",
  "CLAUDE_MEM_BYPASS_CONCURRENCY": "4",
  "CLAUDE_MEM_BATCH_MAX_SIZE": "2",
  "CLAUDE_MEM_BYPASS_MAX_CONSUMERS": "6",
  "CLAUDE_MEM_BYPASS_COOLDOWN_MS": "180000",
  "CLAUDE_MEM_OBSERVER_RESUME": "false"
```
> `CLAUDE_MEM_OBSERVER_RESUME` 显式写 `"false"` 以文档化意图(等价于默认)。
> **Bypass 前提键**(占比验收所需,见 Task 6 背景;凭据缺失则跳过设置、把 Step 4 占比验收标记为"待凭据"):`CLAUDE_MEM_PROVIDER: "openai"`、`CLAUDE_MEM_OPENAI_BASE_URL`/`_API_KEY`/`_MODEL` 为用户提供的有效值。

- [ ] **Step 2: 校验 JSON 合法 + 生效**(评审 R6-1:经运行时解析的路径校验,非 `$HOME` 硬编码)

Run:
```bash
bun -e 'const {USER_SETTINGS_PATH} = await import("./src/shared/paths.ts"); JSON.parse(require("fs").readFileSync(USER_SETTINGS_PATH, "utf8")); console.log("settings.json OK:", USER_SETTINGS_PATH)'
```
Expected: 打印 `settings.json OK: <有效路径>`,且路径与 Step 0 一致。

- [ ] **Step 3: 构建部署 + 重启 worker**

Run: `bun run build-and-sync`
Expected: 构建成功,worker 重启,计数归零。

- [ ] **Step 4: 冒烟核验(新模式生效)**

在任一启用了 claude-mem 的项目跑几个会话后:
Run(**新模式生效性,评审 R1-5 —— 先于一切占比统计**。评审 R6-2:执行机无 `sqlite3` CLI,改用仓库自带的 `bun:sqlite` 探针):
```bash
bun -e "const {Database}=require('bun:sqlite');const db=new Database(process.argv[1],{readonly:true});console.table(db.prepare(\"SELECT id, substr(COALESCE(memory_session_id,'NULL'),1,12) AS anchor, started_at FROM sdk_sessions ORDER BY id DESC LIMIT 5\").all())" <某启用项目>/.claude/mem.db
```
Expected: **部署后新建**的行 `anchor` 以 `cm-` 开头(部署前存量行不算)。若不是:先查 worker 进程环境是否残留 `CLAUDE_MEM_OBSERVER_RESUME=true`(env 优先级最高,会压过 settings.json,导致 legacy 模式下占比数据全部失效),再查 settings.json。**该验证通过之前,下面的占比统计无效**(legacy 模式也可能碰巧跑出高 bypass 占比,冒烟会误判成功)。
Run(状态 + 失败率,M2): `curl -s http://localhost:37777/api/health | bun -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); const b=d.ai.bypass; console.log("bypass:",b.state,"claimed:",b.totalClaimed,"failed:",b.totalFailed,"trips:",b.totalTrips,"failRate:",b.totalClaimed?(b.totalFailed/b.totalClaimed*100).toFixed(1)+"%":"n/a")'`
Expected: `bypass: ACTIVE`;`claimed` 随会话增长;**失败率(failed/claimed)≤ ~10% 且 trips 不频繁增长**。
Run(占比,**obsCount 求和口径**,评审 C1;日志按天分文件 `claude-mem-<YYYY-MM-DD>.log`。**⚠️ 日志目录 ≠ settings/DB 目录(评审 R11-1)**:logger 刻意用 `DEFAULT_DATA_DIR = join(homedir(), '.claude-mem')` 硬编码 logs 目录、**不尊重** `CLAUDE_MEM_DATA_DIR`/settings(`logger.ts:29,64`,注释 "always based on the default, not user settings",规避与 SettingsDefaultsManager 的循环依赖)。故此处必须读 **logger 的真实落盘目录 `homedir()/.claude-mem/logs`**,**不能**用 `paths.LOGS_DIR`(= `<resolved DATA_DIR>/logs`;本 pod resolved DATA_DIR=`/home/shinewine/.claude-mem` → 该目录**空**,真实日志在 `/root/.claude-mem/logs`,占比/`DEAD_LETTER` 会读不到数据)。settings 走 resolved 路径(R6-1)、logs 走 homedir 默认 —— **两者解析口径不同,勿混用**):
```bash
# logger 落盘目录 = homedir()/.claude-mem/logs (DEFAULT_DATA_DIR),与 paths.LOGS_DIR 不同
LOGS_DIR=$(bun -e 'const {homedir}=require("os");const {join}=require("path");console.log(join(homedir(),".claude-mem","logs"))')
grep -h 'STORED | lane=' "$LOGS_DIR/claude-mem-$(date +%F).log" \
  | sed -nE 's/.*lane=(sdk|bypass).*obsCount=([0-9]+).*/\1 \2/p' \
  | awk '{sum[$1]+=$2} END {for (l in sum) print l, sum[l]; t=sum["sdk"]+sum["bypass"]; if (t>0) printf "bypass_share=%.1f%%\n", 100*sum["bypass"]/t}'
```
Expected: `bypass_share` **≥60%**(batch=2 / C=4 期望 ≈2/3)。跨天冒烟对多个日期文件重复。
**统计窗口(评审 C3)**:以部署后**新建**会话为主 —— 存量会话按出生模式跑 legacy,混入会拉低占比;过渡期数据仅作参考。
Run(死信,Q3): `grep -c 'DEAD_LETTER' "$LOGS_DIR/claude-mem-$(date +%F).log"`(`LOGS_DIR` 同上一步解析)
Expected: 0 或极低 —— 每一条都是被永久丢弃的观测;持续增长时按 M2 旋钮处理。
**质量观察项(Q2)**:抽查 `SDK_USAGE_SUMMARY` 的 empty-obs 计数(`consecutiveEmptyObservations`/`peakConsecutiveEmptyObs`)与同 prompt 近重复观测(相似标题)无明显恶化 —— 这是无状态 observer 丢失跨 generator 去重记忆的已接受代价;恶化时旋钮:升 pool / 回 legacy。
> **M2 判据(手动,不自动回退)**:健康 = 占比 ≥60% **且** 失败率 ≤ ~10%。占比达标≠健康 —— bypass 走 deepseek-flash,失败(解析失败)会 `markFailed` 重试、超上限即丢弃,占比越高丢弃绝对量越大。**这两个数由你自己盯**;任一超标,由**你手动**决定是否回退(降 batch→1 / 升 C→6 提占比,或升 pool / 关开关降 bypass 依赖),系统**不自动**调节。

- [ ] **Step 5: 记录结果**(不提交仓库;把冒烟占比记入本 spec 的执行日志或 commit note)

---

## 验收标准(整体)

1. **全量无回归**:`bun test ./tests/` 对照 `b741d043` 基线**无新增失败**(见测试约定;既有 70 个顺序依赖型污染失败不在本计划范围),且本计划新增/修改的测试文件单独跑 100% pass。
2. **新模式默认生效**:默认(未设 flag 或 flag=false)下,新会话 `sdk_sessions.memory_session_id` 为 `cm-` 前缀(Task 6 Step 4 以 DB 查询实证,评审 R1-5 —— 不以占比间接推断);bypass 无需等 SDK 播种即可处理该会话观测。
3. **回退可用**:`CLAUDE_MEM_OBSERVER_RESUME=true` 后,新会话锚为 NULL、observer resume、bypass 等种 —— 与今日行为**功能等价(functionally equivalent)**(评审 R15:非逐字节相同 —— 计划已显式接受更安全的 DB/内存一致性差异[R2-1:helper 先写 DB 成功后才清内存]与遥测变更[lane=/obsCount/DEAD_LETTER],故用"功能等价"而非"byte-for-byte")。建行的 flag 读取是**非创建式、无 TTL**的(评审 R11-2 deep):改完 settings.json 后**下一个新会话即读到最新值**(不再有旧 `loadFromFile` 的 5 秒陈旧窗口);env var 优先级更高、同样即时生效。既有会话按出生模式不变(切换只影响新会话)。
4. **切换安全**:途中切开关 / worker 重启不产生 "No conversation found" 崩溃(`cm-` 锚永不 resume);overflow / stale-resume / watchdog abort 均不清空 `cm-` 锚(Task 2 三站点守卫,评审 R1-1);在途会话按出生模式跑完。代码回滚(git revert)同样安全:旧 `shouldPersistSDKSessionId` 无守卫,会用 SDK 自身 id 覆盖 `cm-` 锚,`ON UPDATE CASCADE` 把既有观测/summary 整体迁到新 id —— 无数据丢失,会话退化为 legacy(评审 C3)。
5. **summary 无回归**:summary 正常产出(fresh query,不依赖 resume)。
6. **占比 + 质量双达标**(M2):新模式稳定运行后 `lane=bypass` 占比(**obsCount 求和口径**,评审 C1)≥60% **且** bypass 失败率 ≤ ~10%、trips 不频繁增长、`DEAD_LETTER` 不持续增长(Q3);另抽查 empty-obs / 近重复观测无明显恶化(Q2)。以上由用户手动盯,系统不自动回退。**硬前提(评审 R6-1)**:执行机已配置有效 bypass 端点(`CLAUDE_MEM_PROVIDER="openai"` + BASE_URL/KEY);缺失时本项验收挂起为"待凭据",其余验收标准(1–5)不受影响。

## 竞争消费者行为说明(范围缺口补全)

- **bypass 失败的天然回落**:bypass 处理失败(如 deepseek 解析失败)走 `BypassLane.ts:622` `markFailed` → 行归还队列(`notifyMessageAvailable`),**更强的 SDK 或另一 bypass 消费者可再认领**——这是竞争消费者天然的兜底。但受 `markFailed` 的 `maxRetries` 上限约束:反复失败超限即 `'failed'`(丢弃)。故占比越高、失败率越高时,丢弃绝对量越大(见 M2 判据)。
- **Chroma / search 不受锚变更影响**:观测改挂 `cm-` 锚只影响 FK 归属;`ChromaSync` 按项目同步、`SearchManager` 按 `content_session_id`/内容检索,均不以 `memory_session_id` 为破坏性键。summary 按 `content_session_id + prompt_number` 取归属范围内的观测,并在后续 migration 34 中按 `content_session_id + turn_number` 保证 turn 唯一性(关键架构事实 #4),无回归。

## 未决 / 显式不做(YAGNI)

- **不动** `src/services/sqlite/sessions/create.ts` 的独立函数 `createSDKSession(db, …)`(db-first 变体,运行时路由不走它;评审 R9-2:先前误记为 `createSession`)。
- **不动** Layer C proactiveReset 语义与其余 resume 失败处理;但三处**清锚**站点(overflow / 2× stale-resume)在 Task 2 加 `isWorkerAnchor` 守卫(评审 R1-1)—— 只豁免 cm- 锚,legacy 行为一字不变。
- **不加** UI 开关、**不加** `settingKeys` 白名单条目(Task 1 Step 6 有源码断言锁死)。
- **不改** code 默认的 pool/C/batch(仅改机器 settings.json);如需全局默认化,另开改动。

## 实施期非阻塞清理(评审 R15 Final gate 建议,不影响架构/解耦目标)

> 这些是 Round 15 Final gate 批准时附带的**非阻塞**清理项,不改变 Task 2→3→4 的实现,但实施时顺手处理可避免遥测/文档误导:

- **[Task 2/3 顺带] `SessionRoutes.ts:1114` 的 `isNewSession` 遥测已失真**:`const isNewSession = !dbSession?.memory_session_id`(`CREATED | … isNew=${isNewSession}` 日志)在新模式下建行即得 `cm-` 锚 → `memory_session_id` 恒非空 → `isNewSession` 恒 `false`,日志"首个 prompt 将从 SDK 捕获 id"的语义也不再成立。实施时把该判定改为 `isWorkerAnchor()`-感知(如 `!dbSession?.memory_session_id || isWorkerAnchor(dbSession.memory_session_id)` 表示"尚未被 SDK 播种"),或按新语义改写日志文案。纯遥测,不影响控制流。
- **[文档澄清] GET `/api/settings` 与建行读取的 settings 源不同**:GET `/api/settings` 经 `SettingsDefaultsManager.loadFromFile` 读 **homedir 引导文件**(只读回显,评审 R1-2),而建行 flag 读取走 resolved `USER_SETTINGS_PATH`(`<DATA_DIR>/settings.json`)。当 `CLAUDE_MEM_DATA_DIR` 被重定向(如本 pod → `/home/shinewine/.claude-mem`)时,GET 的只读回显可能**不代表建行实际生效的 flag 值**。实施时在设置回显处注明此差异(或对齐读取源),避免运维据 GET 回显误判 flag。
- **[已应用] 验收标准 #3 "byte-for-byte" → "功能等价"**:见上方验收标准 #3(评审 R15:计划已显式接受更安全的 DB/内存一致性差异与遥测变更)。

## 评审与决策记录(2026-07-17 sim-review,verdict: approve-with-conditions)

评审条件(已全部并入正文):
- **C1 度量效度**:两侧 store 日志带 `obsCount`,占比按 obsCount 求和(Task 5 Step 3b、Task 6 Step 4)—— 修正"SDK 一行=一次响应 vs bypass 一行=一条消息"的单位不可比。
- **C2 测试密闭性**:Task 3 的 flag 敏感用例走子进程 probe(env / 临时 settings.json 显式注入、临时 `CLAUDE_MEM_DATA_DIR`),不依赖机器 settings.json、无 TTL(评审 R11-2 deep:建行读取非创建式,已不经 `loadFromFile`)。
- **C3 文档补丁**:代码回滚语义(验收 4)、provider=claude 半径(事实 #8)、统计窗口(Task 6 Step 4)。

用户逐项拍板(Q1–Q5):
- **Q1 总闸半径**:全局 OFF,不与 provider 配置耦合 → 事实 #8。
- **Q2 无状态代价**:接受跨 generator 去重/连续性丢失,M2 增加质量观察项 → Task 6 Step 4。
- **Q3 死信兜底**:消费 `markFailed` 返回值,killing blow 打 `DEAD_LETTER` → Task 5 Step 3c。
- **Q4 M3(pool=3)**:接受(含 quota 30min / auth 6h 长熔断窗口下 SDK 独扛的排空风险)。
- **Q5 cooldown**:transient 冷却保留机器现值 3min,显式写入 Task 6。

批准所接受的最大风险:≥60% 观测流量的质量系于 deepseek-flash 解析可靠性,失败超限即死信丢弃,无自动回退 —— 兜底是 M2 人工双判据 + DEAD_LETTER 可见性 + legacy 一键回退。

---

## Review Log

### Round 1
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Initial Review

发现了需要修订的问题，不能批准。

1. 高严重度：`cm-` 锚仍可能被现有 reset/overflow 路径清空

Task 4 只保护 `shouldResume` 和 `shouldPersistSDKSessionId`，但规范明确决定不修改 proactive reset、context overflow 和其他 resume 恢复路径。[SDKAgent.ts](/mnt/volumes/infra-cloud-alg-su01/wangjiazhe/proj-claude-mem/src/services/worker/SDKAgent.ts) 中现有 fresh-start/reset 逻辑会把 DB 和内存中的 `memorySessionId` 清为 `null`。

“新模式下天然失效”不成立：fresh query 仍可能因单个过大输入而 overflow。对 `cm-` 会话执行该逻辑后：

- 锚不再稳定，违反核心不变量；
- bypass gate 会重新阻塞；
- 下一次 SDK init 可把会话退化为 SDK-id 模式；
- 已有 FK 子行时，将父键级联更新为 `NULL` 还可能与子表的 `NOT NULL` 约束冲突。

必须审计所有写入/清空 `memory_session_id` 的路径，并让 reset 对 worker anchor 保留 DB 与内存锚，只重置 SDK 上下文状态。还需要覆盖“已有 observation 后发生 overflow/reset”的测试。

2. 高严重度：“不进入设置 API”的声明是假的

[SettingsRoutes.ts](/mnt/volumes/infra-cloud-alg-su01/wangjiazhe/proj-claude-mem/src/services/worker/http/routes/SettingsRoutes.ts) 的 GET `/api/settings` 返回 `SettingsDefaultsManager.loadFromFile()` 的完整结果。把新键加入 defaults 后，它会自动出现在 GET 响应中，即使文件里没有该字符串。

拟议测试只检查：

```ts
expect(routes).not.toContain("CLAUDE_MEM_OBSERVER_RESUME");
```

这无法检测间接暴露。需二选一：

- 从 GET 响应显式过滤该键，并添加 HTTP 集成测试；或
- 把需求改成“UI 不展示、POST 不可写，但 GET 可读”。

3. Task 4 的 resume 测试是无效的假阳性

`shouldResumeReplica` 只测试测试文件自己复制的表达式，与生产代码没有连接。即使完全漏改生产 `shouldResume`，该测试仍会通过。

应抽取并导出生产使用的 `shouldResumeSDKSession(...)` 纯函数，然后直接测试它；不能用 replica 作为关键安全不变量的唯一验证。

4. 所谓“原子部署单元”与执行顺序矛盾

计划要求按 Task 2 → Task 3 → Task 4 分别提交，但自己也承认 Task 3 生效而 Task 4 未生效会造成 `resume: cm-X`。仅禁止 `build-and-sync` 不能防止源码启动、单独 cherry-pick 或检出中间提交。

应把 2–4 合为一个提交，或至少按“Task 4 守卫 → Task 2 派发 → Task 3 加载”排序，确保每个提交本身安全。

5. 冒烟步骤没有证明新模式实际启用

规范规定 env 覆盖 settings.json，但 Task 6 只写文件并检查 lane 占比。若 worker 环境中仍有 `CLAUDE_MEM_OBSERVER_RESUME=true`，legacy 模式也可能产生较高 bypass 占比，现有冒烟会误判成功。

必须查询部署后新建会话的 `sdk_sessions.memory_session_id`，确认它确实为 `cm-`，并限定统计为部署后的日志窗口。

附带测试问题：Task 2 测试修改 `process.env.CLAUDE_MEM_OBSERVER_RESUME` 后没有恢复，会污染同一 Bun 进程中的后续测试；关键回退路径也缺少 `createSDKSession` 在 flag=true 时实际落库为 `NULL` 的集成测试。

验证限制：我多次尝试执行 `git`、`rg` 和 `bun test ./tests/`，但执行器在运行命令前持续报 `bwrap: Failed to make / slave: Permission denied`，因此无法诚实声称全量测试已运行。没有修改任何文件。上述设计缺陷本身已足以阻止签字。

REVISIONS NEEDED
**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 1

---

### Response to Round 1
**Responder**: Claude Code

**Findings addressed**: 6

1. **cm- 锚可被既有 reset/overflow 路径清空**
   - Verdict: ACCEPTED
   - Evidence: 全量审计确认 3 处无条件清锚站点 —— `SDKAgent.ts:371`(context overflow)、`SessionRoutes.ts:283` 与 `worker-service.ts:802`(stale-resume 检测,且条件含宽泛的 `'aborted by user'` 子串,watchdog abort 亦命中)。另核实 `updateMemorySessionId(id, null)` 对有 FK 子行的会话经 `ON UPDATE CASCADE` 会把子行 NOT NULL 列置 NULL 直接报错(`migrations/runner.ts:108,131`)。
   - Action: 新增关键架构事实 #9(`memory_session_id` 写入点全量清单,6 处);Task 2 扩容为"双守卫 + 三处清锚站点":overflow 站点加 `isWorkerAnchor` 内联守卫,两处 stale-resume 站点改用 Task 1 新增纯函数 `shouldClearStaleAnchorOnResumeFailure(errorMessage, memorySessionId)`(cm- 锚永不清空,legacy 行为不变);配套真函数单测 + 源码断言。

2. **"不进设置 API"声明是假的(GET 全量回显)**
   - Verdict: PARTIALLY ACCEPTED
   - Evidence: `SettingsRoutes.ts:31-36` GET `/api/settings` 确实返回 `loadFromFile()` 全量合并结果,新键必然只读回显。但 viewer UI 只渲染 `constants/settings.ts` 里显式声明的键,POST 白名单(`settingKeys`)不含新键 → 写路径与 UI 展示均隔离。
   - Action: 采纳 Codex 提供的选项 B(改声明,不加过滤代码 —— 过滤 GET 需要特判且破坏 `SettingsDefaults` 类型对称性,防的是"只读可见"这一无害暴露,属过度防御):Architecture 段与 Task 1 Step 6 测试注释改为"不进 viewer UI、不可经 API 写入;GET 只读回显已接受"。

3. **Task 4 的 shouldResumeReplica 是假阳性测试**
   - Verdict: ACCEPTED
   - Evidence: replica 与生产内联布尔零连接,漏改生产代码测试照样绿。
   - Action: Task 2 改为把 `shouldResume` 抽取为导出纯函数 `shouldResumeSDKSession`(`startSession` 唯一调用点),测试直接 import 真函数;replica 从计划中删除。既有 `tests/sdk-agent-resume.test.ts` 的历史 replica 不承载本计划不变量,不动(YAGNI)。

4. **"原子部署单元"与逐 Task 提交矛盾**
   - Verdict: ACCEPTED
   - Evidence: 旧顺序下 cherry-pick / 中间提交检出确实存在"Task 3 生效而 Task 4 未生效"的危险中间态,"禁止 build-and-sync"只是软约束。
   - Action: 重排任务序:Task 2(守卫)→ Task 3(派发)→ Task 4(加载)。守卫先行时系统无 cm- 锚(纯 no-op);派发后内存锚仍 null,SDK 照旧覆盖 DB 中无子行的 cm- 锚(legacy 等价);加载落地时守卫已就位。任意前缀提交序列均可独立部署,旧警告替换为"部署顺序安全"说明。

5. **冒烟未证明新模式实际启用**
   - Verdict: ACCEPTED
   - Evidence: env 覆盖 settings.json(`applyEnvOverrides`),仅写文件不能排除 worker 环境残留 `CLAUDE_MEM_OBSERVER_RESUME=true`;legacy 模式亦可能碰巧跑出高 bypass 占比。
   - Action: Task 6 Step 4 增设第一道验证:`sqlite3` 查询部署后新建 `sdk_sessions` 行的 `memory_session_id` 是否 `cm-` 前缀,未通过前占比统计无效;验收标准 2 同步改为"以 DB 查询实证,不以占比间接推断"。

6. **测试 env 污染 + 缺 flag=true 落库集成测试**
   - Verdict: ACCEPTED
   - Evidence: 原 Task 2 测试改 `process.env` 后未恢复,同进程后续测试文件会受污染;ON 分支只有纯函数单测。
   - Action: Task 3 测试重写为 `pinFlag()` 夹具:`beforeAll` 钉 OFF、`afterAll` 恢复进程原值并失效 TTL 缓存;新增 `legacy (flag=true): new row keeps NULL anchor` 集成用例(try/finally 复位)。测试约定同步加"改 env 必须 afterAll 恢复 + invalidateCache"。

**Spec body updated**: Yes(Architecture 段、事实 #6/#9、测试约定、文件清单、Task 1/2/3/4 重构与重排、Task 6 Step 4、验收标准 2/4、YAGNI 节)
**Open issues remaining**: 0

---

### Round 2
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

修订方向总体正确，但仍有两项实质问题和一项文档矛盾，暂不能批准。

1. 高严重度：R1-1 要求的行为回归测试仍未补上

Task 2 对三处清锚路径的代码方案是合理的；但测试仍主要是源码字符串断言：

- overflow 测试只确认附近 1500 字符出现 `isWorkerAnchor(...)`；
- 两个 stale-resume 测试只确认文件包含 helper 调用。

这些测试无法证明：

- `updateMemorySessionId(..., null)` 确实没有在守卫前或其他分支执行；
- 内存中的 `session.memorySessionId` 仍保留；
- `forceInit` 和 abort 行为仍执行；
- 已有 observation/FK 子行时不会触发 `ON UPDATE CASCADE`/`NOT NULL` 异常。

R1 明确要求覆盖“已有 observation 后发生 overflow/reset”。需要一个执行生产路径的测试：建立带 `cm-` 父锚及至少一个 FK 子行，触发 overflow/reset，断言 DB 父子锚和内存锚不变、没有异常，同时验证 legacy SDK-id 仍会被清除。若完整触发 SDKAgent 太重，可抽取生产实际调用的 reset helper，并用真实 SessionStore 或可断言调用的 store mock 测试；不能只检查源码文本。

2. 中严重度：Task 3 的 env 测试并未真正解决 `mock.module` 泄漏

计划中的测试在文件顶层静态导入 `observer-anchor` 和 `SessionStore`；两者会在 `beforeAll(pinFlag)` 之前绑定 `SettingsDefaultsManager`。后面的动态 import 和可选 `invalidateCache?.()` 只能避免方法不存在时报错，不能撤销其他测试泄漏的 `mock.module`，也不能保证被 mock 的 `loadFromFile()` 会读取刚设置的环境变量。

因此在 `bun test ./tests/` 中，特别是 legacy `flag=true → NULL` 用例，仍可能依赖文件加载顺序或被固定返回值的 mock 破坏。建议把这项集成测试放进设置了 env 的干净 Bun 子进程，或者提供显式配置注入点；随后仍应保留真实配置加载的隔离集成覆盖。

3. 低严重度：R1-2 的旧错误声明仍残留在拟新增代码注释

正文已经正确改成“UI 不展示、POST 不可写、GET 只读回显”。但 Task 1 拟加入的注释仍写着：

- `No viewer-UI/API exposure`
- `Master switch, no UI/API exposure`

这与已接受的 GET 行为冲突。应统一改成“不在 viewer UI；不可经 POST 写入；会由 GET 只读返回”。

其余 R1 回应是充分的：resume 判定改测生产函数、任务重排后的逐提交部署顺序、GET 暴露的需求选择，以及部署后直接查询 `cm-` 锚的冒烟验证，都已合理解决原问题。

验证限制：本轮再次尝试执行 `pwd`、`git/rg` 等只读命令，但执行器仍在进程启动前报 `bwrap: Failed to make / slave: Permission denied`，所以无法诚实声称已读取当前工作树或运行测试；没有修改任何文件。

REVISIONS NEEDED
**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 2

---

### Response to Round 2
**Responder**: Claude Code

**Findings addressed**: 3

1. **R2-1: Behavioral regression tests for the three anchor-clearing sites still missing / spec internally inconsistent**
   - Verdict: ACCEPTED
   - Evidence: The spec's Task 2 test section had already adopted the reviewer-suggested extraction (`resetSessionAnchorForFreshStart` in Task 1, behavioral tests on a real `SessionStore(':memory:')` with an FK child row, plus wiring assertions), but Task 2 implementation Steps 3(e)/4 still showed the old inline guards with raw `updateMemorySessionId(session.sessionDbId, null)` — the spec would have failed its own wiring tests. Schema verified: `sdk_sessions.status` has a DEFAULT and `observations.content_session_id` is nullable, so the fixture INSERTs are valid (`migrations/runner.ts`); `SessionStore.getDatabase()` exists (`SessionStore.ts:1582`); each production file contains exactly one raw-clear occurrence, so the `not.toContain` wiring assertions hold after rewiring.
   - Action: Rewrote Task 2 Step 3(e) (overflow site) and Step 4 (both stale-resume sites) to route through `resetSessionAnchorForFreshStart`; SessionRoutes keeps its best-effort try/catch around the helper (documented micro-delta: on DB failure the anchor now stays consistent in both DB and memory instead of desyncing — forceInit is set either way, so behavior converges). Added the missing `SessionStore` / `resetSessionAnchorForFreshStart` imports to the Task 2 test file. Updated Step 6 grep expectation ("0 raw clears in src/; the only NULL-clearing runtime path is inside the helper"). Updated architecture fact #9 and the file-list table accordingly.

2. **R2-2: In-process env pinning does not defeat `mock.module` leakage**
   - Verdict: ACCEPTED
   - Evidence: Correct — static top-level imports bind `SettingsDefaultsManager` before `beforeAll(pinFlag)` runs; a leaked cross-file `mock.module` replaces `loadFromFile` entirely, so neither the env pin nor `invalidateCache?.()` guarantees the pinned value is read. The repo has 15+ files mocking this module.
   - Action: Rewrote the Task 3 test: both flag-sensitive cases now spawn a **fresh bun subprocess** (`spawnSync([process.execPath, "-e", PROBE], {env: {..., CLAUDE_MEM_OBSERVER_RESUME: flag}})`) that imports the real `SessionStore`, creates an `:memory:` store, and reports the minted anchor as JSON — no mocks, no TTL-cache history, env explicitly injected (outranks machine settings.json), zero cross-contamination in either direction. The flag-agnostic idempotency case stays in-process. The old `pinFlag` fixture is deleted. Test-convention section updated to make subprocess isolation the rule for flag-sensitive integration tests.

3. **R2-3: Stale "no UI/API exposure" wording in Task 1 code comments**
   - Verdict: ACCEPTED (already applied)
   - Evidence: The spec body's Task 1 comments now read "Not in viewer UI, not writable via POST /api/settings; GET /api/settings echoes it read-only (R1-2)" (observer-anchor.ts docstring) and "NOT in viewer UI, NOT writable via POST /api/settings (absent from settingKeys whitelist); GET /api/settings echoes it read-only" (SettingsDefaultsManager interface comment). A full-text scan finds the old phrases only inside the Round 2 review quote itself, not in the spec body.
   - Action: None further needed.

**Spec body updated**: Yes(Task 2 Step 3(e)/4/6、Task 3 测试重写、测试约定、事实 #9、文件清单)
**Open issues remaining**: 0

---

### Round 3
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

R2 的三项回应本身都充分：helper/FK 行为测试方向正确；干净 Bun 子进程确实隔离了 `mock.module` 与 TTL；UI/API 注释也已统一。仍有两项需要修订：

1. **中：计划遗漏了必然失败的既有测试。** 默认 OFF 后，`SessionStore.createSDKSession()` 不再返回 NULL 锚，但 `tests/session_id_usage_validation.test.ts:86` 和 `tests/fk-constraint-fix.test.ts:42` 仍明确断言 NULL；前者还编码了"非 NULL 即可 resume"的旧不变量，与新的前缀判定冲突。Task 2 同样必然打破 `tests/worker/context-overflow-reset.test.ts:39` 的直接赋值/raw-clear 源码断言，但该文件未列入 Files 或 `git add`。这些不是可选的"若冲突"，应明确列出并更新，否则全量 gate 必然失败。

2. **低：`worker-service.ts` 的拟新增 import 路径仍写错。** spec 代码块写的是 `./shared/observer-anchor.js`，实际应为下一行说明中的 `../shared/observer-anchor.js`。照代码块实施会直接构建失败。

验证方面，真实 FK 夹具可用，尝试把带 observation 的父锚更新为 NULL 会得到预期的 `NOT NULL constraint failed`。子进程探针机制也已实测可行。当前 HEAD 的 `bun test ./tests/` 实际得到 `2185 pass / 70 fail`，失败主要来自既有跨文件 mock 污染；这不是本计划引入的回归，但说明"0 fail"还需要可重复的干净执行条件。

**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 3

---

### Response to Round 3
**Responder**: Claude Code

**Findings addressed**: 3(2 项修订 + 1 项验证观察)

1. **R3-1: 三个必然失败的既有测试未列入计划**
   - Verdict: ACCEPTED
   - Evidence: 逐一核实 —— `tests/session_id_usage_validation.test.ts:79-95` Resume Safety 用例断言建行后 `memory_session_id` 为 NULL 并推导 "非 NULL 即可 resume";`tests/fk-constraint-fix.test.ts:37-42` 断言建行 NULL;`tests/worker/context-overflow-reset.test.ts:41-46` 源码断言 SDKAgent 含 raw `.updateMemorySessionId(session.sessionDbId,null)`。三者在 Task 3 / Task 2 落地后必然失败,与"若冲突"的措辞不符。另核实 `ensureMemorySessionIdRegistered`(`SessionStore.ts:84-87`)对不同值**无条件覆盖**(守卫只在 SDKAgent 层),故 fk-constraint 测试的后续流程在新模式下依然成立,只需改建行断言。
   - Action: Task 2 新增 Step 4b(overflow wiring 断言改为 helper 调用 + raw clear 缺席断言,含完整 OLD/NEW);Task 3 新增 Step 3b(两个测试改**模式无关断言** `null || isWorkerAnchor`,Resume-Safety 用例改用真函数 `shouldResumeSDKSession` 验证"建行锚永不可 resume",保留原意图,含完整 OLD/NEW 与 import 相对路径注意);两处 Files 清单与 `git add` 均已补入;Step 4/5 运行命令加入这三个文件。
2. **R3-2: worker-service import 路径代码块写错**
   - Verdict: ACCEPTED
   - Evidence: 代码块写 `'./shared/observer-anchor.js'`,而 `worker-service.ts` 位于 `src/services/` 下,正确路径是 `'../shared/observer-anchor.js'`(旁注早已写对,代码块未同步)。
   - Action: 代码块改为 `'../shared/observer-anchor.js'`,旁注并入标题行,消除块/注矛盾。
3. **验证观察: 全量基线并非 0 fail(2185 pass / 70 fail)**
   - Verdict: ACCEPTED(采纳为基线判据修订)
   - Evidence: 本机复跑确认 2185 pass / 70 fail;失败全部集中在 `SettingsDefaultsManager`(36)/`Project Filter`/`DbConnectionPool`/`resolveProjectDbPath` 等既有 suite,且**单文件跑全部通过**(实测 `settings-defaults-manager.test.ts` 单跑 38/38)—— 是既有的顺序依赖型 `mock.module`/共享状态污染,非本计划引入。上一项目已有同款处理先例(`attn_sink/baseline-test-failures-205b9101.txt`)。
   - Action: 测试约定新增"基线与无新增失败判据"条目(开工前记录 `attn_sink/baseline-test-failures-b741d043.txt`,已生成,70 行;每 Task 全量 gate = diff 基线无新增 + 新增/修改测试文件单独跑 100% pass);验收标准 1 与各 Task 的 "0 fail" 期望全部同步改写;既有污染修复显式列为 YAGNI 不做。

**Spec body updated**: Yes(Task 2 Files/Step 4b/Step 5/Step 7、Task 3 Files/Step 3b/Step 4/Step 5、Step 4 import 代码块、测试约定、验收标准 1)
**Open issues remaining**: 0

---

### Round 4
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

Round 3 的 import 路径修复、FK 测试改写和 raw-clear helper 断言是充分的;既有 70 个失败的诊断也属实。仍有两项阻断问题:

1. **中:R3-1 只部分解决,仍有必然失败的旧断言。** `tests/worker/context-overflow-reset.test.ts:39` 仍要求 `SDKAgent.ts` 直接包含 `session.forceInit = true;`(计划将其唯一出现位置搬进 shared helper,却只改写了下一条 raw-clear 断言);`tests/session_id_usage_validation.test.ts:105`、`:151`、`:156` 仍断言 `createSDKSession()` 后锚为 NULL(计划只改了该文件第一个 Resume Safety 用例)。Task 2/3 的单文件 PASS 预期因此无法成立。应把 overflow 的 `forceInit` source 断言改为 helper wiring,并把后两个 session-id 用例改成 `NULL || cm-`、真实 resume 判定及锚稳定性语义。

2. **中:新增的基线 diff gate 未消除动态耗时,不能稳定复现。** spec 按原始 `(fail)` 行记录并比较,但 Bun 输出带 `[1.20ms]` 等动态后缀,raw diff 会把全部 70 行判为变化。剥离 ` \[[0-9.]+(ms|s)\]$` 后失败数为 70 且 diff 为空。基线生成和后续比较命令都应加入相同的规范化步骤。

针对性现有测试为 14 pass / 0 fail;全量失败集合经耗时规范化后与已记录基线完全一致。

**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 4

---

### Response to Round 4
**Responder**: Claude Code

**Findings addressed**: 2

1. **R4-1: 残余的必然失败旧断言(forceInit 源码断言 + 三处建行-NULL 断言)**
   - Verdict: ACCEPTED
   - Evidence: 核实 `grep -n "forceInit = true" src/services/worker/SDKAgent.ts` 唯一命中即 `:373`(被 helper 取代的 overflow 分支),Task 2 落地后该字面量从 SDKAgent 消失;`session_id_usage_validation.test.ts` 的 `:105`(capture 前 NULL)、`:151/:156`(no-reset 用例两处 NULL)在新模式下必然失败。中间的 'should preserve memorySessionId across createSDKSession calls' 用例(`:119-141`)自行播种 id、无建行-NULL 断言,不受影响。
   - Action: Task 2 Step 4b 改写为覆盖**整个** describe(两个 it 合并为一个 helper-wiring 断言:`resetSessionAnchorForFreshStart(` 存在 + raw clear 缺席;行为语义由 sdk-agent-anchor-guards 的真实-store 测试钉住);Task 3 Step 3b 追加 `:105` 与 `:143-157` 两段完整 OLD/NEW(模式无关 `null || isWorkerAnchor`;no-reset 用例改为"首锚捕获后二次调用锚恒等"——在两种模式下都验证纯 get-or-create 语义)。
2. **R4-2: 基线 diff 未规范化动态耗时后缀**
   - Verdict: ACCEPTED
   - Evidence: Bun `(fail)` 行带 `[1.20ms]`/`[1.20s]` 动态后缀,raw diff 全量误报。已记录的基线文件本身无后缀(生成时已剥 `ms`,经查 0 行残留括号),但 spec 中的命令没写规范化步骤,后续对比会失效。
   - Action: 测试约定的基线条目改为统一规范化管道 `grep '^(fail)' | sed -E 's/ \[[0-9.]+m?s\]$//' | sort`,并明确"基线生成与每次对比必须同一条命令"。

**Spec body updated**: Yes(Task 2 Step 4b 整段重写、Task 3 Step 3b 追加两段 OLD/NEW、测试约定基线命令)
**Open issues remaining**: 0

---

### Round 5
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

未发现新的阻断问题。

- R4-1 修复充分:overflow describe 的两个旧源码断言均被替换;`session_id_usage_validation.test.ts` 中所有受新锚模式影响的 NULL 断言均已覆盖。额外搜到的 `tests/sqlite/sessions.test.ts` 使用另一套未修改的模块化 API,不受影响。
- R4-2 修复充分:基线共 70 行且无耗时后缀。实际重跑全量测试并应用新规范化管道后仍为 70 行,与基线 diff 为空。
- 未修改工作区文件。

**Verdict**: APPROVED
**Next action**: Final review

---

### Round 6
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Final Review(fresh-eyes gate)

发现两个真实阻塞;Tasks 1–5 未发现架构级问题。

1. **Task 6 修改的不是 worker 实际读取的设置文件,且重启后 bypass 会被禁用。** 规格固定修改 `~/.claude-mem/settings.json` 并用 `$HOME` 校验,但代码实际读取由 `CLAUDE_MEM_DATA_DIR` 决定的 `USER_SETTINGS_PATH`(`paths.ts:28`)。本机解析结果是 `/home/shinewine/.claude-mem/settings.json`,不是 shell 展开的 `/root/.claude-mem/settings.json`。而且实际设置是 `provider=claude`、OpenAI-compatible URL 为空、pool=4、C=1、batch=5、cooldown=1200000,与规格声称的机器现状不同。`BypassLane` 在 provider 不是 `openai` 时直接禁用(`BypassLane.ts:214`)。当前 health 中的 `ACTIVE` 来自修改设置前启动的旧进程;执行计划中的 `build-and-sync` 重启后将变成 `DISABLED`,无法完成 ≥60% 验收。计划必须定位并验证有效的 `USER_SETTINGS_PATH`,同时明确保留/恢复 bypass provider、URL 和凭据前提。

2. **冒烟命令依赖不存在的 `sqlite3`。** 应改成仓库已有的 `bun:sqlite` 探针或补充可靠的替代命令。

验证结果:现有三个相关测试 14/14 通过;SettingsDefaultsManager 38/38;全量规范化失败集与 70 行基线 diff 为空;设置对齐脚本通过。当前 daemon 的 bypass 失败率为 3/11(27.3%),也尚未满足 M2,但样本较小。

**Verdict**: REJECTED
**Next action**: Response to Round 6

---

### Response to Round 6
**Responder**: Claude Code

**Findings addressed**: 2

1. **R6-1: Task 6 目标文件错误 + bypass 前提未声明**
   - Verdict: ACCEPTED
   - Evidence: 复核属实。`resolveDataDir()`(`paths.ts:28-45`)三级解析(env > homedir 引导文件的 `CLAUDE_MEM_DATA_DIR` 键 > 默认);本 pod 引导文件 `/root/.claude-mem/settings.json` 是指向持久卷的符号链接、内含 `CLAUDE_MEM_DATA_DIR=/home/shinewine/.claude-mem`,故有效文件为 `/home/shinewine/.claude-mem/settings.json`,其现值 provider=claude、URL/key 空、pool=4 / C=1 / batch=5 / cooldown=1200000 —— spec 原"已核实机器现状"是**另一台机器**(撰写时)的快照。live worker(`/proc/<pid>/environ`)无 `CLAUDE_MEM_*` env 覆盖;当前 health 亦已显示 `provider=claude`。旧 canary 凭据键(`CLAUDE_MEM_OPENCODE_API_KEY`)已随 3243e5ad 的键收敛清除,本机现无可用 bypass 凭据。
   - Action: Task 6 全面重写 —— 新增 Step 0(`bun -e` 经 `paths.ts` 运行时解析 `USER_SETTINGS_PATH` + 检查 worker env 覆盖 + 读取现值,**已实测**:本 pod 解析为 `/home/shinewine/.claude-mem/settings.json`);Step 1/2 改为编辑/校验**解析出的有效文件**;背景改为"现状执行时读取,不采信撰写时快照";新增"Bypass 启用前提"硬前置声明(provider=openai + BASE_URL/KEY 齐备,凭据由用户提供、不虚构),凭据缺失时 Step 4 占比/失败率验收显式挂起为"待凭据",Tasks 1–5 与 cm- 锚生效性验证不受影响;验收标准 6 同步加硬前提;Step 4 的日志路径同理改为运行时解析 `LOGS_DIR`(同类 `~` 硬编码,顺带修复)。
2. **R6-2: 冒烟依赖不存在的 sqlite3 CLI**
   - Verdict: ACCEPTED
   - Evidence: `command -v sqlite3` 确认本机无此二进制。
   - Action: Step 4 生效性查询改为 `bun:sqlite` 探针一行命令,**已在真实 per-project DB(ld-proj/.claude/mem.db)实测输出正常**(现存行均为 raw SDK-id 锚,符合未实施前的预期)。

**Spec body updated**: Yes(Task 6 Files/背景/前提/Step 0-2/Step 4 两处路径与探针、验收标准 6)
**Open issues remaining**: 0(bypass 凭据为用户侧前置条件,非 spec 缺陷)

---

### Round 7
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

当前 daemon 的历史 `ACTIVE` 状态不构成验收证据;修订计划已正确要求重启后重新验证。凭据到位前,验收标准 6 仍然挂起,但这是明确记录的外部前置条件,不是规格缺陷。(R6-1/R6-2 修复均确认充分。)

**Verdict**: APPROVED
**Next action**: Final review

---

### Round 8
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Final Review(fresh-eyes gate)

1. **Blocker — implementation is absent.** HEAD 仍是 `b741d043`,工作区唯一变更是未跟踪的 spec;`observer-anchor.ts` 与全部计划测试文件不存在。
2. **Blocker — core decoupling behavior is unchanged.**(建行仍 NULL、SessionManager 仍恒丢锚、resume 仍接受任意非空 id、三处 raw 清锚仍在。)
3. **Blocker — telemetry / dead-letter 均未实现。**
4. **Blocker — machine tuning 未应用。**

Verification: 既有相关测试 14/14;计划新测试不存在;全量规范化 71 fail vs 70 行基线,多出的 readiness 测试单跑 20/20(与既有污染一致),但 diff-empty gate 未达成。

The project is still at the pre-implementation baseline, so the specification's primary goal and acceptance criteria are unmet.

**Verdict**: REJECTED
**Next action**: Response to Round 8

---

### Response to Round 8
**Responder**: Claude Code

**Findings addressed**: 4 项阻塞 + 1 项验证观察

1. **Findings 1–4(实现缺席 / 行为未变 / 遥测未实现 / 调优未应用)**
   - Verdict: REJECTED(类别错误,非 spec 缺陷)
   - Evidence: 本文档是**实施前计划**(pre-implementation plan),评审对象是计划质量,不是完成度 —— 实现在批准后经 file-to-prod 执行,checkbox 全空、HEAD 停在基准版本 `b741d043` 正是**预期状态**(spec 头部"基准版本: proj-claude-mem@b741d043"、"For agentic workers: 用 subagent-driven-development/executing-plans 逐任务实施本计划")。Round 1–7 的评审均在此共识下进行;Round 8 fresh-eyes 提示词缺失"sign-off before implementation begins"框定,导致把计划评审误读为验收审计。四项"blocker"逐条对应的恰是 Task 1–6 的计划内容本身。
   - Action: 无 spec 修改;后续 Final 轮提示词补充"this is a pre-implementation plan review; implementation follows approval"的事实框定(不影响内容评审强度)。
2. **验证观察: 全量污染集不稳定(71 vs 70 行基线,多出的 readiness 测试单跑 20/20)**
   - Verdict: ACCEPTED(有价值的新事实)
   - Evidence: 同一 HEAD 两次全量运行,污染失败集大小可在 70/71 间抖动 —— 严格 diff-empty gate 会对既有抖动误报。
   - Action: 测试约定基线条目新增**基线抖动裁决**程序:diff 新增行 → 单独跑该文件;单跑 100% pass 且不在本计划触及清单 → 判污染抖动、记录放行;单跑失败或属本计划触及文件 → 判回归、修复后重跑。

**Spec body updated**: Yes(测试约定基线抖动裁决)
**Open issues remaining**: 0

---

### Round 9
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Final Review(fresh-eyes gate,提示词已补"pre-implementation plan review; implementation follows approval"事实框定 —— 修正 Round 8 把计划评审误读为完成度审计的类别错误)

发现 1 个计划级阻塞项,暂不能签字:

- Task 3 漏改了 `tests/worker/summary-lane.test.ts:256`。该用例依赖 `createSDKSession()` 创建 NULL 锚来覆盖 SummaryLane skip 分支。默认 OFF 后,新行会获得 `cm-` 锚,因此 `SummaryLane.ts:259` 不再 skip,现有 SSE、`skipped` 计数及无 summary 行断言必然失败。此失败不在 70 行基线中。应把该文件加入 Task 3,并在测试建行后显式 `updateMemorySessionId(sessionDbId, null)`,保留原 skip 场景。

另有一处非阻塞事实修正:`src/services/sqlite/sessions/create.ts` 导出的函数也叫 `createSDKSession`,不是计划所称的 `createSession`;不过确认没有生产调用方,因此"不修改它"的结论仍可成立。

其余核心架构、三处清锚站点、FK 级联、SessionManager 致命 gate、settings 有效路径及当前机器配置均与基线相符。

**Verdict**: REJECTED
**Next action**: Response to Round 9

> 编排者注(评审 4.3 反漂移):Round 8 Final 的 4 项"阻塞"(实现缺席 / 行为未变 / 遥测未实现 / 调优未应用)是**类别错误** —— fresh-eyes 提示词剥离历史后丢失了"这是实施前计划、实现在批准后执行"的框定,把计划评审当成了完成度审计。Round 9 在 Template C 之上显式补回该框定,Codex 遂回到**计划质量**评审,产出上面这条真实、可核实的具体缺陷(而非重复的类别错误)。故 Round 9 属**有价值的非冗余轮次**,非漂移。

---

### Response to Round 9
**Responder**: Claude Code

**Findings addressed**: 1 项阻塞(R9-1)+ 1 项非阻塞事实订正(R9-2)

1. **R9-1: Task 3 漏改 `tests/worker/summary-lane.test.ts` 的 skip-path 用例**
   - Verdict: ACCEPTED
   - Evidence: 逐一核实属实。`summary-lane.test.ts:256-297` 的 `skip path` 用例在 `:261` `store.createSDKSession('content-no-mem', 'test-project', 'p')` 后留 NULL 锚(`:262` 注释),据此断言 `broadcasts.length === 0`、`counters.skipped >= 1`、`session_summaries` 空,以覆盖 `SummaryLane.ts:258-267` 的 `if (!sessionRow || !sessionRow.memory_session_id)` skip 分支。Task 3 落地后(默认 OFF)`createSDKSession` 经 `mintInitialAnchor()` 吐 `cm-` 锚 → `memory_session_id` 非空 → skip 不触发 → 三条断言必然失败。该文件未在 Task 3 Files/`git add` 中,`grep summary-lane` 全 spec 无命中 → 确属遗漏。且该用例不在 70 行污染基线内(核实 `attn_sink/baseline-test-failures-*.txt` 无 `summary-lane`),当前 PASS → 破坏即为**新增失败**。同文件仅此一处依赖建行 NULL:`seedSession`(`:137-138`)建行后即 `ensureMemorySessionIdRegistered(…, 'mem-abc')` 覆盖锚,`success path`(`:206`)与 `drain timeout`(`:299`)用例的会话均带有效锚,不受影响;`updateMemorySessionId`(`SessionStore.ts:58`)存在且对不同值无条件写入,修复可行。
   - Action: Task 3 已更新 —— ① Files 增列 `tests/worker/summary-lane.test.ts`;② 新增 **Step 3c**:建行后显式 `store.updateMemorySessionId(sessionDbId, null)` 还原 skip 前提(模式无关,无需新增 import);③ Step 4 运行命令与 Step 5 `git add` 均补入该文件。
2. **R9-2: 背景注误记 `create.ts` 内独立函数名为 `createSession`**
   - Verdict: ACCEPTED(事实订正,非阻塞)
   - Evidence: 核实 `create.ts:20` 导出的是 `createSDKSession(db, …)`(db-first 函数式变体),`src/` 内 `grep -E "\bcreateSession\b"` 零命中;`Sessions.ts:11` 以 `export * from './sessions/create.js'` re-export 之。运行时路由走的是 `SessionStore.ts:642` 的同名类方法(内联 INSERT,不委托 create.ts),create.ts 版无生产调用方 → 原"不修改它(YAGNI)"结论成立,仅函数名记述有误。
   - Action: 背景注订正为"db-first 独立函数 `createSDKSession`(经 `Sessions.ts:11` `export *` re-export;先前误记为 `createSession`),经核实无生产调用方",结论不变。

**Spec body updated**: Yes(Task 3 Files + Step 3c + Step 4/5 命令;背景注函数名订正)
**Open issues remaining**: 0(R9-1 已在计划层修复,R9-2 为文档订正)

---

### Round 10
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

未发现新的计划级阻塞项。

- R9-1 已充分修复:Task 3 已将 `summary-lane.test.ts` 纳入 Files、定向测试命令和 `git add`;Step 3c 在建行后显式写回 NULL,准确恢复 `SummaryLane.ts:258` 的 skip 前提。`seedSession` 会立即覆盖锚,其他相关用例不受影响。
- R9-2 的实质事实已订正:独立函数确为 `createSDKSession(db, …)`,由 `Sessions.ts` 重导出,未发现生产调用方。
- 仅剩一处非阻塞文案残留:计划第 1370 行仍写作 `createSession`,建议实施时顺手改成 `createSDKSession`。这不影响范围或执行正确性。
- 已确认 HEAD 为预期基线 `b741d043`;按要求未运行全量或慢测试,也未修改文件。

**Verdict**: APPROVED
**Next action**: Final review

### Response to Round 10
**Responder**: Claude Code

无阻塞项需处理。Codex 指出的唯一非阻塞文案残留(spec 第 1370 行 "未决/YAGNI" 段仍写 `createSession`)已**顺手订正**为 `createSDKSession(db, …)`(db-first 变体,附 R9-2 注)。Review Log 内 R9-2 处的 `createSession` 系记述"先前误记的旧名",保留不动。Focused APPROVED → 下一轮为 Final fresh-eyes gate(带 pre-implementation-plan 框定)。

**Spec body updated**: Yes(第 1370 行函数名订正)
**Open issues remaining**: 0

---

### Round 11
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Final Review(fresh-eyes gate,带 pre-implementation-plan 框定)

当前计划暂不能签字。核心锚模型可行,但有两个计划级阻塞项,**与"实现尚未开始"无关**:

1. **Task 6 查询了错误的日志目录。** 计划用 `paths.LOGS_DIR`,但 logger 明确固定写入 `homedir()/.claude-mem/logs`、不尊重 `DATA_DIR`(`logger.ts:62`)。本机计划查询 `/home/shinewine/.claude-mem/logs`(空),实际日志在 `/root/.claude-mem/logs`。故占比和 `DEAD_LETTER` 验收会读不到数据。必须改验收路径,或把 logger 路径修正纳入实施范围。
2. **Task 3 的子进程测试并非其声称的 hermetic。** 计划直接 `JSON.parse(res.stdout.toString().trim())`(spec:775)。干净环境无 settings 文件时,`loadFromFile()` 会创建文件并向 stdout 输出提示(`SettingsDefaultsManager.ts:267`),stdout 不再是单个 JSON → 解析必然失败,且会修改真实用户目录。应给子进程固定临时 `CLAUDE_MEM_DATA_DIR`、预建扁平 settings 并清理,或至少用明确输出 sentinel。

另需修正文案:Task 3 单独部署时"cm 锚下无子行"并不保证成立;SummaryLane 见 DB 锚非空即可运行并写 summary(`SummaryLane.ts:258`)。不过 `ON UPDATE CASCADE` 使后续 SDK 覆盖仍安全,故非架构阻塞,只是部署安全论证需改准确。

其余关键前提已核实:HEAD 正确、bypass gate、三处清锚、SessionManager blanket-null、FK CASCADE、SummaryLane 检索口径及 `markFailed` 返回类型均与计划基本一致。快速跑了相关基线测试,14/14 通过;未修改任何文件。

**Verdict**: REJECTED
**Next action**: Response to Round 11

> 编排者注(评审 4.3 反漂移):Round 11 的两项阻塞是**真实、可核实、非类别错误**的计划缺陷 —— 正是"带正确框定的 Final fresh-eyes gate"应捕获的东西(锚定的 Focused 轮次漏掉了它们)。故 Round 11 属高价值轮次,非冗余漂移。

---

### Response to Round 11
**Responder**: Claude Code

**Findings addressed**: 2 项阻塞(R11-1/R11-2)+ 1 项非阻塞文案(R11-3)

1. **R11-1: Task 6 验收查错了日志目录(`paths.LOGS_DIR` vs logger 实际 homedir 落盘)**
   - Verdict: ACCEPTED
   - Evidence: 运行时实证属实。`logger.ts:29` `DEFAULT_DATA_DIR = join(homedir(), '.claude-mem')`,`:64` `logsDir = join(DEFAULT_DATA_DIR, 'logs')`,源码注释明写 "always based on the default, not user settings"(规避与 SettingsDefaultsManager 循环依赖)。而 `paths.ts:55` `LOGS_DIR = join(DATA_DIR, 'logs')` 用的是 **resolved** `DATA_DIR`。本 pod:`homedir()=/root` → logger 真实写 `/root/.claude-mem/logs`(实测存在当天 1.76MB 日志);`paths.LOGS_DIR` = `/home/shinewine/.claude-mem/logs`(实测空)。R6-1 曾把日志路径"改为运行时解析 LOGS_DIR",但那按 settings 口径解析,对**日志**是错的 —— settings 走 resolved DATA_DIR、logs 走 homedir 默认,两者口径不同。
   - Action: Task 6 Step 4 占比命令改为读 logger 真实目录:`LOGS_DIR=$(bun -e 'const {homedir}=require("os");const {join}=require("path");console.log(join(homedir(),".claude-mem","logs"))')`;并加显式警示"日志目录 ≠ settings/DB 目录,勿混用两种解析口径"。`DEAD_LETTER` grep 承接同一 `$LOGS_DIR`,一并修正。
2. **R11-2: Task 3 子进程 probe 非真 hermetic(stdout 污染 + 真实目录写入)**
   - Verdict: ACCEPTED
   - Evidence: 核实 `SettingsDefaultsManager.loadFromFile`(`:268-288`)在 `!existsSync(settingsPath)` 时会 `writeFileSync` 创建文件并 `console.log("[SETTINGS] Created settings file...")`。原 probe 既未固定临时 `CLAUDE_MEM_DATA_DIR`(→ 写真实 `~/.claude-mem`,违反 test-filesystem-hygiene),又直接 `JSON.parse(stdout.trim())`(→ 干净环境下创建提示行混入 stdout,解析必失败)。
   - Action: probe 三重加固(同时满足 Codex 两条建议):① 子进程固定 `CLAUDE_MEM_DATA_DIR=mkdtempSync(tmpdir/cm-anchor-probe-)` 且预建扁平 `settings.json`(`{}`;flag 由 env 覆盖,内容无关)→ loadFromFile 走"读"而非"创建",零 stdout 提示、零真实目录写入;② 输出加 `CM_PROBE_JSON:` sentinel,parent 只解析该前缀行(对任何杂散 stdout 免疫);③ `finally` `rmSync` 清理(mkdtemp↔rmSync 满足文件系统卫生 guard)。补 import:`mkdtempSync/writeFileSync/rmSync`、`tmpdir`、`join`。
3. **R11-3: "cm 锚下无子行"部署安全论证不准确**
   - Verdict: ACCEPTED(文案精度,非阻塞;Codex 亦确认非架构阻塞)
   - Evidence: 属实 —— Task 3 单独部署窗口内,SummaryLane 读 DB 锚(非内存)见 cm- 锚非空即可 summarize 并写 `session_summaries` 子行,故"无子行"不成立。真正的安全保证是 `memory_session_id` 上的 `ON UPDATE CASCADE`:SDK 覆盖锚时子行 FK 同步迁移。
   - Action: 部署顺序安全说明(spec 第 340 行)订正为"可能已写入 summary 子行,但 ON UPDATE CASCADE 保证覆盖安全 —— legacy 等价来自 CASCADE 而非子行缺席"。

**Spec body updated**: Yes(Task 6 Step 4 日志路径 + 警示;Task 3 probe 三重加固 + import;第 340 行部署安全论证)
**Open issues remaining**: 0

---

### Round 12
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

一个阻塞项残留;两个修复已完成。

- **R11-1 已解决。** Task 6 现在派生 `homedir()/.claude-mem/logs`,与 `logger.ts:29` 一致,占比与 `DEAD_LETTER` 命令都用该目录。运行时核实 `/root/.claude-mem/logs` 有日志而 resolved `paths.LOGS_DIR` 没有。
- **R11-3 已解决。** 部署文案正确承认可能有 summary 子行,且当前 schema 的 `ON UPDATE CASCADE` 会迁移 summary 与 observation 两类子行(定向内存 UPDATE 实证两个 FK 均从 `cm-old` 迁到 SDK id)。
- **R11-2 仅部分解决。** 子进程 probe 路径现在是可靠的(临时 data dir、预建 settings、sentinel 解析、清理都对)。但同一测试保留了一个**在进程内**的 idempotency 用例(spec:823)。Task 3 后该调用会到达 `mintInitialAnchor()` → `loadFromFile(USER_SETTINGS_PATH)`;干净环境下 `SettingsDefaultsManager`(`:268`)会创建真实 settings 文件,且仍暴露于跨文件 `mock.module` 污染。**影响不止新用例**:至少 **15 个既有测试文件**在进程内调 `SessionStore.createSDKSession()` 且未重定向 `CLAUDE_MEM_DATA_DIR`。计划需要集中式隔离策略 —— **最好是给锚派发做非创建式 settings 读取** —— 或显式隔离所有受影响调用。至少,新 idempotency 断言可复用 `probeAnchor()`。

HEAD 仍正确停在基线 `b741d043`;未修改文件、未跑全量套件。

**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 12

---

### Response to Round 12
**Responder**: Claude Code

**Findings addressed**: R11-1/R11-3 确认已解决;R11-2 残留(记为 R12-1)ACCEPTED 并按 Codex 首选方案(集中式非创建读取)根治

1. **R12-1: `createSDKSession → mintInitialAnchor() → loadFromFile` 的建行侧副作用(创建真实 settings 文件 + mock 污染暴露),波及 15 个在进程内 `store.createSDKSession` 的既有测试**
   - Verdict: ACCEPTED(真实、可核实;非类别错误)
   - Evidence(独立核实,含对 Codex 数字的校准):
     - 副作用机制属实:`observerResumeEnabled()` 无参时回退 `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)`;`loadFromFile` 在文件缺失时 `writeFileSync`+`chmodSync` 创建(`SettingsDefaultsManager.ts:268-288`)、legacy 嵌套时改写(`:307-331`)。
     - **精确 blast radius**:全仓 `createSDKSession` 测试调用点共 39 个文件,但其中 **20 个用的是 `create.ts` 的独立函数 `createSDKSession(db,…)`(Task 3 不改它 → 仍 NULL、不读 settings)**,真正受影响的是用 **`store.createSDKSession(...)` 方法的 15 个文件**(与 Codex "15+" 吻合)。
     - **hygiene gate 现状**:`test-filesystem-hygiene.test.ts` 是**静态**扫描(只查测试源码里 `homedir()`+write 模式),不会捕获生产代码 `loadFromFile` 的真实目录写入 —— 故 CI 不会红,但**确会**在 clean 环境写真实 `~/.claude-mem` 并留存文件影响后续测试(违反仓库"never write production paths"原则)。
     - **Issue B(锚值 NULL→cm-)已完备**:核查 15 个方法调用者,依赖建行 NULL 的仅 3 个(`session_id_usage_validation`/`fk-constraint-fix`/`summary-lane`,均已修);`session_store.test.ts`(建行后即 `updateMemorySessionId` 覆盖)、`summary-null-memory-session.test.ts`(直接向 store 方法传 `null`,不读行锚)**不依赖**行锚为 NULL → 无需改。
   - Action(Codex 首选的"集中式非创建读取",根治 15 个调用者):
     - **Task 1**:`observer-anchor.ts` 新增自包含、非创建、mock 无关的 `readObserverResumeFlag()`(env > settings.json 只读[flat/legacy `{env:{…}}`] > 硬编码默认 `false`),`observerResumeEnabled(无参)` 改走它;**移除对 `SettingsDefaultsManager.loadFromFile` 的依赖**(改 import `fs` 的 `existsSync/readFileSync`)。副带去掉 5s TTL 陈旧窗口。`SettingsDefaultsManager` 仍新增该键(默认单一来源 + GET 只读回显),但不在建行热路径被调。
     - **Task 3**:idempotency 用例改**复用 `probeAnchor()`**(子进程内已建行两次,直接断言 `id2===id1 && a2===a1`)—— 移除最后一个进程内 flag 敏感调用;并新增"**非创建读取:建行不创建缺失的 settings.json**"子进程用例(空临时 data dir + 无 flag env → 断言锚为 `cm-` 且 `<dataDir>/settings.json` 未被创建),把非创建保证锁进回归。
     - 同步更新:关键事实 #6、Task 1 背景、fs import。
   - 备注:这也让计划更**简单**(无需给 15 个测试逐个加 `CLAUDE_MEM_DATA_DIR` 隔离),符合反膨胀 —— 根因修一处、全体受益。

**Spec body updated**: Yes(Task 1 `observer-anchor.ts` 非创建读取 + import;事实 #6;Task 1 背景;Task 3 idempotency 复用 probeAnchor + 新增非创建用例 + `existsSync` import)
**Open issues remaining**: 0

---

### Round 13
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

核心修复方向正确,但计划正文尚未完整收口。已确认:R11-1/R11-3 保持已解决;**R12-1 核心设计有效**(新读取不调 `loadFromFile()`,缺失/legacy 文件不被创建/改写,env>flat/legacy>默认优先级实现正确);基线确有 15 个文件调 `store.createSDKSession()`、仅 3 个依赖初始 NULL 且均已调整;idempotency 已正确并入 probe、no-create 子进程断言有效。

仍有阻塞项(计划正文一致性 + 测试覆盖):
1. 计划正文仍有旧方案残留:声称调 `SettingsDefaultsManager.loadFromFile()`、5s TTL、idempotency 保留进程内(probe 注释、验收标准 #3 同样)。与已改的代码块矛盾,须删/更新;尤其把"下一新会话立即读取最新文件值"写入回退验收。
2. 新读取器的"已有文件"分支无测试:当前 probe 只覆盖 env override + 文件缺失默认。应加临时 settings 文件 flat `"true"`、legacy `{env:{...}}`、env 覆盖文件的子进程断言 —— 这是手工 settings 开关的实际生产路径。
3. "mock-independent"表述略宽:`observer-anchor.ts` 仍经 `paths.ts` 间接导入 `SettingsDefaultsManager`;要么拆出轻量路径解析,要么把声明收窄为"不调用 `loadFromFile`"。

未修改文件,未运行完整测试套件。

**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 13

---

### Response to Round 13
**Responder**: Claude Code

**Findings addressed**: 3 项(均 ACCEPTED;R12-1 核心设计已被 Codex 确认有效,以下为收口/覆盖/措辞)

1. **R13-1: 计划正文旧方案残留,与已改代码块矛盾**
   - Verdict: ACCEPTED
   - Evidence: 核实确有多处旧语义:Task 3 Step 1 Hermeticity 注(声称读 `loadFromFile`+5s TTL、幂等保留进程内)、验收标准 #3(`loadFromFile` 5s TTL 陈旧窗口)、C2 备注(TTL 缓存失效)。另 `flag has no UI exposure`/`POST 白名单` 用例注(第 339 行)提到 `loadFromFile` 是**正确**的 —— 那是 GET `/api/settings` 全量合并回显路径,与建行读取不同码路,保留不动。
   - Action: 全部收口 —— Hermeticity 注改写为"建行走非创建式 `readObserverResumeFlag()`、不调 `loadFromFile`、无 TTL;子进程仍用于 env pin/mock 隔离/真实目录隔离;幂等已并入子进程 probe";验收标准 #3 删 TTL 陈旧窗口、**明确写入"下一新会话即读到最新值"**;C2 备注去 TTL;测试方针条(第 43 行)同步。事实 #6、Task 1 背景已在上一轮改毕。
2. **R13-2: 非创建读取器的"已有文件"分支无测试**
   - Verdict: ACCEPTED(真实覆盖缺口 —— 手工 settings 开关的生产路径)
   - Evidence: 原 probe 仅覆盖 env override(flag env)与文件缺失默认;`existsSync→readFileSync→解析 flat/legacy` 分支确无断言。
   - Action: `probeAnchor(flagValue)` 重构为参数化 `probe({ flagEnv?, settingsFile? })`(返回增 `settingsCreated`),新增 4 个子进程用例:settings.json flat `"true"`→NULL、legacy `{env:{…"true"}}`→NULL、`"false"`→cm-、env `"true"` 压过 file `"false"`→NULL;idempotency 与 no-create 用例并入同一 helper。全部 flag 分支(env/flat/legacy/env-over-file/缺失-默认-不创建)现均有子进程覆盖。
3. **R13-3: "mock-independent"表述略宽**
   - Verdict: ACCEPTED(措辞精度)
   - Evidence: 属实 —— `observer-anchor.ts` 经 `paths.ts` 间接导入 `SettingsDefaultsManager`(`paths.ts` tier-3 用 `SettingsDefaultsManager.get`)。但 `USER_SETTINGS_PATH` 是 paths.ts 模块加载期冻结的**字符串常量**,建行读取运行时**不调用任何 `SettingsDefaultsManager` 方法**(只用 `fs`),故不会因泄漏 mock 崩溃。
   - Action: 选择**收窄声明**(而非为此拆分 `paths.ts` 路径解析 —— 那是过度工程:常量已在加载期冻结,读取只用 `fs`)。impl 注释首行改为"Non-creating, `loadFromFile`-free",并新增精确范围说明:唯一耦合是 `paths.ts` 的 `USER_SETTINGS_PATH` 常量,读取不调 `SettingsDefaultsManager` 任何方法。

**Spec body updated**: Yes(Hermeticity 注、验收标准 #3、C2、测试方针条、impl 注释;probe 参数化重构 + 4 个 settings.json 分支用例)
**Open issues remaining**: 0

---

### Round 14
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

无阻塞项。

- **R13-1 已解决**:计划正文一致陈述非创建式、无 `loadFromFile`、无 TTL 的建行读取;幂等基于子进程;验收标准 #3 正确写明下一新会话即时读到文件变更。残留的 `loadFromFile` 提及要么描述已废弃行为、要么是合法的 GET `/api/settings` 路径。
- **R13-2 已解决**:probe 现覆盖 flat 与 legacy-nested settings 文件、两种 flag 值、env 压过文件、文件缺失/不创建、以及子进程幂等。
- **R13-3 已解决**:措辞明确不再声称完全 mock 独立,准确说明经 `paths.ts` 的传递依赖;基线确认 `USER_SETTINGS_PATH` 在模块加载期冻结,读取本身只调 `fs`。
- 基线仍为 `b741d043`;实现缺席属预期;未修改文件、未跑全量套件。

**Verdict**: APPROVED
**Next action**: Final review

### Response to Round 14
**Responder**: Claude Code

无阻塞项需处理。Focused APPROVED,所有 R13 收口项确认解决。下一轮为 Final fresh-eyes gate(带 pre-implementation-plan 框定)。

**Spec body updated**: No
**Open issues remaining**: 0

---

### Round 15
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Final Review(fresh-eyes gate,带 pre-implementation-plan 框定)

**No blocking plan-level defects found. The plan is technically sound, feasible, and safe to implement in the stated Task 2 → 3 → 4 order.**

针对基线 `b741d043` 逐条核实(全部与计划相符):bypass 的 null-anchor gate 与 SDK/bypass 竞争消费者描述准确;`SessionManager` 确实 blanket-null 持久锚,选择性只恢复 `cm-` 锚是必要修复;三处 worker 侧清锚站点识别正确;两个子表都用 `ON UPDATE CASCADE`,把被引用锚更新为 NULL 确会撞 `NOT NULL`;`SessionStore.createSDKSession` 是活跃建行路径、独立函数式变体无生产调用方;SummaryLane 观测检索按 content-session/prompt、fresh summarize 不 resume;后端-only 设置不违反 build-time UI 对齐检查;logger 与有效 settings 目录确实分别解析;70 行基线文件存在;未跑全量套件、未改任何文件。

**非阻塞清理建议(实施期,不威胁解耦目标、不需架构改动)**:① `SessionRoutes.ts:1114` 的 `isNewSession=!memory_session_id` 遥测在 cm- 模式失真;② 澄清 GET `/api/settings`(读 homedir 引导文件)与建行(读 resolved `USER_SETTINGS_PATH`)的 settings 源差异;③ 验收标准 #3 "byte-for-byte" 宜改 "functionally equivalent"。

**Verdict**: APPROVED
**Next action**: —(终局:Final APPROVED)

> 编排者注:Round 15 为终局。三项非阻塞建议已并入 spec —— ③ 已直接应用于验收标准 #3;①② 记入新增"实施期非阻塞清理(评审 R15)"小节供 file-to-prod 顺带处理。

### 复盘小结(oh-my-review 全程,评审 4.3 反漂移视角)
- **总轮次**:15 轮(预算 20)。Initial→Focused×4(R1–4 迭代)→R5 Focused APPROVED→R6 Final REJECTED(2 真实阻塞:Task6 错设置文件 / sqlite3 CLI 缺失)→R7 Focused APPROVED→**R8 Final REJECTED = 类别错误漂移**(把实施前计划当完成度审计)。
- **反漂移干预**:R8 漂移根因是 Template C fresh-eyes 剥离历史后丢失"pre-implementation plan"框定 → 从 R9 起所有 Final/Focused 提示词显式补回该框定。此后 R9(Task3 漏 summary-lane 测试)、R11(Task6 错日志目录 + probe 非 hermetic)、R12/R13(createSDKSession→loadFromFile 副作用波及 15 个在进程测试 → 集中式非创建读取根治 + 测试覆盖 + 文案收口)均为**真实、可核实、非冗余**发现。
- **终局**:R14 Focused APPROVED → R15 Final fresh-eyes gate APPROVED。计划技术健全、可行、Task 2→3→4 顺序安全。Review Log 完整留痕于本文件。
