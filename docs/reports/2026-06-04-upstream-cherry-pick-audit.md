# 上游 claude-mem v10.6.1 → v13.4.0 可移植 Cherry-Pick 审计报告

> **日期**: 2026-06-04
> **作者**: Claude Opus 4.8（claude-mem 工作区自动审计，16 路多 Agent 工作流编排）
> **基准版本**: 本仓库 `proj-claude-mem@4c032ffa`；上游 `thedotmack/claude-mem`，审计起点 `9f529a30`（2026-03-19，紧邻 v10.6.1 之前），审计终点 `v13.4.0`（`dc2eef8e`，2026-05-29）
> **影响范围**: worker 服务、SQLite 持久层、hooks/CLI、Chroma/MCP、AI provider（BypassLane）、context 注入、skills、安装与跨平台、隐私脱敏、许可证

---

## 〇、本轮 Catch 确认清单（经逐项 grill 确认，2026-06-04）

> 本节是与维护者逐条 grill 后锁定的**本轮实际移植清单**。范围决定为"全部 actionable 逐项裁定";许可证立场:**v13.x(Apache-2.0)代码照常拉取,fork 保持 AGPL-3.0,仅在 commit/PROVENANCE 标注 Apache 出处**。所有移植均为"按 diff 语义手工重做"(无共享 git 历史),schema 变更须以新迁移(34+)重做。

### ✅ 本轮纳入(ADOPT)

**A. 安全 / 数据完整性**
1. observation `content_hash` 用 `\x00` 分隔避免碰撞误去重（`9f...` 9cfa57d49）
2. `parseFileList` 守护 `files_read/files_modified` 裸路径（3 处:ChromaSync/SessionStore/files.ts；2a304d59e）
3. 主通道非 XML 垃圾响应 `markFailed` 重试而非静默丢弃（be99a5d69，有界重试已确认）
4. **observer + fresh-summarize SDK 锁死【选 A】**:`tools:[]`+`allowedTools:[]`+保留 `disallowedTools`+`mcpServers:{}`+`settingSources:[]`+`strictMcpConfig:true`+cwd jail+`canUseTool` 全拒,**两处调用点**;跳过 NDJSON 审计日志（ce13c887 plan-05 + 703c64c7/46d204ee9；SDK 0.1.77 已确认支持全部字段）
5. `~/.claude-mem/.env` 限定 0600/0700（31ee1024c）**＋ 同样保护施加到 `~/.claude-mem/settings.json`**（密钥实际存于此，fork-original 扩展）
6. 持久化边缘剥离 `<system-reminder>`（a66b98bcd）
7. 持久化边缘剥离 `<persisted-output>`（f81684c61）
8. summarize 路径对 `last_assistant_message` 做隐私剥离（46d204ee9/bd68bfcc）
9. 阻断 `CLAUDE_CODE_EFFORT_LEVEL`/`ALWAYS_ENABLE_EFFORT` 进入 SDK 子进程（9c56dda79；已确认我方零依赖、ENTRYPOINT/OAUTH 不受影响）

