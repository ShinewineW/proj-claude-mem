# 上游 Cherry-Pick 实施计划元审计报告（42 Task 合理性 + 合法性独立复核）

> **日期**: 2026-06-05
> **作者**: Claude Opus 4.8（动态 workflow 编排，47 路 Agent：42 逐 task 核验 + 高危对抗复核 + 3 元审计）
> **基准版本**: 本仓库 `proj-claude-mem@4028f4bc`；被审对象 `docs/spec/2026-06-04-upstream-cherrypick-impl-plan.md` + `docs/reports/2026-06-04-upstream-cherry-pick-audit.md`；上游参照 `thedotmack/claude-mem@dc2eef8e`(v13.4.0)，relicense 锚点 `36b0929f`
> **影响范围**: 对上一轮上游 cherry-pick 审计 + 实施计划的二次独立验证（worker / sqlite / hooks-cli / chroma-mcp / provider / context / skills / 许可证）

---

## 一、结论（核心结论前置）

**结论：这份实施计划整体合理且合法，可作为执行蓝图，无阻断性问题。**

- **合理性**：42 个 task 中 **19 项完全 SOUND、21 项 SOUND-但需小修、2 项初判 MAJOR 经独立对抗复核全部下调、0 项 WRONG**。两个 MAJOR 均非真实缺陷——一个是审计员幻读（声称的 `provider,` 简写在全计划 grep 零匹配），一个是把既存问题误归因于本 task。**对抗复核后零确认 MAJOR、零 WRONG。**
- **合法性**：计划中 **35 处 license 标注经 `git merge-base --is-ancestor 36b0929f <hash>` 机器逐一核对，100% 与真实纪元一致**，零误标。fork 保持 AGPL-3.0 不翻转、Apache→AGPL 单向兼容陈述正确、Apache §4 通知义务由 per-file SPDX 头 + commit trailer + PROVENANCE.md 三重承载。唯一建议项：考虑补一个 NOTICE 文件（advisory，非强制）。
- **排除决策**：§6.4 的排除（Server Beta、Worktree 归并、Knowledge Agents、summary salvage 演进、anchor-coercion）**逐类核对均成立，未发现被错误排除、实际仍缺失且有价值的修复**。
- **内部一致性**：41 项→42 task 拆分账目自洽（`41 +1 +1 +1 −1 −1 = 42`），"schema 维持 v33、不新增迁移"约束在全计划无一处被违反，测试删除与移除 task 同 commit 配套，sim-review 8 条执行加固均有 task 级落点。

**原因**：上一轮审计采用了逐条 `文件:行号` 证据 + 多 Agent 交叉 + spec-review/codex 二审，其判定前提在本轮被独立复现验证。剩余 21 项 MINOR **绝大多数是"计划对上游 commit 的描述/归因不够精确"**（不影响移植代码的正确性，只会误导未来读者），少数是真实但小范围的技术缺口（见 §五，实施前应处理）。

---

## 二、审计方法

1. **素材就位**：upstream v13.4.0 完整 clone 至 `attn_sink/upstream-claude-mem`（gitignored）；所有引用的 upstream commit 经 `upstream` remote fetch 进对象库，`git show <hash>` 可验真实 diff。
2. **双向逐 task 核验（42 Agent，sonnet，read-only）**：每个 task 五步——① 读计划规格 → ② `git show` 核对上游 diff 是否如计划所述 → ③ 读 fork 源码核对缺口真实存在、`fork_status` 判定正确 → ④ 核 porting 方案（OLD 块能否内容锚匹配、NEW 是否引入 bug/遗漏调用点/破坏现有契约）→ ⑤ `git merge-base` 判 license 纪元并核对 trailer。结构化输出 + 证据。
3. **对抗复核（opus，仅 MAJOR/WRONG）**：对每个高危判定派独立怀疑者，默认反驳、只有复现到确凿证据才维持原判——用于过滤一审误报。
4. **3 元审计（opus 并行）**：许可证合法性 / 排除决策合理性 / 内部一致性，各自跨全计划取证。

> 规模：47 Agent、约 342 万 token、1272 次工具调用、~19 分钟。本报告为对结构化判定的综合，未执行任何代码改动。

