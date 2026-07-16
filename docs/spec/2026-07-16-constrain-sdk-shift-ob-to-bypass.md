# 约束 SDK 触发 / 迁移 OB 至 Bypass — 实施计划

> **日期**: 2026-07-16
> **状态**: 活跃(oh-my-review 6 轮跨模型审阅通过,2026-07-16)
> **作者**: wangjiazhe(+ Claude Opus 4.8;v2 修订 by Claude Fable 5)
> **基准版本**: `proj-claude-mem@205b9101`
> **目的**: 削减 Claude SDK 订阅消耗——安全削减低价值 OB,并把绝大多数真实 OB 从 SDK observer 迁到便宜的 opencode Bypass 通路。
> 范围: `proj-claude-mem` / worker 子系统(BypassLane、observation-filter、SettingsRoutes、Settings)
> 修订: v2(2026-07-16)——sim-review 全量代码核查后按 5 项已确认决策修订,见「v2 修订记录」。

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个数字开关 `CLAUDE_MEM_BYPASS_CONCURRENCY` 把 OB 处理重心从 SDK 迁到便宜的 openai bypass 通路(C=1 保持现状,C>1 扩容),并用分级熔断 + Layer A 过滤把成本进一步压低。

**Architecture:** 三块正交改动。① Route A:`observation-filter.ts` 增加 Bash 命令提取 + 复合命令守卫,只跳纯导航噪声(cat/head/tail 收窄到噪声路径,与 Read 模式镜像);② 失败分类:把 429 从 `quota` 拆成新的 `ratelimit` 短冷却类别,冷却时长全部改可配;③ C 路并发:`BYPASS_CONCURRENCY>1` 时每会话起 C 个 bypass 消费者 + 全局并发信号量 G 包住 REST 调用。**生命周期与 abort 语义零改动**——v1 的"解耦手术"(gate generator-exit stop)经核查被 idle-abort 架空(见修订记录决策 1),已整体移除。

**Tech Stack:** TypeScript(ESM,`.js` 扩展名 import)、`bun:test`、better-sqlite3、Express。构建 `bun run build-and-sync`。

---

## v2 修订记录(sim-review 决策,2026-07-16)

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 生命周期解耦手术 | **移除**。已核实 idle 超时回调 abort 的是**会话级** `session.abortController`(`SessionManager.ts:1136`),bypass 经 combined signal 必随之停;gate `:297` 的真实收益只剩 pool-cooldown / unrecoverable-error 罕见窗口,不值得在历史 bug 最密集区引入新语义状态。Task 8 只保留"每会话 C 个 consumeLoop + 守卫式删除",所有 `stopForSession` 站点保持无条件原样。 |
| 2 | pool=3 + 45s idle 快释放 | **移除**(实际并发画像常 ≤3,双旋钮空转)。原 Task 6(idle 参数化)、Task 9(45s 释放)、`CLAUDE_MEM_BYPASS_IDLE_RELEASE_MS` 键全部删除;机器保持 `MAX_CONCURRENT_AGENTS=5` 不动。 |
| 3 | 默认 SKIP 的 cat/head/tail | **收窄到噪声路径**(`Bash:cat *.log`、`Bash:cat */logs/*` 等,与 Read 噪声模式镜像),独立 cat 读源码的观测保留(`files_read` 不断流)。 |
| 4 | 冷却分级测试策略 | **行为夹具为主**:复用并扩展 `tests/worker/bypass-openai.test.ts` 既有 white-box 套路((lane as any) 注入),删除 v1 计划中的 `bypass-cooldown-tiers.test.ts` 源码断言文件。 |
| 5 | 小项 | 删除 M3 TTL 缓存(`loadFromFile` 本身已有 5s TTL,`SettingsDefaultsManager.ts:230-252`);复合守卫**永远优先**于用户显式 `Bash:*`(硬规则,代码注释注明);Layer A 加跳过计数。 |

v2 同时落地的审计修复:
- **F1.1(BLOCKER)**:v1 的 consumeLoop 重写在空队列路径 `if (!message) continue;` 会跳过尾部退避形成热自旋(`continue` 经 finally 直接回 while 顶部)。v2 的替换代码已修正(空队列/失败退避在信号量释放**之后**执行),并新增空队列退避行为测试防回归。
- **F5.1**:验收 grep 全部按 logger 真实渲染校准。已核实:logger 行格式为 `时间戳 LEVEL COMPONENT message`(component **不带方括号**);metadata 对象在 INFO 级仅 ≤3 键内联紧凑 JSON(`"category":"ratelimit"` 无空格),**>3 键只渲染摘要、字段不可见**;完整 pretty JSON 仅 DEBUG 级。故 `messageKind`/`storeAction` 类字段的验证必须在临时 DEBUG 窗口进行。
- **F5.3**:新设置键全部进 `validateSettings` 界校验(v1 只校验了 3 个键中的部分)。
- **计数落点修正**:决策 5 批准的"skippedObservations 进 `ActiveSession.optimizationStats`"经核查不可行——Layer A 跳过发生在 `handleObservationsByClaudeId`(`SessionRoutes.ts:803-830`),该点 session 尚未解析(仅有 `contentSessionId` 字符串)。改为 observation-filter 模块级计数 + `/api/status` 暴露,验证靠既有 INFO 日志行 `Skipping observation by pattern filter`(语义等价于批准意图)。
- 关键架构事实 v1 第 3 条的两处笔误修正(`worker-service.ts:786` 实为 `.catch` 的 terminated-session teardown 分支;"SessionRoutes.ts:634" 站点不存在)。

## 关键架构事实(实现者必读)

1. **竞争消费者**:SDK observer generator 与 bypass 消费者抢同一个 `pending_messages` 队列的 observation 行;SDK 批认领(`claimNextObservationBatch`),bypass 单认领(`claimNextObservation`,事务原子,`PendingMessageStore.ts:167` 附近)。SDK 稳赢 → 现状 165 vs 14;C=3 靠"SDK 单推理期间 bypass 三路连续认领"翻转比例。
2. **bypass 依赖 SDK 播种**:`BypassLane.consumeLoop`(`BypassLane.ts:511`)会等 `session.memorySessionId` 被 SDK INIT 填好才处理。**INIT 永远留在 SDK**,本计划不动它。
3. **生命周期(v2 修正版,本计划零改动)**:bypass 由 `startForSession` 启动(站点:`SessionRoutes.ts:221`、`worker-service.ts:732`),由 `stopForSession` 停止(站点:SessionRoutes `:111/:168/:297/:444`,worker-service `:634/:786/:955/:962/:1024/:1052/:1055`)——**全部保持无条件,一处不改**。idle 超时回调 abort 会话级 controller(`SessionManager.ts:1136`)→ combined signal(`AbortSignal.any`,`BypassLane.ts:273`)→ bypass 随 generator 一起停;新观测到达时 `ensureGeneratorRunning('observation')`(`SessionRoutes.ts:667/:905`)重启 generator 并连带重启 bypass。SDK claim 扑空才会 idle ⇒ idle 时队列必为空 ⇒ 停掉 bypass 无滞留风险(至多 C 条在途行由下次启动后的 60s self-heal 复位重放)。
4. **`loadFromFile` 自带 5s TTL 缓存**(`SettingsDefaultsManager.ts:230-252`,写入时 `invalidateCache` 精确失效)——热路径(per-acquire / per-obs)直接调用即可,**不要再包缓存层**。
5. **logger 渲染约束**(影响一切验证 grep):INFO 级下 metadata 对象 >3 键时字段不可见(仅摘要);≤3 键内联为紧凑 JSON(`"key":"value"` 无空格);DEBUG 级才输出完整 pretty JSON(`"key": "value"` 有空格)。message 字符串永远可见。grep 模式用 `-E '"key": ?"value"'` 兼容两种格式,或锚定 message 文本。
6. **Layer A 过滤位置**:仅 `handleObservationsByClaudeId`(`SessionRoutes.ts:803-830`)一处;跳过判定发生在 session 解析之前(手头只有 `contentSessionId` 字符串)。

## 测试约定(`tests/CLAUDE.md` 摘要,务必遵守)

- 框架 `bun:test`;全量 `bun test ./tests/` 是唯一 gate(基线约 2190 pass)。
- **`SettingsDefaultsManager` 被 15+ 文件 `mock.module`**:任何"校验默认值"的测试**不得 import 该模块**,改用 `readFileSync('src/shared/SettingsDefaultsManager.ts')` 源码断言。
- `mock.module()` 不可逆,禁止 mock handler 模块与 `fs`。
- 纯函数(`classifyBypassFailure`、`shouldSkipObservation`、`parseSkipPatterns`)可直接 import 测试。
- **行为级 white-box 夹具范例**:`tests/worker/bypass-openai.test.ts` 直接 `new BypassLane()` + `(lane as any)` 注入 config/stub 私有方法,**不碰 mock.module**——Task 5 的冷却路由测试、Task 7 的空队列退避测试都复用这个套路。
- `src/services/worker/` 下新文件必须 `import { logger }`(纯协调器可加入 `tests/logger-usage-standards.test.ts` 的豁免清单——该清单是 **RegExp 字面量数组**,如 `/generator-action\.ts$/`)。
- 改 `BypassLane.ts` 前 grep `tests/shared/bypass-settings-deadcode.test.ts`——它 pin 了 `BypassLane.ts` 不得含 `settings.CLAUDE_MEM_BYPASS_MAX_CONTEXT_MESSAGES` / `...MAX_TOKENS` 完整字面量(本计划新键 `MAX_CONSUMERS`/`MAX_FAILURES` 是不同子串,已核实不冲突)。

## 文件清单

| 文件 | 职责 / 改动 |
|------|-------------|
| `src/services/worker/http/routes/observation-filter.ts` | 【改】Bash 命令提取 + 复合守卫(Task 1);layerAStats 计数(Task 3) |
| `tests/worker/observation-filter.test.ts` | 【改】新增 Bash/Read 用例(Task 1) |
| `src/shared/SettingsDefaultsManager.ts` | 【改】SKIP 默认扩充 + 5 个新 bypass 键(Task 2/5/6) |
| `tests/worker/bypass-settings-defaults.test.ts` | 【新】源码断言默认值(Task 2/5/6) |
| `src/services/worker/http/routes/SessionRoutes.ts` | 【改】skip 计数自增两处(Task 3) |
| `src/services/worker-service.ts` | 【改】status 暴露 layerA 计数(Task 3) |
| `src/services/worker/BypassLane.ts` | 【改】`ratelimit` 分类、可配冷却、全局信号量、C 个消费者(Task 4/5/7/8) |
| `tests/worker/bypass-classify-failure.test.ts` | 【新】分类纯函数(Task 4) |
| `tests/worker/bypass-openai.test.ts` | 【改】常量改名修复 + 行为夹具扩展覆盖冷却路由(Task 5) |
| `src/services/worker/http/routes/SettingsRoutes.ts` | 【改】校验 + 白名单新键(Task 6) |
| `src/services/worker/global-semaphore.ts` | 【新】GlobalSemaphore 纯模块(Task 7) |
| `tests/worker/bypass-global-semaphore.test.ts` | 【新】信号量上限 + H1 顺序 pin + 空队列退避(Task 7) |
| `tests/logger-usage-standards.test.ts` | 【改】豁免 global-semaphore.ts(Task 7) |
| `tests/worker/bypass-concurrency.test.ts` | 【新】C 个 loop + M1 守卫源码断言(Task 8) |
| `CLAUDE.md`(根) | 【改】Bypass Lane 桶描述同步(Task 9) |
| `~/.claude-mem/settings.json`(机器,非仓库) | 【改】C=3 / G=6 / 冷却=3min(Task 10) |