**B. 可靠性 / 成本**
10. `isPortInUse` 改原子 socket bind（64cce2bf）
11. `aggressiveStartupCleanup` 排除父 hook PID + PID 文件 worker PID（88b47f9e）
12. **会话生命周期防失控 4 部分全纳入**:① SIGTERM/143 视为有意终止 ② 本地 controller 绑定 ③ spawn 前杀同 session 旧进程 ④ 墙钟上限做成配置 `CLAUDE_MEM_SESSION_MAX_AGE_MS`(默认 4h、可调可关)（f97c50bf）
13. context overflow 时清空 `memorySessionId` 强制新会话（703c64c7）
14. 端口竞态优雅退出消除假 ERROR（08cf2ba3）
15. `POST_SPAWN_WAIT` 5s→15s（macOS 冷启动；88b47f9e）
16. 保留主语义搜索 Chroma 相关性排序——**用我方已有的 `rankedIds` 重排实现(风险降为 LOW)**（46d204ee9）
17. chroma-mcp 重连路径 tree-kill 子进程树——**移植 v13.4.0 最终态**(d384d3c5 + 55334129，去 supervisor 依赖；Apache 出处)
18. pin `onnxruntime>=1.20` + `protobuf<7` + `chroma-mcp==0.2.6`（55334129；**不带 Windows `quoteForCmdExe`**，仅 macOS/Linux）
19. chroma-mcp 以 `cwd=os.homedir()` spawn,避开 pydantic 读项目 `.env` 崩溃(`c7c4fd54d` #1297;`ChromaMcpManager.ts` 加 1 行)
20. Chroma 缺失时回退 FTS5/LIKE（be99a5d69；仅 Chroma 缺失时回退，保留我方"返回 0 不回退"区分）——pod 环境有现实价值
21. BypassLane 观测路径补 ghost observation 过滤（方案 b，内联，不扰 context-overflow 检测；e39821298）
22. `ChromaSync.addDocuments` 重复 ID delete+add 重和（64cce2bf）
23. MCP `search`/`timeline` 声明 `inputSchema.properties`（保留 `additionalProperties:true`+加 `from_project`；8cdabe631）
24. `PRAGMA journal_size_limit` 限 WAL 增长（每个池连接；be99a5d69）
25. `parseSummary` 全空子标签假阳性守护（93a30c5c8）
26. 移除死代码退出码 3 `USER_MESSAGE_ONLY`（4aa7119d7）
27. concept 清理日志 error→debug（29ef3f560）
28. `normalizeParams` 单数 `concept`→`concepts`（be99a5d69）
29. `cwdToDashed` 同时编码 `.`→`-`（daf6d9dc0）
30. debug 模式 `JSON.stringify` 包 try/catch（46d204ee9；仅此一分支，保留我方日志按日切分）
31. `trustedDependencies:["tree-sitter-cli"]`（plugin/package.json + build-hooks.js；99ff296f）
32. MCP loopback 连接失败不拖垮 reaper + SummaryLane（MCP connect 单独 try/catch；4589b34e + 重排 init try 块）

**C. 功能 / 增强**
33. context 注入输出压缩 ~53%（MarkdownFormatter + TimelineRenderer；**不带 `$CMEM` 头**；7e072106）
34. **bypass 端点 base URL 通用化为「任意 OpenAI 兼容端点」** + `CLAUDE_MEM_OPENCODE_BASE_URL`(provider-agnostic resolver；d13fc437 改编到 BypassLane；Apache 出处)**＋ 彻底移除已弃用的 OpenRouter 路径**(BypassLane + settings/env/routes/UI/types 全量清扫；**不新增** `CLAUDE_MEM_OPENROUTER_BASE_URL`;保留 Gemini + OpenCode)
35. `weekly-digests` skill（纯 markdown，后端 `/api/context/inject?full=true` 已有；改名 `mem-*`；09e74bbf）
36. `writeJsonFileAtomic` 崩溃/软链安全原子 JSON 写工具(整合关键 config 写入点；65607897a)
37. sqlite **PRAGMA 前可读性探测**(assertSchemaReadable；a8cf67164 之 (i) 部分；保留我方 Python3 修复)

**D. 探针 / 低价值便宜赢**
38. Stop hook 加**一行 `agent_id` 探测日志**(纯 instrumentation；用于在 pod 上确认"子 agent 触发多余 summary"是否真实存在，**带后续验证义务**)
39. chroma-mcp `ANONYMIZED_TELEMETRY=false`（39f110260）
40. `storeObservationsAndMarkComplete` 加 `changes!==1` 断言(仅断言，不改 DELETE-vs-UPDATE；65f2fd8c)
41. 非 XML 响应 200 字预览 WARN 日志(可观测性；92f800d4)

### ⏸️ Defer(标注为未来专门轮次或待证据)

- **文件读取决策门**(Q17)——**显式标注:未来专门一轮做**。会显著改变读取逻辑、有读取摩擦风险(上游 #1729 churn 为证)、需 `permissionDecision/updatedInput` + 新 sqlite 查询 + 路由 + 灰度，独立设计。
- 子 agent summary 抑制 + agent_type/agent_id 标注(Q23 a/b)——**先靠第 38 项探针收集证据**,确认问题存在再纳入;现代 CC 用独立 `SubagentStop`(我方不注册),大概率不存在,且违反"No Over-Defensive Code"。
- Tier 路由 Haiku 降本(Q16)——你 OpenCode-primary,便宜活已被 bypass 接走,边际收益小。
- reapStaleSessions 强杀僵尸 generator(Q12)——缺口窄、MED 风险,本轮不加。
- sqlite 多孤儿一次清理 (ii) + 整体 `.recover` 替换——更罕见 / 引入 sqlite3 CLI 依赖。
- commit-hash 校验(Q22)——你"根不加 git、仓库在下一层"的范式使根层无干净 git 上下文,脆弱,**跳过**。
- smart-explore 24 语言(Q19)——**不需要**(明确放弃)。

### ⛔ 跳过 / 已具备(本轮不动)

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY`——你已用现代 `autoMemoryEnabled:false` 关闭(already-have)。
- **timeline anchor-coercion**(ff0793f7)——经复核**已具备**:`normalizeParams` 已对 `anchor` 强转,且在 `handleTimeline`/`getContextTimeline` 的 `typeof anchor==='number'` 分支前调用,本轮移除该任务。
- LOW 簇其余:Windows 加固(无 Windows)、语义注入 UserPromptSubmit(上游默认关)、隐藏 observer-sessions、`~` 展开、env-file resolver、ANTHROPIC_BASE_URL 持久化(透传已覆盖)、security 观察类型+Telegram、skeleton denylist、`/health` activeSessions、observer prose-discard prompt 改写(待第 41 项日志给证据再说)。
- §6.4 全部排除项:Server Beta 全轨道、Worktree 归并采纳(已被我方 parent-root 解析取代)、summary salvage/coercion/circuit-breaker 演进(已被 SummaryLane+fresh-summarize 取代)、Knowledge Agents(依赖我方没有的 SearchOrchestrator + 全局 corpus 冲突 per-project)、安装器/多 IDE/原生 Codex hooks/platform_source。

### 计数:本轮纳入 41 项(安全/完整性 9 + 可靠性/成本 23 + 功能 5 + 探针/便宜赢 4);Defer 7 类;跳过/已具备若干。
> 注:原审计列 41 项 → spec-review 移出已具备的 **timeline anchor-coercion(ff0793f7)** → 40 → codex 交叉审计补回首版 §0 遗漏的 **chroma-cwd-homedir(c7c4fd54d)** → **41**。
> 这 41 项在 impl-plan 中实现为 **42 个 `### Task` 标题**(item↔task 非 1:1):session-lifecycle 防失控 1 项拆为 2 Task;markFailed+preview-log、system-reminder+persisted-output 各为 2 项合 1 Task;base-url 通用化+OpenRouter 移除 1 项拆为 2 Task;另加 1 个 `docs/PROVENANCE.md` 收尾 Task。

---

## 一、结论（核心结论前置）

**核心结论**：上游在我们审计基线之后发布了 **441 个 commit / 约 300 文件**，跨越 v11、v12、v13 三个大版本。逐条审计（118 条结构化结论）后，**真正值得移植的内容集中在"安全、数据完整性、可靠性"三类小而精的 bug 修复**，而非大型新功能——因为上游的两大新功能轨道（**Server Beta** 与 **Worktree 归并采纳**）要么与我们架构正交、要么已被我们 fork 的设计提前解决。

**原因**：我们 fork 已重写了 summary/observation 管线（SummaryLane + fresh-summarize + 自有 salvage）、引入了 per-project SQLite 隔离、并以 BypassLane 取代了上游的逐 provider agent。这导致上游约 **44%（52/118）的变更已被我方实现取代或不适用**；但也正因我们 fork 起点较早，上游若干**横切的安全/数据完整性修复我们确实缺失**。

**最终分级（基于证据，每条均经 fork 源码核对）**：

- **强烈建议采纳（P0/P1，共约 30 项，多为 S 级工作量、CLEAN/低风险）**：见 §6.1、§6.2。其中安全/数据完整性 10 项为**应优先修复**类。
- **建议评估后采纳（P2，约 17 项）**：有价值的功能/增强，但需适配我方架构或属产品取舍，见 §6.3。
- **明确排除（约 52 项）**：已被取代 / 架构不兼容 / 不适用，见 §6.4。
- **1 项非代码决策**：上游 v13.0.0 起 **AGPL-3.0 → Apache-2.0 重新授权**，我方仍为 AGPL-3.0，需维护者**人工决策**（见 §6.5），不应由自动流程改动许可证。

> ⚠️ **重要前提**：本 fork 与上游**无共享 git 历史**，所有"cherry-pick"本质是**按 diff 语义手工重做**，不能用 `git cherry-pick <hash>`。下文"可移植=CLEAN"指改动小、可近乎照搬。

### P0 应优先修复清单（安全 + 数据完整性，建议立即处理）

| 候选 | 类别 | 上游引用 | 工作量 |
|------|------|----------|--------|
| observation content_hash 用 `\x00` 分隔，消除哈希碰撞误去重 | 数据完整性 | `9cfa57d49` | S |
| `parseFileList` 守护 `files_read/files_modified` 裸路径，修复 ChromaSync 崩溃 + 丢路径 | 数据完整性 | `2a304d59e` (#1359) | S |
| 主通道收到非 XML 垃圾响应时 `markFailed`（重试）而非静默 `confirmProcessed`（丢数据） | 数据完整性 | `be99a5d69` (#1874) | M |
| observer SDK 真正锁死工具（`tools:[]`+`allowedTools:[]`+`canUseTool` 兜底，非仅 `disallowedTools`） | 安全 | `ce13c887` (#2332, plan-05) | M |
| 隔离 worker `query()`：`mcpServers:{}`+`settingSources:[]`+`strictMcpConfig:true` | 安全/正确性 | `703c64c7`/`46d204ee9` | S |
| `~/.claude-mem/.env` 限定 0600/0700 权限 | 安全（密钥泄露） | `31ee1024c` (#1770) | S |
| 中央持久化边缘剥离 `<system-reminder>` 标签 | 隐私 | `a66b98bcd` | S |
| 持久化边缘剥离 `<persisted-output>` 标签 | 隐私 | `f81684c61` | S |
| summarize 路径对 `last_assistant_message` 做隐私剥离 | 隐私 | `46d204ee9` (cherry `bd68bfcc`) | S |
| 阻断 `CLAUDE_CODE_EFFORT_LEVEL`/`ALWAYS_ENABLE_EFFORT` 进入 SDK 子进程（防永久 HTTP 400 重试） | 安全/成本 | `9c56dda79` (plan-06) | S |

---

## 二、背景与规模

- **上游已远超我们的审计基线**：我们 fork 基于上游 v10.5.2，审计同步至 `9f529a30`（≈v10.6.1）。此后上游历经 **v11、v12、v13 三个大版本**，最新发布为 **v13.4.0**（2026-05-29）。
- **变更规模**：审计区间 `9f529a30..v13.4.0` 共 **441 个 commit**、约 **300 个文件**变动。
- **审计产物**：上游已 clone 至 `attn_sink/upstream-claude-mem`（blobless 部分克隆，30MB，可完整 `git log/show/diff`）。commit 已按子系统分类至 `attn_sink/upstream-commits-categorized.txt`，完整 changelog 见 `attn_sink/upstream-CHANGELOG.md`。

### 主要上游版本主题

| 版本 | 日期 | 主题 |
|------|------|------|
| v10.6.1–v10.7.x | 2026-03 | Timeline Report skill、压缩 context 输出、多 IDE 安装器雏形 |
| v11.0.0 | 2026-04-05 | 语义 context 注入（Chroma）、按队列复杂度的 Tier 路由（Haiku 降本）、多机同步、孤儿消息 drain、**严格 observer 响应契约（破坏性）** |
| v12.0.0 | 2026-04-07 | **文件读取决策门（PreToolUse gate）**、smart-explore 24 语言、platform_source（Claude/Codex）会话隔离、40+ bug 修复 |
| v12.1.0 | 2026-04-09 | **Knowledge Agents**（corpus 构建/查询） |
| v12.1.x–v12.2.x | 2026-04 | summary 管线 salvage/coercion 修复、MCP 合规、子 agent summary 禁用与标注、**worktree 归并采纳** |
| v12.6.x–v12.7.x | 2026-05 | Agent SDK 单一路径、网关 env、drain 非法 observer 响应、**原生 Codex hooks**、崩溃安全 JSON 写入 |
| v13.0.0–v13.1.0 | 2026-05-08 | **Server Beta（Postgres+BullMQ+Redis，opt-in）**、AGPL→Apache 重新授权 |
| v13.2.0–v13.3.0 | 2026-05 | 新 skills（wowerpoint/design-is/weekly-digests/oh-my-issues）、MCP 重复 .mcp.json 修复、Codex transcript 回放修复 |
| v13.4.0 | 2026-05-29 | OpenRouter 可配置 base URL、spawn 契约、输出保真（commit-hash 校验 / null-cwd hex 修复）、SQLite 自愈（.recover）、SessionMessageBuffer |

---

## 三、审计方法

1. **基线对齐**：以 `9f529a30`（fork 已审计点）为下界、`v13.4.0` tag 为上界，枚举 441 个 commit（v13.4.0 之后默认分支仅 1 个 docs+merge，无可审计内容）。
2. **子系统分类**：按每个 commit 实际改动的文件路径（而非提交信息关键词）归类到 worker/sqlite/hooks/chroma-mcp/provider/context/skills/install/server-beta 等桶。
3. **fork 分歧测绘**：先完整测绘本 fork 的自有改造（per-project SQLite 隔离、SummaryLane、fresh-summarize、BypassLane、tag-stripping、迁移版本至 33），以此判定每条上游变更对 fork 的适用性。
4. **多 Agent 深度审计**：按主题派发 16 个审计 Agent（15 个返回有效结论、0 失败；约 158 万 token、552 次工具调用），逐条 `git show` 上游真实 diff，并对照 fork 源码判定 `fork_status`（已具备/已被取代/缺失/部分），输出结构化结论（价值/可移植性/冲突风险/工作量/建议）。
5. **综合**：汇总去重，产出本报告的 cherry-pick 清单。

---

## 四、贯穿所有 Cherry-Pick 的结构性约束（重要）

以下约束适用于**几乎每一条**候选项，是"可移植性"判定的前提，**先于**单条结论：

1. **本 fork 与上游无共享 git 历史**：本 fork 以快照导入并累积约 80 个自有 commit，**与上游 commit 无祖先关系**。因此**无法 `git cherry-pick <hash>`**——所有移植本质是"按 diff 语义手工重做"。

2. **数据库迁移必须重新编号**：本 fork 迁移系统使用 `schema_versions` 整数序列，**当前最大版本为 33**，编号方案与上游不同。任何上游 schema 变更**不可照搬迁移代码**，必须在 `src/services/sqlite/migrations/runner.ts` 中以**下一个空闲版本号（34+）新增迁移**重新实现。（典型冲突：上游用 v24 建 `observation_feedback`、v27 加 `agent_type/agent_id`，而这些版本号我方已占用。）

3. **summary/observation 管线已被 fork 重写**：上游针对 observer/summary 响应契约的大量修复，落在我们已用 **SummaryLane + fresh-summarize + 自有 salvage** 替换的区域。整条 salvage/coercion/circuit-breaker 演进（#1718→#1850→#2072→#2074）针对的是"observer 会话内 summarize"失败模式，**被我们的 fresh-query 设计结构性消除**，照搬反而会重新引入我们刻意移除的机制。

4. **Server Beta 轨道整体不适用**：v13.0.0/v13.1.0 的 Server Beta（Postgres + BullMQ + Redis + Better-Auth `/v1` API）是**独立 opt-in 运行时**，与我们 SQLite-worker 架构正交，**整体排除**；仅从其 squash-merge 抽取被一并打包的 worker/sqlite 侧修复。

5. **授权边界**：上游在 **v13.0.0 将仓库由 AGPL-3.0 重新授权为 Apache-2.0**（`36b0929f`）。移植 v13.0.0 及之后 vs 之前的代码，许可证义务不同——需维护者明确我方 fork 立场（详见 §6.5）。

---

## 五、明确排除的类别（非候选）

- 纯版本号提升、changelog、文档、CI、纯测试重构；
- 已构建的 `plugin/` 产物（由 build 生成，不手工移植）；
- Server Beta 运行时全部新增文件（见约束 4）；
- `ragtime/` 子项目；
- v12.3.3 的 revert + re-revert 对（`bfc7de377`/`8d166b47c`，净零）。

---

## 六、Cherry-Pick 候选清单

字段说明：**价值** HIGH/MED/LOW；**可移植** CLEAN(近乎照搬)/ADAPT(需适配)/REIMPL(需重写)；**风险**=冲突风险 LOW/MED/HIGH；**工作量** S/M/L；**现状**=fork_status。

### 6.1 P0 — 安全与数据完整性（强烈建议优先采纳）

| 候选 | 上游引用 | 现状 | 价值 | 可移植 | 风险 | 量 | 关键证据 / 说明 |
|------|----------|------|------|--------|------|----|------|
| content_hash 用 `\x00` 分隔避免碰撞误去重 | `9cfa57d49` | MISSING | HIGH | CLEAN | LOW | S | `observations/store.ts:23-26` 仍裸拼接 `sid+title+narrative`，不同元组可产生相同哈希被静默去重。改 1 行，仅影响新行无需迁移；同时带入碰撞单测。 |
| `parseFileList` 守护裸路径 | `2a304d59e`(#1359) | PARTIAL | HIGH | ADAPT | LOW | S | 三处问题：`ChromaSync.ts:130-133` 无守护 `JSON.parse` 会崩溃并中断向量同步；`SessionStore.ts:521/529` 同样裸 parse；`observations/files.ts:34-53` 虽不崩溃但**丢弃裸路径**。统一引入 `parseFileList`。 |
| 非 XML 垃圾响应 `markFailed` 重试而非静默丢弃 | `be99a5d69`(#1874) | MISSING | HIGH | ADAPT | MED | M | `ResponseProcessor.ts:224-234` 无条件 `confirmProcessed`，主 Claude SDK 通道遇 auth/rate-limit/乱码会丢整批。沿用 `text.trim() && obs==0 && !summary && !XML` 判据，按 fork 的 `markFailed` 返回形适配。 |
| observer 真正"无工具"保证（plan-05） | `ce13c887`(#2332) | MISSING | HIGH | ADAPT | LOW | M | `SDKAgent.ts:102-115` 与 `fresh-summarize.ts:148-156` 仅传 `disallowedTools` 黑名单，新内置工具即可绕过。引入 `buildHardenedSdkOptions`（`tools:[]`+`allowedTools:[]`+`canUseTool` 拒绝+审计）。**契合 CLAUDE.md 安全规则**；采纳前核对所 pin 的 SDK 版本字段名。 |
| 隔离 worker `query()`（mcpServers/settingSources/strictMcpConfig） | `703c64c7`/`46d204ee9` | MISSING | HIGH | ADAPT | LOW | S | 两处调用点均未隔离，会继承用户 MCP server 与 settings.json。`mcpServers:{}` 普遍安全且价值最高；`settingSources:[]`/`strictMcpConfig` 需核对 SDK 版本支持。 |
| `.env` 限定 0600/0700 | `31ee1024c`(#1770) | MISSING | HIGH | CLEAN | LOW | S | `EnvManager.ts` 写 `.env` 无 mode、无 chmod；存有 ANTHROPIC/GEMINI/OPENROUTER/OPENCODE 密钥，permissive umask 下世界可读。 |
| 剥离 `<system-reminder>` 标签 | `a66b98bcd` | PARTIAL | HIGH | CLEAN | LOW | S | 我方仅在 transcript 读取时剥离，**未在中央 `stripTagsInternal` 持久化边缘剥离**；system-reminder 含 CLAUDE.md 内容/工具清单，会被写入 observations/prompts。加 1 条正则 + 计数。 |
| 剥离 `<persisted-output>` 标签 | `f81684c61` | MISSING | MED | CLEAN | LOW | S | 全 fork 无处理；persisted-output 含大体积工具输出，膨胀 observation。与上一条同一机制，可同 PR。 |
| summarize 路径剥离 `last_assistant_message` 隐私标签 | `46d204ee9`(cherry `bd68bfcc`) | MISSING | MED | CLEAN | LOW | S | `handleSummarize`(SessionRoutes.ts:628-653)/hook `summarize.ts` 原样入队，`<private>` 会泄入 summary。在 hook 边缘复用 `stripMemoryTagsFromPrompt`。 |
| 阻断 `CLAUDE_CODE_EFFORT_LEVEL` 等进入子进程 | `9c56dda79`(plan-06) | MISSING | MED | ADAPT | LOW | S | fork 注释明确不阻断 `CLAUDE_CODE_*` 前缀，父 shell 的 effort 变量会被 SDK 转成 `effort` 参数，Haiku/Sonnet-4.5 永久 400 重试。仅把两个变量名加入 `BLOCKED_ENV_VARS`；不引入 env-sanitizer 层。 |

### 6.2 P1 — 可靠性与成本（建议采纳）

| 候选 | 上游引用 | 现状 | 价值 | 可移植 | 风险 | 量 | 关键证据 / 说明 |
|------|----------|------|------|--------|------|----|------|
| `isPortInUse` 改原子 socket bind | `64cce2bf` | MISSING | HIGH | CLEAN | LOW | S | `HealthMonitor.ts:20-29` 用 HTTP `/api/health` 探活有 TOCTOU 竞态；改 `net.createServer().listen()` 仅 `EADDRINUSE` 判真。GUARD2 与 `waitForPortFree` 同时受益。 |
| `aggressiveStartupCleanup` 排除父 hook PID 与 PID 文件 worker PID | `88b47f9e`(#1490) | MISSING | HIGH | CLEAN | LOW | S | `ProcessManager.ts:448-519` 仅排除自身 PID，新生 daemon 可能 SIGKILL 掉 spawn 它的 hook 或在跑的 worker。fork 已有 `readPidFile()`，仅改排除谓词。本地不稳定的真实来源。 |
| 会话生命周期防失控（SIGTERM/143 + 4h 墙钟 + 本地 controller 绑定 + spawn 前杀重复） | `f97c50bf`(#1693) | PARTIAL | HIGH | ADAPT | MED | M | `SessionRoutes.ts:197/253` 直接读 `session.abortController.signal.aborted`（陈旧竞态）；无 SIGTERM 分支、无墙钟上限。需按 fork 的 `decideGeneratorAction/executeAction` 重表达。本切片**最高的成本安全价值**。 |
| context overflow 时清空 `memorySessionId` 强制新会话 | `703c64c7` | MISSING | HIGH | CLEAN | LOW | S | `SDKAgent.ts:363-374` 仅 abort，不重置；resume 会一直复用被污染的上下文（上游单会话曾累计 68 条失败）。fork 已有 `forceInit` 语义，集成自然。 |
| 保留 Chroma 语义排序（`orderBy='relevance'`） | `46d204ee9`(#2153) | MISSING | HIGH | ADAPT | MED | M | `SearchManager.ts` 主语义路径把 Chroma 排序强制改 `date_desc`，破坏相关性。给 `*ByIds` 三方法加 relevance（跳过 ORDER BY，按 id 顺序重排）。`SessionStore` 高度定制故 MED。 |
| chroma-mcp 以 `cwd=homedir` spawn | `c7c4fd54d`(#1297) | MISSING | HIGH | CLEAN | LOW | S | `ChromaMcpManager.ts:119-124` 无 cwd，继承项目目录；pydantic 读到无关 .env 即崩溃进永久退避。`os` 已导入，加 1 行。 |
| pin `onnxruntime>=1.20` + `protobuf<7` | `55334129`(#2371) | MISSING | HIGH | ADAPT | LOW | S | macOS arm64/py3.13 下嵌入全失败（INVALID_PROTOBUF），语义搜索静默降级为 FTS。注入 `--with` 并 pin `chroma-mcp` 版本。Windows 还需配套 `quoteForCmdExe`。 |
| chroma-mcp 重连路径 tree-kill 子进程树 | `d384d3c5`/`55334129` | MISSING | HIGH | ADAPT | MED | M | 五处重连/超时/onclose/stop 仅 `close()`，孙进程在 Linux re-parent 残留（单会话 20+）。移植自包含的 `killProcessTree`+`collectDescendantPids`（去掉 fork 没有的 supervisor 依赖）。 |
| MCP `search`/`timeline` 声明 `inputSchema.properties` | `8cdabe631`(#1384) | MISSING | HIGH | ADAPT | LOW | S | `mcp-server.ts` 这两个工具 `properties:{}`，部分客户端（Codex）只转发已声明参数→调用恒为空。保留 fork 的 `additionalProperties:true` 并加 `from_project`。 |
| 主语义搜索缺 Chroma 时回退 FTS5/LIKE | `be99a5d69`(#1913) | MISSING | MED | ADAPT | MED | M | `SessionSearch.ts` 现返回空并记 "Text search not supported"，但 FTS 表与 `isFts5Available` 已具备。仅在 Chroma **缺失**（非返回 0）时回退，保留 fork 现有区分。 |
| `addDocuments` 重复 ID 冲突 delete+add 重和 | `64cce2bf`(#1566) | MISSING | MED | CLEAN | LOW | S | `ChromaSync.ts:294-300` 对任何错误仅"继续"，含部分写后的重复 ID 冲突。注意匹配 chroma-mcp 实际错误措辞（`already exist`）。 |
| `PRAGMA journal_size_limit` 限 WAL 增长 | `be99a5d69`(#1956) | MISSING | MED | ADAPT | LOW | S | 对我方更相关：DbConnectionPool 多达 10 个 per-project DB，各自 WAL。在 SessionStore PRAGMA 块加 1 行；周期 checkpoint 需遍历池连接。 |
| BypassLane 补 ghost observation 过滤 | `e39821298`(#1625) | PARTIAL | MED | ADAPT | LOW | S | 主通道已在 `ResponseProcessor.ts:75-84` 过滤，但 fork 自有 `BypassLane.ts:760` 直接存储仅查 `length===0`，裸 `<observation>` 可入库。在 BypassLane 存储前内联同款过滤（方案 b，不扰动 overflow 检测）。 |
| `parseSummary` 加"全空子标签"假阳性守护 | `93a30c5c8`(#1360) | MISSING | MED | CLEAN | LOW | S | `parser.ts` 提取后无全空守护，`normalizeSummaryForStorage` 把全 null 转空串入库→空 summary 行。插入 `if(!request&&...)return null;`（保留 fork 的 VerbatimEcho 抛出）。fresh-summarize 也受益。 |
| `timeline()` 数字 anchor 字符串强转（2 处）〔**已具备,移出本轮**〕 | `ff0793f7`(#2176) | ~~MISSING~~→已具备 | MED | CLEAN | LOW | S | ~~原判 `SearchManager.ts:473`/`:1458` 缺强转~~。**spec-review 复核更正**:`normalizeParams` 已对 `anchor` 强转,且在两处 `typeof anchor==='number'` 分支前调用(`handleTimeline`@400 / `getContextTimeline`@1450),故已覆盖,本轮移除。 |
| 移除死代码退出码 3 `USER_MESSAGE_ONLY` | `4aa7119d7` | MISSING | MED | CLEAN | LOW | S | `hook-constants.ts:27` 仍定义且无消费者；Claude Code 仅认 0/2，其它非零触发 "SessionStart hook error"。 |
| `trustedDependencies:["tree-sitter-cli"]` | `99ff296f`(#2278) | MISSING | MED | CLEAN | LOW | S | `plugin/package.json` 与 `build-hooks.js` 均缺；Node 25+ 下 `bun install` 触发 tree-sitter 原生编译失败。两文件各加两行保持同步。 |
| `normalizeParams` 单数 `concept`→`concepts` | `be99a5d69`(#1916) | MISSING | MED | CLEAN | LOW | S | `/api/search/by-concept?concept=X` 因 normalize 不映射单数而静默不过滤。 |
| `cwdToDashed` 同时把 `.` 编码为 `-` | `daf6d9dc0`(#2401) | MISSING | MED | CLEAN | LOW | S | `ObservationCompiler.ts:131-132` 只替换 `/`，含点的用户名/目录使 transcript 目录匹配失效。1 字符正则改 `[/.]`。 |
| concept 清理日志 error→debug | `29ef3f560`(#1606) | MISSING | LOW | CLEAN | LOW | S | `parser.ts:78` 例行归一化却记 error，每次正常响应都产噪声。1 行改 debug。 |
| 端口竞态优雅退出（消除假 ERROR） | `08cf2ba3`(#1447) | MISSING | MED | CLEAN | LOW | S | `worker-service.ts:1766-1772` 无条件 `logger.failure`；检测 EADDRINUSE 且确认 winner 健康则 INFO + exit(0)。 |
| `POST_SPAWN_WAIT` 5s→15s（macOS 冷启动） | `88b47f9e` | MISSING | MED | CLEAN | LOW | S | **直接关系当前 darwin 平台**：macOS 启用 Chroma 冷启 6–8s，5s 会误判 spawn 失败并删 PID 文件。 |
| debug 模式 `JSON.stringify` 包 try/catch | `46d204ee9` | MISSING | LOW | CLEAN | LOW | S | `logger.ts:283` 无守护，循环引用会崩溃 logger（进而 worker）；已有 `formatData` 兜底。仅改此一分支（保留 fork 的日志按日切分）。 |

### 6.3 P2 — 功能增强与可评估项（建议评估）

| 候选 | 上游引用 | 现状 | 价值 | 可移植 | 量 | 说明 |
|------|----------|------|------|--------|----|------|
| context 注入输出压缩 ~53%（表格→扁平行） | `7e072106` | MISSING | HIGH | ADAPT | M | `MarkdownFormatter.ts` 仍输出旧表格格式，每次 SessionStart 注入约 2 倍 token。**勿带入 `$CMEM` 头**（上游已 revert）。本切片唯一高价值项。 |
| 可配置 OpenAI 兼容 base URL（DeepSeek/LM Studio/自定义网关） | `d13fc437` | MISSING | MED | ADAPT | S | `BypassLane.ts:37` 硬编码 OpenRouter URL。上游改的是我们没有的 `OpenRouterProvider`，需重映射到 BypassLane；62 行 resolver 可独立照搬。 |
| Tier 路由（简单工具队列走 Haiku，约降本 52%） | `0fcc07887` | MISSING | MED | ADAPT | M | 仅路由部分有价值且可移植（`modelOverride`+`peekPendingTypes`+`applyTierRouting`）；`observation_feedback` 表无消费者应跳过。注意 BypassLane 活跃时多数 observation 走 bypass 价位，收益缩水。 |
| 文件读取决策门（PreToolUse 注入时间线 + 截断冗余读） | 见 §findings | MISSING | MED | ADAPT | M | fork 完全没有。需扩展 `HookResult` 的 `permissionDecision/updatedInput`、加 `getObservationsByFilePath` + `/api/observations/by-file`（走 per-project 池）。**仅移植收敛后的最终态** + #1729 的 mtime/定向读安全分支。属产品取舍，**建议设置开关默认关闭并先试点**。 |
| `weekly-digests` skill（按 ISO 周连载叙事） | `09e74bbf`(#2399) | MISSING | MED | ADAPT | S | 纯 markdown，所需 `/api/context/inject?full=true` 我方**已有**；改端口/DB 路径解析对齐我方 `mem-timeline` 即可。本切片最佳性价比 skill。 |
| smart-explore 扩到 24 语言 + 用户语法 | `95889c7b` | MISSING | MED | ADAPT | L | 我方解析器仅约 9 语言。需新增 21 个 tree-sitter 依赖并改 build 管线；建议分阶段（先 LANG_MAP+依赖，再用户语法）。 |
| 崩溃安全 + 软链接安全的原子 JSON 写工具 | `65607897a` | PARTIAL | MED | ADAPT | M | fork 有 5+ 处临时原子写均无 fsync/无软链接处理；`~/.claude/settings.json` 可能是软链（dotfile 管理 / 我方 OneDrive sync）。统一为共享工具。 |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（安装时） | `65607897a` | MISSING | MED | ADAPT | S | 防 Claude Code 内置 MEMORY 与 claude-mem 争上下文。可在 `sync-to-cache.cjs` 启用插件处插入。属产品决策，先报维护者。 |
| commit-hash 校验后再持久化 summary（plan-11 之 b） | `0b4611e8`(#2574) | PARTIAL | MED | ADAPT | — | 独立可移植，纯在 summary 文本上 `git cat-file -e` 校验；对 fresh-summarize 防臆造哈希有价值。配套带入 `57612286` 的 null-cwd 守护。 |
| 子 agent summary 抑制 + `agent_type/agent_id` 标注 | `789efe42`(#2073) | MISSING | MED | REIMPL | L | 需新迁移（34+）加列+索引 + hook 端短路。价值取决于是否大量使用 Claude Code 子 agent；暂列 CONSIDER。 |
| sqlite3 `.recover` schema 自愈（替代我方 Python 手术式修复） | `a8cf67164` | SUPERSEDED | MED | ADAPT | M | 我方 `Database.ts` 已有自有修复且**已 close 句柄**（`cf8d36132` 已具备）。仅建议吸收"PRAGMA 前可读性探测 + 多孤儿对象一次清理"，非整体替换。 |
| chroma-mcp `ANONYMIZED_TELEMETRY=false` | `39f110260` | MISSING | LOW | CLEAN | S | 关闭嵌入子进程每次触碰的后台遥测 HTTP。 |
| `/health` 增 `activeSessions` 计数 | `be99a5d69`(#1867) | MISSING | LOW | ADAPT | S | 便于外部监控死/卡队列；我方已有更丰富 SSE 事件，价值有限。 |
| `storeObservationsAndMarkComplete` 加 `changes!==1` 断言 | `65f2fd8c` | PARTIAL | LOW | ADAPT | S | 仅取完整性断言（零行完成静默成功→幻影消息）；DELETE-vs-UPDATE 留给队列生命周期负责人。 |
| Windows 加固（isMainModule / PowerShell EncodedCommand / cmd.exe 引用） | `753837bf`/`07ab7000` | PARTIAL | LOW | ADAPT | S | 对 darwin 低优先；若需 Windows 支持再议。 |
| 其它低价值可选项 | — | — | LOW | — | — | 语义注入(UserPromptSubmit，上游默认关)、隐藏 observer-sessions 项目、`~` 展开、security 观察类型 + Telegram、skeleton CLAUDE.md denylist、`CLAUDE_MEM_ENV_FILE` 懒解析、ANTHROPIC_BASE_URL/AUTH_TOKEN 持久化（透传已覆盖常见网关）。详见审计明细。 |

### 6.4 明确排除（已被取代 / 不适用 / 架构冲突）

| 主题 | 结论 | 原因（证据） |
|------|------|------|
| **Server Beta 全轨道**（Postgres/BullMQ/Redis/Better-Auth `/v1`） | NOT_PORTABLE | fork 无 `src/server/`、`src/storage/`，零相关依赖（已核 package.json）；squash 内捆绑的 worker 改动仅为存储抽象 plumbing（把同步 `PendingMessageStore` 改异步）+ 与我方编号冲突的迁移。`61fe70a2` 更删除 PendingMessageStore 改内存 buffer，与我方持久队列设计相反。 |
| **Worktree 归并采纳**（merged_into_project / adopt CLI / 复合命名 / UI 徽章） | SUPERSEDED | 我方 `paths.ts:resolveProjectRoot()→detectWorktree()` 在**写入时**即把所有 worktree 归到父 repo 根、同一 DB 同一项目名，结构上无需事后采纳。比上游更激进且更简单。 |
| **summary salvage/coercion/circuit-breaker 演进**（#1718/#1850/#2072/#2074） | SUPERSEDED | 针对 observer 会话内 summarize 失败模式；我方 fresh-query + SummaryLane（3 次重试→死信、DB salvage、obs-cap 步降、逐字回显拒绝）已覆盖。照搬会重引入已移除机制。 |
| **Knowledge Agents**（corpus 6 MCP 工具 + `/api/corpus/*`） | REIMPL（高成本高风险，暂排除） | 依赖上游重构的 `SearchOrchestrator`（我方仍用单体 `SearchManager`，无此文件）；corpus 全局存 `~/.claude-mem/corpora/` 与我方 per-project 隔离冲突。MCP/路由壳可移植，但数据层需重写。 |
| **安装器/多 IDE/npx-cli/原生 Codex hooks/platform_source** | 多数不适用 | 上游主体在 `src/npx-cli/`，我方用 `scripts/smart-install.js`。我方 Windows spawn 与 `CLAUDE_PLUGIN_ROOT` 解析已达 post-fix 状态。platform_source 对我方 per-project + 极少 Codex 用法价值低且需非干净迁移。 |
| 大量"已具备/已被取代"的可靠性修复 | ALREADY_HAVE/SUPERSEDED | 如：spinner 作用域、pair-aware 空串 spawn 过滤、completeByDbId 持久化、重复 notifySlotAvailable 移除、`/clear` 队列 drain、agent-pool 超时丢数据、Gemini O(N²) 截断、OpenRouter 回复恢复、迁移列表漂移类 bug（我方 SessionStore 全权委托 MigrationRunner，结构性消除）。 |

### 6.5 许可证决策（需维护者人工处理，非自动采纳）

- **事实**：上游在 `36b0929f`（首见于 v13.0.0）将 `LICENSE` 由 **AGPL-3.0 全文替换为 Apache-2.0**，`package.json` license 字段同步翻转，新增 `NOTICE`。我方 `LICENSE` 仍为 "GNU AFFERO GPL v3 / Copyright (C) 2025 Alex Newman"，`package.json` 为 `AGPL-3.0`，**无 NOTICE 文件**。
- **影响（基于代码分析）**：
  1. 移植**重新授权之前**（≤`36b0929f^`，即 v12.7.5 及更早）的代码为 AGPL-3.0，与我方现状一致；本报告**绝大多数候选来自 v10.x–v12.x（AGPL 期）**。
  2. 移植**重新授权之后**（≥v13.0.0）的代码为 Apache-2.0；将 Apache-2.0 代码并入 AGPL 项目方向上被许可（Apache-2.0 → AGPLv3 单向兼容），但需登记来源出处。
  3. 若维护者希望整体采纳 Apache-2.0 立场，须由版权持有者/贡献者**主动重新授权**并添加 NOTICE。
- **建议**：本项属决策而非机械移植，**交由人类维护者裁定**。本报告中标注来自 v13.x 的少量候选（如 `d13fc437` provider-agnostic base-url resolver、`0b4611e8` plan-11、`a8cf67164` schema 自愈、部分 chroma pin）若采纳，应记录其 Apache-2.0 出处。

---

## 七、建议的分批移植路线

> 移植均为"按语义重做"（见约束 1）。每批后跑 impl plan 定义的**根测试集**验证；在本地保留 ignored `attn_sink/` 上游克隆时，不使用会扫入 reference clone 的裸 `bun test` 结果作为验收口径。

- **P0 批（安全 + 数据完整性，约 1 个工作日）**：§0 A 类全部 9 项,外加与非 XML 失败路径同点位完成的 200 字 preview-log,以及按 impl plan 标为 Optional 的 agent_id 诊断探针。多为 S 级、CLEAN/低风险；优先做 content_hash、parseFileList、observer 工具锁死、.env/settings 0600、三类 tag/隐私剥离、非 XML markFailed、effort 变量阻断。涉及 schema 的均**不涉及**（这批无迁移），可快速合入。
- **P1 批（可靠性 + 成本，约 2–3 个工作日）**：§6.2。先做 darwin 直接相关项（POST_SPAWN_WAIT、chroma cwd=homedir、onnx/protobuf pin、isPortInUse、protected-PID cleanup、context-overflow 重置），再做语义搜索质量（relevance 排序、FTS5 回退、ghost 过滤、singular `concept` 参数归一化）与 WAL/日志/MCP schema 小修。其中"会话生命周期防失控"为 M 级、需按 fork 的 generator-action 重表达，单独成 PR。
- **P2 批（功能增强，按需排期）**：优先 context 输出压缩（高价值 token 节省）与 OpenAI-compatible base URL 泛化；同时全量移除已弃用的 OpenRouter 路径。文件读取决策门、tier 路由、smart-explore 24 语言已在本轮决策中 defer/skip；weekly-digests 属 Optional 功能,按产品取舍推进。
- **持续排除**：§6.4 全部维持不移植；§6.5 许可证待维护者决策。

---

## 附录：审计数据位置

- 上游克隆：`attn_sink/upstream-claude-mem`（blobless 部分克隆）
- commit 分类清单：`attn_sink/upstream-commits-categorized.txt`（441 条）
- 上游完整 changelog：`attn_sink/upstream-CHANGELOG.md`
- 审计 Agent 简报：`attn_sink/AUDIT-BRIEFING.md`
- 审计工作流脚本：`attn_sink/audit-workflow.js`
- 结构化结论原始数据：工作流返回 JSON（118 条 finding，15 Agent）

> **方法学声明**：本报告结论均来自对上游真实 diff 与本 fork 源码的逐一核对（每条 finding 附 `文件:行号` 证据）。"已被取代/已具备"等判断基于实际文件读取；标注"需验证"处（如 SDK 版本字段名、路径存储形态）应在实施时复核。本报告未执行任何代码改动。