---

## 三、合理性核验结果（task 级）

| 分级 | 数量 | 含义 |
|------|------|------|
| SOUND | 19 | 上游+fork 声明均准确，porting 合理，license 正确 |
| MINOR | 21 | 可落地，但有描述/归因不精确或小范围缺口，建议小修 |
| MAJOR（初判） | 2 | **均经对抗复核下调**（见下），非真实阻断 |
| WRONG | 0 | — |

**SOUND 19 项**：C1-T1, C1-T2, C2-T1, C2-T2, C2-T3, C2-T6, C3-T3, C3-T4, C3-T7, C4-T2, C4-T4, C4-T6, C5-T3, C6-T1, C6-T4, C6-T5, C6-T6, C6-T7, C7-T1。

### 两个 MAJOR 的下调（对抗复核证据）

- **C3-T6（session-lifecycle guards Part A）MAJOR → SOUND**。一审核心指控："计划 NEW 块写 `provider,` 简写属性，会对 fork 的 `_provider` 触发 TS2304 编译错误"。对抗复核：**全计划 grep `provider,` 零匹配**；计划该处实际写的是 `provider: 'claude'` 硬编码字面量，与 fork 现有 `SessionRoutes.ts:203` 字节一致；一审"自己开的药方（应改成 `provider: 'claude'`）恰恰已被实现"。次要指控（测试结构偏离上游）亦被 `git show f97c50bf` 反证——上游自己的 'Duplicate process prevention' 块同样手工模拟 kill 逻辑、`createPidCapturingSpawn` 在上游测试体里从未被调用。判定为纯误报。
- **C6-T3（schema-readability-probe）MAJOR → MINOR**。一审核心指控："probe 抛异常会导致 `openAndConfigure` 连接泄漏"。对抗复核：泄漏机制真实但**既存**——当前 fork 的 `openAndConfigure` 首条语句就是 `PRAGMA busy_timeout`，malformed schema 下今天就会抛、就会孤儿 fd，构造器 catch 的 `this.db.close()` 今天就吞掉 undefined 访问。计划只是把"哪条语句触发抛出"从 PRAGMA 换成 `SELECT count(*)`，孤儿 fd 力学前后完全相同。净真实问题是"罕见跨版本修复路径上一个既存的 MINOR fd 泄漏，进程退出即回收"——非本 task 引入、非回归。**保留为 MINOR 提示**（见 §五）。

---

## 四、合法性核验结果（license / provenance）

**元审计判定：SOUND。**

- **35 处 license 标注 100% 正确**。逐一 `git merge-base --is-ancestor 36b0929f <hash>`：AGPL（早于 relicense）含 9cfa57d49 / 2a304d59e / be99a5d69 / 703c64c7 / 46d204ee9 / 31ee1024c / a66b98bcd / f81684c61 / f97c50bf / d384d3c5 等 27 个；Apache（relicense 后裔）含 ce13c887 / 9c56dda79 / 55334129 / a8cf67164 / daf6d9dc0 / d13fc437 / 09e74bbf 等 8 个。零不一致。
- **relicense 锚点真实**：`36b0929f` 把 832 行 AGPL LICENSE 换成 Apache-2.0、`package.json` license 翻转、新增 NOTICE，且为 v13.4.0 祖先——作为纪元边界正确。
- **fork 立场守住**：fork `LICENSE` 仍 GNU AGPL v3 / Copyright (C) 2025 Alex Newman、`package.json` 仍 `AGPL-3.0`，**无任何 task 改动 LICENSE 或翻转**（计划末尾显式禁止 flip）。Apache-2.0 → AGPL-3.0 单向兼容（可并入）法律方向正确。
- **§4 义务已履行**：唯一新增的 Apache 文件（C7-T2 由 d13fc437 泛化而来）带 `SPDX-License-Identifier: Apache-2.0` 头 + 来源 commit 引用 + 修改声明，满足 §4(b)/(c)；AGPL 派生文件带 AGPL SPDX 头；混合来源 commit（如 C2-T2 = Apache ce13c887 + AGPL 703c64c7）整体声明 AGPL 同时 per-source trailer 各列真实 license；tree-kill（C4-T2）单 commit 双 trailer（d384d3c5 AGPL + 55334129 Apache）处理正确。
- **唯一 advisory（MINOR）**：fork 无 NOTICE 文件，而上游 relicense 时新增过一个。鉴于 fork 保持纯 AGPL（不以 Apache 再分发）、上游 NOTICE 为无第三方归属的通用模板、且 Apache 片段归属已 per-file/per-commit/PROVENANCE 三重承载——补 NOTICE 属卫生建议而非强制。**建议**：维护者补一份简短 NOTICE 致谢上游，或在 PROVENANCE.md 显式记录"经评估无需 NOTICE"的决策（C7-T6 当前索引了 provenance 但未对此 §6.5 遗留问题落定结论）。