---

## Chunk 1: Route A — 观测量安全削减

### Task 1: Bash 命令提取 + 复合命令守卫

**Files:**
- Modify: `src/services/worker/http/routes/observation-filter.ts:68-83`(`extractMatchField`)、`:92-109`(`shouldSkipObservation`)
- Test: `tests/worker/observation-filter.test.ts`(顶部已 import `parseSkipPatterns`/`shouldSkipObservation`,直接追加 describe)

**背景(已核实)**:`extractMatchField`(`:68-83`)只认 Read/Grep/Glob,Bash 落 `default: return undefined`,只能 `Bash:*` 整体跳(通配符分支在 `:101`,先于字段提取)。数据显示 `Bash(cd` 685 条里 327/338 是 `cd X && <真实工作>` 复合命令——前缀跳会误杀真实工作。守卫:命令含 `&&`/`||`/`;`/`|`/`$(`/反引号/`>`/`<` 一律**不跳**。

- [ ] **Step 1: 写失败测试**(追加到 `tests/worker/observation-filter.test.ts` 末尾)

```typescript
describe("Bash standalone-nav filtering", () => {
  const bashPatterns = parseSkipPatterns(
    "Bash:cd *,Bash:ls *,Bash:ls,Bash:pwd,Bash:pwd *,Bash:echo *,Bash:sleep *," +
      "Bash:cat *.log,Bash:cat */logs/*,Bash:head *.log,Bash:head */logs/*,Bash:tail *.log,Bash:tail */logs/*",
  );

  test("skips a pure standalone nav command", () => {
    expect(shouldSkipObservation("Bash", { command: "cd /repo" }, bashPatterns)).toBe(true);
    expect(shouldSkipObservation("Bash", { command: "pwd" }, bashPatterns)).toBe(true);
    expect(shouldSkipObservation("Bash", { command: "ls /tmp" }, bashPatterns)).toBe(true);
  });

  test("skips noise-path cat/tail, keeps source cat (Read-mirror narrowing)", () => {
    expect(shouldSkipObservation("Bash", { command: "cat /var/logs/app.txt" }, bashPatterns)).toBe(true);
    expect(shouldSkipObservation("Bash", { command: "tail -20 build.log" }, bashPatterns)).toBe(true);
    expect(shouldSkipObservation("Bash", { command: "cat src/index.ts" }, bashPatterns)).toBe(false);
  });

  test("does NOT skip compound command even if it starts with a nav verb", () => {
    expect(
      shouldSkipObservation("Bash", { command: "cd /repo && python train.py" }, bashPatterns),
    ).toBe(false);
    expect(
      shouldSkipObservation("Bash", { command: "cd /x && pytest -q" }, bashPatterns),
    ).toBe(false);
  });

  test("does NOT skip single-& background compound (R1-3)", () => {
    expect(
      shouldSkipObservation("Bash", { command: "cd /repo & pytest" }, bashPatterns),
    ).toBe(false);
    expect(
      shouldSkipObservation("Bash", { command: "echo starting & python run.py" }, bashPatterns),
    ).toBe(false);
  });

  test("does NOT skip a redirect (real work: writes a file)", () => {
    expect(shouldSkipObservation("Bash", { command: "echo hi > f.txt" }, bashPatterns)).toBe(false);
  });

  test("does NOT skip a non-nav command", () => {
    expect(shouldSkipObservation("Bash", { command: "python3 run.py" }, bashPatterns)).toBe(false);
  });

  test("does NOT skip Bash with no command field", () => {
    expect(shouldSkipObservation("Bash", {}, bashPatterns)).toBe(false);
  });
});

describe("Read noise-path filtering", () => {
  const readPatterns = parseSkipPatterns(
    "Read:*/logs/*,Read:*.log,Read:*/node_modules/*,Read:*/dist/*",
  );
  test("skips noise-path reads", () => {
    expect(shouldSkipObservation("Read", { file_path: "/x/logs/a.txt" }, readPatterns)).toBe(true);
    expect(shouldSkipObservation("Read", { file_path: "/x/app.log" }, readPatterns)).toBe(true);
  });
  test("keeps source reads", () => {
    expect(shouldSkipObservation("Read", { file_path: "/x/src/a.ts" }, readPatterns)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/worker/observation-filter.test.ts`
Expected: FAIL —「cd /repo」等 Bash 用例返回 false(Bash 尚未支持字段提取),compound 用例可能已 pass。

- [ ] **Step 3: 实现**(`observation-filter.ts`)

在 `extractMatchField` 的 `switch` 中,`default:` **之前**插入(`:80` 附近,`case 'Glob': case 'Grep':` 之后):

```typescript
    case 'Bash':
      return typeof toolInput.command === 'string' ? toolInput.command : undefined;
```

在 `shouldSkipObservation`(`:92`)函数体最前面、`for` 循环之前插入复合守卫:

```typescript
  // Bash compound-command guard: a command that chains, backgrounds, or redirects
  // (&, &&, ||, ;, |, $( ), backtick, >, <) almost always wraps real work
  // (e.g. `cd /repo && pytest`, `cd /repo & pytest`). Single `&`/`|` in the char
  // class subsumes `&&`/`||` (R1-3: bare `&` was originally missed).
  // HARD RULE: never skip these — deliberately overrides even an explicit
  // user-configured `Bash:*` wildcard (compound commands always get observed).
  if (toolName === 'Bash') {
    const command = typeof toolInput?.command === 'string' ? toolInput.command : undefined;
    if (command !== undefined && /[&;|<>`]|\$\(/.test(command)) {
      return false;
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/worker/observation-filter.test.ts`
Expected: PASS(全部用例)。

- [ ] **Step 5: 提交**

```bash
git add src/services/worker/http/routes/observation-filter.ts tests/worker/observation-filter.test.ts
git commit -m "feat(filter): extract Bash command with compound-command guard for Layer A skip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: 扩充 SKIP 默认(代码默认 + 源码断言测试)

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts:96-97`(SKIP_TOOLS)、`:145`(SKIP_TOOL_PATTERNS 默认值)
- Test: `tests/worker/bypass-settings-defaults.test.ts`(新建)

**注意**:`SettingsDefaultsManager` 被大量 `mock.module`,测试必须**源码断言**(`readFileSync`),不得 import 模块。

- [ ] **Step 1: 写失败测试**(新建 `tests/worker/bypass-settings-defaults.test.ts`)

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

const SRC = readFileSync("src/shared/SettingsDefaultsManager.ts", "utf-8");

describe("SKIP defaults expanded (Route A)", () => {
  test("SKIP_TOOLS includes ScheduleWakeup and ToolSearch", () => {
    expect(SRC).toContain("ScheduleWakeup");
    expect(SRC).toContain("ToolSearch");
  });
  test("SKIP_TOOL_PATTERNS includes standalone Bash nav and Read noise paths", () => {
    expect(SRC).toContain("Bash:cd *");
    expect(SRC).toContain("Read:*/node_modules/*");
    expect(SRC).toContain("Read:*.log");
  });
  test("cat/head/tail are narrowed to noise paths (decision 3), never blanket", () => {
    expect(SRC).toContain("Bash:cat *.log");
    expect(SRC).toContain("Bash:cat */logs/*");
    expect(SRC).not.toContain("Bash:cat *,");   // 一刀切形态不得出现
    expect(SRC).not.toContain("Bash:head *,");
    expect(SRC).not.toContain("Bash:tail *,");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/worker/bypass-settings-defaults.test.ts`
Expected: FAIL — 源码尚不含这些串。

- [ ] **Step 3: 实现**(`SettingsDefaultsManager.ts`)

替换 `CLAUDE_MEM_SKIP_TOOLS` 默认值(`:96-97`):

OLD:
```typescript
    CLAUDE_MEM_SKIP_TOOLS:
      "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion,Monitor,TaskUpdate,TaskCreate,TaskGet,TaskList,TaskStop,TaskOutput",
```
NEW:
```typescript
    CLAUDE_MEM_SKIP_TOOLS:
      "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion,Monitor,TaskUpdate,TaskCreate,TaskGet,TaskList,TaskStop,TaskOutput,ScheduleWakeup,ToolSearch",
```

替换 `CLAUDE_MEM_SKIP_TOOL_PATTERNS` 默认值(`:145`,当前值为
`"Read:*SKILL.md,Read:*/.claude/rules/*,Read:*settings.json,Read:*hooks.json,Glob:*"`):

OLD:
```typescript
    CLAUDE_MEM_SKIP_TOOL_PATTERNS:
      "Read:*SKILL.md,Read:*/.claude/rules/*,Read:*settings.json,Read:*hooks.json,Glob:*",
```
NEW:
```typescript
    CLAUDE_MEM_SKIP_TOOL_PATTERNS:
      "Read:*SKILL.md,Read:*/.claude/rules/*,Read:*settings.json,Read:*hooks.json,Glob:*," +
      "Read:*/node_modules/*,Read:*/dist/*,Read:*/build/*,Read:*/.git/*,Read:*/logs/*,Read:*.log,Read:*/tmp/*,Read:*/attn_sink/*," +
      "Bash:cd *,Bash:ls *,Bash:ls,Bash:pwd,Bash:pwd *,Bash:echo *,Bash:sleep *," +
      "Bash:cat *.log,Bash:cat */logs/*,Bash:cat */node_modules/*,Bash:head *.log,Bash:head */logs/*,Bash:tail *.log,Bash:tail */logs/*",
```

> 注 1:`Read:*SKILL.md` 里第一个 `*` 会跨 `/` 匹配(`globToRegex` 把 `*`→`.*`),与现有行为一致,不改。
> 注 2(决策 3):cat/head/tail **不做一刀切**——独立 `cat src/x.ts` 与 `Read src/x.ts` 信息等价,是 `files_read` 追踪的原料;只镜像 Read 的噪声路径。

- [ ] **Step 4: 运行确认通过 + 全量无回归**

Run: `bun test tests/worker/bypass-settings-defaults.test.ts && bun test ./tests/`
Expected: 新测试 PASS;全量 0 fail。

- [ ] **Step 5: 提交**

```bash
git add src/shared/SettingsDefaultsManager.ts tests/worker/bypass-settings-defaults.test.ts
git commit -m "feat(filter): expand SKIP defaults with nav/noise patterns (Route A)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Layer A 跳过计数(归因遥测)

**Files:**
- Modify: `src/services/worker/http/routes/observation-filter.ts`(模块级计数器)、`src/services/worker/http/routes/SessionRoutes.ts:813-830`(两处 skip 自增)、`src/services/worker-service.ts:295` 附近(status 暴露)
- Test: `tests/worker/observation-filter.test.ts`(轻量契约断言)

**背景(v2 核查)**:跳过点上 session 未解析(仅有 `contentSessionId`),不能挂 `ActiveSession.optimizationStats`;用模块级计数(与 SessionRoutes 既有 `cachedPatterns` 模块级缓存同风格)。进程内累计、worker 重启归零——与 `BypassLane.counters` 同语义,够用。

- [ ] **Step 1: 实现计数器**(`observation-filter.ts` 末尾追加)

```typescript
/**
 * Layer A skip counters — process-lifetime totals for attribution
 * (how much reduction came from filtering vs. bypass migration).
 * Reset on worker restart, same semantics as BypassLane.counters.
 */
export const layerAStats = {
  toolExcluded: 0,     // CLAUDE_MEM_SKIP_TOOLS exact-match skips
  patternFiltered: 0,  // CLAUDE_MEM_SKIP_TOOL_PATTERNS glob skips
};
```

- [ ] **Step 2: 两处自增**(`SessionRoutes.ts`,`handleObservationsByClaudeId` 内)

`skipTools.has(tool_name)` 分支(`:815` 附近,`logger.debug` 之前)加 `layerAStats.toolExcluded++;`;
`shouldSkipObservation(...)` 分支(`:827` 附近,`logger.info` 之前)加 `layerAStats.patternFiltered++;`。
import 从 `:13` 的既有 observation-filter import 里追加 `layerAStats`。

- [ ] **Step 3: status 暴露**(`worker-service.ts:295` 附近,`getAiStatus` 回调返回对象内、`bypass: this.bypassLane.getStatus(),` 之后;该 payload 经 `Server.ts:191` 挂在 **`GET /api/health` 响应的 `ai` 字段**下)

```typescript
        layerA: layerAStats,
```
顶部补 import:`import { layerAStats } from './worker/http/routes/observation-filter.js';`

- [ ] **Step 4: 轻量契约断言**(追加到 `tests/worker/observation-filter.test.ts`)

```typescript
describe("layerAStats counters", () => {
  test("exports mutable counters for both skip layers", () => {
    expect(typeof layerAStats.toolExcluded).toBe("number");
    expect(typeof layerAStats.patternFiltered).toBe("number");
  });
});
```
(import 行追加 `layerAStats`。自增行为经 Task 10 的日志 grep 验证——既有 INFO 行 `Skipping observation by pattern filter` 是 message 级文本,任意日志级别可见。)

- [ ] **Step 5: 全量 + 提交**

Run: `bun test ./tests/`
Expected: 0 fail。
```bash
git add src/services/worker/http/routes/observation-filter.ts src/services/worker/http/routes/SessionRoutes.ts src/services/worker-service.ts tests/worker/observation-filter.test.ts
git commit -m "feat(filter): layerAStats skip counters exposed via /api/status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Chunk 2: 失败分类 + 分级冷却(无条件生效,C=1 亦然——有意变更)

### Task 4: 新增 `ratelimit` 类别,429 从 quota 拆出

**Files:**
- Modify: `src/services/worker/BypassLane.ts:53`(类型)、`:96-110`(`classifyBypassFailure`)
- Test: `tests/worker/bypass-classify-failure.test.ts`(新建)

**背景**:`classifyBypassFailure`(纯函数、已导出)当前 `:105` 把 429 与 402 都归 `quota`(6h 冷却)。高并发下 429 限流会误触发 6h 熄火。裸 429(body 无 `insufficient_quota`)应归短冷却的 `ratelimit`。

- [ ] **Step 1: 写失败测试**(新建 `tests/worker/bypass-classify-failure.test.ts`)

```typescript
import { describe, test, expect } from "bun:test";
import { classifyBypassFailure } from "../../src/services/worker/BypassLane.js";

describe("classifyBypassFailure", () => {
  test("bare 429 -> ratelimit (not quota)", () => {
    expect(classifyBypassFailure(429, {})).toBe("ratelimit");
  });
  test("429 with insufficient_quota body -> quota", () => {
    expect(classifyBypassFailure(429, { code: "insufficient_quota" })).toBe("quota");
  });
  test("402 -> quota", () => {
    expect(classifyBypassFailure(402, {})).toBe("quota");
  });
  test("401/403 -> auth", () => {
    expect(classifyBypassFailure(401, {})).toBe("auth");
    expect(classifyBypassFailure(403, {})).toBe("auth");
  });
  test("5xx -> transient", () => {
    expect(classifyBypassFailure(503, {})).toBe("transient");
  });
  test("400 -> client", () => {
    expect(classifyBypassFailure(400, {})).toBe("client");
  });
  test("ModelError envelope wins over status -> client", () => {
    expect(classifyBypassFailure(401, { type: "ModelError" })).toBe("client");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/worker/bypass-classify-failure.test.ts`
Expected: FAIL —「bare 429 -> ratelimit」得到 `quota`。

- [ ] **Step 3: 实现**(`BypassLane.ts`)

改类型(`:53`):
```typescript
export type BypassFailureCategory = "quota" | "auth" | "transient" | "client" | "ratelimit";
```

改 `classifyBypassFailure`(`:100-109`)——替换整段状态分桶:

OLD:
```typescript
  if (parsed.code === "insufficient_quota" || parsed.type === "insufficient_quota") return "quota";
  if (parsed.type === "AuthError") return "auth";
  if (parsed.type === "ModelError") return "client"; // our bug — don't trip breaker
  // Fall back to status code
  if (status === 429 || status === 402) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "transient";
  if (status >= 400) return "client"; // 400 = malformed body, our bug
  return "transient";
```
NEW:
```typescript
  if (parsed.code === "insufficient_quota" || parsed.type === "insufficient_quota") return "quota";
  if (parsed.type === "AuthError") return "auth";
  if (parsed.type === "ModelError") return "client"; // our bug — don't trip breaker
  // Fall back to status code
  if (status === 429) return "ratelimit"; // bare rate-limit — short cooldown, self-heals in minutes
  if (status === 402) return "quota";     // payment required — real quota
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "transient";
  if (status >= 400) return "client"; // 400 = malformed body, our bug
  return "transient";
```

- [ ] **Step 4: 运行确认通过**

Run: `bun test tests/worker/bypass-classify-failure.test.ts`
Expected: PASS。

- [ ] **Step 5: grep 校验 `ratelimit` 分支被下游正确处理(不新造未处理枚举)**

Run: `grep -n "ratelimit\|BypassFailureCategory" src/services/worker/BypassLane.ts`
Expected: 仅类型定义与 `classifyBypassFailure` 出现;`recordFailure`(`:326`,`client` 早退、其余计入熔断)与 `tripCircuitBreaker`(`:342`,只特判 `quota`/`auth`)对 `ratelimit` 走默认 `config.cooldownMs`——已核实无需改即正确。Task 10 会把默认冷却设成 3min。

- [ ] **Step 6: 提交**

```bash
git add src/services/worker/BypassLane.ts tests/worker/bypass-classify-failure.test.ts
git commit -m "feat(bypass): split 429 into ratelimit category (short cooldown, not 6h quota)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: 可配分级冷却 + 可配 maxFailures(行为测试)

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`(接口 + 默认)、`src/services/worker/BypassLane.ts`(`:50-51` 常量、`:131-136` `BypassConfig`、`:146` maxFailures、`:177-188` `resolveConfig`、`:342-360` `tripCircuitBreaker`)
- Test: `tests/worker/bypass-openai.test.ts`(**修复 + 扩展**,决策 4)、`tests/worker/bypass-settings-defaults.test.ts`(扩充)

**决策**:`quota` 默认 30min(原硬编码 6h),`auth` 默认 6h(原硬编码,现可配),`ratelimit`/`transient` 用 `CLAUDE_MEM_BYPASS_COOLDOWN_MS`(代码默认仍 20min,机器设 3min),`maxFailures` 默认 3。
**已核实**:`tests/worker/bypass-openai.test.ts:64-65` import 了旧常量名、`:355-360` 断言 6h、`:389` 行为断言 `capturedCooldownMs === QUOTA_COOLDOWN_MS`——重命名+改默认值会破坏它们,本 Task **必须**同步修复,并顺势把该文件的 white-box 夹具扩展成冷却路由的行为测试(不再新建源码断言文件)。

- [ ] **Step 1: 加设置接口 + 默认值**(`SettingsDefaultsManager.ts`)

接口块(`:65` `CLAUDE_MEM_BYPASS_COOLDOWN_MS` 之后,Bypass Lane 注释区内)追加:
```typescript
  CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS: string; // Cooldown for real-quota (402/insufficient_quota) trips (default: 30min)
  CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS: string;  // Cooldown for auth (401/403) trips (default: 6h)
  CLAUDE_MEM_BYPASS_MAX_FAILURES: string;      // Consecutive failures before circuit trips (default: 3)
```
默认值块(`:143` `CLAUDE_MEM_BYPASS_COOLDOWN_MS: "1200000",` 之后)追加:
```typescript
    CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS: "1800000", // 30 minutes
    CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS: "21600000", // 6 hours
    CLAUDE_MEM_BYPASS_MAX_FAILURES: "3",
```

- [ ] **Step 2: 扩充默认值源码断言测试**(追加到 `tests/worker/bypass-settings-defaults.test.ts`)

```typescript
describe("bypass cooldown tier defaults", () => {
  test("quota=30min, auth=6h, maxFailures=3 present in source", () => {
    expect(SRC).toContain("CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS");
    expect(SRC).toContain('"1800000"');   // 30min
    expect(SRC).toContain("CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS");
    expect(SRC).toContain('"21600000"');  // 6h
    expect(SRC).toContain("CLAUDE_MEM_BYPASS_MAX_FAILURES");
  });
});
```

- [ ] **Step 3: 改 BypassLane 常量为默认 + 扩 BypassConfig**(`BypassLane.ts`)

替换 `:50-51`:
OLD:
```typescript
export const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const AUTH_COOLDOWN_MS = 6 * 60 * 60 * 1000;
```
NEW:
```typescript
export const DEFAULT_QUOTA_COOLDOWN_MS = 30 * 60 * 1000; // 30min default (configurable)
export const DEFAULT_AUTH_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h default (configurable)
export const DEFAULT_MAX_FAILURES = 3;
```

扩 `BypassConfig`(`:131-136`):
```typescript
interface BypassConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  cooldownMs: number;
  quotaCooldownMs: number;
  authCooldownMs: number;
  maxFailures: number;
}
```

`:146` 改 maxFailures 为可变:
OLD: `  private readonly maxFailures = 3;`
NEW: `  private maxFailures = DEFAULT_MAX_FAILURES;`

- [ ] **Step 4: `resolveConfig` 读取新键并写回 maxFailures**(`BypassLane.ts:177-188`)

在 `resolveConfig` 里 `const cooldownMs = ...`(`:181`)之后追加读取,并把 `return` 对象补齐。
**R1-4c + R2-1**:`parseInt(x) || default` 会放行负数(`parseInt("-1") === -1` 为 truthy),`parseInt` 还截断垃圾尾串且无上界——validateSettings 只护住 UI 路径,手改 settings.json 可绕过;负 maxFailures 首败即熔断,cooldown 手滑写 `"999999999999"` 熔断 31 年不恢复。故**本计划全部 5 个新键(3 config 键 + C + G)统一走同一个严格带界读取 helper**,解析语义与 validateSettings 的 `Number()+isInteger` 完全一致(`"60000junk"`→NaN→默认,`"1e1"`→10 两侧一致),界与 Task 6 intBounds 逐键相同:

在 `BypassLane.ts` 模块层(常量区之后)新增**导出**纯函数:
```typescript
/**
 * Strict bounded integer read for hand-editable settings (R2-1).
 * Same semantics as SettingsRoutes.validateSettings (Number + isInteger):
 * trailing junk / non-integers / out-of-range all degrade to the default,
 * so a settings.json typo can never wedge the semaphore or the breaker.
 */
export function readIntBounded(raw: string, def: number, lo: number, hi: number): number {
  const n = Number(String(raw ?? "").trim());
  return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
}
```
resolveConfig 内(**R3-1**:既有 `cooldownMs` 同样收编到 readIntBounded,但用**兼容界 [1000, 86400000]**——与 Task 6 该键的 intBounds 完全一致,两路统一;夹具/遗留短值(如 `'5000'`)仍合法,只拒负数/垃圾/超长。原 `parseInt(...) || 1200000` 行整体替换):
```typescript
    const cooldownMs =
      readIntBounded(settings.CLAUDE_MEM_BYPASS_COOLDOWN_MS, 1200000, 1000, 86400000);
    const quotaCooldownMs =
      readIntBounded(settings.CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS, DEFAULT_QUOTA_COOLDOWN_MS, 60000, 86400000);
    const authCooldownMs =
      readIntBounded(settings.CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS, DEFAULT_AUTH_COOLDOWN_MS, 60000, 86400000);
    const maxFailures =
      readIntBounded(settings.CLAUDE_MEM_BYPASS_MAX_FAILURES, DEFAULT_MAX_FAILURES, 1, 20);
```
> R3-1 兼容界的选择依据:`bypass-openai.test.ts` DEFAULT_SETTINGS 用 `'5000'`、机器目标值 3min、代码默认 20min 均 ≥1000;现实中不存在 <1s 的合法冷却。`scheduleCooldownProbe` 的 `?? 1200000` 兜底不变。改动后跑 `bun test tests/worker/bypass-openai.test.ts` 确认夹具无回归。
把 `return { baseUrl, apiKey, model, cooldownMs };` 改为:
```typescript
    return { baseUrl, apiKey, model, cooldownMs, quotaCooldownMs, authCooldownMs, maxFailures };
```
在 `initialize()` 里,`this.config = this.resolveConfig();` 之后、`if (!this.config)` 判空 return 之后加:
```typescript
    this.maxFailures = this.config.maxFailures;
```

- [ ] **Step 5: `tripCircuitBreaker` 用可配冷却**(`BypassLane.ts:348-350`)

OLD:
```typescript
    let cooldownMs: number | undefined;
    if (category === "quota") cooldownMs = QUOTA_COOLDOWN_MS;
    else if (category === "auth") cooldownMs = AUTH_COOLDOWN_MS;
```
NEW:
```typescript
    let cooldownMs: number | undefined;
    if (category === "quota") cooldownMs = this.config?.quotaCooldownMs;
    else if (category === "auth") cooldownMs = this.config?.authCooldownMs;
    // ratelimit / transient fall through to config.cooldownMs via scheduleCooldownProbe
```

- [ ] **Step 6: 修复 + 扩展 `bypass-openai.test.ts`(行为夹具,决策 4)**

必改项:
1. `:64-65` import 改名:`QUOTA_COOLDOWN_MS, AUTH_COOLDOWN_MS` → `DEFAULT_QUOTA_COOLDOWN_MS, DEFAULT_AUTH_COOLDOWN_MS`(否则整个文件 import 报错全灭)。
2. `:355-360` 断言更新语义:`DEFAULT_QUOTA_COOLDOWN_MS === 30 * 60 * 1000`(30min,不再是 6h)、`DEFAULT_AUTH_COOLDOWN_MS === 6 * 60 * 60 * 1000`。
3. `:376-391`「quota category trips with long cooldown」:fixture 的 `(lane as any).config` 补 `quotaCooldownMs: 1800000, authCooldownMs: 21600000, maxFailures: 3` 字段,断言 `capturedCooldownMs` 等于 **fixture 里的 quotaCooldownMs**(行为:trip 用的是 config 值而非常量)。

新增行为用例(同 describe 内,沿用既有 stub 套路 `(lane as any).scheduleCooldownProbe = (ms?) => { captured = ms ?? (lane as any).config?.cooldownMs ?? null; }`):
```typescript
    it('auth category trips with configured authCooldownMs', () => {
      // fixture config: authCooldownMs: 7777; recordFailure('auth') ×3 → captured === 7777
    });

    it('ratelimit category falls through to default cooldownMs (short)', () => {
      // fixture config: cooldownMs: 5000, quotaCooldownMs: 1800000
      // recordFailure('ratelimit') ×3 → TRIPPED 且 captured === 5000(不走 quota/auth 长冷却)
    });

    it('maxFailures is honored when configured', () => {
      // (lane as any).maxFailures = 2; recordFailure('transient') ×2 → TRIPPED
      // (对照:×1 时仍 ACTIVE)
    });
```
(实现时写全断言体;上面注释描述行为契约。)

**新增 `readIntBounded` 单测**(R2-1,同文件新 describe;import 行追加 `readIntBounded`):
```typescript
  describe('readIntBounded (strict bounded settings read)', () => {
    it('accepts in-range integers', () => {
      expect(readIntBounded('180000', 1200000, 60000, 86400000)).toBe(180000);
    });
    it('rejects trailing junk / non-integer / empty → default', () => {
      expect(readIntBounded('60000junk', 7, 1, 100000)).toBe(7);
      expect(readIntBounded('1.5', 7, 1, 10)).toBe(7);
      expect(readIntBounded('', 7, 1, 10)).toBe(7);
      expect(readIntBounded(undefined as any, 7, 1, 10)).toBe(7);
    });
    it('rejects below-min and above-max → default', () => {
      expect(readIntBounded('-1', 6, 1, 64)).toBe(6);
      expect(readIntBounded('0', 6, 1, 64)).toBe(6);
      expect(readIntBounded('65', 6, 1, 64)).toBe(6);
      expect(readIntBounded('999999999999', 1800000, 60000, 86400000)).toBe(1800000);
    });
    it('scientific notation parses consistently with validateSettings', () => {
      expect(readIntBounded('1e1', 6, 1, 64)).toBe(10); // Number('1e1')===10, integer, in range
    });
  });
```

- [ ] **Step 7: grep 旧常量的其它引用(改名会破坏它们)**

Run: `grep -rn "QUOTA_COOLDOWN_MS\|AUTH_COOLDOWN_MS" src/ tests/`
Expected: 仅 `BypassLane.ts`(`DEFAULT_` 前缀)与 `bypass-openai.test.ts`(已按 Step 6 更新)。发现其它引用 → 同步改名。

- [ ] **Step 8: 运行 + 全量**

Run: `bun test tests/worker/bypass-openai.test.ts tests/worker/bypass-settings-defaults.test.ts && bun test ./tests/`
Expected: 全 PASS,全量 0 fail。

- [ ] **Step 9: 提交**

```bash
git add src/shared/SettingsDefaultsManager.ts src/services/worker/BypassLane.ts tests/worker/bypass-openai.test.ts tests/worker/bypass-settings-defaults.test.ts
git commit -m "feat(bypass): configurable tiered cooldowns + maxFailures (quota 30min default)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Chunk 3: C 路并发 + 全局信号量(生命周期零改动)

> **本 chunk 不触碰任何 start/stop 站点与 abort 语义**(v2 决策 1)。改动面 = BypassLane 内部(consumeLoop 重排、startForSession 起 C 个 loop)+ 新增纯信号量模块 + 设置键。每个 Task 后跑全量。

### Task 6: 新增 C / G 设置 + 五键界校验 + 持久化白名单

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`、`src/services/worker/http/routes/SettingsRoutes.ts`
- Test: `tests/worker/bypass-settings-defaults.test.ts`(扩充)

- [ ] **Step 1: 加接口 + 默认**(`SettingsDefaultsManager.ts`,Bypass Lane 区)

接口追加:
```typescript
  CLAUDE_MEM_BYPASS_CONCURRENCY: string;    // Bypass consumers per session; 1=current behavior, >1=scaled (default: 1)
  CLAUDE_MEM_BYPASS_MAX_CONSUMERS: string;  // Global cap on concurrent bypass REST calls across all sessions (default: 6)
```
默认追加:
```typescript
    CLAUDE_MEM_BYPASS_CONCURRENCY: "1",
    CLAUDE_MEM_BYPASS_MAX_CONSUMERS: "6",
```

- [ ] **Step 2: 源码断言测试**(追加到 `tests/worker/bypass-settings-defaults.test.ts`)

```typescript
describe("bypass concurrency defaults", () => {
  test("C=1, G=6 default (backward-compatible)", () => {
    expect(SRC).toContain('CLAUDE_MEM_BYPASS_CONCURRENCY: "1"');
    expect(SRC).toContain('CLAUDE_MEM_BYPASS_MAX_CONSUMERS: "6"');
  });
});
```

- [ ] **Step 3: 界校验**(`SettingsRoutes.ts`,`validateSettings` 内,紧跟 `CLAUDE_MEM_OPENAI_BASE_URL` 校验块之后;`validateSettings(settings: any)` 已核实为 any 类型,字符串索引无 TS 问题)

**五个新键统一进一个 intBounds 数组**(F5.3:Task 5 的三键同样要有界——`parseInt('-1') || 默认` 会放行负数,负 maxFailures 意味着首败即熔断)。
**R1-4a**:用 `Number()`+`Number.isInteger` 做严格整数判定——`parseInt("3junk")`/`parseInt("1.5")` 会截断放行垃圾值,`Number("3junk")` 为 NaN、`Number("1.5")` 非整数,两者均被拒:
```typescript
    // Validate bypass tiered-cooldown / concurrency knobs.
    // Number()+isInteger (not parseInt): rejects trailing junk ("3junk") and
    // non-integers ("1.5") that parseInt would silently truncate (R1-4a).
    const intBounds: Array<[string, number, number]> = [
      ['CLAUDE_MEM_BYPASS_CONCURRENCY', 1, 16],
      ['CLAUDE_MEM_BYPASS_MAX_CONSUMERS', 1, 64],
      ['CLAUDE_MEM_BYPASS_MAX_FAILURES', 1, 20],
      ['CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS', 60000, 86400000],  // 1min–24h
      ['CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS', 60000, 86400000],   // 1min–24h
      // Pre-existing key (R1-4b/R3-1): COMPATIBILITY bounds [1s, 24h], looser
      // than the new keys' 1min floor — existing installs and test fixtures
      // legitimately use short values (e.g. 5000); only negative/junk/absurd
      // durations are outlawed. Runtime read uses the SAME bounds (Task 5).
      ['CLAUDE_MEM_BYPASS_COOLDOWN_MS', 1000, 86400000],
    ];
    for (const [key, lo, hi] of intBounds) {
      if (settings[key] !== undefined && settings[key] !== '') {
        const n = Number(String(settings[key]).trim());
        if (!Number.isInteger(n) || n < lo || n > hi) {
          return { valid: false, error: `${key} must be an integer in [${lo}, ${hi}]` };
        }
      }
    }
```
> **R1-4b**:`CLAUDE_MEM_BYPASS_COOLDOWN_MS` 的界校验行随其白名单补入(Step 3b 的独立 commit)一起提交——同属"既有遗漏补全",不与本计划新键混提。

- [ ] **Step 3b: 把 5 个新键加入持久化白名单 `settingKeys`**(`SettingsRoutes.ts:72-117`)

审查已确认:`POST /api/settings` 的持久化由 **`settingKeys` 数组**(`:72-117`,`validateSettings` 只校验不持久化)控制,当前**不含任何 `CLAUDE_MEM_BYPASS_*` 键**。把 Task 5 + Task 6 的全部新键加入该数组,否则无法经 UI 持久化:
```typescript
      'CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS',
      'CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS',
      'CLAUDE_MEM_BYPASS_MAX_FAILURES',
      'CLAUDE_MEM_BYPASS_CONCURRENCY',
      'CLAUDE_MEM_BYPASS_MAX_CONSUMERS',
```
> **外科手术纪律**:既有的 `CLAUDE_MEM_BYPASS_COOLDOWN_MS` 现同样不在白名单里——这是**本次改动之前就存在的遗漏**(`BypassLane.ts:181` 早已读它),非本 impl 造成。补它属"顺带修既有遗漏",**不与本计划新键混提**:
> - 本 Step 只提交本计划的 5 个**新**键(上方代码块)。
> - `CLAUDE_MEM_BYPASS_COOLDOWN_MS` 的补入**单列一个独立 commit**(`fix(settings): persist pre-existing CLAUDE_MEM_BYPASS_COOLDOWN_MS via UI`),commit 信息注明"既有遗漏,非本次并发改动引入"。
> - Task 10 直接编辑 settings.json + `resolveConfig` 读原始文件,故功能上不阻塞;此步仅为 UI 持久化完整性。
> - 同类既有遗漏 `CLAUDE_MEM_SKIP_TOOLS`/`CLAUDE_MEM_MAX_CONCURRENT_AGENTS` 也不在白名单(已核实),**本计划不动它们**——Task 10 走直接编辑。

- [ ] **Step 4: 运行 + 全量**

Run: `bun test tests/worker/bypass-settings-defaults.test.ts && bun test ./tests/`
Expected: PASS,0 fail。

- [ ] **Step 5: 提交**

```bash
git add src/shared/SettingsDefaultsManager.ts src/services/worker/http/routes/SettingsRoutes.ts tests/worker/bypass-settings-defaults.test.ts
git commit -m "feat(bypass): add concurrency/max-consumers settings + bounds validation for all new keys

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: BypassLane 全局并发信号量(G)+ consumeLoop 重排

**Files:**
- Modify: `src/services/worker/BypassLane.ts`(字段、`consumeLoop:499-563`)
- Add: `src/services/worker/global-semaphore.ts`
- Test: `tests/worker/bypass-global-semaphore.test.ts`(新建:信号量上限 + H1 顺序 pin + 空队列退避)、`tests/logger-usage-standards.test.ts`(豁免)

**设计**:全局计数信号量,包住 `processObservation` 的 REST 调用。C=1/单会话时永不阻塞(in-flight≤1 < G=6),故始终开启无害。

- [ ] **Step 1: 写失败测试**(新建,直接测信号量的 acquire/release 并发上限)

> 信号量提取为独立纯模块 `src/services/worker/global-semaphore.ts` 单测(避免碰 BypassLane private/mock 陷阱)。

```typescript
import { describe, test, expect } from "bun:test";
import { GlobalSemaphore } from "../../src/services/worker/global-semaphore.js";

describe("GlobalSemaphore", () => {
  test("caps concurrent holders at limit", async () => {
    const sem = new GlobalSemaphore(() => 2);
    const ac = new AbortController();
    let peak = 0, cur = 0;
    const work = async () => {
      await sem.acquire(ac.signal);
      cur++; peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 20));
      cur--; sem.release();
    };
    await Promise.all([work(), work(), work(), work()]);
    expect(peak).toBe(2);
  });

  test("converges downward when limit decreases under backlog (R1-2)", async () => {
    // Start with limit 3, saturate with holders + waiters, then drop limit to 1.
    // release() must NOT hand the freed slot straight to a waiter while
    // inFlight >= new limit; concurrency must drain to 1, not stay pinned at 3.
    let limit = 3;
    const sem = new GlobalSemaphore(() => limit);
    const ac = new AbortController();
    let peakAfterDecrease = 0, cur = 0;
    let decreased = false;
    const work = async () => {
      await sem.acquire(ac.signal);
      cur++;
      if (decreased) peakAfterDecrease = Math.max(peakAfterDecrease, cur);
      await new Promise((r) => setTimeout(r, 20));
      cur--; sem.release();
    };
    const batch1 = [work(), work(), work(), work(), work(), work()]; // 3 hold, 3 wait
    await new Promise((r) => setTimeout(r, 5));
    limit = 1; decreased = true;
    await Promise.all(batch1);
    // Waiters granted after the decrease must respect the new limit of 1.
    expect(peakAfterDecrease).toBeLessThanOrEqual(1);
  });

  test("one release fills all new capacity when limit increases under backlog (R2-2)", async () => {
    // limit 1: one holder + 5 parked waiters. Raise limit to 6, then the
    // single holder releases — the release loop must wake ALL 5 waiters at
    // once (peak 5), not just one.
    let limit = 1;
    const sem = new GlobalSemaphore(() => limit);
    const ac = new AbortController();
    let peak = 0, cur = 0;
    let releaseHolder!: () => void;
    const holderDone = new Promise<void>((r) => (releaseHolder = r));
    const holder = (async () => {
      await sem.acquire(ac.signal);
      await holderDone;
      sem.release();
    })();
    await new Promise((r) => setTimeout(r, 5)); // holder owns the only slot
    const work = async () => {
      await sem.acquire(ac.signal);
      cur++; peak = Math.max(peak, cur);
      await new Promise((r) => setTimeout(r, 20));
      cur--; sem.release();
    };
    const waiters = [work(), work(), work(), work(), work()]; // all park
    await new Promise((r) => setTimeout(r, 5));
    limit = 6;
    releaseHolder();
    await Promise.all([holder, ...waiters]);
    expect(peak).toBe(5); // all five waiters ran concurrently after one release
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/worker/bypass-global-semaphore.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现纯信号量模块**(新建 `src/services/worker/global-semaphore.ts`)

```typescript
/**
 * GlobalSemaphore: bounds concurrent bypass REST calls across all sessions.
 * limitFn is read on each acquire AND each release so config changes take
 * effect live in both directions (R1-2): a grant only happens while
 * inFlight < limitFn(), so lowering G under backlog drains to the new limit
 * instead of ping-ponging at the old one. Waiters parked by a decrease are
 * woken by later releases once inFlight sinks below the new limit.
 * acquire() rejects ONLY on signal abort. Fast path may overtake queued
 * waiters when the limit grows mid-flight — acceptable, never deadlocks.
 */
export class GlobalSemaphore {
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  constructor(private limitFn: () => number) {}

  async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('aborted');
    if (this.inFlight < this.limitFn()) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.inFlight++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('aborted'));
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    // R1-2: consult the live limit before granting — a freed slot is only
    // handed to a waiter if concurrency stays within the CURRENT limit.
    // R2-2: grant in a LOOP — when the limit was raised under backlog, a
    // single release must wake as many parked waiters as the new capacity
    // allows, not just one (each grant() increments inFlight, so the loop
    // condition self-terminates at the live limit).
    while (this.waiters.length > 0 && this.inFlight < this.limitFn()) {
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
```

- [ ] **Step 3b: 把新文件加入 logger 豁免**(`tests/logger-usage-standards.test.ts`)

豁免清单是 **RegExp 字面量数组**(`EXCLUDED_PATTERNS`,如 `/generator-action\.ts$/`),不是字符串。在该数组里追加 `/global-semaphore\.ts$/`(**不是**字符串,否则破坏 `.test()`),注释 `// Pure coordination primitive — no I/O to log`。

- [ ] **Step 4: 接入 BypassLane —— H1(acquire-before-claim)+ M2(memSession-before-claim)**(`BypassLane.ts`)

**为什么整段重写 `consumeLoop`**:① H1——若信号量在 claim **之后**拿,被 claim 的行会在"等信号量 + 45s fetch"期间挂 `processing`,G 打满时 >60s 触发 SDK self-heal 重置(`PendingMessageStore.ts` `STALE_OBS_PROCESSING_THRESHOLD_MS = 60_000`)→ 重复消费;故必须**先拿槽再 claim**,让 `processing` 窗口只含 fetch(<45s<60s)。② M2——把 `memorySessionId` 检查提到 claim **之前**,消除 INIT 窗口内 C 个消费者 claim→退回→再 claim 的自旋。
**v2 修正(F1.1)**:退避统一放在信号量释放**之后**的循环尾部,由 `outcome` 驱动——空队列/退回 → `POLL_MS`(500ms),失败 → 1000ms,成功 → 立即下一轮;与改动前时序逐一对齐。**绝不允许裸 `continue` 跳过尾部退避**(v1 版本在此处引入了空队列热自旋)。**绝不在持有信号量时 sleep**。

import(顶部 import 区):
```typescript
import { GlobalSemaphore } from "./global-semaphore.js";
```

字段(`:150` 附近,`private lastFailureReason` 之后)——**无缓存层**(决策 5:`loadFromFile` 自带 5s TTL):
```typescript
  // Global cap on concurrent bypass REST calls across all sessions.
  // loadFromFile has its own 5s TTL cache (SettingsDefaultsManager P3),
  // so reading per-acquire is cheap — no extra caching layer here.
  // R1-4c/R2-1: strict bounded read [1,64] — validateSettings only guards the
  // UI path; a hand-edited settings.json with "-1" would otherwise make
  // limitFn return -1 and every acquire() park forever, and an over-large
  // typo would remove the global cap entirely.
  private globalSemaphore = new GlobalSemaphore(() => {
    const s = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return readIntBounded(s.CLAUDE_MEM_BYPASS_MAX_CONSUMERS, 6, 1, 64);
  });
```

**整段替换 `consumeLoop` 的 while 循环体(`:499-563`)**:

```typescript
    while (!signal.aborted && this.state === "ACTIVE") {
      // M2: gate on memorySessionId BEFORE claiming — rows stay 'pending' untouched
      // until the main channel seeds the id; no claim→retry spin during INIT.
      if (!session.memorySessionId) {
        await this.abortableSleep(POLL_MS, signal);
        continue;
      }

      // H1: acquire a global slot BEFORE claiming, so a claimed row's 'processing'
      // window spans only the REST call (< FETCH_TIMEOUT_MS 45s < 60s self-heal),
      // never the semaphore wait.
      try {
        await this.globalSemaphore.acquire(signal);
      } catch {
        continue; // acquire rejects only on abort; the while condition exits the loop
      }

      let outcome: "processed" | "empty" | "failed" = "empty";
      try {
        // Re-check after a possibly long semaphore wait — don't claim into a
        // tripped breaker or an aborted session.
        if (signal.aborted || this.state !== "ACTIVE") break; // finally releases

        const message = pendingStore.claimNextObservation(session.sessionDbId);
        if (message) {
          this.counters.claimed++;
          // Re-capture: main channel could clear memorySessionId between the gate and here.
          const memorySessionId = session.memorySessionId;
          if (!memorySessionId) {
            pendingStore.retryMessage(message.id); // return the row for a later round
            this.sessionManager!.notifyMessageAvailable(session.sessionDbId, session.dbPath);
            // outcome stays "empty" → POLL_MS backoff below (matches pre-rewrite timing)
          } else {
            try {
              const obsStats = await this.processObservation(message, session, memorySessionId, signal);
              this.recordSuccess();
              logger.info("BYPASS", "Observation processed", {
                messageId: message.id,
                sessionDbId: session.sessionDbId,
                endpoint: this.config ? new URL(this.config.baseUrl).host : null,
                truncatedFields: obsStats.truncatedFields,
              });
              outcome = "processed";
            } catch (error) {
              if (signal.aborted) return; // finally releases
              outcome = "failed";
              const category = (error as { bypassCategory?: BypassFailureCategory })
                ?.bypassCategory;
              logger.warn("BYPASS", "Processing failed, marking for retry", {
                messageId: message.id,
                category: category ?? "unknown",
                error: error instanceof Error ? error.message : String(error),
              });
              pendingStore.markFailed(message.id);
              this.sessionManager!.notifyMessageAvailable(session.sessionDbId, session.dbPath);
              this.lastFailureReason = (
                error instanceof Error ? error.message : String(error)
              ).slice(0, 200);
              this.recordFailure(category);
              if (this.state === "TRIPPED") return; // finally releases
            }
          }
        }
      } finally {
        this.globalSemaphore.release();
      }

      // Backoff AFTER the semaphore is released — never sleep holding a slot.
      // Timings match the pre-rewrite loop exactly: failure → 1000ms,
      // empty queue / memSession fallback → POLL_MS (500ms), success → immediate next claim.
      if (outcome === "failed") {
        await this.abortableSleep(1000, signal);
      } else if (outcome === "empty") {
        await this.abortableSleep(POLL_MS, signal);
      }
    }
```
> `POLL_MS`、`pendingStore` 在 `consumeLoop` 顶部原有声明(`:494-497`)保留不变。**L4 说明**:`consecutiveFailures` 是 BypassLane 实例级、C 个消费者共享——同步 429 爆发会更快凑够 `maxFailures`。这是有意取舍(grill 档 1),由 `ratelimit` 的 3min 短冷却兜住 blast radius;`maxFailures` 已可配。

- [ ] **Step 4b: 写 H1 顺序回归防线(acquire 必须先于 claim)**(追加到 `tests/worker/bypass-global-semaphore.test.ts`)

**为什么是源码顺序断言而非 SQLite 端到端**:H1 的正确性完全取决于 `consumeLoop` 里 `globalSemaphore.acquire` **文本上先于** `claimNextObservation`——一旦有人把 claim 重排到 acquire 之前(正是 H1 的犯错方式),本测试立即红。真实 self-heal 的端到端测试需重夹具 + sleep 计时,确定性与维护成本都劣于顺序断言。

```typescript
import { readFileSync } from "fs";

describe("H1: semaphore acquired before row claimed", () => {
  const SRC = readFileSync("src/services/worker/BypassLane.ts", "utf-8");

  test("acquire precedes claim in consumeLoop (processing window excludes the wait)", () => {
    const acquireIdx = SRC.indexOf("globalSemaphore.acquire");
    const claimIdx = SRC.indexOf("claimNextObservation(session.sessionDbId)");
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(-1);
    // If a refactor moves claim before acquire, a claimed row sits in 'processing'
    // during the (possibly long) semaphore wait; when G is saturated it can exceed
    // the 60s self-heal threshold -> the row is reset to pending -> duplicate
    // consumption. This ordering is the entire H1 mitigation; pin it.
    expect(acquireIdx).toBeLessThan(claimIdx);
  });
});
```

- [ ] **Step 4c: 写空队列退避行为测试(F1.1 回归防线)**(追加到同一文件;white-box 套路同 `bypass-openai.test.ts`,不碰 mock.module)

```typescript
import { BypassLane } from "../../src/services/worker/BypassLane.js";

describe("consumeLoop empty-queue backoff (no hot spin)", () => {
  test("claims at most twice within 150ms against an empty queue", async () => {
    const lane = new BypassLane() as any;
    lane.state = "ACTIVE";
    let claimCalls = 0;
    const fakeStore = {
      claimNextObservation() { claimCalls++; return null; },
      retryMessage() {},
      markFailed() {},
    };
    lane.sessionManager = {
      getPendingMessageStore: () => fakeStore,
      notifyMessageAvailable() {},
    };
    lane.dbManager = {};
    const ac = new AbortController();
    const session = {
      sessionDbId: 1,
      dbPath: "/tmp/x",
      memorySessionId: "m1",
      abortController: new AbortController(),
    } as any;

    const loop = lane.consumeLoop(session, ac.signal);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await loop;

    // POLL_MS=500ms backoff → exactly 1 claim within 150ms.
    // A hot-spinning loop (the v1 plan's `if (!message) continue;` bug) would
    // rack up thousands. Allow 2 for scheduler slack.
    expect(claimCalls).toBeLessThanOrEqual(2);
    // R1-5: lower bound too — a permanently blocked consumer (0 claims) must
    // NOT pass this test; the loop has to actually reach the claim site.
    expect(claimCalls).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 5: 运行 + 全量**

Run: `bun test tests/worker/bypass-global-semaphore.test.ts && bun test ./tests/`
Expected: PASS,0 fail。

- [ ] **Step 6: 提交**

```bash
git add src/services/worker/global-semaphore.ts src/services/worker/BypassLane.ts tests/worker/bypass-global-semaphore.test.ts tests/logger-usage-standards.test.ts
git commit -m "feat(bypass): global concurrency semaphore (G) around REST calls

Acquire-before-claim keeps the 'processing' window under the 60s self-heal
threshold; backoff runs after release (empty=500ms, fail=1000ms, unchanged).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: 每会话 C 个消费者(生命周期零改动)

**Files:**
- Modify: `src/services/worker/BypassLane.ts:278-293`(`startForSession` 起 C 个 loop)
- Test: `tests/worker/bypass-concurrency.test.ts`(新建,源码断言)

> **v2 边界(决策 1)**:`stopForSession` 的全部 11 个站点(SessionRoutes `:111/:168/:297/:444`、worker-service `:634/:786/:955/:962/:1024/:1052/:1055`)**一律不改**。C 个 loop 与今天的单 loop 走完全相同的启停时机:generator 启动时起、combined signal(own abort 或会话 abort)时停。唯一的新语义是"一次起 C 个、共用一个 ownAc"。

- [ ] **Step 1: `startForSession` 起 C 个 loop**(`BypassLane.ts:278-293`)

在 `startForSession` 里读取并发数,把单个 `consumeLoop().catch().finally()` 改为循环起 C 个(共用 `ownAc`/`combinedSignal`):

替换 `:278-293`:

OLD:
```typescript
    this.consumeLoop(session, combinedSignal)
      .catch((error) => {
        if (!combinedSignal.aborted) {
          logger.error(
            "BYPASS",
            "Consumer loop error",
            {
              sessionDbId: session.sessionDbId,
            },
            error as Error,
          );
        }
      })
      .finally(() => {
        this.activeConsumers.delete(session.sessionDbId);
      });
```
NEW:
```typescript
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    // R2-1: strict bounded read [1,16], same semantics as validateSettings —
    // a hand-edited typo must not spawn an unbounded number of loops.
    const concurrency = readIntBounded(settings.CLAUDE_MEM_BYPASS_CONCURRENCY, 1, 1, 16);

    let running = concurrency;
    const onLoopDone = () => {
      running--;
      // M1: only delete when ALL loops exited AND the map still points to THIS ownAc.
      // A stop+restart can install a NEW ownAc before this batch drains; an unconditional
      // delete would clobber the newer controller (the race the original :301-303 warns of).
      if (running <= 0 && this.activeConsumers.get(session.sessionDbId) === ownAc) {
        this.activeConsumers.delete(session.sessionDbId);
      }
    };

    for (let i = 0; i < concurrency; i++) {
      this.consumeLoop(session, combinedSignal)
        .catch((error) => {
          if (!combinedSignal.aborted) {
            logger.error(
              "BYPASS",
              "Consumer loop error",
              { sessionDbId: session.sessionDbId, worker: i },
              error as Error,
            );
          }
        })
        .finally(onLoopDone);
    }
```
> `activeConsumers.get(...).signal.aborted` 的既有幂等检查(`:264-265`)不变——map 里存的仍是 `ownAc`,C 个 loop 共用。`stopForSession` 的"只 abort 不 delete"契约(`:297-305` 注释)由 M1 守卫式删除完整保留。

- [ ] **Step 2: 源码断言测试**(新建 `tests/worker/bypass-concurrency.test.ts`)

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

const BYPASS = readFileSync("src/services/worker/BypassLane.ts", "utf-8");

describe("per-session bypass concurrency (C-as-switch)", () => {
  test("startForSession spawns concurrency loops", () => {
    expect(BYPASS).toContain("CLAUDE_MEM_BYPASS_CONCURRENCY");
    expect(BYPASS).toContain("for (let i = 0; i < concurrency; i++)");
  });
  test("M1 guarded delete: all-exited AND same-controller", () => {
    expect(BYPASS).toContain("running <= 0 && this.activeConsumers.get(session.sessionDbId) === ownAc");
  });
  test("lifecycle stays untouched: no concurrency gate around stopForSession call sites", () => {
    const ROUTES = readFileSync("src/services/worker/http/routes/SessionRoutes.ts", "utf-8");
    const WS = readFileSync("src/services/worker-service.ts", "utf-8");
    expect(ROUTES).not.toContain("BYPASS_CONCURRENCY");
    expect(WS).not.toContain("BYPASS_CONCURRENCY");
  });
});
```
> 第三条把"决策 1:生命周期零改动"钉死——一旦有人把并发开关渗进启停站点,立即红。

- [ ] **Step 2b: C>1 行为级测试(R1-5)**(同文件追加;white-box 套路同 `bypass-openai.test.ts`——`mock.module` SettingsDefaultsManager 注入 `CLAUDE_MEM_BYPASS_CONCURRENCY: "3"`,stub `(lane as any).consumeLoop` 为可控 deferred promise)

行为契约(实现时写全断言体):

```typescript
describe("startForSession spawns C consumers (behavioral)", () => {
  // fixture: mockSettings.CLAUDE_MEM_BYPASS_CONCURRENCY = "3"; lane.state = "ACTIVE";
  // (lane as any).consumeLoop = () => new Promise(...) — 手动持有 resolve。

  test("C=3 spawns exactly 3 consumeLoop invocations sharing one map entry", () => {
    // startForSession(session) → loopInvocations === 3
    // activeConsumers.get(id) 是同一个 ownAc(map 只有一个 entry)
  });

  test("map entry survives until ALL loops exit (M1 all-exited)", async () => {
    // resolve 2 of 3 loops → entry 仍在;resolve 第 3 个 → entry 删除
  });

  test("stale batch does not clobber a replacement controller (M1 same-controller)", async () => {
    // startForSession → stopForSession(abort 旧 ownAc)→ startForSession 装入新 ownAc
    // → resolve 旧批次全部 loop → map 里保留的是新 ownAc(未被误删)
  });
});
```
> C 个 loop 共享 combinedSignal 的取消传播由既有 `AbortSignal.any` 机制保证(`:273`),不重复测。

- [ ] **Step 3: 全量回归(重点看 bypass / session 相关既有测试不破)**

Run: `bun test ./tests/`
Expected: 0 fail(基线约 2190)。已核实 `tests/worker/bypass-lane.test.ts` 的 startForSession 用例把 `consumeLoop` mock 成空函数(`:213`)——C 个 loop 会调 C 次 mock,即刻 resolve 后 M1 守卫删除 map 项,幂等/替换语义断言应仍成立;若有破坏,按"C=1 行为等价"原则修测试夹具而非改实现。

- [ ] **Step 4: 提交**

```bash
git add src/services/worker/BypassLane.ts tests/worker/bypass-concurrency.test.ts
git commit -m "feat(bypass): C-as-switch per-session consumer concurrency

C loops share one ownAc + combined signal; lifecycle call sites untouched.
M1 guarded delete prevents clobbering a newer controller on stop+restart.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: 文档同步

**Files:**
- Modify: `CLAUDE.md`(根,§ Bypass Lane)、`src/services/worker/CLAUDE.md`(§ Layer A)

- [ ] **Step 1: 根 CLAUDE.md** — § Architecture 的 Bypass Lane 段落,更新失败分类描述:

OLD(现状):`classifies failures into quota/auth/transient/client buckets with tiered cooldowns (6h / 6h / 20min / no-trip)`
NEW:`classifies failures into quota/auth/ratelimit/transient/client buckets with tiered, configurable cooldowns (defaults: 30min / 6h / 20min / 20min / no-trip)`

- [ ] **Step 2: worker CLAUDE.md** — § SDK Token Optimization (Phase 1) 的 Layer A 行,补一句 Bash 命令提取 + 复合守卫 + `layerAStats` 计数。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md src/services/worker/CLAUDE.md
git commit -m "docs: sync bypass failure buckets and Layer A description with implementation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: 部署本机配置 + 构建 + 验证

**Files:**
- Modify: `~/.claude-mem/settings.json`(机器,非仓库;软链到 `.my_ssh_keys/claude-mem-settings.json`)

> **R1-1 顺序硬约束:先写配置,后重启**。`BypassLane.initialize()` 在 worker 启动时一次性快照 `this.config = this.resolveConfig()`(cooldown 三键 + maxFailures 均入快照);只有 C(per startForSession)与 G(per acquire)是活读。若先 build-and-sync 再写 settings.json,冷却配置停留在重启前旧值,3min ratelimit 冷却不生效。

- [ ] **Step 1: 写入本机目标值**(**直接编辑 settings.json**——`SKIP_TOOLS`/`MAX_CONCURRENT_AGENTS` 不在 UI 白名单,UI 路径对它们无效;直接编辑不会调 `invalidateCache`,靠 5s TTL 自然过期对活读键生效;快照键靠 Step 2 的重启生效)

```
CLAUDE_MEM_BYPASS_CONCURRENCY       = "3"
CLAUDE_MEM_BYPASS_MAX_CONSUMERS     = "6"
CLAUDE_MEM_BYPASS_COOLDOWN_MS       = "180000"    # transient + ratelimit = 3min
CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS = "1800000"   # 30min
CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS  = "21600000"  # 6h
```
> **不改** `CLAUDE_MEM_MAX_CONCURRENT_AGENTS`(保持 5,决策 2:并发画像 ≤3,pool 收紧无收益)。
> `SKIP_TOOLS` / `SKIP_TOOL_PATTERNS`:本机 settings.json 当前**覆盖**了代码默认(已核实),需手动把 Task 2 的新增项(含收窄版 cat/head/tail 模式)并入本机这两个键,否则 Route A 不生效。

- [ ] **Step 2: 全量构建同步**(在 Step 1 配置落盘**之后**执行,重启后的 `initialize()` 才能快照到新冷却值,R1-1)

Run: `bun run build-and-sync`
Expected: 构建成功、worker 重启。

- [ ] **Step 3: 上线验证(观察日志;grep 已按 logger 真实渲染校准;R1-6 按部署点切片)**

**先临时设 `CLAUDE_MEM_LOG_LEVEL=DEBUG`**(关键事实 5:`messageKind`/`storeAction` 等 >3 键 metadata 仅 DEBUG 级可见)。**部署完成后立刻记录日志偏移**,验证窗口只统计偏移之后的行——全天计数混入部署前流量,无法证明比例翻转(R1-6):

```bash
LOG=~/.claude-mem/logs/claude-mem-$(date +%F).log
OFF=$(stat -c%s "$LOG" 2>/dev/null || echo 0)   # 部署点字节偏移,记下来
# ……跑一段真实会话后……
W() { tail -c +$((OFF+1)) "$LOG"; }             # 只看部署点之后的窗口
echo "SDK obs:";        W | grep -cE '"messageKind": ?"observation"'
echo "Bypass obs:";     W | grep -cE 'BYPASS.*Observation processed'
echo "ratelimit:";      W | grep -cE '"category": ?"ratelimit"'
echo "SUM inserted:";   W | grep -cE '"storeAction": ?"inserted"'
echo "RouteA skips:";   W | grep -c  'Skipping observation by pattern filter'
echo "INIT slot timeout:"; W | grep -c 'Timed out waiting for agent pool slot'
# R1-6: ratelimit 出现次数 ≠ 3min 冷却生效;直接验证 trip 日志记录的 cooldownMs
echo "trip cooldown:";  W | grep -E 'Circuit breaker TRIPPED' | grep -oE '"cooldownMs": ?[0-9]+'
```
> grep 说明:logger 行格式为 `时间戳 LEVEL COMPONENT message`,component **无方括号**;`-E '": ?"'` 同时兼容 DEBUG 级 pretty JSON(冒号后有空格)与 INFO 级 ≤3 键内联紧凑 JSON(无空格)。`RouteA skips` 与 `INIT slot timeout` 是 message 级文本,任意级别可见。TRIPPED 行 metadata 为 2 键(category+cooldownMs),任意级别内联可见;若窗口内无 trip,则该项以 `bun test` 的冷却路由行为测试为准,不阻塞验收。

Expected(均在部署点之后的窗口内):`Bypass obs` 应升为主力、`SDK obs` 大跌;`ratelimit` 若频繁出现→调低 `BYPASS_MAX_CONSUMERS`;`SUM inserted` 持续>0;`RouteA skips` 持续增长;`INIT slot timeout` 应为 0(pool 未收紧,理应恒 0);若发生 ratelimit trip,`trip cooldown` 显示 `"cooldownMs":180000`。另可 `curl -s localhost:37777/api/health | python3 -m json.tool | grep -A3 layerA` 看 `ai.layerA` 累计计数(端点已核实:`Server.ts:191` 经 `getAiStatus` 注入)。

- [ ] **Step 4: 验证后把 `CLAUDE_MEM_LOG_LEVEL` 改回 `INFO`**

- [ ] **Step 5: 对比订阅消耗**

对比改动前后 `SDK_USAGE_SUMMARY` 的 `totalReportedTokens`(`claude_sdk_main`)日均值(需在 DEBUG 窗口内取样,或按 `SDK_USAGE_SUMMARY` message 行数粗算),确认 observation 占比大幅下降。

---

## 验收标准

- 全量 `bun test ./tests/` 0 fail。
- 机器设 C=3 后:日志中 bypass 处理的 observation 数 > SDK;`ratelimit` 可见且触发的是 3min 短冷却(非 30min/6h);SUMLANE 正常 inserted;`INIT slot timeout` 为 0;`RouteA skips` 计数持续增长。
- **C=1(默认)生命周期行为与改动前逐字一致**(启停时机、退避时序、信号量在 C=1 单会话下 `inFlight≤1<G` 永不阻塞);**失败分类与冷却默认值的变化是有意的无条件变更**(429→`ratelimit`、quota 6h→30min),不属回归。

## 风险登记

| 风险 | 缓解 |
|---|---|
| **[H1] 信号量等待使 `processing` >60s → self-heal 重复消费** | **acquire 先于 claim(Task 7 Step 4)→ `processing` 窗口仅含 fetch <45s<60s;Step 4b 源码顺序断言防止重排回归** |
| **[F1.1] consumeLoop 重写引入空队列热自旋** | **退避在 finally 释放后由 `outcome` 驱动(Task 7 Step 4);Step 4c 行为测试钉死 150ms 内 claim ≤2 次** |
| **[M1] C 个 loop 的 `onLoopDone` 误删更新后的 controller** | **守卫式 delete:`running<=0 && map.get(id)===ownAc`(Task 8 Step 1)** |
| **[M2] INIT 窗口内 C 个消费者 claim→退回自旋** | **memSession 检查前置到 claim 之前(Task 7 Step 4)→ 零 claim/零抢槽** |
| [L4] `consecutiveFailures` 实例级共享,C 路同步 429 更快凑满 maxFailures | 有意取舍;`ratelimit` 3min 短冷却兜住 blast radius,`maxFailures` 可配(Task 5) |
| C>1 多消费者对同会话乱序 store | `claimNextObservation` 事务原子(`PendingMessageStore.ts:167`)+ 写串行化;顺序本就不保证,无回归 |
| 高并发撞 opencode 未公开限流 | 全局信号量 G(`loadFromFile` 自带 5s TTL,读设置零成本)+ `ratelimit` 3min 快恢复 + 日志可观测 |
| idle-abort 连带停掉 bypass(设计事实,非本计划引入) | SDK claim 扑空才 idle ⇒ 队列必为空,无滞留;至多 C 条在途行由下次启动后的 60s self-heal 复位重放。v2 已放弃对此做手术(决策 1) |
| 本机 settings.json 覆盖代码默认 | Task 10 Step 2 显式并入 SKIP 项 |
| 验证 grep 与 logger 渲染错位 | 全部模式按关键事实 5 校准(Task 10 Step 3);`messageKind` 类字段仅 DEBUG 窗口可见,验证期临时切级 |

---

## Review Log

### Round 1
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Initial Review

1. High — Task 10 writes cooldown settings after restarting the worker. BypassLane snapshots `this.config = this.resolveConfig()` during initialization; only C and G are reread later. Consequently, the intended 3-minute ratelimit cooldown remains the pre-restart value. Write settings before `build-and-sync`, or restart again afterward. Direct file editing also expires the 5-second cache; it does not call `invalidateCache()`.

2. High — `global-semaphore.ts` does not enforce a live limit decrease. `release()` grants a waiter unconditionally. If six calls are active, waiters exist, and G changes from 6 to 1, every release decrements to five and immediately grants back to six. Under sustained load it may never converge to one. Add a decrease-under-backlog test and consult `limitFn()` before granting.

3. High — The compound-command guard in `observation-filter.ts` omits the shell control operator `&`. Commands such as `cd /repo & pytest` and `echo starting & python run.py` match the new skip patterns and are discarded, contradicting the hard rule that compound commands are never skipped. Add `&` handling and regression tests.

4. Medium — Bounds enforcement in `SettingsRoutes.ts` is incomplete: (a) `parseInt("3junk", 10)` and `parseInt("1.5", 10)` pass as valid integers; (b) the separately whitelisted pre-existing `CLAUDE_MEM_BYPASS_COOLDOWN_MS` receives no bounds validation; (c) runtime readers do not enforce the same bounds — a directly edited `CLAUDE_MEM_BYPASS_MAX_CONSUMERS="-1"` makes every semaphore acquisition wait forever because no holder can ever release a slot.

5. Medium — The central C>1 behavior lacks a real test. `bypass-concurrency.test.ts` only searches source strings; it does not prove that three loops start, share cancellation, wait for all loops before deletion, or preserve a replacement controller. The empty-queue test also permits zero claims, so a permanently blocked consumer passes. Add deterministic behavioral coverage and assert at least one claim.

6. Medium — Task 10 counts the entire day's log, mixing pre- and post-deployment traffic. Those counts cannot establish that bypass now exceeds SDK, that SUM remains healthy after deployment, or that slot timeouts are zero in the tested window. Record a starting byte/line/timestamp and inspect only subsequent logs. Counting `"category":"ratelimit"` also does not prove a 180,000 ms cooldown; verify the breaker's recorded cooldown or timed recovery.

(Verification limitation noted by reviewer: sandboxed shell could not execute commands (`bwrap` denied); findings derived from reading the plan's embedded implementation code against the source tree.)

**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 1

---

### Response to Round 1
**Responder**: Claude Code

**Findings addressed**: 6

1. **Task 10 writes settings after worker restart (config snapshot stale)**
   - Verdict: ACCEPTED
   - Evidence: `BypassLane.ts:192` — `this.config = this.resolveConfig()` runs once in `initialize()`; cooldown 三键 + maxFailures 属快照,仅 C/G 活读。原 Task 10 顺序确实使 3min 冷却停留旧值。
   - Action: Task 10 Step 1/2 对调(先写 settings.json,后 build-and-sync),并加"R1-1 顺序硬约束"说明,标注直接编辑靠 TTL 过期、快照键靠重启生效。

2. **GlobalSemaphore does not converge on live limit decrease**
   - Verdict: ACCEPTED
   - Evidence: 原 `release()` 无条件 shift+grant——holders=6、G→1 时每次 release 立即回授,backlog 期间 inFlight 恒 6。Task 10 的运维预案恰是"ratelimit 频繁→调低 MAX_CONSUMERS",该预案在持续负载下不生效。
   - Action: `release()` 改为仅当 `inFlight < limitFn()` 才 grant(注释说明双向活读);新增 decrease-under-backlog 行为测试(Task 7 Step 1)。

3. **Compound guard omits bare `&`**
   - Verdict: ACCEPTED
   - Evidence: 原正则 `/&&|\|\||;|\||\$\(|`|>|</` 只匹配双 `&&`;`cd /repo & pytest` 匹配 `Bash:cd *` 且不触发守卫 → 真实工作被丢弃,违反硬规则。
   - Action: 正则改为 `/[&;|<>`]|\$\(/`(单 `&`/`|` 子集涵盖 `&&`/`||`);Task 1 Step 1 新增两个 `&` 回归用例。

4. **Bounds enforcement incomplete (parseInt junk / pre-existing key unbounded / runtime readers unclamped)**
   - Verdict: ACCEPTED
   - Evidence: (a) `parseInt("3junk",10)===3`、`parseInt("1.5",10)===1` 截断放行;(b) `CLAUDE_MEM_BYPASS_COOLDOWN_MS` 原计划只补白名单不补界;(c) `parseInt("-1",10)||6 === -1`(truthy)→ limitFn 返回 -1 → `inFlight < -1` 永假 → 所有 acquire 永久挂起,validateSettings 护不住手改 settings.json 路径。
   - Action: Task 6 intBounds 改 `Number()`+`Number.isInteger` 严格判定;`CLAUDE_MEM_BYPASS_COOLDOWN_MS` 进 intBounds(随既有遗漏独立 commit);Task 7 limitFn 加 `Math.max(1,...)`;Task 5 新键读取统一 `readIntFloor(raw, def, min)`(cooldown 下限 60000,maxFailures 下限 1)。既有 `cooldownMs` 的 `parseInt||1200000` 保持原样(改动前行为,外科手术纪律)。

5. **C>1 lacks behavioral test; empty-queue test permits zero claims**
   - Verdict: ACCEPTED
   - Evidence: 原 Task 8 Step 2 仅源码字符串断言;空队列测试 `claimCalls <= 2` 允许 0 claim,永久阻塞的消费者也能过。
   - Action: Task 8 新增 Step 2b 行为级测试(mock.module 注入 C=3 + 可控 deferred consumeLoop stub):① C=3 起 3 个 loop 共享单 map entry;② 全部退出才删 entry(M1 all-exited);③ 旧批次不误删替换后的 controller(M1 same-controller)。Task 7 Step 4c 补 `claimCalls >= 1` 下限断言。取消传播由既有 `AbortSignal.any`(`:273`)保证,不重复测。

6. **Task 10 grep counts whole-day log (pre/post-deploy mixed); ratelimit count ≠ 3min cooldown proof**
   - Verdict: ACCEPTED
   - Evidence: 原 grep 直接扫全天日志文件;`"category":"ratelimit"` 计数只证明分类生效,不证明冷却时长。
   - Action: Task 10 Step 3 改为部署点记录字节偏移(`stat -c%s`)、`tail -c +OFF` 窗口化统计;新增 `Circuit breaker TRIPPED` 行的 `"cooldownMs":180000` 直接验证(TRIPPED metadata 2 键,任意级别内联可见;窗口内无 trip 时以行为测试为准,不阻塞验收)。

**Spec body updated**: Yes
**Open issues remaining**: 0

---

### Round 2
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

1. Medium — Runtime bounds remain inconsistent and bypassable. Task 6 validates six keys strictly through SettingsRoutes, but the runtime readers do not apply the same rules: (a) C/G use `parseInt` with only a lower clamp; values above 16/64 remain unbounded; (b) `readIntFloor` accepts values such as `"60000junk"` and has no upper bound; (c) the pre-existing general cooldown still accepts negative or excessive direct-file values; (d) `Number()` validation accepts forms such as `"1e1"`, while runtime `parseInt` interprets them differently. Task 10 explicitly edits settings.json directly — a typo can create an excessive number of loops/calls, disable practical breaker recovery, or cause immediate cooldown retries. Use one strict bounded runtime parser for all six keys and test malformed, below-minimum, and above-maximum direct-file values.

2. Medium — Raising G under an existing backlog does not fill newly available capacity. The revised `release()` correctly handles decreases, but grants only one waiter. With limit 1, one holder, five queued waiters, raising the limit to 6 and releasing wakes only one waiter. `release()` should grant queued waiters in a loop while `inFlight < limitFn()`. Add an increase-under-backlog behavioral test alongside the decrease test.

(Round-1 responses otherwise confirmed adequate: deployment ordering, decrease convergence, bare `&` guard, C>1/empty-queue coverage, windowed log verification.)

**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 2

---

### Response to Round 2
**Responder**: Claude Code

**Findings addressed**: 2

1. **Runtime bounds inconsistent and bypassable (parseInt junk / no upper bound / "1e1" divergence / pre-existing cooldown)**
   - Verdict: PARTIALLY ACCEPTED
   - Evidence: 上界缺失属实——C=100 会每会话起 100 个 loop,quota cooldown 手滑写 `"999999999999"` ≈ 31 年熔断不恢复;`Number('1e1')===10` 与 `parseInt('1e1')===1` 的解析分歧属实。
   - Action(采纳部分): 新增导出纯函数 `readIntBounded(raw, def, lo, hi)`(`Number()+isInteger` 严格解析,与 validateSettings 语义逐字一致),**本计划全部 5 个新键统一走它**——3 个 config 键(quota/auth cooldown [60000,86400000]、maxFailures [1,20],Task 5)+ C([1,16],Task 8)+ G([1,64],Task 7 limitFn)。新增单测覆盖 junk/below-min/above-max/科学计数法(Task 5 Step 6)。
   - Action(不采纳部分): 既有 `cooldownMs` 的 `parseInt||1200000` 保持原样。理由:`bypass-openai.test.ts` DEFAULT_SETTINGS 以 `'5000'`(低于 60000 下限)作为夹具值,收界会改变既有安装中合法低值配置的语义并破坏既有测试 pin;该键 UI 路径已由 Task 6 intBounds 补界,直改文件的残余风险是改动前既有面,不再扩大(外科手术纪律)。

2. **release() grants only one waiter on limit increase under backlog**
   - Verdict: ACCEPTED
   - Evidence: 原实现单次 grant——limit 1→6 时一次 release 只唤醒 1 个 waiter,扩容按 release 周期逐个渗透。
   - Action: `release()` 改为循环放行 `while (waiters.length > 0 && inFlight < limitFn())`(grant 自增 inFlight,循环自然终止于活上限);新增 increase-under-backlog 行为测试(1 holder + 5 parked → limit=6 → 单次 release 后 peak===5)。

**Spec body updated**: Yes
**Open issues remaining**: 0

---

### Round 3
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

1. Medium — R2-1 remains partially unresolved. `CLAUDE_MEM_BYPASS_COOLDOWN_MS` still uses permissive, unbounded `parseInt`, while Task 6 validates it as a strict integer in `[60000, 86400000]`. The rebuttal also calls `5000` a legal legacy value, which directly conflicts with that new validation. Apply strict bounded parsing with compatibility-appropriate bounds and align `validateSettings`, or define an explicit migration policy.

(R2-2 resolved: release loop correctly fills increased capacity. Five new settings consistently bounded.)

**Verdict**: REVISIONS NEEDED
**Next action**: Response to Round 3

---

### Response to Round 3
**Responder**: Claude Code

**Findings addressed**: 1

1. **Pre-existing cooldown key: UI bounds [60000,86400000] contradict the "5000 is legal" runtime rebuttal**
   - Verdict: ACCEPTED
   - Evidence: 矛盾属实——R1-4b 给该键加的 UI 界(60000 下限)会拒绝 5000,而 R2-1 反驳又以 5000 合法为由拒绝运行时收界,两者不能同真。
   - Action: 统一为**兼容界 [1000, 86400000]**,两路一致:Task 6 intBounds 该键条目改为 `[1000, 86400000]`(注释注明兼容界与依据);Task 5 resolveConfig 将原 `parseInt(...) || 1200000` 整体替换为 `readIntBounded(settings.CLAUDE_MEM_BYPASS_COOLDOWN_MS, 1200000, 1000, 86400000)`。依据:夹具 `'5000'`、机器目标 3min、代码默认 20min 均 ≥1000,现实不存在 <1s 合法冷却;负数/垃圾/超长两路皆拒。`scheduleCooldownProbe` 的 `?? 1200000` 兜底不变;要求改动后跑 `bypass-openai.test.ts` 验证夹具无回归。

**Spec body updated**: Yes
**Open issues remaining**: 0

---

### Round 4
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Focused Review

The Round 3 finding is adequately resolved. Both paths now use compatible bounds `[1000, 86400000]`: runtime parsing uses strict `readIntBounded(...)`; `validateSettings` applies the same bounds; legacy fixture value `"5000"` remains valid; negative, malformed, fractional, and excessive values fall back or are rejected appropriately; the focused `bypass-openai.test.ts` regression run is explicitly required. No remaining finding.

**Verdict**: APPROVED
**Next action**: Final review

---

### Round 5
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Final Review

Blocking review issue: the workspace sandbox fails before any file or command can be accessed (`bwrap: Failed to make / slave: Permission denied`). Could not inspect the implementation, diff, or run tests/build. This is a verification-infrastructure blocker, not a confirmed code defect. Re-run the final review with a functioning workspace sandbox.

**Verdict**: REJECTED (infrastructure-only; zero spec findings)
**Next action**: Response to Round 5

---

### Response to Round 5
**Responder**: Claude Code

**Findings addressed**: 1 (infrastructure, not spec content)

1. **Reviewer sandbox could not access files/commands**
   - Verdict: ACCEPTED (as process issue)
   - Evidence: 本 pod 的 bwrap 嵌套受限,Codex CLI 沙箱在该轮完全无法初始化;reviewer 明确说明"非已确认代码缺陷",并要求重跑终审。
   - Action: spec 正文零改动。Round 6 重跑 Final gate,并把审阅所需的关键源文件(BypassLane.ts、observation-filter.ts、SettingsRoutes.ts、SettingsDefaultsManager.ts 相关段、PendingMessageStore 相关段、既有测试锚点)**全文内联**进提示词,使终审不依赖 shell 即可对照真实代码验证。

**Spec body updated**: No
**Open issues remaining**: 0

---

### Round 6
**Reviewer**: Codex (gpt-5.6-sol @ xhigh) | **Type**: Final Review (re-run with inlined sources after Round 5 infra failure)

未发现真实阻塞项。方案与内联源码一致,关键并发、熔断、退避、生命周期和测试防线均具备可实施性。

**Verdict**: APPROVED
**Next action**: Phase 2