---

## 五、值得在实施前处理的 MINOR（按优先级）

> 以下均不阻断计划成立，但建议在对应 task 落地前消化。每条附 task ID 与证据。

### P1 — 真实技术缺口（应处理）

1. **C6-T2：平行实现未覆盖**。`SessionStore.ts:1086-1179` 的 `storeObservationsAndMarkComplete` 含一份**同样未加 `changes` 守护**的 `updateStmt.run(...)`，本 task 只改了另一处。**这违反 fork 自有的 F6 dual-maintenance 规则**（fixed-bugs.md："observation 存储有 6 处实现跨 3 文件，校验改动必须全覆盖"）。应同 commit 一并修，并加回归 pin 防未来误迁 DELETE 路径。
2. **C2-T4：漏掉 a66b98bcd 的 DRY-up 部分**。计划只在中央持久化边缘加了剥离，但未把 `transcript-parser.ts` / `ObservationCompiler.ts` 改为 import 共享 `SYSTEM_REMINDER_REGEX`——属部分移植。另：导出的正则带 `/g` flag 但执行后将无 `.test()` 调用点（`/g` 在 `.test()` 上有 lastIndex 陷阱，无调用点则无害，但建议去掉以免误用）。
3. **C5-T4：ghost filter 比上游更宽**。上游判据 `!title && !narrative && facts==0 && concepts==0`（有意保留仅含 subtitle/files 的 observation），计划复用了 ResponseProcessor 的更严判据（还查 subtitle/files_read/files_modified）——会过滤掉上游会保存的"仅 subtitle/files"observation。架构上可接受，但应是**有意识的决策并在 task 内记录**，而非默认。
4. **C3-T8：漏 `mcpReady = existsSync(mcpServerPath)` 预赋值**。上游在 MCP self-check 非致命化的同时加了该预判，计划未带入。
5. **C7-T6：`git -C <path>` 写错**，步骤 6.1/6.3 的命令逐字执行会失败（机械错误，直接修命令）。

### P2 — 描述/归因不精确（不影响落地，但会误导未来 auditor）

- **C1-T3**：把 `92f800d4` 描述为"独立 preview-log commit"——实际它是把 `resetProcessingToPending` 换成 `clearPendingForSession` 的**行为反转**（丢整批），不含任何 preview-log。计划"不采纳其行为"的决策正确，但理由写错。
- **C2-T5**：声称从上游获得"两点覆盖"，实际 `46d204ee9` 只动一个提取点；cherry `bd68bfcc` 在 fork 对象库不可达（不影响，因按语义重做）。
- **C4-T5**：`ANONYMIZED_TELEMETRY=false` 引错 provenance commit。
- **C5-T1**：上游修复位置写错——`46d204ee9` 改的是 `SessionStore.ts` + `ChromaSearchStrategy.ts`，非 `SearchManager.ts`。
- **C7-T2**：夸大上游 scope——`d13fc437` 是 OpenRouter 专用、只接 `OpenRouterProvider.ts`，把它泛化到 BypassLane/OpenCode 是 **fork-original 设计决策**而非"移植"。函数签名也从单参泛化为双参（fork 原创）。建议如实标注，以免误导。
- **C7-T4**：上游文件位置混淆（函数在 `src/npx-cli/utils/paths.ts`，描述里与 `src/utils/json-utils.ts` 混提）；且 fork 现有 `writeAllowlist` 已是 `tmpPath+renameSync` 的部分原子写——fork_status 宜标 PARTIAL 而非全 MISSING。
- **C4-T1 / C6-T9**：版本 pin 与 `trustedDependencies` 的归因 framing 含糊（`overrides` 上游本已存在，本 commit 只加 trustedDependencies）。porting 动作正确。

### P3 — 配套测试缺口

- **C4-T3**：上游回归测试 `chroma-mcp-manager-cwd.test.ts` 未移植，且 Step 3 引用了 fork 中**不存在**的测试文件。
- **C3-T1**：测试策略与上游分歧（计划用 real-socket bind，上游用 `spyOn(net,'createServer')` mock）未声明；Step 5 留下的测试依赖 `port 39999` 空闲假设，CI 上若被占用会假失败。
- **C5-T2**：省略上游 FTS 查询的 try-catch、param 构造方式分歧、引入 `hasFtsTables()`/`isFts5Available()` public 可见性（上游用私有缓存字段）——增加了跨模块耦合。
- **一致性元审计发现**：`bypass-ghost-filter.test.ts` 的 `provider:'openrouter'` 占位**未列入 C7-T3 的文件枚举**，仅靠 C7-T3 收尾的 catch-all `grep -i openrouter` 兜底——计划不会静默破坏，但只照枚举步骤执行的实施者会漏到 grep gate 才发现。建议把该文件显式补进 C7-T3 枚举。

---

## 六、排除决策核验（元审计：SOUND）

逐类抽查上游真实 commit + fork 源码，所有排除前提成立：

- **Server Beta 全轨道**：fork 确无 `src/server/`/`src/storage/`、零 Postgres/BullMQ/Redis 依赖；`61fe70a2` 把持久队列换内存 buffer 与 fork 设计相反；squash 内可分离的 worker/sqlite 修复来自独立 AGPL commit 且已单独移植。
- **Worktree 归并采纳**：`paths.ts` 在写入时即把 worktree 重映射到父 repo（同库同名），结构上无独立数据需事后采纳——比上游复合命名+adopt CLI 更激进更简。
- **Knowledge Agents**：fork 零 `SearchOrchestrator`（用单体 `SearchManager`），上游 corpus 全局存储与 per-project 隔离冲突，数据层需重写——暂排除合理。
- **summary salvage/coercion 演进**：已被 fork `SummaryLane`+`fresh-summarize` 结构性取代；`#1718/#1850` 本身是上游 revert 自己的 overengineered salvage，照搬会重引入 fork 刻意删除的 Case2/3 poisoning。
- **anchor-coercion（ff0793f7）已具备**：fork `normalizeParams`(L89-97) 已对 `anchor` 强转且在两处 `typeof==='number'` 分支前调用——上游读 raw `args.anchor` 的 bug 在 fork 不存在，移出本轮正确。
- **Defer 三项**（文件读取决策门 Q17 / 子 agent summary 抑制 Q23 / tier 路由 Q16）延后理由均站得住（fork 无 PreToolUse、不注册 SubagentStop、bypass 已接走价位）。

唯一可观测的"信息损失"是 worktree-origin 徽章/复合命名——属维护者刻意简化，无数据完整性或安全后果。

---

## 七、附录

- 上游克隆：`attn_sink/upstream-claude-mem`（v13.4.0=dc2eef8e，gitignored，保留供实施期取证）
- 审计原始结构化判定：workflow run `wf_77a382e2-11a` 输出（42 task verdict + 3 meta verdict + 2 对抗复核）
- 被审对象：`docs/spec/2026-06-04-upstream-cherrypick-impl-plan.md`、`docs/reports/2026-06-04-upstream-cherry-pick-audit.md`

> **方法学声明**：本报告所有 task 级判定均来自对上游真实 diff（`git show`）与 fork 源码的逐一核对，每条 MINOR/MAJOR 附 `文件:行号` 或 commit hash 证据。两个 MAJOR 的下调由独立 opus 对抗 Agent 复现验证（非同一核验 Agent 自我推翻）。license 判定为机器化 `git merge-base` 结果，非人工推断。计划尚未实施，本报告不构成对"实施后行为"的验证——P1 缺口与各 task 的 RED→GREEN 仍须在实施 commit 中实跑。
