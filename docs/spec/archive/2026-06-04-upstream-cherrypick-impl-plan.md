# 上游 Cherry-Pick 本轮实施计划（41 项，经 spec-review + codex 交叉审计修订）

> **类型**: 设计文档 / 实施计划（Spec）
> **日期**: 2026-06-04
> **状态**: 活跃
> **作者**: Claude Opus 4.8（writing-plans skill，多 Agent 编排 author→review-repair）
> **基准版本**: `proj-claude-mem@4c032ffa`；上游参考 `thedotmack/claude-mem@dc2eef8e`(v13.4.0)
> **目的**: 把审计确认的 41 项上游修复/增强按 P0→P1→P2 分批、以 TDD 逐步方式移植进本 fork
> 范围: worker / sqlite / hooks-cli / chroma-mcp / provider(BypassLane) / context / skills

---

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务执行。步骤用 `- [ ]` 复选框跟踪。
>
> **配套文档**: 决策与取舍见 `docs/reports/2026-06-04-upstream-cherry-pick-audit.md`(§0 本轮 Catch 确认清单)。

**Goal:** 将 41 项经审计+逐项 grill 确认的上游变更(安全/数据完整性 9、可靠性/成本 23、功能 5、探针/便宜赢 4)移植进 fork,让**实施后的**根测试集保持 0 fail,并且不新增数据库迁移(schema 维持 v33)。`1933 pass` 只是 CLAUDE.md 记录的既有参考基线,不是硬编码目标;最终 pass 数应以实施当日的根测试集实际 pass 数 + 本轮净新增用例为准。**计数沿革**:原审计 41 项 → spec-review 移出已具备的 anchor-coercion → 40 → codex 交叉审计补回首版 §0 遗漏的 chroma-cwd-homedir → **41**。这 41 项实现为 **42 个 `### Task` 标题**(item↔task 非 1:1:session-lifecycle 1 项=2 Task;markFailed+preview-log 与 system-reminder+persisted-output 各 2 项=1 Task;base-url 通用化+OpenRouter 移除 1 项=2 Task;另加 1 个 `docs/PROVENANCE.md` 收尾 Task)。

**Architecture:** 本 fork 与上游无共享 git 历史,所有移植为"按 diff 语义手工重做"(非 git cherry-pick)。按 P0(安全/完整性)→P1(可靠性/成本)→P2(功能)三批,每批一个 PR、批内按子系统聚焦提交;行为变更项独立 commit + 回归测试;每个移植 commit 带 `Upstream: thedotmack/claude-mem@<hash> (<license>)` provenance trailer。

**Tech Stack:** TypeScript(ESM)→ Bun;SQLite3(better-sqlite3 风格 per-project 池);@anthropic-ai/claude-agent-sdk 0.1.77;Chroma via uvx chroma-mcp;Express worker(:37777)。
- 目标测试: `bun test <path>`。
- 根测试集:在 clean checkout 可用 `bun test`。若本地保留 ignored 审计素材 `attn_sink/upstream-claude-mem/tests`,裸 `bun test` 会扫入上游克隆并污染结果;此时根测试集命令为:
  ```bash
  find "$PWD/tests" -type f \( -name '*.test.ts' -o -name '*test.ts' \) -print0 | xargs -0 bun test
  ```
  下文所有"full suite/根测试集/`bun test` 全绿"均指**本 fork 根目录 tests**,不包含 `attn_sink/`、node_modules 或其他 ignored reference clone。
- 构建: `npm run build`(bundle/resolution/syntax)/ `npm run build-and-sync`(含 worker 重启)。
- 草稿状态说明:本文件是实施计划,不是已实施变更。当前未实施时的测试红灯只用于暴露验证命令或既有基线口径问题,不能作为"移植项不成立"的证据;每个任务必须在实施 commit 中按本计划跑 RED→GREEN 目标测试。

---

## 执行顺序与批次

- **Chunk 1 = P0 数据完整性** → **Chunk 2 = P0 安全/隐私** →(P0 批 PR,先合)
- **Chunk 3 = P1 worker 生命周期** → **Chunk 4 = P1 chroma&mcp** → **Chunk 5 = P1 搜索质量** → **Chunk 6 = P1 sqlite&杂项**(P1 批 PR)
- **Chunk 7 = P2 功能/增强**(P2 批 PR)
- 每批合入前:根测试集 0 fail + `npm run build-and-sync`;P0/P1 关键行为变更项合入前跑一次真实 observe/summarize 冒烟。

## 执行加固(sim-review 结论 — 实施时遵守)

经 sim-review 多角度对抗评审后追加的执行约束:

1. **PR 粒度:风险子 PR 不改变优先级。** P0 中的两个高风险行为变更——非 XML `markFailed`(C1)与 observer SDK 锁死(C2)——归入 **`P0-risky` 子 PR**(仍先于 P1 合入)。P1 中的两个高风险行为变更——context-overflow 重置(C3)与会话防失控 guards(C3)——归入 **`P1-risky` 子 PR**。其余 P0/P1/P2 项按原 chunk 顺序执行。风险子 PR 的目的只是便于二分定位/整体回退,**不得把 P0 项降级为 P1**。
2. **typecheck gate = 行号无关的"错误集 diff"(非清零)。** 本仓库 `tsc --noEmit` 基线**本就有 336 个存量错误**(esbuild-only,从不跑 tsc),参照集存于 `attn_sink/tsc-baseline-set.txt`(120 条去重、行号无关;若 clean checkout 缺少该 ignored 文件,先从最新基线重新生成再比较,不要把缺文件解释为类型全绿)。每批结束跑 `bun x tsc --noEmit`,对**我们触及的文件**做"错误集"diff,**不得新增** baseline 之外的错误。**注意**:`SearchManager.ts`(63 存量错误)、`BypassLane.ts`(16)本就深红,对这两文件 tsc 信号弱,**以根测试集 + 实测冒烟为主**。
3. **行号即 t0 定位符,内容锚为准。** 计划中所有 `file:line` 仅为撰写时(HEAD `4c032ffa`)定位;**同一文件被多任务连续编辑**(ChromaMcpManager 4 次、BypassLane 3 次、EnvManager/SessionStore/parser 等 2–4 次),行号会漂移。**以 OLD→NEW 内容块匹配为权威**,每个同文件后续任务**编辑前重新 grep 锚点**。
4. **改共享代码前先扫受影响测试。** 行为变更项编辑前,`grep -rl "<符号/选项>" tests/` 列出受影响 spec,在**同一 commit**内更新/删除它们,而非等批末全量跑才被动发现。
5. **删除过时/不泛用的测试(维护者指令)。** 凡测试的是**本轮移除的代码面**(OpenRouter 路径及其 test、`USER_MESSAGE_ONLY` 断言、C5 bypass-ghost-filter 测试里 `provider:'openrouter'` 占位)或**已失效契约**的测试,**随对应移除任务一并删除/改写**;不保留死测试。判断依据:该测试因其覆盖的代码已被删而失败 → 删,而非 skip。广义"过时测试"清理在执行时凭实际失败信号判断。
6. **双许可证 provenance(单 commit + 双 trailer)。** tree-kill(C4)源自 `d384d3c5`(AGPL,静态助手 `killProcessTree`/`collectDescendantPids`)+ `55334129`(Apache,`disposeCurrentSubprocess` 路由),两部分**相互依赖**——助手无路由即死代码、路由无助手不可编译。**故不拆分**(强行拆会制造"只含死代码的 commit",违反反过度工程);采用**单 commit 同时携带两条 `Upstream:` trailer**(d384d3c5 AGPL + 55334129 Apache),provenance 由双 trailer + `docs/PROVENANCE.md` 索引共同承载。其余移植项**多为**单 hash 单 trailer;少数任务合并多个上游 hash(如 observer 锁死 = `ce13c887`+`703c64c7`/`46d204ee9`;tag 剥离 = `a66b98bcd`+`f81684c61`),此时**同一 commit 内每个来源 hash 各列一条 `Upstream:` trailer**。(C4 tree-kill 同此惯例,二者一致。)
7. **实测冒烟是唯一非同模型校验,load-bearing。** 全链由同一模型产出,关联盲点风险高;P0/P1 合入前的真实 observe/summarize 冒烟**必须实跑**(尤其 observer 锁死后仍正常产出 observation),不可省。
8. **合入前跨模型 gate。** 至少对 **P0 批**跑一次 `oh-my-codex`(Codex 跨模型质疑)再合,作为缺失的"独立第二评审"。

## 必要性分层与 Go/Stop 口径

本计划不是"上游有就全搬"。42 个任务按必要性分为三类:

- **Must**:当前 fork 存在明确安全、隐私、数据完整性、错误状态或治理风险;不移植会保留真实缺陷。
- **Should**:当前 fork 有明确可靠性、成本、可维护性或兼容性收益;不移植不一定立即破坏,但会保留已知脆弱点。
- **Optional**:功能/体验/诊断增强;可按维护者产品取舍延后,但若延后必须同步更新 41 项审计决策记录。

| Chunk/Task | Necessity | 本地移植理由 |
| --- | --- | --- |
| C1-T1 content-hash delimiter | Must | 去掉合法 observation 的 hash 碰撞/误去重风险。 |
| C1-T2 parseFileList bare paths | Must | 防止 summary 文件列表解析崩溃或静默丢文件。 |
| C1-T3 non-XML markFailed + preview log | Must | 防止 pending message 卡死并保留失败上下文。 |
| C2-T1 agent-id probe | Optional | 诊断 Q23;只应短期存在,不属于永久功能。 |
| C2-T2 observer SDK lockdown | Must | 工具权限边界;防止 SDK 新内置工具绕过 blacklist。 |
| C2-T3 env/settings 0600 | Must | 本地凭据/配置权限硬化。 |
| C2-T4 system-reminder/persisted-output strip | Must | 持久化边缘隐私脱敏。 |
| C2-T5 summarize last_assistant strip | Must | summarize hook 隐私脱敏。 |
| C2-T6 effort env block | Must | SDK 子进程配置边界;避免无意继承高成本/错模型指令。 |
| C3-T1 atomic isPortInUse | Should | 降低 daemon 端口探测 TOCTOU。 |
| C3-T2 port-race graceful exit | Should | 消除 duplicate daemon 输掉 bind race 后的假 ERROR。 |
| C3-T3 startup cleanup PID protection | Must | 防止 cleanup 误杀父 hook 或当前 worker。 |
| C3-T4 POST_SPAWN_WAIT 15s | Should | macOS ARM64 + Chroma 冷启动可靠性。 |
| C3-T5 context-overflow reset | Must | 防止 overflow 后继续复用坏 memorySessionId。 |
| C3-T6 lifecycle guards A | Must | stale controller/SIGTERM/duplicate spawn 生命周期正确性。 |
| C3-T7 lifecycle guards B | Must | 会话 wall-clock 上限,防止失控长跑。 |
| C3-T8 MCP self-check nonfatal | Should | MCP loopback 异常不应饿死 reaper/SummaryLane。 |
| C4-T1 chroma pin | Should | Chroma/onnx/protobuf 依赖可复现。 |
| C4-T2 chroma tree-kill | Must | 防止 worker 重启后残留 chroma 子树。 |
| C4-T3 chroma cwd homedir | Should | 绕过 pydantic 误读项目 `.env`。 |
| C4-T4 reconcile dupid | Should | Chroma 批冲突恢复能力。 |
| C4-T5 anon telemetry false | Should | 第三方工具 telemetry 默认关闭。 |
| C4-T6 inputSchema props | Should | MCP tool schema 正确性/客户端兼容。 |
| C5-T1 relevance ranking | Should | 保留 Chroma 语义顺序,搜索质量。 |
| C5-T2 FTS5 fallback | Should | Chroma 不可用时仍有文本搜索降级。 |
| C5-T3 concept param normalization | Should | API 兼容 singular/plural query。 |
| C5-T4 bypass ghost filter | Should | 过滤空内容 observation,提升数据质量。 |
| C6-T1 journal size limit | Should | 控制 WAL 膨胀。 |
| C6-T2 changes assertion | Must | 防止 phantom completion 静默吞数据。 |
| C6-T3 schema readability probe | Should | 早发现 schema 损坏/不可读。 |
| C6-T4 parseSummary all-null | Should | 避免空 summary 被误当有效。 |
| C6-T5 concept log debug | Should | 降低噪音,不把正常清理记成 error。 |
| C6-T6 cwdToDashed dot | Should | 项目名编码更稳定。 |
| C6-T7 logger stringify guard | Should | 日志 debug 路径不因循环 JSON 崩溃。 |
| C6-T8 remove dead exitcode | Should | 移除过期 hook 契约。 |
| C6-T9 trusted deps treesitter | Should | plugin install/build 依赖可用性。 |
| C7-T1 markdown compression | Optional | 输出体验/可读性增强。 |
| C7-T2 generic base URL | Should | OpenAI-compatible endpoint 灵活性。 |
| C7-T3 OpenRouter removal | Should | 删除已弃用 provider 路径,统一到 OpenCode/Gemini。 |
| C7-T4 atomic JSON writer | Should | settings/config 写入耐久性与 symlink safety。 |
| C7-T5 weekly digests skill | Optional | 新 skill 功能,可按产品取舍延后。 |
| C7-T6 PROVENANCE index | Must | 治理与许可证审计索引;本轮收尾必需。 |

**Go criteria:**每个任务进入实施前必须有(1)本地 OLD 锚点,(2)上游来源/许可证或 fork-original 说明,(3)RED→GREEN 目标测试,(4)触及共享符号时的 caller/test sweep。每个 chunk 合入前必须有根测试集 0 fail、`npm run build` 或 `npm run build-and-sync`、必要的 live smoke、无新增 schema migration、无新增 `git diff --check` 问题。

**Stop criteria:**若某任务的本地 OLD 锚点不存在、SDK/依赖预检否定计划假设、目标测试无法证明该任务契约、或 Optional 项被维护者决定延后,必须暂停该任务并同步更新审计决策记录/计数映射;不得机械继续。

## 文件改动总览（本轮触及）


- `src/services/sqlite/observations/store.ts`
- `tests/sqlite/data-integrity.test.ts`
- `src/services/sqlite/observations/files.ts`
- `src/services/sqlite/SessionStore.ts`
- `src/services/sync/ChromaSync.ts`
- `tests/sqlite/parse-file-list.test.ts`
- `src/services/worker/agents/ResponseProcessor.ts`
- `tests/worker/agents/response-processor-nonxml.test.ts`
- `src/cli/hook-command.ts`
- `tests/cli/agent-id-probe.test.ts`
- `src/sdk/hardened-options.ts`
- `src/services/worker/SDKAgent.ts`
- `src/services/worker/fresh-summarize.ts`
- `tests/security/observer-tool-enforcement.test.ts`
- `src/shared/EnvManager.ts`
- `src/services/worker/http/routes/SettingsRoutes.ts`
- `tests/shared/env-manager-perms.test.ts`
- `src/utils/tag-stripping.ts`
- `tests/utils/tag-stripping.test.ts`
- `src/cli/handlers/summarize.ts`
- `tests/cli/summarize-privacy-strip.test.ts`
- `tests/shared/env-manager-blocklist.test.ts`
- `src/services/infrastructure/HealthMonitor.ts`
- `tests/infrastructure/health-monitor.test.ts`
- `src/services/worker-service.ts`
- `tests/services/worker-daemon-port-race.test.ts`
- `src/services/infrastructure/ProcessManager.ts`
- `tests/infrastructure/process-manager.test.ts`
- `src/shared/hook-constants.ts`
- `tests/hook-constants.test.ts`
- `tests/worker/context-overflow-reset.test.ts`
- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/services/worker/ProcessRegistry.ts`
- `tests/worker/session-lifecycle-guard.test.ts`
- `src/shared/SettingsDefaultsManager.ts`
- `tests/shared/settings-defaults-manager.test.ts`
- `tests/services/worker-mcp-nonfatal.test.ts`
- `src/services/sync/ChromaMcpManager.ts`
- `src/servers/mcp-server.ts`
- `tests/services/sync/chroma-mcp-onnx-pin.test.ts`
- `tests/services/sync/chroma-mcp-manager-singleton.test.ts`
- `tests/services/sync/chroma-reconcile-dupid.test.ts`
- `tests/servers/mcp-tool-schemas.test.ts`
- `src/services/worker/SearchManager.ts`
- `src/services/sqlite/SessionSearch.ts`
- `src/services/worker/BypassLane.ts`
- `tests/worker/search/search-param-normalization.test.ts`
- `tests/services/sqlite/session-search-fts5-fallback.test.ts`
- `tests/worker/bypass-ghost-filter.test.ts`
- `src/services/sqlite/SessionStore.ts`
- `src/services/sqlite/transactions.ts`
- `src/services/sqlite/Database.ts`
- `src/sdk/parser.ts`
- `src/services/context/ObservationCompiler.ts`
- `src/utils/logger.ts`
- `plugin/package.json`
- `scripts/build-hooks.js`
- `tests/sqlite/transactions.test.ts`
- `tests/sqlite/schema-readable-probe.test.ts`
- `tests/sdk/parse-summary.test.ts`
- `tests/context/include-last-message-dot-path.test.ts`
- `src/services/context/formatters/MarkdownFormatter.ts`
- `src/services/context/sections/TimelineRenderer.ts`
- `tests/context/formatters/markdown-formatter.test.ts`
- `tests/services/context/context-builder-full.test.ts`
- `src/shared/openai-compatible-base-url.ts`
- `tests/shared/openai-compatible-base-url.test.ts`
- `src/services/worker/BypassLane.ts`
- `tests/worker/bypass-lane.test.ts`
- `tests/worker/bypass-lane-properties.test.ts`
- `tests/worker/bypass-sliding-window.test.ts`
- `tests/worker/bypass-opencode.test.ts`
- `src/utils/json-utils.ts`
- `tests/utils/json-utils.test.ts`
- `src/shared/project-allowlist.ts`
- `plugin/skills/mem-weekly-digests/SKILL.md`

---

> **spec-review 修订说明(2026-06-04)**:本计划经 Full spec-review(78 findings,7 chunk + cross-cutting)并按维护者决策修订。要点:① anchor-coercion 任务复核为冗余(`normalizeParams` 已强转 anchor)→ 整条移除;② OpenRouter 全量清扫但 BypassLane 保留并泛化(任意 OpenAI 兼容端点可插);③ observer 隐私信任边缘脱敏(无新增代码);④ settings.json 0600 + 原子写保留(仓库走 git 同步,无 OneDrive)。**继而经 codex(gpt-5.5)8 轮跨模型交叉审计**:修正 §0↔plan 计数(补回首版 §0 遗漏的 chroma-cwd-homedir → 41 项/42 Task)、FTS 回退 no-match 判据(capability 而非计数)+ 对真实 SearchManager 构造签名的守护测试、OpenRouter 全量清扫文件清单补全(agents/* + worker/CLAUDE.md 注释)、provenance(单 commit 双 trailer + 新增 `docs/PROVENANCE.md` 索引 Task)。评审/修订记录与 open-items 见文末附录 A/B/C 及 `attn_sink/oh-my-codex-review-log.md`。


---

## Chunk 1: P0 数据完整性 (data-integrity)

> Target repo: `/Users/shinewine/Coding/proj-claude-mem` (the FORK). All paths below are absolute.
> Upstream reference clone: `/Users/shinewine/Coding/proj-claude-mem/attn_sink/upstream-claude-mem`.
> Order is load-bearing: do Task 1 → 2 → 3 (markFailed + preview-log share Task 3, one commit).
> No DB migration in this chunk (schema stays v33). All four items are new-code / read-path only.

---

### Task 1: Null-byte delimiter in observation content hash (collision fix)

**Why**: `computeObservationContentHash` concatenates `memorySessionId + title + narrative` with no separator, so distinct tuples (`session="ab",title="cd"` vs `session="abc",title="d"`) hash identically and legitimate observations get silently deduped within the 30s window. Fix joins fields with `'\x00'`. **New-rows-only — NO migration, NO backfill** (existing `content_hash` values were random-backfilled in migration 22 and stay as-is).

**Files**
- Modify: `/Users/shinewine/Coding/proj-claude-mem/src/services/sqlite/observations/store.ts` (function `computeObservationContentHash`, the `.update(...)` call inside the `return` on lines 23-26)
- Test (extend existing): `/Users/shinewine/Coding/proj-claude-mem/tests/sqlite/data-integrity.test.ts` (inside `describe('Content-hash deduplication', ...)`, after the `handles nulls` case at lines 67-70)

**Steps**

- [ ] **1.0 Confirm the fork's OLD form before editing.** Visually verify the unguarded first field (this drives the `|| ''` addition in step 1.3):
  ```bash
  sed -n '23,26p' /Users/shinewine/Coding/proj-claude-mem/src/services/sqlite/observations/store.ts
  ```
  Expected: line 24 is `.update(memorySessionId + (title || '') + (narrative || ''))` — `memorySessionId` is bare (no `|| ''` guard), while `title`/`narrative` are already guarded. (Confirmed at write-time: fork `store.ts:24`.)

- [ ] **1.1 Write the failing collision test.** Open `/Users/shinewine/Coding/proj-claude-mem/tests/sqlite/data-integrity.test.ts`. Find this existing block (lines 67-70):
  ```typescript
      it('computeObservationContentHash handles nulls', () => {
        const hash = computeObservationContentHash('session-1', null, null);
        expect(hash.length).toBe(16);
      });
  ```
  Insert the upstream collision test immediately AFTER it (verbatim from `git show 9cfa57d49 -- tests/sqlite/data-integrity.test.ts`; narrative arg passed as `''`):
  ```typescript
      it('computeObservationContentHash handles nulls', () => {
        const hash = computeObservationContentHash('session-1', null, null);
        expect(hash.length).toBe(16);
      });

      it('computeObservationContentHash avoids collision from field boundary ambiguity', () => {
        // These tuples would collide without a delimiter between fields
        const hash1 = computeObservationContentHash('session-abc', 'debug log', '');
        const hash2 = computeObservationContentHash('session-ab', 'cdebug log', '');
        const hash3 = computeObservationContentHash('session-', 'abcdebug log', '');
        const hash4 = computeObservationContentHash('', 'session-abcdebug log', '');
        const hashes = new Set([hash1, hash2, hash3, hash4]);
        expect(hashes.size).toBe(4);
      });
  ```

- [ ] **1.2 Run the test, see it FAIL.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/sqlite/data-integrity.test.ts
  ```
  Expected: FAIL on the new case — `expect(hashes.size).toBe(4)` reports `received: 1` (all four tuples collide to one hash). All other cases in the file still pass.

- [ ] **1.3 Apply the minimal fix.** In `/Users/shinewine/Coding/proj-claude-mem/src/services/sqlite/observations/store.ts`, change the `.update(...)` line inside `computeObservationContentHash`.
  OLD (lines 23-26):
  ```typescript
    return createHash('sha256')
      .update(memorySessionId + (title || '') + (narrative || ''))
      .digest('hex')
      .slice(0, 16);
  ```
  NEW:
  ```typescript
    return createHash('sha256')
      .update([memorySessionId || '', title || '', narrative || ''].join('\x00'))
      .digest('hex')
      .slice(0, 16);
  ```
  (Note: fork's OLD used bare `memorySessionId`; upstream's OLD already had `(memorySessionId || '')`. The NEW guards it with `|| ''` to match upstream and keep the `''`-arg test cases stable. The NEW line is byte-identical to upstream 9cfa57d49.)

- [ ] **1.4 Run the test, see it PASS.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/sqlite/data-integrity.test.ts
  ```
  Expected: all cases pass (the file's existing 9 cases + the new collision case = 10). Look for `0 fail`.

- [ ] **1.5 Commit.**
  ```bash
  git -C /Users/shinewine/Coding/proj-claude-mem add src/services/sqlite/observations/store.ts tests/sqlite/data-integrity.test.ts
  git -C /Users/shinewine/Coding/proj-claude-mem commit -m "fix(sqlite): null-byte delimiter in observation content hash to prevent collisions

Fields joined without a separator allowed distinct tuples to produce
identical content hashes, silently deduplicating legitimate observations
within the 30s window. Join with '\\x00' so field boundaries are
unambiguous. New-rows-only; no migration (historical hashes were
random-backfilled in migration 22).

Upstream: thedotmack/claude-mem@9cfa57d49 (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: `parseFileList()` helper — recover bare-path strings instead of crash/drop

**Why**: Legacy/edge rows can store a bare path string (e.g. `/foo/bar.ts`) in `files_read`/`files_modified` instead of a JSON array. The fork has THREE problem sites:
1. `ChromaSync.ts:132-133` — UNGUARDED `JSON.parse` on `files_read`/`files_modified` → `SyntaxError` aborts vector sync for the whole observation (most severe).
2. `SessionStore.ts:520,529` — a duplicate copy of `getFilesForSession` with UNGUARDED `JSON.parse` → throws.
3. `observations/files.ts:34-53` — wraps `JSON.parse` in try/catch (no crash) but on a bare path logs `Malformed` and DROPS the path (data loss). NOTE: this is a fork-specific divergence — upstream's `files.ts` OLD was UNGUARDED; the fork already added the try/catch. The OLD block below reflects the FORK's guarded code.

Upstream adds one `parseFileList()` helper and reuses it at all three. **Note (flag, do not fix)**: `getFilesForSession` is duplicated in `SessionStore.ts` and `observations/files.ts` (pre-existing duplication — patch both, do not refactor). **Note**: the fork's `ChromaSync.ts:130-131` also has unguarded `JSON.parse` on `facts`/`concepts`; that is OUT OF SCOPE for this item (upstream only touched the two file columns) — leave those two lines unchanged.

**Files**
- Modify: `/Users/shinewine/Coding/proj-claude-mem/src/services/sqlite/observations/files.ts` (add `parseFileList` after imports at lines 6-8; rewrite loop body at lines 31-55)
- Modify: `/Users/shinewine/Coding/proj-claude-mem/src/services/sqlite/SessionStore.ts` (add import after the `observations/store` import at line 13; rewrite loop body at lines 518-534)
- Modify: `/Users/shinewine/Coding/proj-claude-mem/src/services/sync/ChromaSync.ts` (add import after the `logger` import at lines 18-19; rewrite lines 132-133)
- Test (new): `/Users/shinewine/Coding/proj-claude-mem/tests/sqlite/parse-file-list.test.ts` (upstream ships it at `tests/services/sqlite/parse-file-list.test.ts`; place under `tests/sqlite/` per fork convention)

**Steps**

- [ ] **2.1 Write the failing unit test (new file).** Create `/Users/shinewine/Coding/proj-claude-mem/tests/sqlite/parse-file-list.test.ts` with the upstream tests (import path adjusted to fork layout — file lives in `tests/sqlite/`, so `../../src/...`):
  ```typescript
  /**
   * Tests for parseFileList (fix for #1359)
   *
   * Validates safe JSON array parsing for files_read/files_modified DB columns
   * that may contain legacy bare path strings instead of JSON arrays.
   */
  import { describe, it, expect } from 'bun:test';
  import { parseFileList } from '../../src/services/sqlite/observations/files.js';

  describe('parseFileList', () => {
    it('returns [] for null', () => {
      expect(parseFileList(null)).toEqual([]);
    });

    it('returns [] for undefined', () => {
      expect(parseFileList(undefined)).toEqual([]);
    });

    it('returns [] for empty string', () => {
      expect(parseFileList('')).toEqual([]);
    });

    it('returns [] for empty JSON array', () => {
      expect(parseFileList('[]')).toEqual([]);
    });

    it('parses a normal JSON array', () => {
      expect(parseFileList('["/a/b.ts","/c/d.ts"]')).toEqual(['/a/b.ts', '/c/d.ts']);
    });

    it('wraps a bare path in an array instead of crashing', () => {
      expect(parseFileList('/Users/foo/bar.go')).toEqual(['/Users/foo/bar.go']);
    });

    it('wraps a Windows bare path in an array', () => {
      expect(parseFileList('C:\\Users\\foo\\bar.ts')).toEqual(['C:\\Users\\foo\\bar.ts']);
    });

    it('handles invalid JSON by treating value as single element', () => {
      expect(parseFileList('not valid json {')).toEqual(['not valid json {']);
    });

    it('wraps a JSON scalar string in an array', () => {
      expect(parseFileList('"single-file.ts"')).toEqual(['single-file.ts']);
    });
  });
  ```

- [ ] **2.2 Run the test, see it FAIL.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/sqlite/parse-file-list.test.ts
  ```
  Expected: import error / all cases fail — `parseFileList` does not exist yet (`export 'parseFileList' not found in observations/files.ts`).

- [ ] **2.3 Add `parseFileList` to `observations/files.ts`.** Open `/Users/shinewine/Coding/proj-claude-mem/src/services/sqlite/observations/files.ts`. Insert the helper between the imports and `getFilesForSession`.
  OLD (lines 6-12):
  ```typescript
  import { Database } from 'bun:sqlite';
  import { logger } from '../../../utils/logger.js';
  import type { SessionFilesResult } from './types.js';

  /**
   * Get aggregated files from all observations for a session
   */
  ```
  NEW:
  ```typescript
  import { Database } from 'bun:sqlite';
  import { logger } from '../../../utils/logger.js';
  import type { SessionFilesResult } from './types.js';

  /**
   * Safely parse a JSON array string from the DB.
   * Handles legacy bare-path strings (e.g. "/foo/bar.ts") by wrapping them
   * in an array instead of crashing with a SyntaxError (fix for #1359).
   */
  export function parseFileList(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [String(parsed)];
    } catch {
      return [value];
    }
  }

  /**
   * Get aggregated files from all observations for a session
   */
  ```

- [ ] **2.4 Run the new unit test, see it PASS.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/sqlite/parse-file-list.test.ts
  ```
  Expected: all 9 cases pass, `0 fail`.

- [ ] **2.5 Reuse `parseFileList` at site 3 (`observations/files.ts` loop).** Still in `/Users/shinewine/Coding/proj-claude-mem/src/services/sqlite/observations/files.ts`, replace the per-row parse loop.
  OLD (lines 31-55, the `for (const row of rows)` body — note the fork's GUARDED try/catch form):
  ```typescript
    for (const row of rows) {
      // Parse files_read
      if (row.files_read) {
        try {
          const files = JSON.parse(row.files_read);
          if (Array.isArray(files)) {
            files.forEach(f => filesReadSet.add(f));
          }
        } catch {
          logger.debug('DB', 'Malformed files_read JSON, skipping row');
        }
      }

      // Parse files_modified
      if (row.files_modified) {
        try {
          const files = JSON.parse(row.files_modified);
          if (Array.isArray(files)) {
            files.forEach(f => filesModifiedSet.add(f));
          }
        } catch {
          logger.debug('DB', 'Malformed files_modified JSON, skipping row');
        }
      }
    }
  ```
  NEW:
  ```typescript
    for (const row of rows) {
      // Parse files_read (recovers bare-path strings; #1359)
      parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

      // Parse files_modified (recovers bare-path strings; #1359)
      parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
    }
  ```
  **Keep the `import { logger }` line** at the top of the file even though it becomes unused after this change — the suite-level `logger-usage-standards.test.ts` gate requires every file under `src/services/sqlite/` to `import { logger }`. (Confirmed at write-time: the gate's include pattern is `/^services\/sqlite\/(?!types\.ts$|index\.ts$|query-utils\.ts$)/` at `tests/logger-usage-standards.test.ts:56`, which matches `services/sqlite/observations/files.ts` — it is NOT in the type/index/util exclusion list.) Removing the import would fail that gate. (If a lint pass complains about an unused import, that is acceptable; the suite gate takes priority. Step 2.9 re-runs the gate as proof.)

- [ ] **2.6 Reuse `parseFileList` at site 2 (`SessionStore.ts` duplicate loop).** Open `/Users/shinewine/Coding/proj-claude-mem/src/services/sqlite/SessionStore.ts`. First add the import on a new line immediately after the existing `observations/store` import. The unambiguous anchor is the `findDuplicateObservation` import; the new import goes between it and the `summaries/store` import.
  OLD (lines 13-14):
  ```typescript
  import { computeObservationContentHash, findDuplicateObservation } from './observations/store.js';
  import { computeSummaryContentHash, findDuplicateSummary } from './summaries/store.js';
  ```
  NEW:
  ```typescript
  import { computeObservationContentHash, findDuplicateObservation } from './observations/store.js';
  import { parseFileList } from './observations/files.js';
  import { computeSummaryContentHash, findDuplicateSummary } from './summaries/store.js';
  ```
  (Confirmed at write-time: fork `SessionStore.ts:13` is the `observations/store` import and `:14` is the `summaries/store` import — inserting the new import as a standalone line between them keeps the insertion point unambiguous.)
  Then replace the `getFilesForSession` loop body. OLD (lines 518-534, the UNGUARDED fork copy):
  ```typescript
      for (const row of rows) {
        // Parse files_read
        if (row.files_read) {
          const files = JSON.parse(row.files_read);
          if (Array.isArray(files)) {
            files.forEach(f => filesReadSet.add(f));
          }
        }

        // Parse files_modified
        if (row.files_modified) {
          const files = JSON.parse(row.files_modified);
          if (Array.isArray(files)) {
            files.forEach(f => filesModifiedSet.add(f));
          }
        }
      }
  ```
  NEW:
  ```typescript
      for (const row of rows) {
        // Parse files_read (recovers bare-path strings; #1359)
        parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

        // Parse files_modified (recovers bare-path strings; #1359)
        parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
      }
  ```

- [ ] **2.7 Reuse `parseFileList` at site 1 (`ChromaSync.ts` — the unguarded one).** Open `/Users/shinewine/Coding/proj-claude-mem/src/services/sync/ChromaSync.ts`. Add the import after the existing `logger` import.
  OLD (lines 18-19):
  ```typescript
  import { SessionStore } from '../sqlite/SessionStore.js';
  import { logger } from '../../utils/logger.js';
  ```
  NEW:
  ```typescript
  import { SessionStore } from '../sqlite/SessionStore.js';
  import { logger } from '../../utils/logger.js';
  import { parseFileList } from '../sqlite/observations/files.js';
  ```
  Then replace ONLY the two file columns in `formatObservationDocs`. OLD (lines 130-133):
  ```typescript
      const facts = obs.facts ? JSON.parse(obs.facts) : [];
      const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
      const files_read = obs.files_read ? JSON.parse(obs.files_read) : [];
      const files_modified = obs.files_modified ? JSON.parse(obs.files_modified) : [];
  ```
  NEW (leave `facts`/`concepts` untouched — out of scope):
  ```typescript
      const facts = obs.facts ? JSON.parse(obs.facts) : [];
      const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
      const files_read = parseFileList(obs.files_read);
      const files_modified = parseFileList(obs.files_modified);
  ```

- [ ] **2.8 Type-check + build to confirm all three sites compile.**
  ```bash
  cd /Users/shinewine/Coding/proj-claude-mem && npm run build
  ```
  Expected: build succeeds, no TypeScript errors. (`build` is sufficient here — no worker restart needed for a read-path change; `build-and-sync` is only needed if you want to exercise it live.)

- [ ] **2.9 Run the relevant test directories + the logger gate, see PASS.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/sqlite/ /Users/shinewine/Coding/proj-claude-mem/tests/services/
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/logger-usage-standards.test.ts
  ```
  Expected: `0 fail`. Confirms `parse-file-list.test.ts` passes, no `getFilesForSession`/ChromaSync regression, and that the `import { logger }` line you kept in step 2.5 satisfies the logger gate for `files.ts`.

- [ ] **2.10 Commit.**
  ```bash
  git -C /Users/shinewine/Coding/proj-claude-mem add src/services/sqlite/observations/files.ts src/services/sqlite/SessionStore.ts src/services/sync/ChromaSync.ts tests/sqlite/parse-file-list.test.ts
  git -C /Users/shinewine/Coding/proj-claude-mem commit -m "fix(sqlite): handle bare-path strings in files_read/files_modified columns

JSON.parse('/path/to/file') throws SyntaxError, aborting Chroma vector
sync and SessionStore.getFilesForSession on legacy bare-path data; the
observations/files.ts copy silently DROPPED the path. Add parseFileList()
(JSON.parse, fall back to [value]) and reuse at all three read sites.
getFilesForSession remains duplicated across SessionStore.ts and
observations/files.ts — pre-existing duplication, both patched, not
refactored.

Upstream: thedotmack/claude-mem@2a304d59e (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 3: Mark pending messages failed + preview-log on non-XML responses (shared commit)

**Why**: In `ResponseProcessor.processAgentResponse`, after parsing, a response with non-empty text but zero observations, no summary, and no XML tag (auth errors, rate limits, garbled SDK output) falls through to the CLAIM-CONFIRM block (lines 224-234) which calls `confirmProcessed()` for every `processingMessageId` unconditionally → the queued batch is silently discarded. Fix: detect the non-XML case BEFORE the storage/CLAIM-CONFIRM block; log a 200-char preview WARN (observability) and call `markFailed()` (retry, bounded by `maxRetries=3`) on each in-flight `processingMessageId`, then `return`. The `markFailed` primitive already exists (`PendingMessageStore.ts:640`, signature `markFailed(messageId: number)`, used by SummaryLane:187 / BypassLane:685). Upstream ships the preview-log and markFailed in one branch (`be99a5d69`); the standalone preview-log commit (`92f800d4`) targets a `parseAgentXml`/`parsed.valid` shape the fork does NOT have, so we adapt to the fork's `parseObservations`/`parseSummary` structure using the `be99a5d69` predicate.

**CRITICAL — existing test must be updated (verified against fork source).** The fork's `tests/worker/agents/response-processor.test.ts:482` case `'should handle response with only text (no XML)'` feeds `'This is just plain text without any XML tags.'` and asserts `expect(mockStoreObservations).toHaveBeenCalledTimes(1)`. After this change that input trips the new predicate and `return`s BEFORE `storeObservations`, so the assertion breaks. (Upstream shipped the same un-updated test in be99a5d69 and accepted the breakage; we fix it.) Step 3.5b updates that test in place, and step 3.7 includes `response-processor.test.ts` in the commit. The `empty-ob-detection.test.ts` cases at lines 155/233 also feed non-XML text but only assert `forceInit`/`conversationHistory` (both still hold after early return) AND their session uses `processingMessageIds: []` (so the new branch's `markFailed` loop body never executes), so they do NOT need changes — confirmed by tracing (see step 3.0).

**Predicate safety (grill-confirmed, no misfire)**:
- Genuinely empty response → `text.trim() === ''` → predicate false → no markFailed. ✓
- `<skip_summary reason="..."/>` → `parseSummary` returns `null` and `observations === 0`, but the regex `/<observation>|<summary>|<skip_summary\b/` matches `<skip_summary` → predicate false → no markFailed. ✓ (verified: fork `src/sdk/parser.ts:144` skip regex `/<skip_summary\s+reason="([^"]+)"\s*\/>/` returns `null` for skip_summary; predicate regex matches `<skip_summary` via `\b`.)
- Valid `<observation>` with content → `observations.length > 0` → predicate false. ✓
- Only garbage prose (no XML, non-empty) → predicate TRUE → markFailed + return. ✓

**Callers of `processAgentResponse`** (grep verified — none need a signature change; behavior change only when the predicate fires):
- `src/services/worker/SDKAgent.ts:420` (the only production caller) — passes `(textContent, session, this.dbManager, this.sessionManager, worker, discoveryTokens, originalTimestamp, "SDK", cwdTracker.lastCwd)`. No update needed; the new branch is internal.
- `tests/worker/agents/response-processor.test.ts` — the XML cases stay green; the plain-text case at line 482 MUST be updated (step 3.5b).
- `tests/worker/agents/empty-ob-detection.test.ts` — no update needed (assertions survive early return; verified in step 3.0).

**Files**
- Modify: `/Users/shinewine/Coding/proj-claude-mem/src/services/worker/agents/ResponseProcessor.ts` (insert branch after `const summary = parseSummary(...)` at line 97, before the `// Convert nullable fields...` comment at line 99)
- Modify (existing test, regression fix): `/Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/response-processor.test.ts` (rewrite the `'should handle response with only text (no XML)'` case at lines 482-511)
- Test (new): `/Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/response-processor-nonxml.test.ts`

**Steps**

- [ ] **3.0 Verify signature + predicate-safety facts before writing tests/code (read-only).** Confirm the four assumptions the branch and tests depend on; abort and re-plan if any differs:
  ```bash
  # (a) Exact processAgentResponse signature — confirms positional arg order used by all test calls
  sed -n '49,59p' /Users/shinewine/Coding/proj-claude-mem/src/services/worker/agents/ResponseProcessor.ts
  # (b) skip_summary returns null in parseSummary — basis for the no-misfire claim
  sed -n '143,153p' /Users/shinewine/Coding/proj-claude-mem/src/sdk/parser.ts
  # (c) CLAIM-CONFIRM uses getPendingMessageStore(session.dbPath) — the branch must match this call shape
  sed -n '224,234p' /Users/shinewine/Coding/proj-claude-mem/src/services/worker/agents/ResponseProcessor.ts
  # (d) empty-ob-detection non-XML cases use processingMessageIds:[] and assert only forceInit/conversationHistory
  sed -n '60,80p;141,164p' /Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/empty-ob-detection.test.ts
  ```
  Expected (confirmed at write-time):
  - (a) `processAgentResponse(text, session, dbManager, sessionManager, worker, discoveryTokens, originalTimestamp, agentName, projectRoot?)` — 8 required positional params + optional `projectRoot`. Every test call below ends with `'TestAgent'`/`'SDK'` as the 8th arg (`agentName`) and omits `projectRoot`; `worker` (param 5) is `undefined`/`mockWorker`, `discoveryTokens` (param 6) a number, `originalTimestamp` (param 7) `null`. The order matches.
  - (b) `parseSummary` returns `null` when the skip regex matches.
  - (c) line 226 is `const pendingStore = sessionManager.getPendingMessageStore(session.dbPath);` — the new branch reuses the same `getPendingMessageStore(session.dbPath)` shape.
  - (d) `makeSession()` sets `processingMessageIds: []` and the non-XML cases assert only `session.forceInit` / `session.conversationHistory.length` — both survive the early return, and the empty `processingMessageIds` means the branch's `markFailed` loop never runs.

- [ ] **3.1 Write the failing test (new file).** Create `/Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/response-processor-nonxml.test.ts`. It reuses the harness pattern from `response-processor.test.ts` but makes `getPendingMessageStore` return a STABLE object so `markFailed`/`confirmProcessed` calls can be asserted (the existing harness returns a fresh object per call, which can't be inspected). All `processAgentResponse(...)` calls use the 8-positional-arg form verified in step 3.0(a):
  ```typescript
  import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
  import { logger } from '../../../src/utils/logger.js';

  // Mock modules that cause import chain issues - MUST be before imports
  mock.module('../../../src/services/worker-service.js', () => ({
    updateCursorContextForProject: () => Promise.resolve(),
  }));
  mock.module('../../../src/shared/worker-utils.js', () => ({
    getWorkerPort: () => 37777,
    fetchWithTimeout: async (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
  }));
  mock.module('../../../src/services/domain/ModeManager.js', () => ({
    ModeManager: {
      getInstance: () => ({
        getActiveMode: () => ({
          name: 'code',
          prompts: { init: 'init', observation: 'obs', summary: 'summary' },
          observation_types: [{ id: 'discovery' }],
          observation_concepts: [],
        }),
        getTypeIcon: () => '📌',
        loadMode: () => {},
      }),
    },
  }));

  import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
  import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
  import type { ActiveSession } from '../../../src/services/worker-types.js';
  import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
  import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

  describe('ResponseProcessor non-XML handling', () => {
    let loggerSpies: ReturnType<typeof spyOn>[] = [];
    let markFailed: ReturnType<typeof mock>;
    let confirmProcessed: ReturnType<typeof mock>;
    let storeObservations: ReturnType<typeof mock>;
    let mockDbManager: DatabaseManager;
    let mockSessionManager: SessionManager;

    beforeEach(() => {
      loggerSpies = [
        spyOn(logger, 'info').mockImplementation(() => {}),
        spyOn(logger, 'debug').mockImplementation(() => {}),
        spyOn(logger, 'warn').mockImplementation(() => {}),
        spyOn(logger, 'error').mockImplementation(() => {}),
      ];

      markFailed = mock(() => ({ finalStatus: 'pending', retryCount: 1 }));
      confirmProcessed = mock(() => {});
      storeObservations = mock(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      mockDbManager = {
        getSessionStore: () => ({
          storeObservations,
          ensureMemorySessionIdRegistered: mock(() => {}),
          getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
        }),
        getChromaSync: () => ({
          syncObservation: mock(() => Promise.resolve()),
          syncSummary: mock(() => Promise.resolve()),
        }),
      } as unknown as DatabaseManager;

      // STABLE pending store so markFailed/confirmProcessed are inspectable
      const stablePendingStore = { markFailed, confirmProcessed };
      mockSessionManager = {
        getPendingMessageStore: () => stablePendingStore,
      } as unknown as SessionManager;
    });

    afterEach(() => {
      loggerSpies.forEach(spy => spy.mockRestore());
      mock.restore();
    });

    function createMockSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
      return {
        sessionDbId: 1,
        contentSessionId: 'content-session-123',
        memorySessionId: 'memory-session-456',
        project: 'test-project',
        userPrompt: 'Test prompt',
        pendingMessages: [],
        abortController: new AbortController(),
        generatorPromise: null,
        lastPromptNumber: 5,
        startTime: Date.now(),
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        earliestPendingTimestamp: Date.now() - 10000,
        conversationHistory: [],
        currentProvider: 'claude',
        processingMessageIds: [],
        ...overrides,
      } as unknown as ActiveSession;
    }

    it('marks pending messages failed (not confirmed) on non-XML garbage and returns', async () => {
      const session = createMockSession({ processingMessageIds: [11, 22] });
      const garbage = 'Error: 401 Unauthorized — your API key is invalid.';

      await processAgentResponse(
        garbage, session, mockDbManager, mockSessionManager,
        undefined, 0, null, 'TestAgent'
      );

      expect(markFailed).toHaveBeenCalledTimes(2);
      expect(markFailed.mock.calls[0][0]).toBe(11);
      expect(markFailed.mock.calls[1][0]).toBe(22);
      // Must NOT confirm (which would discard the batch) and must NOT store
      expect(confirmProcessed).not.toHaveBeenCalled();
      expect(storeObservations).not.toHaveBeenCalled();
      // processingMessageIds cleared
      expect(session.processingMessageIds).toHaveLength(0);
    });

    it('does NOT markFailed on empty response (text.trim() === "")', async () => {
      const session = createMockSession({ processingMessageIds: [11] });

      await processAgentResponse(
        '   ', session, mockDbManager, mockSessionManager,
        undefined, 0, null, 'TestAgent'
      );

      expect(markFailed).not.toHaveBeenCalled();
    });

    it('does NOT markFailed on intentional skip_summary response', async () => {
      const session = createMockSession({ processingMessageIds: [11] });
      const skip = '<skip_summary reason="no substantive work" />';

      await processAgentResponse(
        skip, session, mockDbManager, mockSessionManager,
        undefined, 0, null, 'TestAgent'
      );

      expect(markFailed).not.toHaveBeenCalled();
      // skip_summary is a valid (storable) path → reaches CLAIM-CONFIRM
      expect(confirmProcessed).toHaveBeenCalledTimes(1);
    });
  });
  ```

- [ ] **3.2 Run the test, see it FAIL.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/response-processor-nonxml.test.ts
  ```
  Expected: the first case FAILS — `markFailed` is called 0 times and `confirmProcessed` is called 2 times (current code falls through to CLAIM-CONFIRM). The skip_summary and empty cases may already pass; the garbage case is the RED proof. (The skip_summary case is the explicit no-misfire guard from the predicate-safety analysis: it must reach CLAIM-CONFIRM with `confirmProcessed` called exactly once.)

- [ ] **3.3 Insert the non-XML branch in `ResponseProcessor.ts`.** Open `/Users/shinewine/Coding/proj-claude-mem/src/services/worker/agents/ResponseProcessor.ts`. The branch goes immediately AFTER `const summary = parseSummary(...)` (line 97) and BEFORE the `// Convert nullable fields...` comment (line 99).
  OLD (lines 97-100):
  ```typescript
    const summary = parseSummary(text, session.sessionDbId);

    // Convert nullable fields to empty strings for storeSummary (if summary exists)
    let summaryForStore = normalizeSummaryForStorage(summary);
  ```
  NEW:
  ```typescript
    const summary = parseSummary(text, session.sessionDbId);

    // Detect non-XML responses (auth errors, rate limits, garbled output).
    // When the response has non-empty text, produced no observations, no summary,
    // and contains no <observation>/<summary>/<skip_summary> tag, mark the in-flight
    // pending messages as failed (retry, bounded by maxRetries) instead of
    // confirming them — confirming would silently discard the queued batch (#1874).
    const isNonXmlResponse = (
      text.trim() &&
      observations.length === 0 &&
      !summary &&
      !/<observation>|<summary>|<skip_summary\b/.test(text)
    );

    if (isNonXmlResponse) {
      const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      logger.warn('PARSER', `${agentName} returned non-XML response; marking messages as failed for retry (#1874)`, {
        sessionId: session.sessionDbId,
        preview,
      });

      const pendingStore = sessionManager.getPendingMessageStore(session.dbPath);
      for (const messageId of session.processingMessageIds) {
        pendingStore.markFailed(messageId);
      }
      session.processingMessageIds = [];
      return;
    }

    // Convert nullable fields to empty strings for storeSummary (if summary exists)
    let summaryForStore = normalizeSummaryForStorage(summary);
  ```
  Note: `observations` (line 75), `summary` (line 97), `sessionManager` (param), `session.processingMessageIds`, `session.dbPath`, `agentName` (param), and `logger` (import line 14) are all in scope at this point — verified against fork source in step 3.0. The branch reuses the same `getPendingMessageStore(session.dbPath)` shape as the existing CLAIM-CONFIRM call at line 226 (fork-specific: per-project isolation passes `session.dbPath`, unlike upstream which passes no arg), and `markFailed(messageId)` is a single-arg call returning `{finalStatus, retryCount}` (return value ignored here, as in BypassLane). The predicate regex `/<observation>|<summary>|<skip_summary\b/` is byte-identical to upstream be99a5d69. The branch combines the markFailed (be99a5d69) and the preview-log in one place, exactly as upstream be99a5d69 ships it.

- [ ] **3.4 Run the non-XML test, see it PASS.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/response-processor-nonxml.test.ts
  ```
  Expected: all 3 cases pass, `0 fail`. The skip_summary case passing confirms the no-misfire guarantee for intentional skips.

- [ ] **3.5 Run the existing ResponseProcessor + empty-obs suites — expect ONE failure to fix next.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/response-processor.test.ts
  ```
  Expected: exactly ONE failure — `'should handle response with only text (no XML)'` now fails because `mockStoreObservations` was NOT called (the new branch returned early). This is the expected, intended behavior change; step 3.5b updates the test to match. (`empty-ob-detection.test.ts` is unaffected — its non-XML cases only assert `forceInit`/`conversationHistory`, which still hold after early return, and use `processingMessageIds: []` so the markFailed loop never runs — confirmed in step 3.0.)

- [ ] **3.5b Update the existing `'should handle response with only text (no XML)'` case to assert the new behavior.** Open `/Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/response-processor.test.ts`. The default `createMockSession()` sets `processingMessageIds: []`, so the existing harness's `getPendingMessageStore` mock (which lacks `markFailed`) is never exercised by the empty loop — but to assert the new contract we add a `markFailed` mock to a local stable store and give the session processing IDs.
  OLD (lines 482-511, the whole `it('should handle response with only text (no XML)', ...)` block):
  ```typescript
      it('should handle response with only text (no XML)', async () => {
        const session = createMockSession();
        const responseText = 'This is just plain text without any XML tags.';

        mockStoreObservations = mock(() => ({
          observationIds: [],
          summaryId: null,
          createdAtEpoch: 1700000000000,
        }));
        (mockDbManager.getSessionStore as any) = () => ({
          storeObservations: mockStoreObservations,
          ensureMemorySessionIdRegistered: mock(() => {}),
          getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
        });

        await processAgentResponse(
          responseText,
          session,
          mockDbManager,
          mockSessionManager,
          mockWorker,
          100,
          null,
          'TestAgent'
        );

        expect(mockStoreObservations).toHaveBeenCalledTimes(1);
        const [, , observations] = mockStoreObservations.mock.calls[0];
        expect(observations).toHaveLength(0);
      });
  ```
  NEW (non-XML text now marks messages failed and does NOT store — #1874):
  ```typescript
      it('marks messages failed (does not store) on response with only text (no XML)', async () => {
        const session = createMockSession({ processingMessageIds: [7, 8] });
        const responseText = 'This is just plain text without any XML tags.';

        mockStoreObservations = mock(() => ({
          observationIds: [],
          summaryId: null,
          createdAtEpoch: 1700000000000,
        }));
        (mockDbManager.getSessionStore as any) = () => ({
          storeObservations: mockStoreObservations,
          ensureMemorySessionIdRegistered: mock(() => {}),
          getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
        });

        const markFailed = mock(() => ({ finalStatus: 'pending', retryCount: 1 }));
        const confirmProcessed = mock(() => {});
        (mockSessionManager.getPendingMessageStore as any) = () => ({ markFailed, confirmProcessed });

        await processAgentResponse(
          responseText,
          session,
          mockDbManager,
          mockSessionManager,
          mockWorker,
          100,
          null,
          'TestAgent'
        );

        // Non-XML garbage must NOT be stored or confirmed — messages are failed for retry
        expect(mockStoreObservations).not.toHaveBeenCalled();
        expect(confirmProcessed).not.toHaveBeenCalled();
        expect(markFailed).toHaveBeenCalledTimes(2);
        expect(session.processingMessageIds).toHaveLength(0);
      });
  ```

- [ ] **3.5c Re-run the agents directory, see PASS.**
  ```bash
  bun test /Users/shinewine/Coding/proj-claude-mem/tests/worker/agents/
  ```
  Expected: `0 fail`. Confirms the new branch + updated existing test + `empty-ob-detection.test.ts` (empty observations still reach CLAIM-CONFIRM because they DO contain `<observation>` tags → predicate false; its no-tag cases survive the early return per step 3.0) all pass.

- [ ] **3.6 Build to confirm types.**
  ```bash
  cd /Users/shinewine/Coding/proj-claude-mem && npm run build
  ```
  Expected: build succeeds, no TypeScript errors.

- [ ] **3.7 Commit (markFailed + preview-log + test update together).**
  ```bash
  git -C /Users/shinewine/Coding/proj-claude-mem add src/services/worker/agents/ResponseProcessor.ts tests/worker/agents/response-processor-nonxml.test.ts tests/worker/agents/response-processor.test.ts
  git -C /Users/shinewine/Coding/proj-claude-mem commit -m "fix(worker): mark pending messages failed + log preview on non-XML responses

ResponseProcessor fell through to CLAIM-CONFIRM and confirmProcessed()
every in-flight message even when the LLM returned non-XML garbage (auth
errors, rate limits, garbled output) — silently discarding the queued
batch. Detect the non-XML case (non-empty text, zero observations, no
summary, no observation/summary/skip_summary tag) before storage: log a
200-char preview WARN for operator visibility and markFailed() each
processingMessageId (retry bounded by maxRetries=3). Predicate does not
misfire on empty or intentional skip_summary responses. Existing
'only text (no XML)' test updated to assert the new failed-not-stored
contract.

Upstream: thedotmack/claude-mem@be99a5d69 (AGPL-3.0)
Upstream: thedotmack/claude-mem@92f800d4 (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Final verification (whole chunk)

- [ ] Run the full suite to confirm no cross-file regression:
  ```bash
  find "$PWD/tests" -type f \( -name '*.test.ts' -o -name '*test.ts' \) -print0 | xargs -0 bun test
  ```
  Expected: root tests 0 fail. Pass count should equal the implementation-day root-test baseline plus the net new cases: +1 collision (Task 1), +9 parseFileList (Task 2), +3 non-XML (Task 3); the Task 3 existing-test rewrite is a replacement, not an addition.


---

## Chunk 2: P0 安全/隐私 (security-privacy)

> Provenance license per item determined via `git -C attn_sink/upstream-claude-mem merge-base --is-ancestor 36b0929f <hash>` (exit 0 → Apache-2.0, else AGPL-3.0). Results: `ce13c887`→Apache, `9c56dda79`→Apache; `703c64c7`/`46d204ee9`/`31ee1024c`/`a66b98bcd`/`f81684c61`→AGPL.
> Fork pins `@anthropic-ai/claude-agent-sdk@^0.1.76`, resolved to **0.1.77** (bun.lock). Current-local verification found the required fields under `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/runtimeTypes.d.ts` and `coreTypes.d.ts`; `sdk.d.ts` is only a re-export and MUST NOT be used as the grep target. Re-run Task 2 Step 0 at implement time because SDK patch versions may drift.
> Task ordering rationale (grill-confirmed): agent-id-probe ships FIRST (deploy early to collect pod evidence); observer-sdk-lockdown is its own commit (riskiest behavior change); .env + settings 0600 share a commit; the two tag strips share a commit.
> Build note: `npm run build` runs esbuild (transpile + bundle), not `tsc` — it catches unresolved imports, syntax errors, and duplicate identifiers, but NOT pure type errors. "build OK" below means the bundle resolves and emits cleanly; type-level mistakes surface when `bun test` loads the modules.

---

### Task 1: agent-id-probe — log incoming agent_id/agent_type from raw stdin (fork-original, NO trailer)

**Why**: Collect pod evidence for deferred Q23. The normalized hook input (`NormalizedHookInput`, `src/cli/types.ts`) drops `agent_id`/`agent_type` (verified — the interface has only `sessionId/cwd/platform/prompt/toolName/toolInput/toolResponse/transcriptPath/filePath/edits/_projectContext`); only the raw stdin object (`rawInput` in `src/cli/hook-command.ts:80`) carries them. This is the single edge with raw access and fires for every hook event. Temporary diagnostic — no behavior change.

**Files**
- Modify: `src/cli/hook-command.ts` (insert after line 82, `input.platform = platform;`)
- Test: `tests/cli/agent-id-probe.test.ts` (new)

**Steps**
- [ ] Step 1 — Write failing test. Create `tests/cli/agent-id-probe.test.ts`:
  ```typescript
  import { describe, it, expect } from 'bun:test';
  import { readFileSync } from 'fs';
  import { join } from 'path';

  // Source-level guard (string-pinned): the probe must read raw agent fields
  // before normalization strips them, and must be clearly marked temporary.
  // We assert on the source text rather than exercising process.exit().
  describe('agent-id-probe (temporary Q23 instrumentation)', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../src/cli/hook-command.ts'),
      'utf-8',
    );

    it('reads agent_id / agent_type from the RAW stdin object', () => {
      expect(src).toContain('AGENT_ID_PROBE');
      // Must reference rawInput (pre-normalization), not the normalized input
      expect(src).toMatch(/rawInput[\s\S]{0,200}agent_id/);
      expect(src).toMatch(/rawInput[\s\S]{0,200}agent_type/);
    });

    it('is marked as a temporary probe with a removal condition', () => {
      expect(src).toMatch(/TEMPORARY PROBE/i);
      // C2-F7: the probe must carry an explicit removal condition so it cannot
      // silently persist indefinitely once Q23 is decided.
      expect(src).toMatch(/TODO\(Q23\)/);
    });
  });
  ```
- [ ] Step 2 — Run it, see it FAIL:
  ```
  bun test tests/cli/agent-id-probe.test.ts
  ```
  Expected: 2 fail (`AGENT_ID_PROBE` not found in source).
- [ ] Step 3 — Minimal impl. In `src/cli/hook-command.ts`, OLD block (lines 80-82):
  ```typescript
    const rawInput = await readJsonFromStdin();
    const input = adapter.normalizeInput(rawInput);
    input.platform = platform;
  ```
  NEW block:
  ```typescript
    const rawInput = await readJsonFromStdin();
    const input = adapter.normalizeInput(rawInput);
    input.platform = platform;

    // TEMPORARY PROBE (deferred Q23 pod evidence): the normalized input drops
    // agent_id/agent_type, so read them straight off the raw stdin object.
    // No behavior change — single info log to the file logger (never stderr).
    // TODO(Q23): remove this probe once the deferred sub-agent summary impact
    // question (Q23) is resolved — i.e. once agent_id/agent_type pod evidence
    // has been collected and Q23 is closed in the audit report (§6.3/6.4). Do
    // not leave it in past Q23 resolution.
    {
      const r = rawInput as { agent_id?: unknown; agent_type?: unknown };
      logger.info('HOOK', 'AGENT_ID_PROBE', {
        event,
        agent_id: r.agent_id ?? null,
        agent_type: r.agent_type ?? null,
      });
    }
  ```
  (`logger` is already imported at `src/cli/hook-command.ts:5`; `event` is the `hookCommand(platform, event, ...)` function parameter already in scope. `logger.info(component, message, context?, data?)` — the object here is the `context` arg, which renders its keys via the `{k=v}` form; acceptable for a diagnostic.)
- [ ] Step 4 — Run, see PASS:
  ```
  bun test tests/cli/agent-id-probe.test.ts
  ```
  Expected: 2 pass.
- [ ] Step 5 — Bundle/import check (probe touches a hook entry point):
  ```
  npm run build
  ```
  Expected: build completes, no unresolved-import or syntax errors.
- [ ] Step 6 — Commit (fork-original — NO provenance trailer):
  ```
  git add src/cli/hook-command.ts tests/cli/agent-id-probe.test.ts
  git commit -m "feat(probe): temporary agent_id/agent_type stdin probe for Q23

  Logs incoming agent_id/agent_type from the raw hook stdin object before
  normalization strips them. Diagnostic only; remove once Q23 resolved
  (TODO(Q23) marker + removal condition documented at the call site).

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: observer-sdk-lockdown — `buildHardenedSdkOptions()` helper at both SDK call sites (Apache `ce13c887` + AGPL `703c64c7`/`46d204ee9`)

**Why**: Both observer (`SDKAgent.ts:227-246`) and fresh-summarize (`fresh-summarize.ts:148-159`) currently enforce "no tools" with a `disallowedTools` blacklist only — a new built-in SDK tool would bypass it. Centralize a defense-in-depth lockdown: `tools:[]` + `allowedTools:[]` + existing `disallowedTools` + `permissionMode` + deny-all `canUseTool` + `mcpServers:{}` + `settingSources:[]` + `strictMcpConfig:true` + `additionalDirectories:[]` + cwd jail. SKIP the NDJSON `observer-audit.ts` (per audit decision) — `canUseTool` just denies and WARN-logs.

**Observer-output privacy (already covered — no new code; C2-F3)**: This task hardens *tool access*, not content. The concern "observer observations could leak `<private>` content" is already covered by the fork's edge-stripping, verified at write-time:
- The observer's *input* (`tool_input`/`tool_response`) is stripped at the persistence edge before the observer ever sees it: `SessionRoutes.ts:819-820` calls `cleanToolField()` → `observation-utils.ts:46 stripMemoryTagsFromJson()` on enqueue. The summarize hook strips `last_assistant_message` at the hook edge (Task 5). So the observer is conditioned on already-stripped content and cannot reintroduce a `<private>` block it never received.
- The observer is an LLM extracting structured facts from already-stripped input; it does not echo verbatim secrets back. Per DECISIONS C2, do NOT add a second defensive strip on the observer output — trust the existing edge-stripping. This note exists so a future maintainer does not "re-add" the strip thinking it is missing.

**Provenance note**: combines Apache (`ce13c887`) and AGPL (`703c64c7`/`46d204ee9`) upstream work → use the more-restrictive **AGPL-3.0** trailer and cite both commits.

**Caller check (verified)**:
- SDKAgent's local `const disallowedTools` (lines 102-115) is referenced only at line 236 (the options block being replaced). After this task `grep -n disallowedTools src/services/worker/SDKAgent.ts` must return zero matches → safe to delete the const.
- The fresh-summarize path's tool list comes from `SummaryLane.SUMMARIZE_DISALLOWED_TOOLS` (`SummaryLane.ts:56`) which is wired into `buildFreshSummarizeDeps` (`fresh-summarize-deps.ts:44`) → `deps.disallowedTools`. After Step 8 the hardened helper ignores `deps.disallowedTools` and supplies `OBSERVER_DISALLOWED_TOOLS` (a superset). `deps.disallowedTools` stays a (now set-but-unread) field on `FreshSummarizeDeps`; the interface is left untouched (no caller change). The `buildFreshSummarizeDeps` builder and its test `tests/worker/fresh-summarize-deps.test.ts` are unaffected (they test the builder, not the options).
- One EXISTING test asserts the old pass-through behavior: `tests/worker/fresh-summarize.test.ts:127-134` ("passes the disallowedTools list to the query options") expects `captured.options.disallowedTools` to equal `deps.disallowedTools`. This WILL break and is updated in Step 9 below (it must move to asserting the hardened list).

**Files**
- Create: `src/sdk/hardened-options.ts`
- Modify: `src/services/worker/SDKAgent.ts` (import after line 52; remove `disallowedTools` const lines 102-115; replace options block lines 227-246)
- Modify: `src/services/worker/fresh-summarize.ts` (import after line 24; replace options block lines 148-159)
- Modify: `tests/worker/fresh-summarize.test.ts` (update the disallowedTools pass-through test, lines 127-134)
- Test: `tests/security/observer-tool-enforcement.test.ts` (new; adapted from `ce13c887`, audit assertions removed)

**Steps**
- [ ] Step 0 — VERIFY SDK field/value support before coding. Run the package-wide entrypoint grep (do not grep top-level `sdk.d.ts`; in this fork it only re-exports):
  ```
  rg -n "permissionMode|dontAsk|settingSources|strictMcpConfig|allowedTools|canUseTool|additionalDirectories" \
    node_modules/@anthropic-ai/claude-agent-sdk/entrypoints
  ```
  Expected on current local 0.1.77: `runtimeTypes.d.ts` contains `additionalDirectories`, `allowedTools`, `canUseTool`, `permissionMode`, `settingSources`, and `strictMcpConfig`; `coreTypes.d.ts` contains `PermissionMode = ... | 'dontAsk'`.
  - If `'dontAsk'` is a valid `PermissionMode` literal → use it in Step 3.
  - If 0.1.77's `PermissionMode` does NOT include `'dontAsk'` (it post-dates the upstream v0.2.141 verification) → OMIT the `permissionMode` line entirely. The load-bearing enforcement is `tools:[]` + `disallowedTools` + deny-all `canUseTool`; `permissionMode` is the redundant "braces" layer. The Step 1 test already tolerates both (`permissionMode === undefined || 'dontAsk'`), so no test edit is needed in that case.
  - The helper return type is `Record<string, unknown>` (NOT the SDK `Options` type) precisely to avoid a hard compile dependency on this enum across SDK versions. (Upstream `ce13c887` returned `Options` against v0.2.141; the fork deliberately loosens this.)
  - **Record the result in code (C2-F1)**: whichever branch you take, write the outcome into a one-line comment directly above the `permissionMode` line in `hardened-options.ts` (Step 3) — e.g. `// Step 0 (2026-06-04, sdk 0.1.77): 'dontAsk' present in PermissionMode → kept.` or `// Step 0 (2026-06-04, sdk 0.1.77): 'dontAsk' absent → permissionMode line omitted.` This makes the deferred verification auditable and flags drift if a future SDK bump changes the enum. (The Step 1 test already pins the behavioral contract — `permissionMode === undefined || 'dontAsk'`, never `'bypassPermissions'` — so a future bump is also caught by CI without a separate type-introspection test.)
- [ ] Step 1 — Write failing test. Create `tests/security/observer-tool-enforcement.test.ts` (adapted: no `observer-audit` import, no audit-file assertions):
  ```typescript
  import { describe, it, expect } from 'bun:test';
  import {
    buildHardenedSdkOptions,
    OBSERVER_DISALLOWED_TOOLS,
  } from '../../src/sdk/hardened-options.js';
  import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';

  const BASE_INPUT = {
    source: 'Observer' as const,
    model: 'claude-sonnet-4-6',
    env: {} as NodeJS.ProcessEnv,
    pathToClaudeCodeExecutable: '/usr/bin/claude',
  };

  describe('Observer/Summarize SDK tool enforcement (hardened-options)', () => {
    it('sets tools to an empty array (disables ALL built-in tools)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(Array.isArray(opts.tools)).toBe(true);
      expect((opts.tools as unknown[]).length).toBe(0);
    });

    it('sets allowedTools to an empty array (nothing auto-approved)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(Array.isArray(opts.allowedTools)).toBe(true);
      expect((opts.allowedTools as unknown[]).length).toBe(0);
    });

    it('keeps the full disallowedTools deny-list (12 tools)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      const denied = (opts.disallowedTools as string[]) ?? [];
      for (const tool of OBSERVER_DISALLOWED_TOOLS) {
        expect(denied).toContain(tool);
      }
      expect(denied.length).toBe(OBSERVER_DISALLOWED_TOOLS.length);
      expect(OBSERVER_DISALLOWED_TOOLS.length).toBe(12);
    });

    it("uses a non-interactive deny permissionMode (or omits it on older SDK)", () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      // Step 0 decides: 'dontAsk' on 0.1.77+ that supports it, else undefined.
      expect(opts.permissionMode === undefined || opts.permissionMode === 'dontAsk').toBe(true);
    });

    it('never uses bypassPermissions', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(opts.permissionMode).not.toBe('bypassPermissions');
    });

    it('isolates settings, MCP, and extra directories', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(opts.mcpServers).toEqual({});
      expect(opts.settingSources).toEqual([]);
      expect(opts.strictMcpConfig).toBe(true);
      expect(opts.additionalDirectories).toEqual([]);
    });

    it('jails cwd to OBSERVER_SESSIONS_DIR by default and never to process.cwd()', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(opts.cwd).toBe(OBSERVER_SESSIONS_DIR);
      expect(opts.cwd).not.toBe(process.cwd());
    });

    it('honors an explicit cwd override (fresh-summarize jail unchanged)', () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT, cwd: '/some/jail' });
      expect(opts.cwd).toBe('/some/jail');
    });

    it('exposes a canUseTool callback that denies every invocation', async () => {
      const opts = buildHardenedSdkOptions({ ...BASE_INPUT });
      expect(typeof opts.canUseTool).toBe('function');
      const result = await (opts.canUseTool as (n: string, i: unknown) => Promise<{ behavior: string }>)(
        'Bash',
        { command: 'rm -rf /' },
      );
      expect(result.behavior).toBe('deny');
    });

    it('passes through model, env, executable, abortController, spawn wrapper', () => {
      const ac = new AbortController();
      const spawn = (() => undefined) as unknown;
      const opts = buildHardenedSdkOptions({
        ...BASE_INPUT,
        abortController: ac,
        spawnClaudeCodeProcess: spawn as never,
      });
      expect(opts.model).toBe('claude-sonnet-4-6');
      expect(opts.pathToClaudeCodeExecutable).toBe('/usr/bin/claude');
      expect(opts.abortController).toBe(ac);
      expect(opts.spawnClaudeCodeProcess).toBe(spawn);
    });
  });
  ```
- [ ] Step 2 — Run it, see it FAIL:
  ```
  bun test tests/security/observer-tool-enforcement.test.ts
  ```
  Expected: failure — cannot resolve `../../src/sdk/hardened-options.js`.
- [ ] Step 3 — Create `src/sdk/hardened-options.ts` (MUST `import { logger }` — `logger-usage-standards.test.ts` line 60 requires every non-types file under `src/sdk/` to import logger, else the full suite fails). If Step 0 said omit `permissionMode`, delete the `permissionMode` line:
  ```typescript
  /**
   * Single source of truth for the SECURITY-SENSITIVE SDK options that lock the
   * Observer and fresh-summarize sessions down to "no tool access".
   *
   * The memory agent's prompts assert "you have no tools". Historically that was
   * enforced ONLY by `disallowedTools` — a future SDK built-in tool would slip
   * the net. This helper makes the guarantee true at the config layer with
   * defense-in-depth (no single option is load-bearing):
   *   - tools: []           disables ALL built-in tools
   *   - allowedTools: []    nothing auto-approved
   *   - disallowedTools     explicit per-tool deny list (suspenders)
   *   - permissionMode      'dontAsk' = deny unless pre-approved (nothing is)
   *   - canUseTool          deny EVERY invocation + WARN log (backstop)
   *   - cwd jail + mcpServers:{} + settingSources:[] + strictMcpConfig
   *     + additionalDirectories:[] — no settings/MCP inheritance, no fs escape
   *
   * NDJSON audit log (upstream observer-audit.ts) intentionally SKIPPED — the
   * WARN log is the live trail.
   *
   * Returns Record<string, unknown> (not the SDK Options type) so the module
   * does not hard-depend on the SDK's PermissionMode enum across versions.
   */

  import { OBSERVER_SESSIONS_DIR } from '../shared/paths.js';
  import { logger } from '../utils/logger.js';

  /** Explicit deny-list. `tools: []` already disables all built-ins; this is
   *  the redundant "suspenders" layer and documents intent for reviewers. */
  export const OBSERVER_DISALLOWED_TOOLS = [
    'Bash',            // Prevent infinite loops
    'Read',            // No file reading
    'Write',           // No file writing
    'Edit',            // No file editing
    'Grep',            // No code searching
    'Glob',            // No file pattern matching
    'WebFetch',        // No web fetching
    'WebSearch',       // No web searching
    'Task',            // No spawning sub-agents
    'NotebookEdit',    // No notebook editing
    'AskUserQuestion', // No asking questions
    'TodoWrite',       // No todo management
  ] as const;

  export interface HardenedSdkOptionsInput {
    /** Which call site is constructing options — flows into the WARN log. */
    source: 'Observer' | 'Summarize';
    /** Carried into the WARN log for post-incident correlation. */
    sessionDbId?: number;
    contentSessionId?: string;

    // Pass-through fields the caller still owns:
    model: string;
    env: NodeJS.ProcessEnv;
    pathToClaudeCodeExecutable: string;
    /** Defaults to OBSERVER_SESSIONS_DIR. Never falls back to process.cwd(). */
    cwd?: string;
    abortController?: AbortController;
    resume?: string;
    /** SDK SpawnFactory wrapper (PID-capturing / stderr-tail). */
    spawnClaudeCodeProcess?: unknown;
  }

  /**
   * Build the fully hardened SDK options for an Observer / fresh-summarize
   * query() call. Both call sites MUST go through this helper so the lockdown
   * cannot drift between them.
   */
  export function buildHardenedSdkOptions(
    input: HardenedSdkOptionsInput,
  ): Record<string, unknown> {
    const canUseTool = async (toolName: string, _toolInput: unknown) => {
      // Logged under the 'SYSTEM' component (the closest member of the logger's
      // Component union; there is no dedicated 'SECURITY' member). Records that a
      // tool-use attempt was denied for post-incident correlation.
      logger.warn('SYSTEM', `Blocked tool use by ${input.source}: ${toolName}`, {
        sessionDbId: input.sessionDbId,
        contentSessionId: input.contentSessionId,
        source: input.source,
        tool_name: toolName,
      });
      return {
        behavior: 'deny' as const,
        message: `${input.source} is forbidden from tool use (claude-mem hard lockdown).`,
      };
    };

    return {
      model: input.model,
      cwd: input.cwd ?? OBSERVER_SESSIONS_DIR,
      env: input.env,
      pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
      ...(input.abortController ? { abortController: input.abortController } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.spawnClaudeCodeProcess
        ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess }
        : {}),

      // === Tool lockdown (defense-in-depth) ===
      tools: [],
      allowedTools: [],
      disallowedTools: [...OBSERVER_DISALLOWED_TOOLS],
      // Step 0 verification result recorded here (see Task 2 Step 0): keep this
      // line only if 0.1.77's PermissionMode includes 'dontAsk'; otherwise delete
      // it. Annotate with the checked SDK version + outcome, e.g.
      //   // Step 0 (sdk 0.1.77): 'dontAsk' present → kept.
      permissionMode: 'dontAsk', // DELETE this line if Step 0 found 0.1.77 lacks 'dontAsk'
      canUseTool,

      // === Filesystem / settings / MCP isolation ===
      additionalDirectories: [],
      mcpServers: {},
      settingSources: [],
      strictMcpConfig: true,
    };
  }
  ```
  NOTE (C2-F6): use the logger component `'SYSTEM'` (a real member of the logger's `Component` union `'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA' | ...`, verified at `src/utils/logger.ts:18`). Do NOT use `'SECURITY'` — it is NOT in the union, and although the helper is typed `Record<string, unknown>` and built/run via esbuild + bun (which transpile without `tsc`) so a `'SECURITY'` string would not break the current build, it would become a type error the moment `tsc` is added and there is no upside over `'SYSTEM'`. Behavior is identical. (No test asserts the component string.)
- [ ] Step 4 — Run the new test, see PASS:
  ```
  bun test tests/security/observer-tool-enforcement.test.ts
  ```
  Expected: 10 pass.
- [ ] Step 5 — Wire SDKAgent call site. In `src/services/worker/SDKAgent.ts`, add the import after line 52:
  OLD:
  ```typescript
  import { shouldProactiveReset } from "./generator-action.js";
  ```
  NEW:
  ```typescript
  import { shouldProactiveReset } from "./generator-action.js";
  import { buildHardenedSdkOptions } from "../../sdk/hardened-options.js";
  ```
- [ ] Step 6 — Remove the now-orphaned `disallowedTools` const, then replace the options block.
  6a. Delete the `disallowedTools` const. OLD (lines 100-115):
  ```typescript
    const modelId = this.getModelId();
    // Memory agent is OBSERVER ONLY - no tools allowed
    const disallowedTools = [
      "Bash", // Prevent infinite loops
      "Read", // No file reading
      "Write", // No file writing
      "Edit", // No file editing
      "Grep", // No code searching
      "Glob", // No file pattern matching
      "WebFetch", // No web fetching
      "WebSearch", // No web searching
      "Task", // No spawning sub-agents
      "NotebookEdit", // No notebook editing
      "AskUserQuestion", // No asking questions
      "TodoWrite", // No todo management
    ];
  ```
  NEW (lines 100-101):
  ```typescript
    const modelId = this.getModelId();
    // Memory agent is OBSERVER ONLY - no tools allowed. The hardened deny-list
    // (OBSERVER_DISALLOWED_TOOLS) now lives in buildHardenedSdkOptions; the
    // former local const here was orphaned once the options block routes through it.
  ```
  6b. Replace the options block. OLD (lines 227-246):
  ```typescript
      const queryResult = query({
        prompt: messageGenerator,
        options: {
          model: modelId,
          // Isolate observer sessions - they'll appear under project "observer-sessions"
          // instead of polluting user's actual project resume lists
          cwd: OBSERVER_SESSIONS_DIR,
          // Only resume if shouldResume is true (memorySessionId exists, not first prompt, not forceInit)
          ...(shouldResume && { resume: session.memorySessionId }),
          disallowedTools,
          abortController: session.abortController,
          pathToClaudeCodeExecutable: claudePath,
          // Custom spawn function captures PIDs to fix zombie process accumulation
          spawnClaudeCodeProcess: createPidCapturingSpawn(
            session.sessionDbId,
            session.dbPath,
          ),
          env: isolatedEnv, // Use isolated credentials from ~/.claude-mem/.env, not process.env
        },
      });
  ```
  NEW:
  ```typescript
      // Hardened, no-tools SDK options (defense-in-depth) — single source of
      // truth shared with fresh-summarize so the lockdown can't drift. cwd jail
      // (OBSERVER_SESSIONS_DIR) and PID-capturing spawn preserved.
      const queryResult = query({
        prompt: messageGenerator,
        options: buildHardenedSdkOptions({
          source: 'Observer',
          sessionDbId: session.sessionDbId,
          contentSessionId: session.contentSessionId,
          model: modelId,
          cwd: OBSERVER_SESSIONS_DIR,
          // Only resume if shouldResume is true (memorySessionId exists, not first prompt, not forceInit)
          ...(shouldResume ? { resume: session.memorySessionId } : {}),
          abortController: session.abortController,
          pathToClaudeCodeExecutable: claudePath,
          // Custom spawn function captures PIDs to fix zombie process accumulation
          spawnClaudeCodeProcess: createPidCapturingSpawn(
            session.sessionDbId,
            session.dbPath,
          ),
          env: isolatedEnv, // isolated credentials from ~/.claude-mem/.env
        }),
      });
  ```
  Re-verify with `grep -n disallowedTools src/services/worker/SDKAgent.ts` after editing — expect zero matches. (`session.contentSessionId` is a real field on `ActiveSession`, already referenced at SDKAgent.ts:189/204/211 — verified in scope.)
- [ ] Step 7 — Wire fresh-summarize call site. In `src/services/worker/fresh-summarize.ts`, add import after line 24:
  OLD:
  ```typescript
  import type { ModeConfig } from '../domain/types.js';
  ```
  NEW:
  ```typescript
  import type { ModeConfig } from '../domain/types.js';
  import { buildHardenedSdkOptions } from '../../sdk/hardened-options.js';
  ```
- [ ] Step 8 — Replace the fresh-summarize options block. OLD (lines 148-159):
  ```typescript
    const options: Record<string, unknown> = {
      model: deps.modelId,
      cwd: deps.cwd,
      disallowedTools: deps.disallowedTools,
      abortController: deps.abortController,
      pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
      env: deps.isolatedEnv,
      // Explicitly NO resume — this is the entire point of the fresh path.
    };
    if (deps.spawnClaudeCodeProcess) {
      options.spawnClaudeCodeProcess = deps.spawnClaudeCodeProcess;
    }
  ```
  NEW:
  ```typescript
    // Hardened, no-tools SDK options — same lockdown as the observer path.
    // cwd jail (deps.cwd = observer-sessions dir) preserved; NO resume (the
    // entire point of the fresh path — buildHardenedSdkOptions omits resume
    // unless passed, and we never pass it here). The hardened helper supplies
    // OBSERVER_DISALLOWED_TOOLS (a superset of SUMMARIZE_DISALLOWED_TOOLS), so
    // deps.disallowedTools is no longer read here (kept on the interface for
    // the SummaryLane builder; see Step 9 test update).
    const options = buildHardenedSdkOptions({
      source: 'Summarize',
      model: deps.modelId,
      cwd: deps.cwd,
      abortController: deps.abortController,
      pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
      env: deps.isolatedEnv,
      ...(deps.spawnClaudeCodeProcess
        ? { spawnClaudeCodeProcess: deps.spawnClaudeCodeProcess }
        : {}),
    });
  ```
  Note: `deps.disallowedTools` remains a field on `FreshSummarizeDeps` (set by `SummaryLane.SUMMARIZE_DISALLOWED_TOOLS` via `buildFreshSummarizeDeps`); leave the interface untouched — only the local options construction changes.
- [ ] Step 9 — Update the EXISTING fresh-summarize options test that pinned the old pass-through behavior. After Step 8, `runFreshSummarizeQuery` ignores `deps.disallowedTools` and always emits the hardened list, so the old assertion (`captured.options.disallowedTools` === `deps.disallowedTools`) is now false and must change. In `tests/worker/fresh-summarize.test.ts`:
  9a. Add the import for the hardened list. After the existing import block (lines 33-37, the `runFreshSummarizeQuery` import from `'../../src/services/worker/fresh-summarize.js'`), insert:
  ```typescript
  import { OBSERVER_DISALLOWED_TOOLS } from '../../src/sdk/hardened-options.js';
  ```
  9b. Replace the test body. OLD (lines 127-134):
  ```typescript
    it('passes the disallowedTools list to the query options', async () => {
      const { fn, captured } = makeFakeQuery([]);
      const deps = makeDeps({ fn: fn as any } as any);
      deps.query = fn as any;
      deps.disallowedTools = ['Bash', 'Read', 'Write', 'Grep'];
      await runFreshSummarizeQuery(deps, baseInput);
      expect(captured.options.disallowedTools).toEqual(['Bash', 'Read', 'Write', 'Grep']);
    });
  ```
  NEW:
  ```typescript
    it('always applies the hardened OBSERVER_DISALLOWED_TOOLS, ignoring deps.disallowedTools', async () => {
      const { fn, captured } = makeFakeQuery([]);
      const deps = makeDeps({ query: fn as any });
      // Even a narrow deps deny-list must be overridden by the hardened lockdown.
      deps.disallowedTools = ['Bash', 'Read', 'Write', 'Grep'];
      await runFreshSummarizeQuery(deps, baseInput);
      // Hardened helper supplies the full 12-tool deny-list, plus tools:[] /
      // allowedTools:[] for defense-in-depth.
      expect(captured.options.disallowedTools).toEqual([...OBSERVER_DISALLOWED_TOOLS]);
      expect(captured.options.tools).toEqual([]);
      expect(captured.options.allowedTools).toEqual([]);
    });
  ```
- [ ] Step 10 — Run the focused suites + full build:
  ```
  bun test tests/security/observer-tool-enforcement.test.ts tests/sdk-agent-resume.test.ts tests/worker/fresh-summarize.test.ts
  npm run build-and-sync
  ```
  Expected: security test 10 pass; resume test pass; fresh-summarize test pass (including the updated lockdown assertion); build completes, worker restarts.
- [ ] Step 11 — SMOKE NOTE (manual, record result in commit body): after `build-and-sync`, run one real observe cycle (trigger a PostToolUse in a real session or the project's smoke harness) and confirm at least one observation is still produced (the lockdown must NOT break legitimate observation extraction — the agent uses zero tools, so denying tools is expected to be a no-op for it). If zero observations appear, STOP and investigate before committing.
- [ ] Step 12 — Run full suite (lockdown touches hot paths):
  ```
  find "$PWD/tests" -type f \( -name '*.test.ts' -o -name '*test.ts' \) -print0 | xargs -0 bun test
  ```
  Expected: all pass. Pass count should equal the implementation-day root-test baseline plus new security tests; the one updated fresh-summarize test keeps the count stable.
- [ ] Step 13 — Commit (AGPL-3.0 — combines Apache `ce13c887` with AGPL isolation fields from `703c64c7`/`46d204ee9`; use the more-restrictive license):
  ```
  git add src/sdk/hardened-options.ts src/services/worker/SDKAgent.ts src/services/worker/fresh-summarize.ts tests/security/observer-tool-enforcement.test.ts tests/worker/fresh-summarize.test.ts
  git commit -m "fix(security): real no-tools lockdown for observer + fresh-summarize SDK

  Centralize buildHardenedSdkOptions(): tools:[]+allowedTools:[]+disallowedTools+
  deny-all canUseTool+mcpServers:{}+settingSources:[]+strictMcpConfig+cwd jail,
  applied at both SDK query() call sites so the lockdown can't drift. NDJSON
  audit log skipped; canUseTool WARN-logs denials (component 'SYSTEM'). fresh-
  summarize no longer reads deps.disallowedTools (hardened list is a superset);
  updated the pass-through test accordingly. Smoke: observe cycle still produces
  observations.

  Upstream: thedotmack/claude-mem@ce13c887 (Apache-2.0)
  Upstream: thedotmack/claude-mem@703c64c7 (AGPL-3.0)
  Upstream: thedotmack/claude-mem@46d204ee9 (AGPL-3.0)
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 3: env-file-0600 — restrict `.env` to 0600 + dir 0700, extend to settings.json (AGPL `31ee1024c`)

**Why**: `~/.claude-mem/.env` (ANTHROPIC/GEMINI/OPENROUTER/OPENCODE keys) and `~/.claude-mem/settings.json` (the UI persists `CLAUDE_MEM_*_API_KEY` here via the `settingKeys` list at `SettingsRoutes.ts:79-90`, written at `SettingsRoutes.ts:136`) are written with no explicit mode → umask-dependent, world-readable under a permissive umask. `writeFileSync`'s `mode:` only applies on creation, so a `chmodSync` after write fixes pre-existing files. `chmodSync`/`mkdirSync mode` are no-ops on win32 (ACL-controlled) — safe.

**Sync note**: this repo syncs via git (no OneDrive in the loop), so there is no external-sync verification step to run — the 0600/0700 enforcement applies to the local on-disk file only, which is exactly the threat surface. (No "verify on OneDrive/sync workflow" step is needed here.)

**Scope note**: `SettingsRoutes.ts` has a second `writeFileSync(settingsPath, …)` at line 386 inside `ensureSettingsFile()`, which writes the *defaults* file on first creation (no API keys present at that point). Secrets only land via the line-136 path; chmodding there fixes the on-disk file to 0600 after any key write (incl. pre-existing files). The defaults-only path is intentionally left untouched — it never contains secrets.

**Files**
- Modify: `src/shared/EnvManager.ts` (import line 12; `saveClaudeMemEnv` dir-create lines 143-146 and write line 186)
- Modify: `src/services/worker/http/routes/SettingsRoutes.ts` (import line 10; write at line 136)
- Test: `tests/shared/env-manager-perms.test.ts` (new)

**Steps**
- [ ] Step 1 — Write failing test. Create `tests/shared/env-manager-perms.test.ts` (uses real tmpdir; NEVER `mock.module('fs')` per test conventions; NEVER write to `homedir()`/`~/.claude-mem`):
  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
  import { mkdtempSync, rmSync, writeFileSync, statSync, chmodSync, mkdirSync } from 'fs';
  import { join } from 'path';
  import { tmpdir } from 'os';

  // POSIX permission bits only matter off-win32.
  const isWin = process.platform === 'win32';

  describe('credential file permissions (0600 file / 0700 dir)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cm-perms-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it.skipIf(isWin)('writeFileSync mode 0o600 + chmodSync yields owner-only file', () => {
      // Mirrors the EnvManager.saveClaudeMemEnv write path exactly.
      const f = join(dir, '.env');
      writeFileSync(f, 'ANTHROPIC_API_KEY=secret\n', { encoding: 'utf-8', mode: 0o600 });
      chmodSync(f, 0o600);
      const mode = statSync(f).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it.skipIf(isWin)('mkdirSync mode 0o700 + chmodSync yields owner-only dir', () => {
      const d = join(dir, 'sub');
      mkdirSync(d, { recursive: true, mode: 0o700 });
      chmodSync(d, 0o700);
      const mode = statSync(d).mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });

  // Source-level guards: pin that the production writers actually set 0600/0700.
  // (The dynamic test above proves the OS honors the bits; these prove the code
  //  uses them, without writing to the real ~/.claude-mem.)
  import { readFileSync } from 'fs';
  describe('source guards: writers set restrictive permissions', () => {
    it('EnvManager imports chmodSync and chmods .env (0600) + dir (0700)', () => {
      const src = readFileSync(
        join(import.meta.dir, '../../src/shared/EnvManager.ts'),
        'utf-8',
      );
      expect(src).toMatch(/import\s*\{[^}]*chmodSync[^}]*\}\s*from\s*['"]fs['"]/);
      expect(src).toContain('mode: 0o700');
      expect(src).toContain('chmodSync(DATA_DIR, 0o700)');
      expect(src).toMatch(/mode:\s*0o600/);
      expect(src).toContain('chmodSync(ENV_FILE_PATH, 0o600)');
    });

    it('SettingsRoutes chmods settings.json to 0600 after write', () => {
      const src = readFileSync(
        join(import.meta.dir, '../../src/services/worker/http/routes/SettingsRoutes.ts'),
        'utf-8',
      );
      expect(src).toMatch(/import\s*\{[^}]*chmodSync[^}]*\}\s*from\s*['"]fs['"]/);
      expect(src).toMatch(/mode:\s*0o600/);
      expect(src).toContain('chmodSync(settingsPath, 0o600)');
    });
  });
  ```
- [ ] Step 2 — Run it, see it FAIL:
  ```
  bun test tests/shared/env-manager-perms.test.ts
  ```
  Expected: the dynamic tests pass (they inline the bits), but the two source-guard tests FAIL (`chmodSync` not imported in EnvManager / SettingsRoutes yet).
- [ ] Step 3 — Modify `src/shared/EnvManager.ts` import. OLD (line 12):
  ```typescript
  import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
  ```
  NEW:
  ```typescript
  import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
  ```
- [ ] Step 4 — Modify the directory creation in `saveClaudeMemEnv`. OLD (lines 143-146):
  ```typescript
      // Ensure directory exists
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
      }
  ```
  NEW:
  ```typescript
      // Ensure directory exists with restricted permissions (owner only).
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      }
      // The mkdirSync `mode` option only applies at creation time; if DATA_DIR
      // already exists, that mode param is silently ignored. chmodSync therefore
      // explicitly tightens pre-existing dirs. Do NOT remove it thinking
      // mkdirSync's mode covers the existing-dir case — it does not.
      // No-op on Windows (permissions are ACL-controlled, not POSIX).
      chmodSync(DATA_DIR, 0o700);
  ```
- [ ] Step 5 — Modify the file write in `saveClaudeMemEnv`. OLD (line 186):
  ```typescript
      writeFileSync(ENV_FILE_PATH, serializeEnvFile(updated), 'utf-8');
  ```
  NEW:
  ```typescript
      writeFileSync(ENV_FILE_PATH, serializeEnvFile(updated), { encoding: 'utf-8', mode: 0o600 });
      // writeFileSync's `mode` only applies when the file is newly created
      // (O_CREAT); for a pre-existing .env it is silently ignored, so chmodSync
      // explicitly fixes pre-existing files. Required — do not drop. No-op on
      // Windows (ACL-controlled).
      chmodSync(ENV_FILE_PATH, 0o600);
  ```
- [ ] Step 6 — Modify `src/services/worker/http/routes/SettingsRoutes.ts` import. OLD (line 10):
  ```typescript
  import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
  ```
  NEW:
  ```typescript
  import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
  ```
- [ ] Step 7 — Modify the settings.json write (the API-key writer). OLD (lines 135-136):
  ```typescript
      // Write back
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  ```
  NEW:
  ```typescript
      // Write back. settings.json holds CLAUDE_MEM_*_API_KEY values, so restrict
      // to owner-only (same policy as ~/.claude-mem/.env). The writeFileSync mode
      // only applies on creation; chmodSync fixes pre-existing files. No-op on
      // Windows (ACL-controlled).
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf-8', mode: 0o600 });
      chmodSync(settingsPath, 0o600);
  ```
- [ ] Step 8 — Run the test, see PASS:
  ```
  bun test tests/shared/env-manager-perms.test.ts
  ```
  Expected: all pass (dynamic + 2 source guards).
- [ ] Step 9 — Run neighboring EnvManager suites + build (no regression in load/save):
  ```
  bun test tests/shared/env-manager-blocklist.test.ts tests/shared/env-manager-opencode.test.ts
  npm run build
  ```
  Expected: all pass; build OK.
- [ ] Step 10 — Commit (AGPL-3.0):
  ```
  git add src/shared/EnvManager.ts src/services/worker/http/routes/SettingsRoutes.ts tests/shared/env-manager-perms.test.ts
  git commit -m "fix(security): restrict .env + settings.json to owner-only (0600/0700)

  API keys in ~/.claude-mem/.env and ~/.claude-mem/settings.json were written
  with umask-dependent mode (world-readable under permissive umask). Set dir
  0700 + file 0600 via mode option, plus chmodSync to fix pre-existing files.
  No-op on Windows (ACL-controlled). Extends upstream .env fix to the fork's
  settings.json key writer.

  Upstream: thedotmack/claude-mem@31ee1024c (AGPL-3.0)
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 4: strip system-reminder + persisted-output at the persistence edge (AGPL `a66b98bcd` + `f81684c61`, shared commit)

**Why**: `stripTagsInternal` (`src/utils/tag-stripping.ts`) is the central persistence-edge filter. It strips `<claude-mem-context>`, `<private>`, `<system_instruction>`, `<system-instruction>`, `<task-notification>` but NOT `<system-reminder>` (CLAUDE.md contents / deferred tool lists leak into observations) or `<persisted-output>` (bulky tool output bloats observations). Add both. Export `SYSTEM_REMINDER_REGEX` for reuse by transcript parsers. (Fork-specific: the fork already added `<task-notification>` which upstream does not have — the NEW blocks below preserve it and only APPEND the two new strips.)

**Convergence check (C2-F2 — verify all persistence paths funnel through `stripTagsInternal`)**: Before relying on this central filter, confirm every observation-write path actually calls one of the strip wrappers (`stripMemoryTagsFromJson` / `stripMemoryTagsFromPrompt`, both of which call `stripTagsInternal`). Verified at write-time of this plan:
  - Observation tool fields converge via `SessionRoutes.ts:819-820 cleanToolField()` → `observation-utils.ts:46 stripMemoryTagsFromJson()`.
  - Prompt content converges via `SessionRoutes.ts:1073 stripMemoryTagsFromPromptDetailed()`.
  - The summarize hook strips `last_assistant_message` at the edge (Task 5).
Add a static guard sub-step so a NEW bypass path (new middleware, direct SQL, async worker) is caught:
  ```
  # Every "raw content → observation/summary" boundary must be preceded by a strip.
  # Inspect each hit and confirm it flows through cleanToolField / a stripMemoryTags* wrapper.
  grep -rn "cleanToolField\|stripMemoryTagsFromJson\|stripMemoryTagsFromPrompt" src/services/worker/http/routes/
  grep -rn "INSERT INTO observations" src/services/sqlite/ | grep -vi "_fts\|observations_new"
  ```
  Expected: the SessionRoutes enqueue path (and only it) feeds untrusted content into the observation INSERTs, and it is already wrapped. If a new INSERT path appears that does NOT pass through a strip wrapper, STOP and route it through `cleanToolField` / `stripMemoryTagsFromJson` before persisting. (No code change required by this plan unless the grep reveals a new bypass — this is a regression guard, not a refactor.)

**Files**
- Modify: `src/utils/tag-stripping.ts` (add `SYSTEM_REMINDER_REGEX` export at the import block lines 14-21; `countTags` lines 27-34; `stripTagsInternal` lines 52-58)
- Test: `tests/utils/tag-stripping.test.ts` (append two describe blocks before the final `});` at line 335)

**Steps**
- [ ] Step 1 — Write failing tests. In `tests/utils/tag-stripping.test.ts`, insert BEFORE the closing `});` of the top-level `describe('Tag Stripping Utilities', …)` (currently line 335). Insert AFTER the `privacy enforcement integration` block (its `});` is line 334):
  ```typescript
    // NOTE (C2-F4): the tests below intentionally call BOTH stripMemoryTagsFromJson
    // and stripMemoryTagsFromPrompt on the same kinds of content. The two names
    // label the CALLER context (JSON-serialized payload vs. plain prompt text),
    // NOT a behavioral difference — both wrappers delegate to the identical
    // stripTagsInternal. Do not add divergent logic to one without the other.
    describe('system-reminder tag stripping', () => {
      it('should strip single <system-reminder> tag from prompt', () => {
        const input = 'user content <system-reminder>CLAUDE.md contents here</system-reminder> more content';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('user content  more content');
      });

      it('should strip <system-reminder> mixed with other tag types', () => {
        const input = '<system-reminder>reminder</system-reminder> public <private>secret</private> <claude-mem-context>ctx</claude-mem-context> end';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('public   end');
      });

      it('should return empty string for entirely <system-reminder> content', () => {
        const input = '<system-reminder>entire content is a system reminder</system-reminder>';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('');
      });

      it('should strip <system-reminder> tags from JSON content', () => {
        const jsonContent = JSON.stringify({
          data: '<system-reminder>injected reminder</system-reminder> real data'
        });
        const result = stripMemoryTagsFromJson(jsonContent);
        const parsed = JSON.parse(result);
        expect(parsed.data).toBe(' real data');
      });

      it('should strip multiline content within <system-reminder> tags', () => {
  // IMPORTANT: this template literal is FLUSH-LEFT (no indentation on the
  // <system-reminder>/inner/after lines) so the expected output is the
  // upstream form 'before\n\nafter'. Do NOT indent the inner lines — that
  // would leave leading whitespace after `before\n` and the expectation
  // would no longer match. The de-indentation here is intentional.
        const input = `before
<system-reminder>
Contents of /path/to/CLAUDE.md:

<claude-mem-context>
# Recent Activity
- Item 1
</claude-mem-context>
</system-reminder>
after`;
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('before\n\nafter');
      });

      it('exports SYSTEM_REMINDER_REGEX matching the tag', () => {
        const { SYSTEM_REMINDER_REGEX } = require('../../src/utils/tag-stripping.js');
        expect('<system-reminder>x</system-reminder>'.replace(SYSTEM_REMINDER_REGEX, '')).toBe('');
      });
    });

    describe('persisted-output tag stripping', () => {
      it('should strip <persisted-output> tags from prompt', () => {
        const input = 'public <persisted-output>large output</persisted-output> after';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('public  after');
      });

      it('should strip persisted-output tags from JSON', () => {
        const jsonContent = JSON.stringify({
          output: '<persisted-output>big output</persisted-output> keep'
        });
        const result = stripMemoryTagsFromJson(jsonContent);
        const parsed = JSON.parse(result);
        expect(parsed.output).toBe(' keep');
      });
    });
  ```
- [ ] Step 2 — Run it, see it FAIL:
  ```
  bun test tests/utils/tag-stripping.test.ts
  ```
  Expected: system-reminder + persisted-output tests fail (tags not stripped; `SYSTEM_REMINDER_REGEX` undefined).
- [ ] Step 3 — Add the exported regex. In `src/utils/tag-stripping.ts`, OLD (lines 14-21):
  ```typescript
  import { logger } from './logger.js';

  /**
   * Maximum number of tags allowed in a single content block
   * This protects against ReDoS (Regular Expression Denial of Service) attacks
   * where malicious input with many nested/unclosed tags could cause catastrophic backtracking
   */
  const MAX_TAG_COUNT = 100;
  ```
  NEW:
  ```typescript
  import { logger } from './logger.js';

  /**
   * Regex to match <system-reminder> tags and their content.
   *
   * @remarks Exported PURELY for reuse by transcript parsers that strip
   * system-reminder at read-time; it is an internal implementation detail of the
   * stripping module, not a stable public API. Treat as `@internal`. Carries the
   * `/g` flag — see the lastIndex caveat at the stripTagsInternal call site.
   */
  export const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

  /**
   * Maximum number of tags allowed in a single content block
   * This protects against ReDoS (Regular Expression Denial of Service) attacks
   * where malicious input with many nested/unclosed tags could cause catastrophic backtracking
   */
  const MAX_TAG_COUNT = 100;
  ```
- [ ] Step 4 — Extend `countTags`. OLD (lines 27-34):
  ```typescript
  function countTags(content: string): number {
    const privateCount = (content.match(/<private>/g) || []).length;
    const contextCount = (content.match(/<claude-mem-context>/g) || []).length;
    const sysInstructionCount = (content.match(/<system_instruction>/g) || []).length;
    const sysInstructionHyphenCount = (content.match(/<system-instruction>/g) || []).length;
    const taskNotificationCount = (content.match(/<task-notification>/g) || []).length;
    return privateCount + contextCount + sysInstructionCount + sysInstructionHyphenCount + taskNotificationCount;
  }
  ```
  NEW:
  ```typescript
  function countTags(content: string): number {
    const privateCount = (content.match(/<private>/g) || []).length;
    const contextCount = (content.match(/<claude-mem-context>/g) || []).length;
    const sysInstructionCount = (content.match(/<system_instruction>/g) || []).length;
    const sysInstructionHyphenCount = (content.match(/<system-instruction>/g) || []).length;
    const taskNotificationCount = (content.match(/<task-notification>/g) || []).length;
    const systemReminderCount = (content.match(/<system-reminder>/g) || []).length;
    const persistedOutputCount = (content.match(/<persisted-output>/g) || []).length;
    return privateCount + contextCount + sysInstructionCount + sysInstructionHyphenCount + taskNotificationCount + systemReminderCount + persistedOutputCount;
  }
  ```
- [ ] Step 5 — Extend `stripTagsInternal`. OLD (lines 52-58):
  ```typescript
    return content
      .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
      .replace(/<private>[\s\S]*?<\/private>/g, '')
      .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/g, '')
      .replace(/<system-instruction>[\s\S]*?<\/system-instruction>/g, '')
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      .trim();
  ```
  NEW:
  ```typescript
    return content
      .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
      .replace(/<private>[\s\S]*?<\/private>/g, '')
      .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/g, '')
      .replace(/<system-instruction>[\s\S]*?<\/system-instruction>/g, '')
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      .replace(SYSTEM_REMINDER_REGEX, '')
      .replace(/<persisted-output>[\s\S]*?<\/persisted-output>/g, '')
      .trim();
  ```
  Note: `SYSTEM_REMINDER_REGEX` carries the `/g` flag. Used here only with `String.replace` (which resets `lastIndex` to 0 after completion), so it is safe to share one module-level instance; do NOT reuse it with `.test()` anywhere without resetting `lastIndex`.
- [ ] Step 6 — Run the test, see PASS:
  ```
  bun test tests/utils/tag-stripping.test.ts
  ```
  Expected: all pass (existing + 8 new).
- [ ] Step 7 — Build (bundle/import):
  ```
  npm run build
  ```
  Expected: build OK.
- [ ] Step 8 — Commit (AGPL-3.0; shared commit for both strips):
  ```
  git add src/utils/tag-stripping.ts tests/utils/tag-stripping.test.ts
  git commit -m "fix(privacy): strip <system-reminder> and <persisted-output> at persistence edge

  <system-reminder> (CLAUDE.md contents, deferred tool lists) and
  <persisted-output> (bulky tool output) were persisted into observations.
  Add both to the central stripTagsInternal + countTags. Export
  SYSTEM_REMINDER_REGEX (internal) for transcript-parser reuse.

  Upstream: thedotmack/claude-mem@a66b98bcd (AGPL-3.0)
  Upstream: thedotmack/claude-mem@f81684c61 (AGPL-3.0)
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 5: strip privacy tags from `last_assistant_message` in the summarize hook (AGPL `46d204ee9`, cherry `bd68bfcc`)

**Why**: `extractLastMessage` (`src/shared/transcript-parser.ts:10`, signature `(transcriptPath, role, stripSystemReminders=false)`) strips `<system-reminder>` but NOT `<private>` — so a `<private>…</private>` block in the assistant's last message leaks into the summary. Prefer the hook edge (`src/cli/handlers/summarize.ts`) per the fork's edge-processing model — strip with `stripMemoryTagsFromPrompt` right after extraction, at both extraction sites (worker-down fallback path AND normal path).

**Scope note (observer path already covered; C2-F3)**: This task covers the *summarize* leak path (`last_assistant_message` → summary). The *observer* leak path is NOT in scope here and needs NO additional strip — observer input (`tool_input`/`tool_response`) is already stripped at the persistence edge (`SessionRoutes.ts:819-820 cleanToolField()` → `observation-utils.ts:46 stripMemoryTagsFromJson()`), so the observer is conditioned on already-stripped content. Per DECISIONS C2, do not add a second defensive strip on the observer SDK output.

**Caller check**: `extractLastMessage` is called at `summarize.ts:58-60` (fallback) and `summarize.ts:89` (normal). No signature change — we wrap the return value locally (it returns `string`, which `stripMemoryTagsFromPrompt(content: string)` accepts). No other caller affected.

**Files**
- Modify: `src/cli/handlers/summarize.ts` (import block lines 12-15; lines 56-66 fallback extraction; line 89 normal extraction)
- Test: `tests/cli/summarize-privacy-strip.test.ts` (new)

**Steps**
- [ ] Step 1 — Write failing test. Create `tests/cli/summarize-privacy-strip.test.ts` (source-level guard — avoids mocking the worker/transcript and process.exit; pins that the hook strips before enqueue):
  ```typescript
  import { describe, it, expect } from 'bun:test';
  import { readFileSync } from 'fs';
  import { join } from 'path';

  describe('summarize hook strips privacy tags from last_assistant_message', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../src/cli/handlers/summarize.ts'),
      'utf-8',
    );

    it('imports stripMemoryTagsFromPrompt', () => {
      expect(src).toMatch(/import\s*\{[^}]*stripMemoryTagsFromPrompt[^}]*\}\s*from\s*['"][^'"]*tag-stripping\.js['"]/);
    });

    it('wraps every extractLastMessage result with stripMemoryTagsFromPrompt', () => {
      // Both extraction sites (fallback + normal) must be wrapped — no raw
      // extractLastMessage assignment may flow into a fallback/summarize payload.
      const stripCount = (src.match(/stripMemoryTagsFromPrompt\(/g) || []).length;
      expect(stripCount).toBeGreaterThanOrEqual(2);
    });
  });

  // Behavioral unit test of the stripping primitive (proves the privacy contract
  // independent of the hook plumbing).
  import { stripMemoryTagsFromPrompt } from '../../src/utils/tag-stripping.js';
  describe('last_assistant_message privacy contract', () => {
    it('removes <private> blocks the transcript parser leaves intact', () => {
      const msg = 'I did the work. <private>secret token abc123</private> Done.';
      expect(stripMemoryTagsFromPrompt(msg)).toBe('I did the work.  Done.');
    });
  });
  ```
- [ ] Step 2 — Run it, see it FAIL:
  ```
  bun test tests/cli/summarize-privacy-strip.test.ts
  ```
  Expected: source-guard tests FAIL (`stripMemoryTagsFromPrompt` not imported / <2 calls); the behavioral test passes (primitive already works).
- [ ] Step 3 — Add import. In `src/cli/handlers/summarize.ts`, OLD (lines 12-15):
  ```typescript
  import { extractLastMessage } from '../../shared/transcript-parser.js';
  import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';
  import { resolveProjectContext } from '../../shared/project-allowlist.js';
  import { writeFallbackEntry } from '../../shared/fallback-queue.js';
  ```
  NEW:
  ```typescript
  import { extractLastMessage } from '../../shared/transcript-parser.js';
  import { stripMemoryTagsFromPrompt } from '../../utils/tag-stripping.js';
  import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';
  import { resolveProjectContext } from '../../shared/project-allowlist.js';
  import { writeFallbackEntry } from '../../shared/fallback-queue.js';
  ```
- [ ] Step 4 — Strip in the worker-down fallback path. OLD (lines 56-66):
  ```typescript
        const ctx = input._projectContext ?? resolveProjectContext(input.cwd);
        if (ctx) {
          const lastAssistantMessage = input.transcriptPath
            ? extractLastMessage(input.transcriptPath, 'assistant', true)
            : '';
          writeFallbackEntry({
            type: 'summarize', sessionId: input.sessionId, cwd: input.cwd, dbPath: ctx.dbPath,
            timestamp: Date.now(),
            payload: { last_assistant_message: lastAssistantMessage }
          });
        }
  ```
  NEW:
  ```typescript
        const ctx = input._projectContext ?? resolveProjectContext(input.cwd);
        if (ctx) {
          // Strip privacy tags (<private> etc.) — the transcript parser only
          // removes <system-reminder>, so <private> would otherwise reach the summary.
          const lastAssistantMessage = stripMemoryTagsFromPrompt(
            input.transcriptPath
              ? extractLastMessage(input.transcriptPath, 'assistant', true)
              : ''
          );
          writeFallbackEntry({
            type: 'summarize', sessionId: input.sessionId, cwd: input.cwd, dbPath: ctx.dbPath,
            timestamp: Date.now(),
            payload: { last_assistant_message: lastAssistantMessage }
          });
        }
  ```
- [ ] Step 5 — Strip in the normal path. OLD (line 89):
  ```typescript
      const lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
  ```
  NEW:
  ```typescript
      // Strip privacy tags before this value flows into the summarize POST / fallback.
      // extractLastMessage only removes <system-reminder>; <private> must be stripped here.
      const lastAssistantMessage = stripMemoryTagsFromPrompt(
        extractLastMessage(transcriptPath, 'assistant', true)
      );
  ```
  Note: `lastAssistantMessage` is reused at lines 105, 120, 141, 152 (POST body + fallback payloads) — all now receive the stripped value. No further edits needed.
- [ ] Step 6 — Run the test, see PASS:
  ```
  bun test tests/cli/summarize-privacy-strip.test.ts
  ```
  Expected: all pass (2 source guards + 1 behavioral).
- [ ] Step 7 — Run hook suites + build:
  ```
  bun test tests/hooks/ tests/cli/
  npm run build
  ```
  Expected: all pass; build OK.
- [ ] Step 8 — Commit (AGPL-3.0):
  ```
  git add src/cli/handlers/summarize.ts tests/cli/summarize-privacy-strip.test.ts
  git commit -m "fix(privacy): strip privacy tags from last_assistant_message in summarize hook

  extractLastMessage only removes <system-reminder>, so <private> blocks in the
  assistant's last message leaked into summaries. Strip via stripMemoryTagsFromPrompt
  at both hook extraction sites (worker-down fallback + normal path) — the fork's
  edge-processing model.

  Upstream: thedotmack/claude-mem@46d204ee9 (AGPL-3.0)
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 6: block effort env vars from SDK subprocesses (Apache `9c56dda79`)

**Why**: The fork intentionally does NOT block the `CLAUDE_CODE_*` prefix (ENTRYPOINT/OAUTH are needed). But `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` from the parent shell get forwarded by the SDK as the Messages API `effort` param; models without effort support (Haiku 4.5, Sonnet 4.5) reject with a permanent HTTP 400 that retries forever. Add both to `BLOCKED_ENV_VARS`. Verified safe: `CLAUDE_CODE_ENTRYPOINT` is set at `EnvManager.ts:220` (outside the `includeCredentials` block, so set even when `buildIsolatedEnv(false)`) and `CLAUDE_CODE_OAUTH_TOKEN` at `:247-249` — both AFTER the filter loop (lines 212-217), so the exact-match block does not touch them.

**Caller check**: change is to the `BLOCKED_ENV_VARS` array constant only — no signature change, no caller impact.

**Files**
- Modify: `src/shared/EnvManager.ts` (`BLOCKED_ENV_VARS`, lines 28-33)
- Test: `tests/shared/env-manager-blocklist.test.ts` (extend existing)

**Steps**
- [ ] Step 1 — Add failing assertions to the existing test. In `tests/shared/env-manager-blocklist.test.ts`, extend the `testVars` array (lines 6-11):
  OLD:
  ```typescript
    const testVars = [
      'CLAUDECODE_INTEROP_PORT',
      'CLAUDECODE_SESSION_KEY',
      'CLAUDE_CODE_SESSION',
      'MCP_SESSION_ID',
    ];
  ```
  NEW:
  ```typescript
    const testVars = [
      'CLAUDECODE_INTEROP_PORT',
      'CLAUDECODE_SESSION_KEY',
      'CLAUDE_CODE_SESSION',
      'MCP_SESSION_ID',
      'CLAUDE_CODE_EFFORT_LEVEL',
      'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
    ];
  ```
  And add a new `it` block after the `still blocks CLAUDECODE exact match` test (its closing `});` is line 56). (NOTE: an existing test at line 46 already asserts `CLAUDE_CODE_ENTRYPOINT === 'sdk-ts'`; the second `it` below intentionally re-asserts it in the context of the effort block to document that adding the effort vars does NOT disturb ENTRYPOINT. If you consider it redundant, the first `it` alone is sufficient.):
  ```typescript
    it('blocks CLAUDE_CODE_EFFORT_LEVEL and CLAUDE_CODE_ALWAYS_ENABLE_EFFORT (#2357)', () => {
      const env = buildIsolatedEnv(false);
      expect(env).not.toHaveProperty('CLAUDE_CODE_EFFORT_LEVEL');
      expect(env).not.toHaveProperty('CLAUDE_CODE_ALWAYS_ENABLE_EFFORT');
    });

    it('still preserves CLAUDE_CODE_ENTRYPOINT despite effort block (set after filter)', () => {
      const env = buildIsolatedEnv(false);
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
    });
  ```
- [ ] Step 2 — Run it, see it FAIL:
  ```
  bun test tests/shared/env-manager-blocklist.test.ts
  ```
  Expected: the effort-block test FAILS (`CLAUDE_CODE_EFFORT_LEVEL` still present — not in `BLOCKED_ENV_VARS`).
- [ ] Step 3 — Add the two vars. In `src/shared/EnvManager.ts`, OLD (lines 28-33):
  ```typescript
  const BLOCKED_ENV_VARS = [
    'ANTHROPIC_API_KEY',  // Issue #733: Prevent auto-discovery from project .env files
    'CLAUDECODE',         // Prevent "cannot be launched inside another Claude Code session" error
    'CLAUDE_CODE_SESSION',  // Prevent nested session detection in child processes
    'MCP_SESSION_ID',       // Prevent MCP session ID inheritance
  ];
  ```
  NEW:
  ```typescript
  const BLOCKED_ENV_VARS = [
    'ANTHROPIC_API_KEY',  // Issue #733: Prevent auto-discovery from project .env files
    'CLAUDECODE',         // Prevent "cannot be launched inside another Claude Code session" error
    'CLAUDE_CODE_SESSION',  // Prevent nested session detection in child processes
    'MCP_SESSION_ID',       // Prevent MCP session ID inheritance
    // Issue #2357: parent-shell effort config forwarded by the SDK as the
    // Messages API `effort` param; models without effort support (Haiku 4.5,
    // Sonnet 4.5) reject with a permanent HTTP 400 that retries forever.
    // Safe because ENTRYPOINT/OAUTH are set explicitly AFTER the filter loop.
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  ];
  ```
- [ ] Step 4 — Run the test, see PASS:
  ```
  bun test tests/shared/env-manager-blocklist.test.ts
  ```
  Expected: all pass (existing + 2 new).
- [ ] Step 5 — Build:
  ```
  npm run build
  ```
  Expected: build OK.
- [ ] Step 6 — Commit (Apache-2.0):
  ```
  git add src/shared/EnvManager.ts tests/shared/env-manager-blocklist.test.ts
  git commit -m "fix(env): block CLAUDE_CODE_EFFORT_LEVEL/ALWAYS_ENABLE_EFFORT from SDK subprocess

  Parent-shell effort vars were forwarded by the SDK as the Messages API effort
  param; models without effort support (Haiku 4.5, Sonnet 4.5) reject with a
  permanent HTTP 400 that retried forever. Add both to BLOCKED_ENV_VARS.
  ENTRYPOINT/OAUTH unaffected (set after the filter loop).

  Upstream: thedotmack/claude-mem@9c56dda79 (Apache-2.0)
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

> Final chunk verification (after all 6 tasks): run the root-test command from the Tech Stack section and confirm 0 fail (implementation-day baseline + the new tests added here; Task 2 updates — not adds — one existing fresh-summarize test, so the net count rises by the new files only), then `npm run build-and-sync` to deploy and restart the worker for the Task 2 observe smoke check. Commit order in this chunk is the deploy order: Task 1 (probe) → Task 2 (lockdown) → Task 3 (perms) → Task 4 (tag strips) → Task 5 (summarize strip) → Task 6 (effort vars).


---

## Chunk 3: P1 worker 生命周期 (worker-lifecycle)

> All upstream hashes in this chunk are **AGPL-3.0** (verified: `git -C <clone> merge-base --is-ancestor 36b0929f <hash>` returns non-zero for every hash — none is an ancestor of the v13.0.0 relicense commit 36b0929f).
> No DB migration in this chunk — schema stays v33. `sdk_sessions.started_at_epoch` already exists (migrations.ts:224).
> Heads-up: `sdk_sessions` also has `started_at TEXT NOT NULL` (migrations.ts:223) with no default — any direct test INSERT must supply it.
> Heads-up (epoch units): `sdk_sessions.started_at_epoch` is written in **milliseconds** since epoch (`new Date().getTime()` at SessionStore.ts:1559-1564 manual-session INSERT; verify with `grep -n "started_at_epoch" src/services/sqlite/SessionStore.ts`). `session.startTime` is also milliseconds (`Date.now()` at SessionManager.ts:263). Task 7's age math (`Date.now() - sessionOriginMs`) therefore needs **no unit conversion** — both operands are ms. Confirm at write-time before inserting the guard.
> Heads-up: `src/shared/CLAUDE.md` prose says "56 unique settings"; Task 7 adds one (→57). Doc-only drift, no test pins the count — update the prose opportunistically, not required for green.
> Build/test commands: test = `bun test <path>`, full build = `npm run build-and-sync`, type/bundle-only = `npm run build`.

---

### Task 1: atomic isPortInUse (socket-bind) — eliminate TOCTOU spawn race

Upstream `64cce2bf` (AGPL-3.0). Replaces the HTTP `/api/health` check with an atomic `net.createServer().listen()` that resolves `true` only on `EADDRINUSE`. Windows keeps the HTTP fallback (socket-bind semantics differ). The existing fork test mocks `global.fetch` for `isPortInUse`/`waitForPortFree`; those mocks no longer drive the non-win32 path, so this task also rewrites the affected test cases to bind a real port.

**Files**
- Modify: `src/services/infrastructure/HealthMonitor.ts` (import block lines 12-15; `isPortInUse` JSDoc+body lines 17-29)
- Modify: `tests/infrastructure/health-monitor.test.ts` (`isPortInUse` describe lines 17-58; `waitForPortFree` describe lines 186-251 — 4 cases, all mock `global.fetch`)

Steps:

- [ ] **Step 1 — Write failing test (real port bind).** In `tests/infrastructure/health-monitor.test.ts`, replace the entire `describe('isPortInUse', ...)` block (lines 17-58) with a real-socket test. First add `import net from 'net';` after line 1. Then (the whole describe is wrapped in a `process.platform !== 'win32'` guard so it self-skips on Windows CI — the atomic socket-bind path is POSIX-only; the win32 HTTP fallback is exercised in production, not unit-tested here):
  ```typescript
  // Atomic socket-bind isPortInUse is POSIX-only; skip on Windows CI where the
  // HTTP fallback (not socket bind) is the live path.
  if (process.platform !== 'win32') {
    describe('isPortInUse', () => {
      it('returns true when a port is actually bound (EADDRINUSE)', async () => {
        const server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const port = (server.address() as net.AddressInfo).port;
        try {
          const result = await isPortInUse(port);
          expect(result).toBe(true);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });

      it('returns false for a free port (listen succeeds)', async () => {
        // Grab a free port by binding+closing, then probe it.
        const probe = net.createServer();
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
        const port = (probe.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        const result = await isPortInUse(port);
        expect(result).toBe(false);
      });
    });
  }
  ```
  > Note: this test exercises the non-win32 atomic-bind path on the macOS dev machine. The `if (process.platform !== 'win32')` wrapper means the cases simply do not register on Windows (matches the fork's existing platform-gated approach — `bun:test` has no skip-decorator, so a conditional `describe` is the portable form).

- [ ] **Step 2 — Run it, see RED.** `bun test tests/infrastructure/health-monitor.test.ts`
  Expected: the new `isPortInUse` cases FAIL — current impl `fetch()`-es `http://127.0.0.1:<port>/api/health`; a raw `net` server returns no HTTP, so `fetch` rejects → `isPortInUse` returns `false` for the bound-port case (expected `true`). FAIL with `expect(received).toBe(expected) // true`.

- [ ] **Step 3 — Add `net` import.** In `src/services/infrastructure/HealthMonitor.ts`, OLD (lines 12-15):
  ```typescript
  import path from 'path';
  import { readFileSync } from 'fs';
  import { logger } from '../../utils/logger.js';
  import { MARKETPLACE_ROOT } from '../../shared/paths.js';
  ```
  NEW:
  ```typescript
  import path from 'path';
  import net from 'net';
  import { readFileSync } from 'fs';
  import { logger } from '../../utils/logger.js';
  import { MARKETPLACE_ROOT } from '../../shared/paths.js';
  ```

- [ ] **Step 4 — Rewrite `isPortInUse`.** OLD (lines 17-29):
  ```typescript
  /**
   * Check if a port is in use by querying the health endpoint
   */
  export async function isPortInUse(port: number): Promise<boolean> {
    try {
      // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok;
    } catch (error) {
      // [ANTI-PATTERN IGNORED]: Health check polls every 500ms, logging would flood
      return false;
    }
  }
  ```
  NEW:
  ```typescript
  /**
   * Check if a port is in use by attempting an atomic socket bind.
   * More reliable than an HTTP health check for daemon spawn guards —
   * prevents the TOCTOU race where two daemons both see "port free" via
   * HTTP and then both call listen() (#1566).
   *
   * Windows keeps the HTTP fallback: socket-bind semantics differ
   * (SO_REUSEADDR defaults, firewall prompts) and would cause false
   * positives or UAC popups.
   */
  export async function isPortInUse(port: number): Promise<boolean> {
    if (process.platform === 'win32') {
      // APPROVED OVERRIDE: Windows keeps the HTTP health check. The TOCTOU
      // race remains on Windows but is an accepted limitation.
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        return response.ok;
      } catch {
        return false;
      }
    }

    // Unix: atomic socket bind check — no TOCTOU race
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true);
        } else {
          resolve(false);
        }
      });
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      server.listen(port, '127.0.0.1');
    });
  }
  ```

- [ ] **Step 5 — Update `waitForPortFree` test cases that mocked fetch.** In `tests/infrastructure/health-monitor.test.ts`, the `describe('waitForPortFree', ...)` block (lines 186-251) has **four** cases, ALL of which mock `global.fetch` (confirmed at write-time):
  1. line 187 `'should return true immediately when port is already free'`
  2. line 199 `'should timeout when port remains occupied'`
  3. line 212 `'should succeed when port becomes free'` — counts fetch calls (`callCount`), so it is **fetch-coupled and MUST be DELETED** (the atomic-bind path makes the fetch mock dead; there is no portable way to flip a real bound socket to free mid-poll deterministically).
  4. line 229 `'should use default timeout when not specified'` — mocks fetch but only asserts a quick `true` for a free port; **keep it but remove the now-dead `global.fetch = mock(...)` line** (free port 39999 returns `true` naturally on the atomic path).

  Replace cases 1 and 2 with real-socket equivalents:
  ```typescript
  it('returns true immediately when port is already free', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const start = Date.now();
    const result = await waitForPortFree(port, 5000);
    expect(result).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('times out while the port stays occupied', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const start = Date.now();
      const result = await waitForPortFree(port, 1500);
      expect(result).toBe(false);
      expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  ```
  Then DELETE case 3 entirely, and from case 4 delete only its `global.fetch = mock(...)` line (the body's `waitForPortFree(39999)` + `expect(result).toBe(true)` still passes against a free port on the atomic path). Finally `grep -n "global.fetch" tests/infrastructure/health-monitor.test.ts` to confirm no `global.fetch` reference remains inside the `isPortInUse`/`waitForPortFree` describes; remove any dead mock the two rewrites left behind.

- [ ] **Step 6 — Run it, see GREEN.** `bun test tests/infrastructure/health-monitor.test.ts`
  Expected: all `isPortInUse` and `waitForPortFree` cases PASS. `0 fail`.

- [ ] **Step 7 — Full suite + build (no regression elsewhere depends on fetch-based isPortInUse).** Run the root-test command from the Tech Stack section, then `npm run build`.
  Expected: root tests 0 fail; `npm run build` exits 0 with no esbuild resolution/syntax errors.

- [ ] **Step 8 — Commit.**
  ```
  git commit -am "fix(health): atomic socket-bind isPortInUse to kill TOCTOU spawn race

  Replace HTTP /api/health probe with net.createServer().listen() on POSIX,
  resolving true only on EADDRINUSE. Windows keeps the HTTP fallback. Updates
  the health-monitor tests to bind a real port instead of mocking fetch.

  Upstream: thedotmack/claude-mem@64cce2bf (AGPL-3.0)"
  ```

---

### Task 2: port-race graceful exit — suppress false ERROR when duplicate daemon loses bind race

Upstream `08cf2ba3` (AGPL-3.0). In `main()`'s `worker.start().catch`, detect `EADDRINUSE`/"port in use"/"address in use"; if `waitForHealth(port)` confirms the winner is healthy, log INFO and `process.exit(0)` instead of `logger.failure`. Ships an upstream source-inspection test, adapted to fork paths.

**Files**
- Modify: `src/services/worker-service.ts` (`worker.start().catch` at line 1766; `port` is in scope from `const port = getWorkerPort()` at line 1572; `waitForHealth` imported at line 95)

> Scope confidence (verified at write-time): `const port = getWorkerPort()` (line 1572) and `worker.start().catch(...)` (line 1766) are BOTH inside the same `async function main()` (declared at line 1562). No intervening function boundary shadows `port`, so it is directly in scope at the catch handler — no `const port = getWorkerPort()` redeclaration is needed inside the catch.
- Create: `tests/services/worker-daemon-port-race.test.ts`

Steps:

- [ ] **Step 1 — Add upstream's source-inspection test (fork path).** Create `tests/services/worker-daemon-port-race.test.ts`:
  ```typescript
  import { describe, it, expect } from 'bun:test';
  import { readFileSync } from 'fs';
  import { join } from 'path';

  /**
   * Source-inspection tests for the worker startup port race (#1447).
   * When the MCP server and SessionStart hook both spawn a daemon concurrently,
   * the loser of the bind race must verify the winner is healthy and exit cleanly
   * instead of logging an ERROR. The race is non-deterministic, so we pin the guard
   * shape in source.
   */
  const WORKER_SERVICE_PATH = join(import.meta.dir, '../../src/services/worker-service.ts');
  const source = readFileSync(WORKER_SERVICE_PATH, 'utf-8');

  describe('Worker daemon port-race guard (#1447)', () => {
    it('detects EADDRINUSE in the port-conflict check', () => {
      expect(source).toContain("code === 'EADDRINUSE'");
    });

    it('detects the port-in-use message via regex', () => {
      expect(source).toContain('/port.*in use|address.*in use/i.test(error.message)');
    });

    it('calls waitForHealth before exiting on a port conflict', () => {
      expect(source).toContain('isPortConflict && await waitForHealth(port,');
    });

    it('uses an async catch handler so it can await the health check', () => {
      expect(source).toContain('worker.start().catch(async (error) =>');
    });

    it('logs info (not failure) on the clean exit path', () => {
      expect(source).toContain("logger.info('SYSTEM', 'Duplicate daemon exiting");
    });
  });
  ```

- [ ] **Step 2 — Run it, see RED.** `bun test tests/services/worker-daemon-port-race.test.ts`
  Expected: all 5 cases FAIL — current source has `worker.start().catch((error) =>` (not async) and no EADDRINUSE branch.

- [ ] **Step 3 — Add the port-conflict branch.** In `src/services/worker-service.ts`, OLD (lines 1765-1772):
  ```typescript
        const worker = new WorkerService();
        worker.start().catch((error) => {
          logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
          removePidFile();
          // Exit gracefully: Windows Terminal won't keep tab open on exit 0
          // The wrapper/plugin will handle restart logic if needed
          process.exit(0);
        });
  ```
  NEW (the `async` on the catch handler is **CRITICAL** — the port-conflict branch `await`s `waitForHealth(port, 3000)`; without `async` the `await` is a syntax error and the build fails):
  ```typescript
        const worker = new WorkerService();
        worker.start().catch(async (error) => {
          // Port race: when the MCP server and SessionStart hook both spawn a daemon
          // concurrently, one loses the bind race with EADDRINUSE or Bun's equivalent
          // "port in use" error. If the winner is already healthy, exit cleanly (#1447).
          const isPortConflict = error instanceof Error && (
            (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ||
            /port.*in use|address.*in use/i.test(error.message)
          );
          if (isPortConflict && await waitForHealth(port, 3000)) {
            logger.info('SYSTEM', 'Duplicate daemon exiting — another worker already claimed port', { port });
            process.exit(0);
          }
          logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
          removePidFile();
          // Exit gracefully: Windows Terminal won't keep tab open on exit 0
          // The wrapper/plugin will handle restart logic if needed
          process.exit(0);
        });
  ```

- [ ] **Step 4 — Run it, see GREEN.** `bun test tests/services/worker-daemon-port-race.test.ts`
  Expected: 5 pass, 0 fail.

- [ ] **Step 5 — Build check.** `npm run build`
  Expected: exits 0, no esbuild resolution/syntax errors (`port` and `waitForHealth` already in scope — verified at worker-service.ts:1572 (`const port = getWorkerPort()`, same `main()` scope) and import line 95; the `async` keyword is required for the `await` inside the catch).

- [ ] **Step 6 — Commit.**
  ```
  git commit -am "fix(worker): exit cleanly when a duplicate daemon loses the port bind race

  In main()'s start().catch, detect EADDRINUSE / 'port in use' / 'address in use'
  and, if the winner is healthy, log INFO + exit(0) instead of logger.failure.
  Stops the misleading ERROR on every first session start.

  Upstream: thedotmack/claude-mem@08cf2ba3 (AGPL-3.0)"
  ```

---

### Task 3: aggressiveStartupCleanup must protect parent hook PID + PID-file worker PID

Upstream `88b47f9e` fix 2 (AGPL-3.0). Build `protectedPids = {currentPid, process.ppid, readPidFile().pid}` and skip them in BOTH kill loops. Today only `currentPid` is excluded (Windows line 476, POSIX line 519). `readPidFile()` already exists (ProcessManager.ts:142, returns `PidInfo | null` = `{pid, port, startedAt}` or `null`). Upstream ships no test → add a focused source-inspection test (matches fork conventions for source-shape guards).

**Files**
- Modify: `src/services/infrastructure/ProcessManager.ts` (`aggressiveStartupCleanup` head lines 448-453, then `try` at 454; guards at 476 (Windows) and 519 (POSIX))
- Modify: `tests/infrastructure/process-manager.test.ts` (add a new describe block)

> Imports note: this test file imports `import * as fs from 'fs'` (line 2) and `import path from 'path'` (line 4) — it does NOT import bare `readFileSync`/`join`. The test below therefore uses `fs.readFileSync` and `path.join` to match existing file conventions, so NO new imports are added.
> readPidFile null-safety note: `readPidFile()` returns `PidInfo | null` (verified at ProcessManager.ts:142). The production edit in Step 3 guards with optional chaining (`if (pidFileInfo?.pid && pidFileInfo.pid > 0)`), so a missing/corrupt PID file (null return) is safe — `pidFileInfo.pid` is never dereferenced on null. The Step-1 test only string-matches `protectedPids.add(pidFileInfo.pid);` against source, so it does not execute the null path.

Steps:

- [ ] **Step 1 — Add a failing source-inspection test.** In `tests/infrastructure/process-manager.test.ts`, add a new describe block near the file end, just before the final closing `});` of the top-level `describe('ProcessManager', ...)`:
  ```typescript
  describe('aggressiveStartupCleanup protected PIDs (#1426)', () => {
    const SOURCE = fs.readFileSync(
      path.join(import.meta.dir, '../../src/services/infrastructure/ProcessManager.ts'),
      'utf-8'
    );

    it('builds a protectedPids set seeded with currentPid', () => {
      expect(SOURCE).toContain('const protectedPids = new Set<number>([currentPid]);');
    });

    it('adds process.ppid to protectedPids', () => {
      expect(SOURCE).toContain('protectedPids.add(process.ppid);');
    });

    it('adds the PID-file worker PID to protectedPids', () => {
      expect(SOURCE).toContain('protectedPids.add(pidFileInfo.pid);');
    });

    it('skips protected PIDs in both kill loops', () => {
      const occurrences = SOURCE.split('protectedPids.has(pid)').length - 1;
      expect(occurrences).toBe(2); // Windows loop + POSIX loop
    });
  });
  ```

- [ ] **Step 2 — Run it, see RED.** `bun test tests/infrastructure/process-manager.test.ts`
  Expected: the 4 new cases FAIL — source has no `protectedPids` and uses `pid === currentPid` (so `protectedPids.has(pid)` count is 0, not 2). RED is guaranteed: a fresh `grep -n "protectedPids\|readPidFile" src/services/infrastructure/ProcessManager.ts` shows `readPidFile` defined at line 142 but NOT called inside `aggressiveStartupCleanup` (lines 448+), confirming the source lacks the new wiring before Step 3.

- [ ] **Step 3 — Build the protectedPids set.** OLD (lines 448-453, the function head up to but not including the `try` at line 454):
  ```typescript
  export async function aggressiveStartupCleanup(): Promise<void> {
    const isWindows = process.platform === 'win32';
    const currentPid = process.pid;
    const pidsToKill: number[] = [];
    const allPatterns = [...AGGRESSIVE_CLEANUP_PATTERNS, ...AGE_GATED_CLEANUP_PATTERNS];

    try {
  ```
  NEW:
  ```typescript
  export async function aggressiveStartupCleanup(): Promise<void> {
    const isWindows = process.platform === 'win32';
    const currentPid = process.pid;
    const pidsToKill: number[] = [];
    const allPatterns = [...AGGRESSIVE_CLEANUP_PATTERNS, ...AGE_GATED_CLEANUP_PATTERNS];

    // Protect the parent process (the hook that spawned us) and the PID-file-registered
    // worker from being killed. Without this, a new daemon SIGKILLs its own parent hook
    // process (#1426) and any already-running worker the PID file points to.
    const protectedPids = new Set<number>([currentPid]);
    if (process.ppid && process.ppid > 0) {
      protectedPids.add(process.ppid);
    }
    const pidFileInfo = readPidFile();
    if (pidFileInfo?.pid && pidFileInfo.pid > 0) {
      protectedPids.add(pidFileInfo.pid);
    }

    try {
  ```

- [ ] **Step 4 — Swap the Windows-loop guard.** This insertion shifts every later line down by ~14 lines, so the Windows guard originally at line 476 is now near line 490. Do NOT trust the absolute line number after Step 3 — instead `grep -n "pid === currentPid" src/services/infrastructure/ProcessManager.ts` (there are exactly TWO occurrences). The FIRST occurrence is the Windows guard (inside `for (const proc of processList)`). OLD:
  ```typescript
          if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;
  ```
  NEW:
  ```typescript
          if (!Number.isInteger(pid) || pid <= 0 || protectedPids.has(pid)) continue;
  ```
  > This is the guard inside the `for (const proc of processList)` loop (Windows branch).

- [ ] **Step 5 — Swap the POSIX-loop guard.** After Step 4, re-run `grep -n "pid === currentPid" src/services/infrastructure/ProcessManager.ts` — exactly ONE occurrence now remains (the POSIX guard inside `for (const line of lines)`), making this unambiguous. OLD:
  ```typescript
          if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;
  ```
  NEW:
  ```typescript
          if (!Number.isInteger(pid) || pid <= 0 || protectedPids.has(pid)) continue;
  ```
  > This is the guard inside the `for (const line of lines)` loop (Unix branch). Both guard lines are textually identical before edits, so always operate on the single remaining `pid === currentPid` after Step 4.

- [ ] **Step 6 — Run it, see GREEN.** `bun test tests/infrastructure/process-manager.test.ts`
  Expected: all cases pass; new block reports 4 pass.

- [ ] **Step 7 — Build check.** `npm run build`
  Expected: exits 0, no esbuild resolution/syntax errors.

- [ ] **Step 8 — Commit.**
  ```
  git commit -am "fix(process): protect parent hook + PID-file worker in aggressiveStartupCleanup

  Build protectedPids {currentPid, process.ppid, readPidFile().pid} and skip them
  in both kill loops, so a freshly spawned daemon no longer SIGKILLs the hook that
  spawned it or the already-running worker the PID file points to.

  Upstream: thedotmack/claude-mem@88b47f9e (AGPL-3.0)"
  ```

---

### Task 4: POST_SPAWN_WAIT 5s -> 15s for macOS ARM64 cold starts with Chroma

Upstream `88b47f9e` fix 3 (AGPL-3.0). Trivial constant change. The post-spawn health wait uses `getPlatformTimeout(HOOK_TIMEOUTS.POST_SPAWN_WAIT)`; `getPlatformTimeout` only scales (win32-only multiplier) on Windows, giving macOS no headroom. A test at `tests/hook-constants.test.ts:35-37` asserts `5000` and MUST be updated.

**Files**
- Modify: `src/shared/hook-constants.ts` (line 4)
- Modify: `tests/hook-constants.test.ts` (lines 35-37)

Steps:

- [ ] **Step 1 — Update the assertion (RED-first).** In `tests/hook-constants.test.ts`, OLD (lines 35-37):
  ```typescript
      it('should define POST_SPAWN_WAIT as 5s', () => {
        expect(HOOK_TIMEOUTS.POST_SPAWN_WAIT).toBe(5000);
      });
  ```
  NEW:
  ```typescript
      it('should define POST_SPAWN_WAIT as 15s (macOS cold-start headroom)', () => {
        expect(HOOK_TIMEOUTS.POST_SPAWN_WAIT).toBe(15000);
      });
  ```

- [ ] **Step 2 — Run it, see RED.** `bun test tests/hook-constants.test.ts`
  Expected: this case FAILS — source still has `POST_SPAWN_WAIT: 5000`. `expect(5000).toBe(15000)`.

- [ ] **Step 3 — Bump the constant.** In `src/shared/hook-constants.ts`, OLD (line 4):
  ```typescript
    POST_SPAWN_WAIT: 5000,      // Wait for daemon to start after spawn (starts in <1s on Linux)
  ```
  NEW:
  ```typescript
    POST_SPAWN_WAIT: 15000,     // Wait for daemon to start after spawn (starts in <1s on Linux, 6-8s on macOS with Chroma)
  ```

- [ ] **Step 4 — Run it, see GREEN.** `bun test tests/hook-constants.test.ts`
  Expected: all cases pass, `0 fail`.

- [ ] **Step 5 — Grep for any other 5000 dependency + type check.** Two greps:
  1. `grep -rn "POST_SPAWN_WAIT" src tests` — list every consumer. Expected EXACT set (verified at write-time): the constant def (`src/shared/hook-constants.ts:4`), two consumers `getPlatformTimeout(HOOK_TIMEOUTS.POST_SPAWN_WAIT)` at `src/services/worker-service.ts:1536` and `:1630`, and the one test assertion in `tests/hook-constants.test.ts`. Nothing else references the symbol.
  2. `grep -rn '\b5000\b' tests/ | grep -v node_modules | grep -v POST_SPAWN_WAIT` — find any OTHER test that hardcodes a 5000 spawn-wait. Expected: only unrelated `5000` literals (BypassLane `cooldownMs`, markdown-formatter token totals, logger `timeout: 5000`, sqlite epoch fixtures) — NONE is a spawn-wait pin, so no further test edits needed.

  Then `npm run build` — exits 0.

- [ ] **Step 6 — Commit.**
  ```
  git commit -am "fix(hooks): raise POST_SPAWN_WAIT 5s -> 15s for macOS ARM64 cold starts

  5s was sized for Linux (<1s startup); macOS cold starts take 6-8s with Chroma,
  so the post-spawn health wait falsely declared spawn failure and removed the
  PID file. Updates the constant test accordingly.

  Upstream: thedotmack/claude-mem@88b47f9e (AGPL-3.0)"
  ```

---

### Task 5: context-overflow reset — clear memorySessionId + forceInit before abort

Upstream `703c64c7` (AGPL-3.0). In the context-overflow branch (SDKAgent.ts:363-374), before aborting, force a fresh SDK session on the next spawn so crash-recovery can drain remaining pending messages instead of re-resuming the poisoned context forever. Fork already has `forceInit` resume-skip semantics (`shouldResume` checks `!session.forceInit`). This reactive branch is complementary to Layer-C proactive reset (`shouldProactiveReset`, SDKAgent.ts:434-451), which sets `proactiveReset` preemptively by message/token thresholds; the overflow branch does NOT set either flag today, so the next spawn re-resumes. Adapt upstream's `resetSessionForFreshStart` to the fork's per-project `getSessionStore(session.dbPath)`.

**Files**
- Modify: `src/services/worker/SDKAgent.ts` (context-overflow branch lines 363-374; `this.dbManager.getSessionStore(session.dbPath)` pattern already used at lines 311/319; `updateMemorySessionId(id, null)` accepts `string | null` per SessionStore.ts:48)
- Create: `tests/worker/context-overflow-reset.test.ts`

Steps:

- [ ] **Step 1 — Write a passing behavior contract test.** Create `tests/worker/context-overflow-reset.test.ts`. The reset is a 3-line side effect (DB null-out + in-memory flags); pin the contract via a real SessionStore round-trip. NOTE (verified at write-time, SessionStore.ts:25-46): `SessionStore`'s constructor accepts a `':memory:'` path directly — it skips `ensureDir` for `:memory:`, opens `new Database(':memory:')`, and runs all migrations to schema v33 via `new MigrationRunner(this.db).runAllMigrations()` in the ctor. So `new (SessionStore as any)(':memory:')` is sufficient — NO separate Database/MigrationRunner setup is needed. Also `sdk_sessions.started_at` is `TEXT NOT NULL` (migrations.ts:223) — the INSERT MUST supply it alongside `started_at_epoch`:
  ```typescript
  import { describe, it, expect } from 'bun:test';
  import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

  /**
   * Issue #2088 (703c64c7): on context overflow the session must start fresh on the
   * next spawn — null memorySessionId in the DB + set forceInit — so crash recovery
   * does not re-resume the poisoned SDK context forever.
   */
  describe('context-overflow fresh-start reset', () => {
    it('nulls memory_session_id in the DB and sets the in-memory fresh-start flags', () => {
      // SessionStore(:memory:) self-migrates to schema v33 in its ctor (verified
      // SessionStore.ts:25-46 — :memory: skips ensureDir, ctor runs runAllMigrations()).
      const store = new (SessionStore as any)(':memory:');
      const now = Date.now();
      const sid = store.db.prepare(
        "INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, memory_session_id) VALUES (?,?,?,?,?,?)"
      ).run('content-1', '/proj', 'hi', new Date(now).toISOString(), now, 'mem-uuid-poisoned').lastInsertRowid as number;

      // Simulate resetSessionForFreshStart's DB side-effect:
      store.updateMemorySessionId(sid, null);

      const row = store.getSessionById(sid);
      expect(row?.memory_session_id).toBeNull();

      // Simulate the in-memory side-effect on the session object:
      const session: any = { memorySessionId: 'mem-uuid-poisoned', forceInit: false };
      session.memorySessionId = null;
      session.forceInit = true;
      expect(session.memorySessionId).toBeNull();
      expect(session.forceInit).toBe(true);
    });
  });
  ```

- [ ] **Step 1b — Add the source-inspection guard (this is the RED→GREEN driver).** Append to the SAME file `tests/worker/context-overflow-reset.test.ts` (add `readFileSync`/`join` to the import line). This is what actually fails before the production edit and passes after:
  ```typescript
  import { readFileSync } from 'fs';
  import { join } from 'path';

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

- [ ] **Step 2 — Run it, see RED.** `bun test tests/worker/context-overflow-reset.test.ts`
  Expected: the Step 1 contract cases PASS (they test the contract directly, no production wiring), but the Step 1b source-inspection cases FAIL — the overflow branch currently only logs + aborts (no `forceInit`, no `updateMemorySessionId(session.sessionDbId, null)`). This is the real RED tied to the production edit.

- [ ] **Step 3 — Add the reset to the overflow branch.** In `src/services/worker/SDKAgent.ts`, OLD (lines 363-374):
  ```typescript
            // Check for context overflow - prevents infinite retry loops
            if (
              textContent.toLowerCase().includes("prompt is too long") ||
              textContent.toLowerCase().includes("context window")
            ) {
              logger.error(
                "SDK",
                "Context overflow detected - terminating session",
              );
              session.abortController.abort();
              return;
            }
  ```
  NEW:
  ```typescript
            // Check for context overflow - prevents infinite retry loops
            if (
              textContent.toLowerCase().includes("prompt is too long") ||
              textContent.toLowerCase().includes("context window")
            ) {
              logger.error(
                "SDK",
                "Context overflow detected - terminating session and forcing fresh start",
                { sessionDbId: session.sessionDbId },
              );
              // Resuming this SDK session would overflow forever. Null the memory
              // session id and force a fresh init so the next spawn drains the
              // remaining pending messages successfully (#2088). Complementary to
              // Layer-C proactive reset (which fires preemptively by thresholds).
              this.dbManager
                .getSessionStore(session.dbPath)
                .updateMemorySessionId(session.sessionDbId, null);
              session.memorySessionId = null;
              session.forceInit = true;
              session.abortController.abort();
              return;
            }
  ```

- [ ] **Step 4 — Run it, see GREEN.** `bun test tests/worker/context-overflow-reset.test.ts`
  Expected: all cases pass.

- [ ] **Step 5 — Type check + targeted suite.** `npm run build` then `bun test tests/worker/`
  Expected: build exits 0; `tests/worker/` `0 fail`.

- [ ] **Step 6 — Commit.**
  ```
  git commit -am "fix(sdk): reset memorySessionId + forceInit on context overflow

  Before aborting on a context-overflow message, null memory_session_id in the DB
  (per-project getSessionStore(session.dbPath)) and set forceInit so the next spawn
  starts a fresh SDK session instead of re-resuming the poisoned context. Reactive
  counterpart to Layer-C proactive reset.

  Upstream: thedotmack/claude-mem@703c64c7 (AGPL-3.0)"
  ```

---

### Task 6: session-lifecycle guards (Part A) — stale-controller binding, SIGTERM-as-intentional, kill-duplicate-before-spawn

Upstream `f97c50bf` (AGPL-3.0), three of four guards. Re-expressed against the fork's `startGeneratorWithProvider` (`.catch` lines 194-205) and `decideGeneratorAction/executeAction` split. Bind `myController = session.abortController` at generator start; use it in `.catch` (currently reads `session.abortController.signal.aborted` directly at line 197, which can be a controller replaced by stale-recovery). Treat `code 143`/`signal SIGTERM` as intentional → `myController.abort()` + `return` (the `.finally` then sees `wasAborted=true` → decideGeneratorAction does not respawn). In `ProcessRegistry.createPidCapturingSpawn` (line 446), kill any existing live process for the session before spawning. The fork lacks `getSupervisor()` — drop upstream's `assertCanSpawn` line. Upstream ships `tests/worker/session-lifecycle-guard.test.ts`; adopt it (registry behavior tests are portable; fork exports `registerProcess/unregisterProcess/getProcessBySession/getActiveCount/getActiveProcesses/createPidCapturingSpawn`).

**Files**
- Modify: `src/services/worker/http/routes/SessionRoutes.ts` (`startGeneratorWithProvider`: bind point before line 194; `.catch` head lines 195-205)
- Modify: `src/services/worker/ProcessRegistry.ts` (`createPidCapturingSpawn` body, insert at top of returned closure before `const child = spawnClaudeChild(...)` line 448; `getProcessBySession`/`unregisterProcess`/`logger` all in scope)
- Create: `tests/worker/session-lifecycle-guard.test.ts` (adapted from upstream)

> Directory note (verified): `tests/worker/` already exists in the fork (contains `bypass-lane.test.ts`, `db-unreachable.test.ts`, etc.) — create the new file directly, no `mkdir -p` needed.

Steps:

- [ ] **Step 1 — Add upstream's lifecycle-guard test (Part A subset).** Create `tests/worker/session-lifecycle-guard.test.ts` with the SIGTERM-detection and duplicate-process describe blocks from upstream (skip the wall-clock block — that lands in Task 7). The import block folds `readFileSync`/`join` together with the registry imports so Task 7 Step 6 can reuse them. Imports must match fork exports:
  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
  import { EventEmitter } from 'events';
  import { readFileSync } from 'fs';
  import { join } from 'path';
  import {
    registerProcess,
    unregisterProcess,
    getProcessBySession,
    getActiveCount,
    getActiveProcesses,
  } from '../../src/services/worker/ProcessRegistry.js';

  function createMockProcess(overrides: { exitCode?: number | null } = {}) {
    const emitter = new EventEmitter();
    const mock: any = Object.assign(emitter, {
      pid: Math.floor(Math.random() * 100_000) + 10_000,
      exitCode: overrides.exitCode ?? null,
      killed: false,
      kill(signal?: string) {
        mock.killed = true;
        setTimeout(() => { mock.exitCode = 0; mock.emit('exit', 0, signal || 'SIGTERM'); }, 10);
        return true;
      },
    });
    return mock;
  }

  function clearRegistry() {
    for (const p of getActiveProcesses()) unregisterProcess(p.pid);
  }

  describe('SIGTERM detection (#1590)', () => {
    const isSig = (m: string) => m.includes('code 143') || m.includes('signal SIGTERM');
    it('classifies "code 143" as SIGTERM', () => expect(isSig('exited with code 143')).toBe(true));
    it('classifies "signal SIGTERM" as SIGTERM', () => expect(isSig('terminated with signal SIGTERM')).toBe(true));
    it('does NOT classify ordinary errors as SIGTERM', () => expect(isSig('Invalid API key')).toBe(false));
    it('does NOT classify code 1 as SIGTERM', () => expect(isSig('exited with code 1')).toBe(false));
    it('aborting on SIGTERM marks wasAborted=true (no respawn)', () => {
      const ac = new AbortController();
      ac.abort();
      expect(ac.signal.aborted).toBe(true);
    });
  });

  describe('Duplicate process prevention (#1590)', () => {
    beforeEach(clearRegistry);
    afterEach(clearRegistry);

    it('detects a live duplicate for the session', () => {
      const p = createMockProcess();
      registerProcess(p.pid, 42, p as any);
      const existing = getProcessBySession(42);
      expect(existing).toBeDefined();
      expect(existing!.process.exitCode).toBeNull();
    });

    it('does NOT treat an exited process as a live duplicate', () => {
      const p = createMockProcess({ exitCode: 0 });
      registerProcess(p.pid, 42, p as any);
      expect(getProcessBySession(42)!.process.exitCode).not.toBeNull();
    });

    it('kills + unregisters the existing process before a new spawn', () => {
      const old = createMockProcess();
      registerProcess(old.pid, 99, old as any);
      expect(getActiveCount()).toBe(1);
      const dup = getProcessBySession(99);
      if (dup && dup.process.exitCode === null) {
        try { (dup.process as any).kill('SIGTERM'); } catch {}
        unregisterProcess(dup.pid);
      }
      expect(getActiveCount()).toBe(0);
      expect(getProcessBySession(99)).toBeUndefined();
    });

    it('is a no-op when no existing process is registered', () => {
      expect(getProcessBySession(55)).toBeUndefined();
      expect(getActiveCount()).toBe(0);
    });
  });

  describe('SessionRoutes stale-controller + SIGTERM guard (source)', () => {
    const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/http/routes/SessionRoutes.ts'), 'utf-8');
    it('binds myController at generator start', () => {
      expect(SRC).toContain('const myController = session.abortController;');
    });
    it('uses myController in the .catch abort check', () => {
      expect(SRC).toContain('if (myController.signal.aborted) return;');
    });
    it('treats code 143 / signal SIGTERM as intentional termination', () => {
      expect(SRC).toContain("errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM')");
    });
  });

  describe('ProcessRegistry kill-duplicate-before-spawn (source)', () => {
    const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/ProcessRegistry.ts'), 'utf-8');
    it('kills any live existing process for the session before spawning', () => {
      expect(SRC).toContain('Killing duplicate process PID');
    });
  });
  ```

- [ ] **Step 2 — Run it, see RED.** `bun test tests/worker/session-lifecycle-guard.test.ts`
  Expected: registry behavior + SIGTERM-detection cases PASS (pure logic), but the two source-inspection describe blocks FAIL — fork has no `myController`, no SIGTERM branch, no "Killing duplicate process" log.

- [ ] **Step 3 — Bind myController + rewrite the `.catch` head.** In `src/services/worker/http/routes/SessionRoutes.ts`, OLD (lines 193-205):
  ```typescript
      session.generatorPromise = agent.startSession(session, this.workerService)
        .catch(error => {
          // Only log non-abort errors
          if (session.abortController.signal.aborted) return;

          session.lastGeneratorError = error instanceof Error ? error : new Error(String(error));

          logger.error('SESSION', `Generator failed`, {
            sessionId: session.sessionDbId,
            provider: 'claude',
            error: error.message
          }, error);
  ```
  NEW:
  ```typescript
      // Capture the AbortController that belongs to THIS generator run.
      // session.abortController may be replaced (e.g. by stale-recovery) before the
      // .catch handler runs, so binding it here prevents a stale rejection from
      // checking against a brand-new controller (#1590).
      const myController = session.abortController;

      session.generatorPromise = agent.startSession(session, this.workerService)
        .catch(error => {
          // Only log non-abort errors
          if (myController.signal.aborted) return;

          const errorMsg = error instanceof Error ? error.message : String(error);

          // Treat SIGTERM (exit code 143) as intentional termination, not a crash.
          // When the subprocess is killed externally, abort the controller so the
          // .finally's decideGeneratorAction sees wasAborted=true and does NOT respawn (#1590).
          if (errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM')) {
            logger.warn('SESSION', 'Generator killed by external signal — aborting session to prevent respawn', {
              sessionId: session.sessionDbId,
              error: errorMsg
            });
            myController.abort();
            return;
          }

          session.lastGeneratorError = error instanceof Error ? error : new Error(String(error));

          logger.error('SESSION', `Generator failed`, {
            sessionId: session.sessionDbId,
            provider: 'claude',
            error: errorMsg
          }, error);
  ```
  > Surgical note: the rest of the `.catch` body (markSessionMessagesFailed at lines 207-224, stale-resume detection at 226-238 which still reads its own `errorMessage` const) and the `.finally` are unchanged. The `.finally` keeps reading `session.abortController.signal.aborted` for `wasAborted` (line 253) — correct, because the SIGTERM path aborts `myController`, which IS `session.abortController` unless stale-recovery already replaced it (in which case the original generator's rejection must not touch the new controller — exactly what the `myController` binding achieves). The trailing `}, error)` still passes the original `error` object (in scope) as the 4th logger arg.

- [ ] **Step 4 — Add kill-duplicate-before-spawn in ProcessRegistry.** In `src/services/worker/ProcessRegistry.ts`, OLD (lines 446-448):
  ```typescript
  export function createPidCapturingSpawn(sessionDbId: number, dbPath?: string) {
    return (spawnOptions: ClaudeSpawnOptions) => {
      const child = spawnClaudeChild(spawnOptions);
  ```
  NEW:
  ```typescript
  export function createPidCapturingSpawn(sessionDbId: number, dbPath?: string) {
    return (spawnOptions: ClaudeSpawnOptions) => {
      // Kill any existing live process for this session before spawning a new one.
      // Multiple processes sharing the same --resume UUID waste API credits and can
      // conflict with each other (#1590).
      const existing = getProcessBySession(sessionDbId);
      if (existing && existing.process.exitCode === null) {
        logger.warn('PROCESS', `Killing duplicate process PID ${existing.pid} before spawning new one for session ${sessionDbId}`, {
          existingPid: existing.pid,
          sessionDbId
        });
        let exited = false;
        try {
          existing.process.kill('SIGTERM');
          exited = existing.process.exitCode !== null;
        } catch {
          // Already dead — safe to unregister immediately
          exited = true;
        }
        if (exited) {
          unregisterProcess(existing.pid);
        }
        // If still alive, the existing 'exit' handler (below) unregisters it.
      }

      const child = spawnClaudeChild(spawnOptions);
  ```
  > `getProcessBySession` and `unregisterProcess` are defined above in the same file (lines 67, 56); `logger` is imported at line 21 (confirmed at write-time — `logger.warn` here is in scope). Upstream's `getSupervisor().assertCanSpawn(...)` line is intentionally omitted — the fork has no supervisor.

- [ ] **Step 5 — Run it, see GREEN.** `bun test tests/worker/session-lifecycle-guard.test.ts`
  Expected: all cases pass (source-inspection guards now satisfied).

- [ ] **Step 6 — Type check + worker suite (no regression in decideGeneratorAction path).** `npm run build` then `bun test tests/worker/ tests/services/`
  Expected: build exits 0; both suites `0 fail`. In particular `tests/services/stale-abort-controller-guard.test.ts` still passes — and here is WHY: that test exercises the stale-recovery path (SessionRoutes line 139, which REPLACES `session.abortController`), which runs independently of the `.catch` handler. The `myController` binding does not interfere with the replacement; in fact it FIXES the latent bug that test guards against — a stale rejection from the original generator now checks against `myController` (the original controller) instead of the freshly-replaced `session.abortController`, so it can no longer cancel the new controller.

- [ ] **Step 7 — Commit.**
  ```
  git commit -am "fix(session): stale-controller binding, SIGTERM-as-intentional, kill-dup-before-spawn

  - Bind myController = session.abortController at generator start; use it in the
    .catch so a stale rejection cannot cancel a controller replaced by stale-recovery.
  - Treat 'code 143' / 'signal SIGTERM' generator errors as intentional: abort the
    controller (wasAborted=true) so decideGeneratorAction does not respawn.
  - createPidCapturingSpawn: kill + unregister any live process for the session before
    spawning a new --resume. Drops upstream's getSupervisor() call (fork has none).

  Upstream: thedotmack/claude-mem@f97c50bf (AGPL-3.0)"
  ```

---

### Task 7: session-lifecycle guards (Part B) — wall-clock age cap + CLAUDE_MEM_SESSION_MAX_AGE_MS setting

Upstream `f97c50bf` (AGPL-3.0), fourth guard. Refuse new generators when a session's wall-clock age exceeds a cap, draining its queue. Upstream hardcoded `MAX_SESSION_WALL_CLOCK_MS = 4h`; the fork exposes it as a new setting `CLAUDE_MEM_SESSION_MAX_AGE_MS` (default `14400000` = 4h). Uses persisted `sdk_sessions.started_at_epoch` (exists, schema v33 — NO migration) so the guard survives worker restarts. Guard inserted at the top of `ensureGeneratorRunning` (after the `if (!session) return;` at line 85). `markAllSessionMessagesAbandoned`, `removeSessionImmediate(sessionDbId, dbPath)`, `getPendingMessageStore(dbPath)` all exist (PendingMessageStore.ts:586, SessionManager.ts:644, SessionManager.ts:122).

**Files**
- Modify: `src/shared/SettingsDefaultsManager.ts` (interface lines 91-93; DEFAULTS lines 178-183)
- Modify: `src/services/worker/http/routes/SettingsRoutes.ts` (settingKeys allowlist lines 125-127, so the value round-trips via the API)
- Modify: `src/services/worker/http/routes/SessionRoutes.ts` (`ensureGeneratorRunning`, insert after line 85; OLD block lines 83-93)
- Modify: `tests/worker/session-lifecycle-guard.test.ts` (add the wall-clock describe block)
- Modify: `tests/shared/settings-defaults-manager.test.ts` (add file-based default assertions)

Steps:

- [ ] **Step 1 — Add the setting default (file-based test).** Per tests/CLAUDE.md, SettingsDefaultsManager is mocked by 15+ files, so assert defaults via `readFileSync` on the source, not by importing the module. Add to `tests/shared/settings-defaults-manager.test.ts`:
  ```typescript
  import { readFileSync } from 'fs';
  import { join } from 'path';

  describe('CLAUDE_MEM_SESSION_MAX_AGE_MS default', () => {
    const SRC = readFileSync(join(import.meta.dir, '../../src/shared/SettingsDefaultsManager.ts'), 'utf-8');
    it('declares the setting in the SettingsDefaults interface', () => {
      expect(SRC).toContain('CLAUDE_MEM_SESSION_MAX_AGE_MS: string;');
    });
    it('defaults to 4 hours (14400000 ms)', () => {
      expect(SRC).toContain('CLAUDE_MEM_SESSION_MAX_AGE_MS: "14400000"');
    });
  });
  ```
  > If `readFileSync`/`join` are already imported at the top of the file, do not re-import — fold the new names into the existing import lines.

- [ ] **Step 1b — Verify no existing test pins the full defaults set.** Run `grep -n "Object.keys\|toHaveLength\|\.length" tests/shared/settings-defaults-manager.test.ts`. Interpret the results:
  - If a line like `expect(Object.keys(defaults)).toHaveLength(NN)` appears, that is a numeric count pin — note its line number and bump `NN` by +1 (e.g. `57 → 58`).
  - The fork (verified at write-time) uses only relative `toEqual(getAllDefaults())` comparisons and `for (const key of Object.keys(defaults))` iteration — NO numeric count pin — so adding one key is safe and no count edit is needed. Proceed.

- [ ] **Step 2 — Run it, see RED.** `bun test tests/shared/settings-defaults-manager.test.ts`
  Expected: the two new cases FAIL — setting not yet present.

- [ ] **Step 3 — Add to the interface.** In `src/shared/SettingsDefaultsManager.ts`, OLD (lines 91-93):
  ```typescript
    // SummaryLane adaptive observation cap
    CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS: string; // Default cap on obs embedded in fresh-summarize prompt (first step of adaptive sequence)
  }
  ```
  NEW:
  ```typescript
    // SummaryLane adaptive observation cap
    CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS: string; // Default cap on obs embedded in fresh-summarize prompt (first step of adaptive sequence)
    // Session lifecycle guard
    CLAUDE_MEM_SESSION_MAX_AGE_MS: string; // Wall-clock age (ms) after which a session refuses new generators (#1590)
  }
  ```

- [ ] **Step 4 — Add to DEFAULTS.** OLD (lines 178-183):
  ```typescript
      // SummaryLane: default cap at the first step of the adaptive sequence.
      // The runtime derives the rest by repeated halving, so the default 150
      // becomes [150, 75, 37, 18, 9, 4, 2, 1]. Setting values <= 0 or
      // non-numeric fall back to 150 defensively.
      CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS: "150",
    };
  ```
  NEW:
  ```typescript
      // SummaryLane: default cap at the first step of the adaptive sequence.
      // The runtime derives the rest by repeated halving, so the default 150
      // becomes [150, 75, 37, 18, 9, 4, 2, 1]. Setting values <= 0 or
      // non-numeric fall back to 150 defensively.
      CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS: "150",
      // Session lifecycle guard: 4 hours. Sessions older than this refuse new
      // generators and drain their queue, capping runaway API spend (#1590).
      CLAUDE_MEM_SESSION_MAX_AGE_MS: "14400000",
    };
  ```

- [ ] **Step 5 — Allow the setting through the API.** In `src/services/worker/http/routes/SettingsRoutes.ts`, OLD (lines 125-127):
  ```typescript
        // SummaryLane adaptive observation cap
        'CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS',
      ];
  ```
  NEW:
  ```typescript
        // SummaryLane adaptive observation cap
        'CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS',
        // Session lifecycle guard
        'CLAUDE_MEM_SESSION_MAX_AGE_MS',
      ];
  ```
  > Validation is optional and out of scope here; the value is read with a numeric fallback in Step 7. No `validateSettings` clause added (keeps the change surgical).

- [ ] **Step 6 — Add the wall-clock test block.** In `tests/worker/session-lifecycle-guard.test.ts`, add:
  ```typescript
  describe('Wall-clock age cap (#1590)', () => {
    const MAX = 14_400_000; // 4h default
    it('does NOT terminate a session younger than the cap', () => {
      const origin = Date.now() - 30 * 60 * 1000; // 30m
      expect(Date.now() - origin).toBeLessThan(MAX);
    });
    it('uses strict > so exactly the cap is still alive', () => {
      const origin = Date.now() - MAX;
      expect(Date.now() - origin).toBeLessThanOrEqual(MAX);
    });
    it('terminates a session older than the cap', () => {
      const origin = Date.now() - MAX - 1;
      expect(Date.now() - origin).toBeGreaterThan(MAX);
    });

    // Source guard tying the production wiring to a RED:
    const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker/http/routes/SessionRoutes.ts'), 'utf-8');
    it('reads CLAUDE_MEM_SESSION_MAX_AGE_MS for the cap', () => {
      expect(SRC).toContain('CLAUDE_MEM_SESSION_MAX_AGE_MS');
    });
    it('queries persisted started_at_epoch for the age', () => {
      expect(SRC).toContain('started_at_epoch FROM sdk_sessions');
    });
    it('drains the queue via markAllSessionMessagesAbandoned on cap breach', () => {
      expect(SRC).toContain('markAllSessionMessagesAbandoned(sessionDbId)');
    });
  });
  ```
  > `readFileSync`/`join` are already imported in this file from Task 6 Step 1.

- [ ] **Step 7 — Run the new source guards, see RED; verify scope + epoch units; then wire the guard.** `bun test tests/worker/session-lifecycle-guard.test.ts` → the three source-guard cases FAIL. Before inserting, confirm three preconditions (all verified at write-time):
  - **Imports in scope**: `SettingsDefaultsManager` and `USER_SETTINGS_PATH` are imported at `SessionRoutes.ts:22-23`; `SettingsDefaultsManager.loadFromFile(path)` is a static method (`SettingsDefaultsManager.ts:261`). `this.dbManager.getSessionStore(...)` and `SessionStore.db` (public, `SessionStore.ts:23`) are available.
  - **Epoch units = milliseconds**: `started_at_epoch` is stored via `new Date().getTime()` (ms) and `session.startTime` via `Date.now()` (ms) — see the chunk header heads-up. So `Date.now() - sessionOriginMs` needs **no `*1000` conversion**; both are ms. (If a re-check shows seconds, multiply, but verification confirms ms.)
  - **session.startTime fallback**: `session.startTime` is set once to `Date.now()` at session activation (`SessionManager.ts:263`); it is a valid ms timestamp, used only as the fallback when the DB row is missing.

  Now insert the wall-clock guard in `src/services/worker/http/routes/SessionRoutes.ts`. OLD (lines 83-93):
  ```typescript
    private ensureGeneratorRunning(sessionDbId: number, source: string, dbPath?: string): void {
      const session = this.sessionManager.getSession(sessionDbId, dbPath);
      if (!session) return;

      const key = this.spawnKey(sessionDbId, dbPath);

      // GUARD: Prevent duplicate spawns
      if (this.spawnInProgress.get(key)) {
        logger.debug('SESSION', 'Spawn already in progress, skipping', { sessionDbId, source });
        return;
      }
  ```
  NEW:
  ```typescript
    private ensureGeneratorRunning(sessionDbId: number, source: string, dbPath?: string): void {
      const session = this.sessionManager.getSession(sessionDbId, dbPath);
      if (!session) return;

      const key = this.spawnKey(sessionDbId, dbPath);

      // Wall-clock age guard: refuse new generators for sessions alive too long, to
      // cap runaway API spend (#1590). Use persisted started_at_epoch (milliseconds
      // since epoch — same unit as Date.now()) so the guard survives worker restarts
      // (session.startTime resets on every re-activation).
      const settingsForAge = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const maxAgeMs = parseInt(settingsForAge.CLAUDE_MEM_SESSION_MAX_AGE_MS, 10) || 14400000;
      const dbSessionRecord = this.dbManager.getSessionStore(session.dbPath).db
        .prepare('SELECT started_at_epoch FROM sdk_sessions WHERE id = ? LIMIT 1')
        .get(sessionDbId) as { started_at_epoch: number } | undefined;
      // started_at_epoch and session.startTime are BOTH milliseconds — no conversion.
      const sessionOriginMs = dbSessionRecord?.started_at_epoch ?? session.startTime;
      const sessionAgeMs = Date.now() - sessionOriginMs;
      if (sessionAgeMs > maxAgeMs) {
        logger.warn('SESSION', 'Session exceeded wall-clock age limit — aborting to prevent runaway spend', {
          sessionId: sessionDbId,
          ageHours: Math.round(sessionAgeMs / 3_600_000 * 10) / 10,
          limitHours: maxAgeMs / 3_600_000,
          source
        });
        if (!session.abortController.signal.aborted) {
          session.abortController.abort();
        }
        this.bypassLane?.stopForSession(sessionDbId); // Mirror stale-recovery teardown ordering (line 139)
        const pendingStore = this.sessionManager.getPendingMessageStore(session.dbPath);
        pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
        this.sessionManager.removeSessionImmediate(sessionDbId, session.dbPath);
        return;
      }

      // GUARD: Prevent duplicate spawns
      if (this.spawnInProgress.get(key)) {
        logger.debug('SESSION', 'Spawn already in progress, skipping', { sessionDbId, source });
        return;
      }
  ```
  > `SettingsDefaultsManager`/`USER_SETTINGS_PATH` imported at SessionRoutes.ts:22-23 (confirmed); `SettingsDefaultsManager.loadFromFile` is static (SettingsDefaultsManager.ts:261); `SessionStore.db` is public (SessionStore.ts:23); `getPendingMessageStore(dbPath?)` (SessionManager.ts:122) / `removeSessionImmediate(sessionDbId, dbPath?)` (SessionManager.ts:644) / `markAllSessionMessagesAbandoned(sessionDbId)` (PendingMessageStore.ts:586) all exist. `this.bypassLane?.stopForSession(sessionDbId)` matches the stale-recovery teardown at SessionRoutes.ts:139 (field declared at line 43). `session.startTime` exists on ActiveSession (SessionManager.ts:263, used as the fallback origin).

- [ ] **Step 8 — Run it, see GREEN.** `bun test tests/worker/session-lifecycle-guard.test.ts tests/shared/settings-defaults-manager.test.ts`
  Expected: all cases pass.

- [ ] **Step 9 — Full build + suite.** `npm run build` then the root-test command from the Tech Stack section.
  Expected: build exits 0; root tests 0 fail. (Watch SettingsRoutes tests — the added allowlist key is additive. The settings-defaults-manager `getAllDefaults()` comparisons are relative, unaffected by the +1 key.)

- [ ] **Step 10 — Commit.**
  ```
  git commit -am "feat(session): wall-clock age cap via CLAUDE_MEM_SESSION_MAX_AGE_MS (default 4h)

  ensureGeneratorRunning refuses new generators once a session's persisted
  started_at_epoch age exceeds the cap, aborting + draining the queue to cap runaway
  spend (#1590). Adds the setting to SettingsDefaultsManager and the SettingsRoutes
  allowlist. No migration (started_at_epoch already in schema v33).

  Upstream: thedotmack/claude-mem@f97c50bf (AGPL-3.0)"
  ```

---

### Task 8: MCP loopback self-check non-fatal — don't starve reapers / SummaryLane

Upstream `4589b34e` (AGPL-3.0). The fork's MCP connect (worker-service.ts:552-568) lives inside the same `try` whose `catch` rethrows at line 680 (`throw error;`), so a hung/failed MCP connect (5-min `Promise.race` timeout) prevents the orphan reaper (571), stale-session reaper (581), fallback cleanup (639) and `summaryLane.start()` (665) from ever starting. Wrap the MCP connect in its OWN try/catch: on failure set `mcpReady = false`, log, and continue. Upstream's exact code depends on `getSupervisor()` (fork lacks); adapt by wrapping only the connect. This is critical for SummaryLane on pods.

**Files**
- Modify: `src/services/worker-service.ts` (MCP connect lines 552-568; `mcpReady` field declared `mcpReady: boolean = false;` at line 168 — confirmed default false; `existsSync` imported line 10)
- Create: `tests/services/worker-mcp-nonfatal.test.ts`

Steps:

- [ ] **Step 1 — Add a failing source-inspection test.** Create `tests/services/worker-mcp-nonfatal.test.ts`:
  ```typescript
  import { describe, it, expect } from 'bun:test';
  import { readFileSync } from 'fs';
  import { join } from 'path';

  /**
   * 4589b34e: the loopback MCP self-check must be non-fatal so the orphan/stale
   * reapers, fallback cleanup, and SummaryLane all start regardless of MCP health.
   */
  const SRC = readFileSync(join(import.meta.dir, '../../src/services/worker-service.ts'), 'utf-8');

  describe('MCP loopback self-check is non-fatal', () => {
    it('wraps the MCP connect race in its own try', () => {
      // The connect + Promise.race must sit inside a dedicated try block.
      expect(SRC).toContain('// Best-effort loopback MCP self-check');
    });
    it('marks mcpReady=false on self-check failure instead of throwing', () => {
      expect(SRC).toContain('this.mcpReady = false;');
    });
    it('logs the self-check failure as a warning (non-fatal)', () => {
      expect(SRC).toContain('MCP loopback self-check failed');
    });
    it('still references SummaryLane start after the MCP block', () => {
      // Sanity: the reaper/SummaryLane wiring remains after the connect.
      const mcpIdx = SRC.indexOf('// Best-effort loopback MCP self-check');
      const laneIdx = SRC.indexOf('this.summaryLane.start();');
      expect(mcpIdx).toBeGreaterThan(0);
      expect(laneIdx).toBeGreaterThan(mcpIdx);
    });
  });
  ```

- [ ] **Step 2 — Run it, see RED.** `bun test tests/services/worker-mcp-nonfatal.test.ts`
  Expected: cases 1-3 FAIL — the connect is not wrapped, no `mcpReady = false`, no "self-check failed" log.

- [ ] **Step 3 — Wrap the MCP connect in its own try/catch.** In `src/services/worker-service.ts`, OLD (lines 552-568):
  ```typescript
        // Connect to MCP server
        const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');
        const transport = new StdioClientTransport({
          command: 'node',
          args: [mcpServerPath],
          env: process.env
        });

        const MCP_INIT_TIMEOUT_MS = 300000;
        const mcpConnectionPromise = this.mcpClient.connect(transport);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MCP connection timeout after 5 minutes')), MCP_INIT_TIMEOUT_MS)
        );

        await Promise.race([mcpConnectionPromise, timeoutPromise]);
        this.mcpReady = true;
        logger.success('WORKER', 'MCP server connected');
  ```
  NEW:
  ```typescript
        // Best-effort loopback MCP self-check.
        // Codex/Claude Desktop connect to the bundled stdio binary directly; this
        // loopback connect is only a self-check and MUST NOT be fatal — a hung or
        // failed connect must not starve the orphan/stale reapers, fallback cleanup,
        // or SummaryLane that start below (#4589b34e).
        const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');
        try {
          const transport = new StdioClientTransport({
            command: 'node',
            args: [mcpServerPath],
            env: process.env
          });

          const MCP_INIT_TIMEOUT_MS = 300000;
          const mcpConnectionPromise = this.mcpClient.connect(transport);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('MCP connection timeout after 5 minutes')), MCP_INIT_TIMEOUT_MS)
          );

          await Promise.race([mcpConnectionPromise, timeoutPromise]);
          this.mcpReady = true;
          logger.success('WORKER', 'MCP loopback self-check connected');
        } catch (mcpError) {
          // Non-fatal: external stdio clients can still use the bundled binary.
          this.mcpReady = false;
          logger.warn('WORKER', 'MCP loopback self-check failed — continuing without loopback MCP', {
            path: mcpServerPath,
            error: mcpError instanceof Error ? mcpError.message : String(mcpError)
          });
        }
  ```
  > Surgical note: only the connect is wrapped. Lines 570-677 (orphan reaper, stale reaper, fallback cleanup, processPendingQueues → summaryLane.start) and the outer `catch` at 678-681 (which rethrows via `throw error;` at line 680) are untouched, so they now execute regardless of MCP outcome. `mcpReady` already defaults to false (declared `mcpReady: boolean = false;` at line 168, confirmed at write-time), so the catch's `this.mcpReady = false` is a no-op safety re-assert, not a new field. No `existsSync(mcpServerPath)` gate is added (unlike upstream) because the fork always ships the binary and the field already defaults false — keeping the adaptation minimal.

- [ ] **Step 4 — Run it, see GREEN.** `bun test tests/services/worker-mcp-nonfatal.test.ts`
  Expected: 4 pass, 0 fail.

- [ ] **Step 5 — Full build + suite (verify no caller asserts the old "MCP server connected" log or the throw).** `grep -rn "MCP server connected" src tests` then `npm run build` then the root-test command from the Tech Stack section.
  Expected: no test pins the old log string (verified at authoring time — only worker-service.ts:568 referenced it); build exits 0; root tests 0 fail.

- [ ] **Step 6 — Commit.**
  ```
  git commit -am "fix(worker): make MCP loopback self-check non-fatal

  Wrap the loopback MCP connect (Promise.race) in its own try/catch: on failure set
  mcpReady=false, log a warning, and continue so the orphan/stale reapers, fallback
  cleanup, and SummaryLane start regardless. Previously a hung MCP connect threw past
  the shared catch and starved the background safety loops (critical for SummaryLane
  on pods).

  Upstream: thedotmack/claude-mem@4589b34e (AGPL-3.0)"
  ```

---

### Build-and-sync at chunk end

- [ ] After all 8 commits: `npm run build-and-sync` then the root-test command from the Tech Stack section
  Expected: build deploys to cache + marketplace and restarts the worker without error; root tests 0 fail (implementation-day baseline + new cases from Tasks 1-3,5-8).


---

## Chunk 4: P1 chroma & mcp

This chunk ports 6 upstream fixes into `src/services/sync/ChromaMcpManager.ts` (4 items), `src/services/sync/ChromaSync.ts` (1 item), and `src/servers/mcp-server.ts` (1 item). No DB migration (schema stays v33). Tasks are ordered so the onnx/protobuf pin lands before tree-kill (the pin stabilizes the subprocess; tree-kill cleans it up), and the two `getSpawnEnv` / arg-building edits in `ChromaMcpManager` don't collide.

All commits use a provenance trailer. License determined via `git -C <clone> merge-base --is-ancestor 36b0929f <hash>`: c7c4fd54 / d384d3c5 / 64cce2bf / 39f11026 / 8cdabe63 are **AGPL-3.0** (not ancestors of relicense), 55334129 is **Apache-2.0** (descendant of relicense).

> Pre-flight (run once before this chunk): all anchors below were verified against the fork on 2026-06-04. `ChromaMcpManager.ts` currently has NO imports of `ChildProcess` / `execFile` / `promisify` / `getSupervisor` / `paths` (fork has no `src/supervisor/`). `DEFAULT_CHROMA_DATA_DIR` is inlined at fork line 29 and `class ChromaMcpManager` begins at line 31 (re-confirmed at write-time). The fork's `getCombinedCertPath()` is inline at fork line 362 (not `paths.combinedCerts()`), and there is no `quoteForCmdExe` anywhere in the file. Drop ALL upstream supervisor/paths-namespace deps when porting.
>
> Build-verification note: `npm run build` bundles via esbuild (`scripts/build-hooks.js`, `bundle: true`) for the `worker-service` and `mcp-server` entry points (which transitively include all three files touched here). esbuild catches syntax errors, duplicate identifiers, and unresolved imports, but does NOT perform full type-checking. So "build passes" here means "the bundle builds cleanly", not "tsc is happy". For the trivial-change tasks (3, 5) the bundle build is the agreed verification per the briefing's §5 exemption.

---

### Task 1: chroma-onnx-protobuf-pin — pin chroma-mcp==0.2.6 + inject onnxruntime/protobuf overrides

**Why:** chroma-mcp 0.2.6 can transitively resolve an onnxruntime too old to parse the shipped all-MiniLM-L6-v2 model, failing every embedding add with `INVALID_PROTOBUF` on macOS arm64 / Python 3.13. The protobuf cap is required because forcing only onnxruntime re-resolves to protobuf 7.x which breaks opentelemetry. POSIX-only — do NOT add Windows `quoteForCmdExe`.

**Files**
- Modify: `src/services/sync/ChromaMcpManager.ts` (const block ~29; `buildCommandArgs` ~183-228)
- Test: `tests/services/sync/chroma-mcp-onnx-pin.test.ts` (new)

**Steps**

- [ ] **Step 1 — Write failing test.** Create `tests/services/sync/chroma-mcp-onnx-pin.test.ts` (static-source assertion, no spawn). Pure `bun:test`, reads the source file as text and asserts on it (this is a focused fork-original test; no upstream test ships covering the pin specifically). The `quoteForCmdExe` assertion is gated behind a `process.platform !== 'win32'` guard: the port is POSIX-only by design, so a Windows-only `quoteForCmdExe` helper (were one ever added) is out of scope for this guard, and the assertion only encodes the POSIX-port invariant on POSIX runners. The fork's established win32 idiom is an early `return` inside the `it()` body (see `tests/infrastructure/process-manager.test.ts:513`).
```typescript
import { describe, it, expect } from 'bun:test';

// Static source-level regression guard for upstream #2371.
// Verifies chroma-mcp is pinned and onnxruntime/protobuf overrides are injected
// into the uvx spawn args (both persistent and remote modes). No subprocess spawn.
const src = await Bun.file(
  new URL('../../../src/services/sync/ChromaMcpManager.ts', import.meta.url).pathname
).text();

describe('ChromaMcpManager onnx/protobuf pin (#2371)', () => {
  it('declares CHROMA_MCP_PINNED_VERSION = 0.2.6', () => {
    expect(src).toContain("const CHROMA_MCP_PINNED_VERSION = '0.2.6'");
  });

  it('declares onnxruntime and protobuf dep overrides', () => {
    expect(src).toContain("'onnxruntime>=1.20'");
    expect(src).toContain("'protobuf<7'");
  });

  it('references the pinned version via chroma-mcp==${CHROMA_MCP_PINNED_VERSION}', () => {
    expect(src).toContain('`chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`');
  });

  it('injects dep override flags into both arg builders', () => {
    // depOverrideFlags spread must appear in both the remote and persistent arg arrays
    const occurrences = src.split('...depOverrideFlags').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('does NOT add a Windows quoteForCmdExe helper (POSIX-only port)', () => {
    // POSIX-only port: this invariant is only meaningful on non-Windows runners.
    // On a Windows CI, a quoteForCmdExe helper could legitimately exist, so skip
    // the assertion there rather than report a false POSIX-only breach.
    if (process.platform === 'win32') return;
    expect(src).not.toContain('quoteForCmdExe');
  });
});
```

- [ ] **Step 2 — Run it, see it FAIL.**
  `bun test tests/services/sync/chroma-mcp-onnx-pin.test.ts`
  Expected (on POSIX): FAIL — `expect(src).toContain("const CHROMA_MCP_PINNED_VERSION = '0.2.6'")` fails (const not yet present). 4 fail, 1 pass (the win32-guarded `quoteForCmdExe` assertion passes since the fork has no such helper). On a hypothetical win32 runner the guard early-returns, so that test always passes.

- [ ] **Step 3 — Add the const block.** In `src/services/sync/ChromaMcpManager.ts`, insert after the existing `DEFAULT_CHROMA_DATA_DIR` const (line 29).
  OLD:
```typescript
const DEFAULT_CHROMA_DATA_DIR = path.join(os.homedir(), '.claude-mem', 'chroma');

export class ChromaMcpManager {
```
  NEW:
```typescript
const DEFAULT_CHROMA_DATA_DIR = path.join(os.homedir(), '.claude-mem', 'chroma');

const CHROMA_MCP_PINNED_VERSION = '0.2.6';

// Override transitive dep resolutions for chroma-mcp 0.2.6 (issue #2371).
//
// Why onnxruntime>=1.20: the shipped all-MiniLM-L6-v2 model has pytorch-2.0
// IR. Older onnxruntime versions can't parse it and fail every embedding
// add with `[ONNXRuntimeError] : 7 : INVALID_PROTOBUF`. uv may otherwise
// resolve to a too-old onnxruntime on macOS arm64 / Python 3.13 depending
// on cache state, so we force a floor.
//
// Why protobuf<7: protobuf 7.x's stricter generated-file check rejects
// opentelemetry's _pb2 stubs (generated with protoc <3.19), throwing
// `TypeError: Descriptors cannot be created directly` at chromadb import.
// Capping below 7 lands on protobuf 6.x which opentelemetry tolerates.
//
// These pins are runtime-only (uvx --with) so we don't have to fork
// chroma-mcp upstream — they apply only to claude-mem's spawned subprocess.
const CHROMA_MCP_DEP_OVERRIDES: ReadonlyArray<string> = [
  'onnxruntime>=1.20',
  'protobuf<7',
];

export class ChromaMcpManager {
```

- [ ] **Step 4 — Wire overrides into `buildCommandArgs` (remote mode).** Locate the remote-mode `args` array (fork ~196-202). First add the `depOverrideFlags` const at the top of `buildCommandArgs` after `pythonVersion`.
  OLD:
```typescript
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaMode = settings.CLAUDE_MEM_CHROMA_MODE || 'local';
    const pythonVersion = process.env.CLAUDE_MEM_PYTHON_VERSION || '3.13';

    if (chromaMode === 'remote') {
```
  NEW:
```typescript
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaMode = settings.CLAUDE_MEM_CHROMA_MODE || 'local';
    const pythonVersion = process.env.CLAUDE_MEM_PYTHON_VERSION || '3.13';

    const depOverrideFlags = CHROMA_MCP_DEP_OVERRIDES.flatMap(spec => ['--with', spec]);

    if (chromaMode === 'remote') {
```

- [ ] **Step 5 — Pin + inject in the remote `args` array.**
  OLD:
```typescript
      const args = [
        '--python', pythonVersion,
        'chroma-mcp',
        '--client-type', 'http',
        '--host', chromaHost,
        '--port', chromaPort
      ];
```
  NEW:
```typescript
      const args = [
        '--python', pythonVersion,
        ...depOverrideFlags,
        `chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`,
        '--client-type', 'http',
        '--host', chromaHost,
        '--port', chromaPort
      ];
```

- [ ] **Step 6 — Pin + inject in the persistent (local) `return` array** (fork ~222-227).
  OLD:
```typescript
    // Local mode: persistent client with data directory
    return [
      '--python', pythonVersion,
      'chroma-mcp',
      '--client-type', 'persistent',
      '--data-dir', DEFAULT_CHROMA_DATA_DIR.replace(/\\/g, '/')
    ];
```
  NEW:
```typescript
    // Local mode: persistent client with data directory
    return [
      '--python', pythonVersion,
      ...depOverrideFlags,
      `chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`,
      '--client-type', 'persistent',
      '--data-dir', DEFAULT_CHROMA_DATA_DIR.replace(/\\/g, '/')
    ];
```

- [ ] **Step 7 — Run test, see PASS.**
  `bun test tests/services/sync/chroma-mcp-onnx-pin.test.ts`
  Expected: PASS — 5 pass, 0 fail.

- [ ] **Step 8 — Commit.**
```
git add src/services/sync/ChromaMcpManager.ts tests/services/sync/chroma-mcp-onnx-pin.test.ts
git commit -m "fix(chroma): pin chroma-mcp==0.2.6 + onnxruntime/protobuf overrides

Upstream: thedotmack/claude-mem@55334129 (Apache-2.0)"
```

---

### Task 2: chroma-tree-kill — single chroma-mcp subprocess per worker via tree-kill

**Why:** Every reconnect path (`connectInternal` re-entry, connect-timeout catch, `callTool` transport-error retry, `onclose`, `stop`) abandons the transport by calling at most `transport.close()` and nulling handles. The MCP SDK's `StdioClientTransport.close()` only signals the direct child (uvx); on Linux the grandchildren (uv → python → chroma-mcp) re-parent to init and survive, leaking 20+ instances per session. This task ports the upstream v13.4.0 final state: static `killProcessTree(pid)` + `collectDescendantPids(rootPid)` (pure POSIX `pgrep`/`pkill`, taskkill on Windows) and a `disposeCurrentSubprocess()` helper that all 5 abandon paths route through BEFORE nulling handles.

**Critical fork deltas vs upstream:** the fork has NO `src/supervisor/`, so DROP every `getSupervisor()` / `unregisterProcess()` / `registerProcess()` / `CHROMA_SUPERVISOR_ID` / `sanitizeEnv` / `paths.chroma()` / `paths.combinedCerts()` reference from the upstream version. Keep the fork's existing inline `DEFAULT_CHROMA_DATA_DIR` and inline `getCombinedCertPath()`.

**Callers check:** `disposeCurrentSubprocess` and `killProcessTree`/`collectDescendantPids` are new private methods — no external callers. The 5 abandon sites are all internal to this file. `stop()` is called by `reset()` (line 348-352) and externally; its public signature `Promise<void>` is unchanged.

**Files**
- Modify: `src/services/sync/ChromaMcpManager.ts` (imports ~15-23; `connectInternal` ~88-176; `callTool` retry catch ~251-273; `stop` ~322-342; add 3 new private methods)
- Test: `tests/services/sync/chroma-mcp-manager-singleton.test.ts` (new, adapted from upstream)

**Steps**

- [ ] **Step 1 — Write failing test.** Create `tests/services/sync/chroma-mcp-manager-singleton.test.ts`. This is the upstream test from `55334129` ADAPTED for the fork: the upstream version mocks `src/supervisor/index.ts`, `src/supervisor/env-sanitizer.js`, and a `paths` namespace with `chroma()`/`combinedCerts()` — the fork imports NONE of those, so those `mock.module` blocks are removed and the `paths.js` mock only exposes `USER_SETTINGS_PATH`.
```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Singleton enforcement regression coverage for issue #2313 (fork adaptation).
//
// Prior to the fix, ChromaMcpManager leaked its chroma-mcp subprocess tree on
// every reconnect / transport error, accumulating 20+ instances per session on
// Linux because the MCP SDK's transport.close() only signals the direct child.
// The fix routes every "abandon current transport" path through
// disposeCurrentSubprocess(), which tree-kills via killProcessTree() before
// nulling handles. (Fork has no src/supervisor/, so supervisor mocks dropped.)

let transportCount = 0;
const transportInstances: Array<FakeTransport> = [];

interface FakeChildProcess {
  pid: number;
  once: (event: string, _cb: (...args: unknown[]) => void) => FakeChildProcess;
  on: (event: string, _cb: (...args: unknown[]) => void) => FakeChildProcess;
}

class FakeTransport {
  static nextPid = 100_000;
  onclose: (() => void) | null = null;
  closed = false;
  // Mimic StdioClientTransport's internal `_process` field that the manager
  // pokes into via `(this.transport as unknown as { _process })._process`.
  _process: FakeChildProcess;

  constructor(_opts: { command: string; args: string[] }) {
    transportCount += 1;
    const pid = FakeTransport.nextPid++;
    const child: FakeChildProcess = {
      pid,
      once: function (this: FakeChildProcess) { return this; },
      on: function (this: FakeChildProcess) { return this; },
    };
    this._process = child;
    transportInstances.push(this);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeTransport,
}));

let connectImpl: () => Promise<void> = async () => {};
let callToolImpl: () => Promise<unknown> = async () => ({
  content: [{ type: 'text', text: '{}' }],
});

class FakeClient {
  closed = false;
  async connect(): Promise<void> {
    await connectImpl();
  }
  async callTool(): Promise<unknown> {
    return await callToolImpl();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: () => '',
    getInt: () => 0,
    loadFromFile: () => ({}),
  },
}));

// Fork paths.js only needs USER_SETTINGS_PATH (no paths.chroma()/combinedCerts()).
mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
  },
}));

// Track tree-kill invocations and the transport whose subprocess was killed.
const killTreeCalls: number[] = [];

// Replace child_process.execFile so the static killProcessTree implementation
// can be observed without actually shelling out. We feed pgrep an empty stdout
// (no descendants) so the only signal target is the root pid. The source
// imports from the bare 'child_process' specifier, so mock that exactly.
mock.module('child_process', () => {
  const original = require('node:child_process');
  return {
    ...original,
    execFile: (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: { stdout: string; stderr: string }) => void
    ) => {
      cb(null, { stdout: '', stderr: '' } as any);
    },
    execSync: () => '',
  };
});

// Stub process.kill so the tree-kill path can record targets without crashing
// the runner if a synthetic PID collides with a real process.
const realProcessKill = process.kill.bind(process);
const stubbedProcessKill = ((pid: number, _signal?: string | number) => {
  killTreeCalls.push(pid);
  return true;
}) as typeof process.kill;
process.kill = stubbedProcessKill;

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

function resetState(): void {
  transportCount = 0;
  transportInstances.length = 0;
  killTreeCalls.length = 0;
  connectImpl = async () => {};
  callToolImpl = async () => ({ content: [{ type: 'text', text: '{}' }] });
}

describe('ChromaMcpManager singleton enforcement (#2313)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    resetState();
  });

  it('serializes concurrent ensureConnected() calls into one spawn', async () => {
    const mgr = ChromaMcpManager.getInstance();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        mgr.callTool('chroma_list_collections', { limit: 1 })
      )
    );
    expect(transportCount).toBe(1);
  });

  it('kills the prior subprocess tree before a reconnect spawn', async () => {
    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);
    const firstPid = transportInstances[0]._process.pid;

    let invocations = 0;
    callToolImpl = async () => {
      invocations += 1;
      if (invocations === 1) {
        throw new Error('Connection closed');
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(transportInstances.length).toBe(2);
    expect(killTreeCalls).toContain(firstPid);
  });

  it('stop() disposes state including any pending connecting promise', async () => {
    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);
    const subprocessPid = transportInstances[0]._process.pid;

    await mgr.stop();
    expect(killTreeCalls).toContain(subprocessPid);

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(2);
  });
});

process.on('exit', () => {
  process.kill = realProcessKill;
});
```

- [ ] **Step 2 — Run it, see it FAIL.**
  `bun test tests/services/sync/chroma-mcp-manager-singleton.test.ts`
  Expected: FAIL — the "kills the prior subprocess tree before a reconnect spawn" and "stop() disposes" tests fail because `killTreeCalls` is empty (current code only nulls handles, never tree-kills). The serialization test may pass already (existing `connecting` lock), so at least 2 tests fail.

- [ ] **Step 3 — Extend imports.** In `src/services/sync/ChromaMcpManager.ts`, update the `child_process` import to add `execFile` + `ChildProcess` type and add `promisify`. The module-level `execFileAsync = promisify(execFile)` is defined once and shared by both `killProcessTree` and `collectDescendantPids` (this is the agreed pattern — see DECISIONS C4-T2-001, confirmed correct; no class-level alternative needed).
  OLD:
```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
```
  NEW:
```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile, execSync, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

const execFileAsync = promisify(execFile);
```

- [ ] **Step 4 — Route `connectInternal` pre-spawn cleanup through `disposeCurrentSubprocess`.** Replace the manual close/null block at the top of `connectInternal` (fork ~89-100). Note this keeps the `const commandArgs = this.buildCommandArgs();` line that immediately follows, so the rest of the method is untouched. (DECISIONS C4-T2-002 confirmed: `disposeCurrentSubprocess()` sets `this.connected = false` internally, and the `await` preserves the upstream cleanup-before-`buildCommandArgs` ordering — no semantic change.)
  OLD:
```typescript
  private async connectInternal(): Promise<void> {
    // Clean up any stale client/transport from a dead subprocess.
    // Close transport first (kills subprocess via SIGTERM) before client
    // to avoid hanging on a stuck process.
    if (this.transport) {
      try { await this.transport.close(); } catch { /* already dead */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* already dead */ }
    }
    this.client = null;
    this.transport = null;
    this.connected = false;

    const commandArgs = this.buildCommandArgs();
```
  NEW:
```typescript
  private async connectInternal(): Promise<void> {
    // Singleton invariant (#2313): kill any pre-existing chroma-mcp subprocess
    // tree before spawning a new one. The MCP SDK's transport.close() only
    // signals the direct child (uvx); on Linux the grandchildren (uv, python,
    // chroma-mcp) get re-parented to init and survive, accumulating 20+
    // instances per session if reconnects fire repeatedly. Reuse the same
    // tree-kill primitive used by stop() so reconnect can never leave
    // orphans behind. disposeCurrentSubprocess() also resets connected/client/
    // transport, so the prior manual `this.connected = false` is now covered.
    await this.disposeCurrentSubprocess();

    const commandArgs = this.buildCommandArgs();
```

- [ ] **Step 5 — Route the connect-timeout catch through `disposeCurrentSubprocess`.** Replace the catch body (fork ~142-154).
  OLD:
```typescript
    } catch (connectionError) {
      // Connection failed or timed out - kill the subprocess to prevent zombies
      clearTimeout(timeoutId!);
      logger.warn('CHROMA_MCP', 'Connection failed, killing subprocess to prevent zombie', {
        error: connectionError instanceof Error ? connectionError.message : String(connectionError)
      });
      try { await this.transport.close(); } catch { /* best effort */ }
      try { await this.client.close(); } catch { /* best effort */ }
      this.client = null;
      this.transport = null;
      this.connected = false;
      throw connectionError;
    }
    clearTimeout(timeoutId!);
```
  NEW:
```typescript
    } catch (connectionError) {
      // Connection failed or timed out - kill the subprocess tree to prevent zombies
      clearTimeout(timeoutId!);
      logger.warn('CHROMA_MCP', 'Connection failed, killing subprocess tree to prevent zombie', {
        error: connectionError instanceof Error ? connectionError.message : String(connectionError)
      });
      // Tree-kill (not just transport.close) so failed-connect descendants
      // can't survive on Linux (#2313).
      await this.disposeCurrentSubprocess();
      throw connectionError;
    }
    clearTimeout(timeoutId!);
```

- [ ] **Step 6 — Add descendant sweep to the `onclose` handler.** Capture the tracked PID before installing the handler, and tree-kill descendants inside it (fork ~164-175). (DECISIONS C4-T2-003 confirmed: the PID is captured AFTER `client.connect` finishes, so `_process` holds a real PID; the `if (currentTrackedPid)` null-guard is intentional best-effort, not over-defensive.)
  OLD:
```typescript
    const currentTransport = this.transport;
    this.transport.onclose = () => {
      if (this.transport !== currentTransport) {
        logger.debug('CHROMA_MCP', 'Ignoring stale onclose from previous transport');
        return;
      }
      logger.warn('CHROMA_MCP', 'chroma-mcp subprocess closed unexpectedly, applying reconnect backoff');
      this.connected = false;
      this.client = null;
      this.transport = null;
      this.lastConnectionFailureTimestamp = Date.now();
    };
```
  NEW:
```typescript
    const currentTransport = this.transport;
    const currentTrackedPid = (this.transport as unknown as { _process?: ChildProcess })._process?.pid;
    this.transport.onclose = () => {
      if (this.transport !== currentTransport) {
        logger.debug('CHROMA_MCP', 'Ignoring stale onclose from previous transport');
        return;
      }
      logger.warn('CHROMA_MCP', 'chroma-mcp subprocess closed unexpectedly, applying reconnect backoff');
      this.connected = false;
      this.client = null;
      this.transport = null;
      this.lastConnectionFailureTimestamp = Date.now();

      // Direct child (uvx) emitted close, but on Linux the grandchildren
      // (uv/python/chroma-mcp) often outlive their parent because MCP SDK
      // does not use process groups. Sweep the descendant tree using the
      // captured PID — best-effort; pgrep returns nothing if everything
      // already exited (#2313).
      if (currentTrackedPid) {
        ChromaMcpManager.killProcessTree(currentTrackedPid).catch((error) => {
          logger.debug('CHROMA_MCP', 'Background tree-kill after onclose finished (best-effort)', {
            pid: currentTrackedPid,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    };
```

- [ ] **Step 7 — Route the `callTool` transport-error retry through `disposeCurrentSubprocess`.** Replace the manual null block in the catch (fork ~251-262).
  OLD:
```typescript
    } catch (transportError) {
      // Transport error: chroma-mcp subprocess likely died (e.g., killed by orphan reaper,
      // HNSW index corruption). Mark connection dead and retry once after reconnect (#1131).
      // Without this retry, callers see a one-shot error even though reconnect would succeed.
      this.connected = false;
      this.client = null;
      this.transport = null;

      logger.warn('CHROMA_MCP', `Transport error during "${toolName}", reconnecting and retrying once`, {
        error: transportError instanceof Error ? transportError.message : String(transportError)
      });

      try {
        await this.ensureConnected();
```
  NEW:
```typescript
    } catch (transportError) {
      // Transport error: chroma-mcp subprocess likely died (e.g., killed by orphan reaper,
      // HNSW index corruption). Mark connection dead and retry once after reconnect (#1131).
      // Without this retry, callers see a one-shot error even though reconnect would succeed.
      logger.warn('CHROMA_MCP', `Transport error during "${toolName}", reconnecting and retrying once`, {
        error: transportError instanceof Error ? transportError.message : String(transportError)
      });

      // Tree-kill the dying subprocess before reconnect. Previously this path
      // just nulled the handle, which on Linux leaks the uv/python/chroma-mcp
      // descendants every time a transport error happens (#2313).
      await this.disposeCurrentSubprocess();

      try {
        await this.ensureConnected();
```

- [ ] **Step 8 — Route `stop()` through `disposeCurrentSubprocess`.** Replace the body (fork ~322-342). Note the guard changes to `!this.client && !this.transport` so a half-spawned transport is still disposed.
  OLD:
```typescript
  async stop(): Promise<void> {
    if (!this.client) {
      logger.debug('CHROMA_MCP', 'No active MCP connection to stop');
      return;
    }

    logger.info('CHROMA_MCP', 'Stopping chroma-mcp MCP connection');

    try {
      await this.client.close();
    } catch (error) {
      logger.debug('CHROMA_MCP', 'Error during client close (subprocess may already be dead)', {}, error as Error);
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
    this.connecting = null;

    logger.info('CHROMA_MCP', 'chroma-mcp MCP connection stopped');
  }
```
  NEW:
```typescript
  async stop(): Promise<void> {
    if (!this.client && !this.transport) {
      logger.debug('CHROMA_MCP', 'No active MCP connection to stop');
      this.connecting = null;
      return;
    }

    logger.info('CHROMA_MCP', 'Stopping chroma-mcp MCP connection');

    await this.disposeCurrentSubprocess();
    this.connecting = null;

    logger.info('CHROMA_MCP', 'chroma-mcp MCP connection stopped');
  }
```

- [ ] **Step 9 — Add the 3 new private methods.** Insert `disposeCurrentSubprocess`, `killProcessTree`, and `collectDescendantPids` immediately AFTER the `stop()` method and BEFORE the `static async reset()` method (fork `reset` is at ~348). The upstream versions reference `getSupervisor().unregisterProcess(...)` and `paths` — both DROPPED here (fork has no supervisor).
  Insert this block (place it right before the `/**\n   * Reset the singleton instance (for testing).` JSDoc that precedes `static async reset()`):
```typescript
  /**
   * Singleton enforcement helper (#2313): tree-kill the currently tracked
   * chroma-mcp subprocess and reset all state so the next spawn starts clean.
   *
   * Every code path that intends to abandon `this.transport` / `this.client`
   * (reconnect, transport error, connect-timeout, onclose, stop()) MUST funnel
   * through here. The MCP SDK's transport.close() only signals the direct child
   * (uvx); on Linux the grandchildren (uv, python, chroma-mcp) re-parent to
   * init and accumulate. Calling killProcessTree() against the captured PID
   * before we drop the reference is the only way to guarantee at most one
   * chroma-mcp subprocess tree exists per worker process.
   *
   * Idempotent and best-effort — safe to call when there is no active
   * subprocess (no-op in that case).
   */
  private async disposeCurrentSubprocess(): Promise<void> {
    const chromaProcess = (this.transport as unknown as { _process?: ChildProcess })?._process;
    const trackedPid = chromaProcess?.pid;

    if (trackedPid) {
      try {
        await ChromaMcpManager.killProcessTree(trackedPid);
      } catch (error) {
        logger.warn('CHROMA_MCP', 'failed to kill prior chroma-mcp tree (best-effort)', {
          pid: trackedPid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (this.transport) {
      try { await this.transport.close(); } catch { /* already dead */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* already dead */ }
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  /**
   * Kill a process and all its descendants (tree-kill).
   *
   * `private static` by intent — exercised only via the public abandon paths
   * (the singleton test observes it indirectly through `killTreeCalls`); it is
   * NOT part of the public API and must not be called from outside this class.
   *
   * POSIX: collects the full descendant set via `pgrep -P` walks, then sends
   * SIGTERM (leaves first), waits briefly, then SIGKILL stragglers (union of
   * pre-TERM and post-wait descendant sets to catch re-parented children).
   *
   * Windows: `taskkill /T /F /PID` for full subtree teardown.
   *
   * Best-effort — swallows ESRCH (already dead) and logs other errors.
   */
  private static async killProcessTree(pid: number): Promise<void> {
    logger.debug('CHROMA_MCP', `Killing process tree rooted at PID ${pid}`);

    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5_000,
          windowsHide: true
        });
      } catch (error) {
        // taskkill exits non-zero when the process is already dead — that's fine.
        logger.debug('CHROMA_MCP', `taskkill tree-kill finished (may already be dead)`, {
          pid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    // POSIX: walk descendants recursively (bottom-up) and signal each.
    // `pkill -P <pid>` only reaches direct children, so `python` /
    // `chroma-mcp` under `uv` (grandchildren) get re-parented to init and
    // survive. We collect the full descendant set via `pgrep -P` walks before
    // signaling, so the SIGTERM phase reaches every layer.
    try {
      const descendantsBeforeTerm = await ChromaMcpManager.collectDescendantPids(pid);
      // Signal leaves first, then the root.
      for (const child of descendantsBeforeTerm) {
        try {
          process.kill(child, 'SIGTERM');
        } catch {
          // Already gone — fine.
        }
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          logger.debug('CHROMA_MCP', `Failed to SIGTERM PID ${pid}`, { code });
        }
      }

      // Brief wait for SIGTERM to propagate, then SIGKILL stragglers.
      await new Promise(resolve => setTimeout(resolve, 500));

      // SIGKILL targets the UNION of pre-TERM and post-wait descendant sets:
      // when the root exits between snapshots, children get re-parented to
      // init and drop out of `pgrep -P <root>`. Without the union, those
      // re-parented descendants would never receive SIGKILL even though they
      // were definitely children before SIGTERM. Dedupe via Set.
      const descendantsBeforeKill = await ChromaMcpManager.collectDescendantPids(pid);
      const killTargets = Array.from(new Set([...descendantsBeforeTerm, ...descendantsBeforeKill]));
      for (const child of killTargets) {
        try {
          process.kill(child, 'SIGKILL');
        } catch {
          // Already dead — fine.
        }
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead — fine.
      }
    } catch (error) {
      logger.debug('CHROMA_MCP', `Process tree kill completed (best-effort)`, {
        pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Recursively collect all descendant PIDs of `rootPid` using `pgrep -P`.
   * Returned bottom-up (leaves first) so callers can signal leaves before
   * their ancestors. Best-effort: missing pgrep / non-zero exits return [].
   *
   * `private static` by intent — internal helper for killProcessTree only.
   */
  private static async collectDescendantPids(rootPid: number): Promise<number[]> {
    const seen = new Set<number>();
    const collected: number[] = [];

    async function walk(pid: number): Promise<void> {
      let stdout = '';
      try {
        const result = await execFileAsync('pgrep', ['-P', String(pid)], { timeout: 2_000 });
        stdout = result.stdout;
      } catch {
        // pgrep exits 1 when no children match — that's fine, just return.
        return;
      }
      const children = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => Number.parseInt(line, 10))
        .filter(n => Number.isFinite(n) && n > 0 && !seen.has(n));

      for (const child of children) {
        seen.add(child);
        await walk(child);
        // Bottom-up: push after recursion so leaves come first.
        collected.push(child);
      }
    }

    await walk(rootPid);
    return collected;
  }
```

- [ ] **Step 10 — Run the singleton test, see PASS.**
  `bun test tests/services/sync/chroma-mcp-manager-singleton.test.ts`
  Expected: PASS — 3 pass, 0 fail. (Each tree-kill dispose includes a 500ms SIGTERM grace wait, so the suite takes ~1-2s — that's expected, not a hang.)

- [ ] **Step 11 — Build to confirm no bundle breakage** (this task touches imports + many call sites).
  `npm run build`
  Expected: esbuild bundles `worker-service` and `mcp-server` with no unresolved-import/duplicate-identifier/syntax errors; ends after `cp scripts/smart-install.js plugin/scripts/smart-install.js` with exit 0. (esbuild is bundle-only — it will not flag pure type-annotation issues, only resolution/syntax.)

- [ ] **Step 12 — Commit.**
```
git add src/services/sync/ChromaMcpManager.ts tests/services/sync/chroma-mcp-manager-singleton.test.ts
git commit -m "fix(chroma): enforce single chroma-mcp subprocess via tree-kill

Route all 5 abandon paths through disposeCurrentSubprocess() which
tree-kills (pgrep/pkill on POSIX, taskkill on Windows) before nulling
handles. Drops upstream supervisor/paths deps (fork has neither).

Upstream: thedotmack/claude-mem@d384d3c5 (AGPL-3.0)
Upstream: thedotmack/claude-mem@55334129 (Apache-2.0)"
```

---

### Task 3: chroma-cwd-homedir — spawn chroma-mcp from $HOME to dodge pydantic .env crash

**Why:** chroma-mcp uses pydantic-settings which auto-reads `.env`/`.env.local` from CWD. Project dirs with non-chroma vars (e.g. `CELERY_TASK_ALWAYS_EAGER`) make pydantic reject them with "Extra inputs are not permitted", crashing the subprocess into a permanent backoff loop. One line: `cwd: os.homedir()` on the transport options. `os` is already imported (fork line 19).

**Files**
- Modify: `src/services/sync/ChromaMcpManager.ts` (`StdioClientTransport` options in `connectInternal` ~119-124)

**Steps**

- [ ] **Step 1 — Trivial 1-line change (no new test; verified via build + existing singleton suite).** In `connectInternal`, add `cwd: os.homedir()` to the `StdioClientTransport` options. (This block is untouched by Task 2, so the OLD anchor below is still valid after Task 2 lands.)
  OLD:
```typescript
    this.transport = new StdioClientTransport({
      command: uvxSpawnCommand,
      args: uvxSpawnArgs,
      env: spawnEnvironment,
      stderr: 'pipe'
    });
```
  NEW:
```typescript
    // Run chroma-mcp from the home directory so that pydantic-settings (used
    // by chroma-mcp internally) does not pick up .env / .env.local files from
    // the project directory. Those files often contain project-specific vars
    // that pydantic rejects with "Extra inputs are not permitted", crashing the
    // subprocess immediately. Fixes #1297.
    this.transport = new StdioClientTransport({
      command: uvxSpawnCommand,
      args: uvxSpawnArgs,
      env: spawnEnvironment,
      cwd: os.homedir(),
      stderr: 'pipe'
    });
```

- [ ] **Step 2 — Build to confirm no bundle error.**
  `npm run build`
  Expected: exit 0, no esbuild resolution/syntax errors. (`cwd` is a valid `StdioServerParameters` field at runtime; the bundle build confirms the file still parses and resolves.)

- [ ] **Step 3 — Run the singleton test to confirm no regression** (the FakeTransport constructor takes `_opts` so the added field is ignored).
  `bun test tests/services/sync/chroma-mcp-manager-singleton.test.ts`
  Expected: 3 pass, 0 fail.

- [ ] **Step 4 — Commit.**
```
git add src/services/sync/ChromaMcpManager.ts
git commit -m "fix(chroma): spawn chroma-mcp from \$HOME to avoid pydantic .env crash

Upstream: thedotmack/claude-mem@c7c4fd54 (AGPL-3.0)"
```

---

### Task 4: chroma-reconcile-dupid — delete+add reconcile on "already exist" batch conflict

**Why:** A partial write before an MCP timeout/crash leaves duplicate IDs; the next `chroma_add_documents` then fails with "IDs already exist", and the batch is silently dropped until the next backfill cycle. Reconcile in place: on "already exist", delete the batch's IDs then re-add (`chroma_update_documents` only updates existing IDs and silently ignores missing ones, so delete+add is the correct upsert). This NEW block matches upstream `64cce2bf`'s final state (after its CodeRabbit review replaced the initial `chroma_update_documents` fallback with delete+add). The fork already has `chroma_delete_documents` (line 337) and `chroma_add_documents` (line 288). `cleanMetadatas`, `chromaMcp`, `batch`, and `i` are all in scope inside the catch (the catch sits inside the batch `for` loop where they are declared).

**Files**
- Modify: `src/services/sync/ChromaSync.ts` (`addDocuments` catch ~294-300)
- Test: `tests/services/sync/chroma-reconcile-dupid.test.ts` (new — no upstream test ships for this file)

**Steps**

- [ ] **Step 1 — Write failing test.** Create `tests/services/sync/chroma-reconcile-dupid.test.ts`. Mock `ChromaMcpManager` so the first `chroma_add_documents` throws an "already exist" error, then assert a `chroma_delete_documents` + second `chroma_add_documents` happen. `mock.module` must precede the ChromaSync import.
```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Regression for upstream #1566: a duplicate-ID add conflict must be reconciled
// in place via delete+add instead of being dropped until the next backfill.

interface ToolCall { name: string; args: Record<string, unknown>; }
let toolCalls: ToolCall[] = [];
let addAttempts = 0;

const fakeChromaMcp = {
  callTool: async (name: string, args: Record<string, unknown>) => {
    toolCalls.push({ name, args });
    if (name === 'chroma_add_documents') {
      addAttempts += 1;
      // First add fails with a duplicate-ID conflict; the post-delete re-add succeeds.
      if (addAttempts === 1) {
        throw new Error('Error: IDs already exist in collection cm__test');
      }
    }
    return null;
  },
};

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: { getInstance: () => fakeChromaMcp },
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, failure: () => {} },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

describe('ChromaSync addDocuments duplicate-ID reconcile (#1566)', () => {
  beforeEach(() => {
    toolCalls = [];
    addAttempts = 0;
  });

  it('deletes then re-adds the batch when add fails with "already exist"', async () => {
    const sync = new ChromaSync('test-project');
    // ensureCollectionExists() will call chroma-mcp (chroma_create_collection);
    // the fake returns null for everything except the rigged first add.
    await (sync as any).addDocuments([
      { id: 'obs_1_text', document: 'hello', metadata: { project: 'test-project' } },
    ]);

    const names = toolCalls.map(c => c.name);
    // Expected sequence within the batch: add (fails) -> delete -> add (succeeds).
    expect(names.filter(n => n === 'chroma_delete_documents').length).toBe(1);
    expect(names.filter(n => n === 'chroma_add_documents').length).toBe(2);

    const deleteCall = toolCalls.find(c => c.name === 'chroma_delete_documents');
    expect(deleteCall?.args.ids).toEqual(['obs_1_text']);
  });
});
```

> Note: this test exercises `ensureCollectionExists()` (calls `chroma_create_collection`, fake returns null → `collectionCreated=true`) then the batch loop. The fake's default `null` return covers `chroma_create_collection`, `chroma_delete_documents`, and the second add. The document shape `{ id, document, metadata }` matches the fork's `ChromaDocument` interface (ChromaSync.ts lines 22-26). If the typecheck complains about `metadata` value types, note `Record<string, string|number>` accepts the `{ project: 'test-project' }` literal as-is.

- [ ] **Step 2 — Run it, see it FAIL.**
  `bun test tests/services/sync/chroma-reconcile-dupid.test.ts`
  Expected: FAIL — `chroma_delete_documents` count is 0 and `chroma_add_documents` count is 1 (current catch just logs and drops the batch).

- [ ] **Step 3 — Replace the catch body in `addDocuments`** (fork ~294-300). The reconcile branch is keyed on the `'already exist'` substring of chroma-mcp's error message. This wording is chroma-mcp's, not ours, and is the only signal available (chroma-mcp returns a plain `Error`, no structured error code), so the comment below documents the contract: if a future chroma-mcp release changes the phrasing, this branch falls through to the generic `else` (the batch is logged and dropped, exactly the pre-fix behavior — no silent data corruption, just a missed reconcile). The Step-1 test pins the current wording so a wording drift surfaces as a test failure.
  OLD:
```typescript
      } catch (error) {
        logger.error('CHROMA_SYNC', 'Batch add failed, continuing with remaining batches', {
          collection: this.collectionName,
          batchStart: i,
          batchSize: batch.length
        }, error as Error);
      }
```
  NEW:
```typescript
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        // Duplicate IDs from a partial write before timeout/crash. chroma_update_documents
        // only updates *existing* IDs — it silently ignores missing ones. So delete-then-add
        // to guarantee all IDs are written.
        //
        // Detection contract: chroma-mcp surfaces this as a plain Error whose message
        // contains "already exist" (no structured error code is exposed), so we match on
        // that substring. If chroma-mcp ever changes the wording, this branch falls through
        // to the generic else below (batch logged + dropped == pre-fix behavior, no
        // corruption) and the Step-1 regression test on this wording will fail loudly.
        if (errMsg.includes('already exist')) {
          try {
            await chromaMcp.callTool('chroma_delete_documents', {
              collection_name: this.collectionName,
              ids: batch.map(d => d.id)
            });
            await chromaMcp.callTool('chroma_add_documents', {
              collection_name: this.collectionName,
              ids: batch.map(d => d.id),
              documents: batch.map(d => d.document),
              metadatas: cleanMetadatas
            });
            logger.info('CHROMA_SYNC', 'Batch reconciled via delete+add after duplicate conflict', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length
            });
          } catch (reconcileError) {
            logger.error('CHROMA_SYNC', 'Batch reconcile (delete+add) failed', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length
            }, reconcileError as Error);
          }
        } else {
          logger.error('CHROMA_SYNC', 'Batch add failed, continuing with remaining batches', {
            collection: this.collectionName,
            batchStart: i,
            batchSize: batch.length
          }, error as Error);
        }
      }
```

- [ ] **Step 4 — Run test, see PASS.**
  `bun test tests/services/sync/chroma-reconcile-dupid.test.ts`
  Expected: PASS — 1 pass, 0 fail.

- [ ] **Step 5 — Commit.**
```
git add src/services/sync/ChromaSync.ts tests/services/sync/chroma-reconcile-dupid.test.ts
git commit -m "fix(chroma): reconcile duplicate-ID batch conflict via delete+add

Upstream: thedotmack/claude-mem@64cce2bf (AGPL-3.0)"
```

---

### Task 5: chroma-anon-telemetry — default ANONYMIZED_TELEMETRY=false in spawn env

**Why:** Chroma's anonymous telemetry issues background HTTP from the embedding subprocess on every collection touch. Default it off unless the user has pinned it. (The upstream commit also removed an ONNX/OpenBLAS thread-cap — SKIPPED here because the fork never had that cap; the fork's `getSpawnEnv` has no thread-cap loop.)

**Files**
- Modify: `src/services/sync/ChromaMcpManager.ts` (`getSpawnEnv` ~429-440)

**Steps**

- [ ] **Step 1 — Trivial env-default change (verified via build + sync suite, no new test).** In `getSpawnEnv`, insert the telemetry default after the `baseEnv` population loop and BEFORE the `combinedCertPath` early-return block (so it applies in both the cert and no-cert paths). The placement is load-bearing — the comment in the NEW code records WHY (must precede the early-return, else the no-cert path skips it).
  OLD:
```typescript
  private getSpawnEnv(): Record<string, string> {
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }

    const combinedCertPath = this.getCombinedCertPath();
    if (!combinedCertPath) {
      return baseEnv;
    }
```
  NEW:
```typescript
  private getSpawnEnv(): Record<string, string> {
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }

    // Disable Chroma's anonymous telemetry — it issues background HTTP from
    // the embedding subprocess on every collection touch. Only set if the
    // user hasn't pinned it explicitly. Must be set BEFORE the combinedCertPath
    // early-return below so it applies to both the cert and no-cert paths.
    if (!baseEnv.ANONYMIZED_TELEMETRY) baseEnv.ANONYMIZED_TELEMETRY = 'false';

    const combinedCertPath = this.getCombinedCertPath();
    if (!combinedCertPath) {
      return baseEnv;
    }
```

- [ ] **Step 2 — Build to confirm no bundle error.**
  `npm run build`
  Expected: exit 0, no esbuild resolution/syntax errors.

- [ ] **Step 3 — Run the sync test suite to confirm no regression.**
  `bun test tests/services/sync/`
  Expected: all sync tests pass (including the singleton + onnx-pin + reconcile tests added earlier), 0 fail.

- [ ] **Step 4 — Commit.**
```
git add src/services/sync/ChromaMcpManager.ts
git commit -m "fix(chroma): default ANONYMIZED_TELEMETRY=false in spawn env

Upstream: thedotmack/claude-mem@39f11026 (AGPL-3.0)"
```

---

### Task 6: mcp-inputschema-props — declare search & timeline inputSchema properties

**Why:** Both tools had `properties: {}`, which prevents MCP clients from exposing params to the LLM — every call sends `{}` and gets a 500 ("Either query or filters required"). Declare each param explicitly. KEEP `additionalProperties: true` and ALSO declare `from_project` (the fork strips it from args before calling the worker via `const { from_project, ...searchParams } = args` at lines 352/378, but it must be advertised so cross-project queries are discoverable).

**Files**
- Modify: `src/servers/mcp-server.ts` (search inputSchema ~346-350; timeline inputSchema ~372-376)
- Test: `tests/servers/mcp-tool-schemas.test.ts` (new — adapted from upstream `8cdabe63`)

**Steps**

- [ ] **Step 1 — Write failing test.** Create `tests/servers/mcp-tool-schemas.test.ts` (static-source validation, adapted from upstream — also asserts `from_project` since the fork advertises it). This is a regression guard (catches the `properties: {}` regression and confirms each named param is declared); it is NOT an exhaustive audit that every parameter the handler accepts is advertised — it pins the params upstream declared plus `from_project`.
```typescript
/**
 * Tests for MCP tool inputSchema declarations (upstream #1384 / #1413, fork-adapted).
 *
 * Validates that search and timeline tools declare their parameters explicitly
 * (including from_project) so MCP clients (Claude Code) can expose them to the LLM.
 *
 * Scope: regression guard, not an exhaustive parameter audit. It asserts the
 * upstream-declared params plus from_project are present and that properties: {}
 * is gone — it does not enumerate every arg the handler may destructure.
 */
import { describe, it, expect } from 'bun:test';

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

describe('MCP tool inputSchema declarations', () => {
  it('search tool declares its parameters', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).toContain("name: 'search'");
    const searchSection = src.slice(src.indexOf("name: 'search'"), src.indexOf("name: 'timeline'"));
    expect(searchSection).toContain("query:");
    expect(searchSection).toContain("limit:");
    expect(searchSection).toContain("project:");
    expect(searchSection).toContain("type:");
    expect(searchSection).toContain("obs_type:");
    expect(searchSection).toContain("dateStart:");
    expect(searchSection).toContain("dateEnd:");
    expect(searchSection).toContain("offset:");
    expect(searchSection).toContain("orderBy:");
    expect(searchSection).toContain("from_project:");
    expect(searchSection).not.toContain("properties: {}");
    expect(searchSection).toContain("additionalProperties: true");
  });

  it('timeline tool declares its parameters', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const timelineSection = src.slice(
      src.indexOf("name: 'timeline'"),
      src.indexOf("name: 'get_observations'")
    );
    expect(timelineSection).toContain("anchor:");
    expect(timelineSection).toContain("query:");
    expect(timelineSection).toContain("depth_before:");
    expect(timelineSection).toContain("depth_after:");
    expect(timelineSection).toContain("project:");
    expect(timelineSection).toContain("from_project:");
    expect(timelineSection).not.toContain("properties: {}");
    expect(timelineSection).toContain("additionalProperties: true");
  });

  it('get_observations still declares ids (regression check)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const getObsSection = src.slice(src.indexOf("name: 'get_observations'"));
    expect(getObsSection).toContain("ids:");
    expect(getObsSection).toContain("required:");
  });
});
```

- [ ] **Step 2 — Run it, see it FAIL.**
  `bun test tests/servers/mcp-tool-schemas.test.ts`
  Expected: FAIL — the search/timeline sections still contain `properties: {}` and lack `query:` etc. (`get_observations` test passes; note the OLD search description text contains `type:` from "observation type:" but NOT `query:`, so the `query:`/`properties: {}` assertions still fail). 2 fail, 1 pass.

- [ ] **Step 3 — Declare search inputSchema properties** (fork ~346-350).
  OLD:
```typescript
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { from_project, ...searchParams } = args;
```
  NEW:
```typescript
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        project: { type: 'string', description: 'Filter by project name' },
        type: { type: 'string', description: 'Filter by observation type' },
        obs_type: { type: 'string', description: 'Filter by obs_type field' },
        dateStart: { type: 'string', description: 'Start date filter (ISO)' },
        dateEnd: { type: 'string', description: 'End date filter (ISO)' },
        offset: { type: 'number', description: 'Pagination offset' },
        orderBy: { type: 'string', description: 'Sort order: date_desc or date_asc' },
        from_project: { type: 'string', description: 'Cross-project: project name or "*" for all projects' }
      },
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { from_project, ...searchParams } = args;
```

- [ ] **Step 4 — Declare timeline inputSchema properties** (fork ~372-376).
  OLD:
```typescript
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { from_project, ...timelineParams } = args;
      if (from_project === '*') {
```
  NEW:
```typescript
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: 'number', description: 'Observation ID to center the timeline around' },
        query: { type: 'string', description: 'Query to find anchor automatically' },
        depth_before: { type: 'number', description: 'Items before anchor (default 3)' },
        depth_after: { type: 'number', description: 'Items after anchor (default 3)' },
        project: { type: 'string', description: 'Filter by project name' },
        from_project: { type: 'string', description: 'Cross-project: project name only ("*" not supported for timeline)' }
      },
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { from_project, ...timelineParams } = args;
      if (from_project === '*') {
```

- [ ] **Step 5 — Run test, see PASS.**
  `bun test tests/servers/mcp-tool-schemas.test.ts`
  Expected: PASS — 3 pass, 0 fail.

- [ ] **Step 6 — Commit.**
```
git add src/servers/mcp-server.ts tests/servers/mcp-tool-schemas.test.ts
git commit -m "fix(mcp): declare inputSchema properties for search and timeline tools

Upstream: thedotmack/claude-mem@8cdabe63 (AGPL-3.0)"
```

---

### Chunk 4 final verification

- [ ] **Build the full plugin and run the whole suite.**
  `npm run build-and-sync` then the root-test command from the Tech Stack section.
  Expected: build completes (build → sync-to-cache → worker restart) with exit 0; root tests report all existing tests plus the 4 new test files passing, with 0 fail. Skip count should not increase unless an intentional skip is documented in the task commit.


---


---

## Chunk 5: P1 搜索质量 (search-quality)

> Group provenance: the three distinct upstream refs used in this chunk (`46d204ee9`, `be99a5d69`, `e39821298`) are all **AGPL-3.0** (each **predates** the v13.0.0 relicense commit `36b0929f`, i.e. is NOT a descendant of it; verified via `git merge-base --is-ancestor 36b0929f <hash>` → exit 1 for all three — exit≠0 ⇒ `36b0929f` is not an ancestor ⇒ predates the relicense ⇒ AGPL-3.0). Note `be99a5d69` (PR #2079) is shared by Task 2 and Task 3 (it bundled both the search FTS fix and the concept-param fix), so four tasks map to three hashes.
>
> **Pre-flight verification notes (read before implementing):**
> - **Chroma-returned-0 vs Chroma-ABSENT distinction (Task 2) — confirmed against fork + upstream.** The fork already encodes the distinction in source: SearchManager.ts:244-247 logs `'ChromaDB found no matches (final result, no FTS5 fallback)'` (the "returned 0" branch, an intentional final answer), and SearchManager.ts:249-257 is the separate "not initialized" (ABSENT) branch that currently empties the result set. Upstream `be99a5d69` confirms this is intentional: `git show be99a5d69 -- src/services/worker/SearchManager.ts` shows the "returned 0 results … don't fall back to FTS5" branch carried UNCHANGED (context-only in the diff), with the `-`/`+` edits applied solely to the ABSENT (`else if (query)`) branch. So Task 2 fixes only the ABSENT branch and preserves the 0-result branch exactly as upstream did — this is upstream parity, not a fork-only invention.
> - **Task 3 (normalizeparams-concept) caller check — executed before implementation (spec-time).** `grep -rn "concept" src/services/worker/SearchManager.ts | grep -v concepts` (run at write-time) shows: internal calls pass literal-string concepts (`findByConcept('change', …)`, `findByConcept('what-changed', …)` at :764-765/:794) — these are unrelated to the singular query-param key. The ONLY consumer of a singular `concept` param-key is `findByConcept` itself, which reads the plural via `const { concepts: concept, ...filters } = normalized` (SearchManager.ts:1065) — i.e. `concept` there is a destructure-rename of the plural key, not a surviving singular key. A whole-tree check (`grep -rn "{ concept" src/`) finds no route handler or other caller destructuring a singular `concept` AFTER normalizeParams. Conclusion: mapping singular→plural in normalizeParams is safe; nothing depends on a surviving singular key. (Path note: the by-concept route lives at `src/services/worker/http/routes/SearchRoutes.ts` — handler registered at :67, documented param at :156.)
> - All four tasks fix live fork defects.
> - **No DB migration anywhere in this chunk.** All tasks operate on the existing schema (verified `schema_versions` max = 33). Task 2's FTS5 tables (`observations_fts`, `session_summaries_fts`) are created/populated by `SessionSearch`'s existing `ensureFTSTables()` constructor path — NOT by a migration. `hasFtsTables()` only READS `sqlite_master`.

### Task 1: relevance-ranking — preserve Chroma semantic order in the main search() hydration path

**Problem (verified):** `SearchManager.search()` PATH 2 (Chroma) hydrates obs/sessions/prompts then merges them into `allResults` (SearchManager.ts:292-311) and sorts by date only when `orderBy === 'date_desc'|'date_asc'` (lines 313-318). When `orderBy` is the default (no value) the Chroma vector-similarity order is **lost** because hydration forces `chromaOrderBy = date_desc` (line 218) and nothing restores rank order. The fork already has the reuse pattern in `findByConcept` (:1095), `decisions` (:715), `changes` (:784): `results.sort((a,b)=>rankedIds.indexOf(a.id)-rankedIds.indexOf(b.id))`. We do **NOT** add a `'relevance'` orderBy enum to SessionStore (lower risk per briefing).

**Files:**
- Modify: `src/services/worker/SearchManager.ts` (search method: add rank-key prefix constant + rank-map capture at lines 127-130; populate map in categorize loop at lines 200-213; re-sort block at lines 313-318)
- Test: `tests/worker/search/search-param-normalization.test.ts` (extend the existing "P3: unified pagination" describe block — it already has the Chroma-mock harness)

**Steps:**

- [ ] **Step 1 — Write failing test.** Append a new `it(...)` to the existing describe `P3: unified pagination — no double-offset` block in `tests/worker/search/search-param-normalization.test.ts` (after the `'Chroma query path applies unified offset+limit for json results'` test, before the closing `});` of that describe). This reuses the file's existing `sessionSearch`/`sessionStore` and the `chromaManager` mock pattern. (Uses `format: 'json'` so the formatter is never invoked — no ModeManager method gaps to worry about.)

```typescript
  it('Chroma path preserves semantic rank order when orderBy is default (relevance)', async () => {
    // Build date_desc baseline to obtain real observation IDs
    const all = await searchManager.search({
      project: 'test-project',
      limit: '100',
      orderBy: 'date_desc',
      format: 'json'
    });
    const seed = all.observations.slice(0, 5);
    expect(seed.length).toBe(5);

    // Chroma returns IDs in REVERSED date order — i.e. relevance != date order.
    const rankedSeed = [...seed].reverse();

    const relevanceManager = new SearchManager(
      sessionSearch,
      sessionStore,
      {
        queryChroma: async () => ({
          ids: rankedSeed.map((o: any) => o.id),
          distances: rankedSeed.map((_o: any, i: number) => i / 100),
          metadatas: rankedSeed.map((o: any) => ({
            doc_type: 'observation',
            created_at_epoch: o.created_at_epoch
          }))
        })
      } as any,
      new FormattingService(),
      new TimelineService()
    );

    // No orderBy → default relevance: output must echo Chroma rank order, NOT date order.
    const result = await relevanceManager.search({
      query: 'semantic test query',
      project: 'test-project',
      limit: '10',
      format: 'json'
    });

    expect(result.observations.map((o: any) => o.id)).toEqual(
      rankedSeed.map((o: any) => o.id)
    );
  });
```

- [ ] **Step 2 — Run it, see it FAIL.**
  - Command: `bun test tests/worker/search/search-param-normalization.test.ts`
  - Expected: the new test FAILS — without the fix the merged `allResults` is left in the date-desc hydration order (no relevance re-sort), so `toEqual(rankedSeed ids)` fails because the produced order is the date order, not the reversed Chroma rank order. Other tests in the file still pass.

- [ ] **Step 3 — Add the rank-key prefix constant + rank-map capture.** In `src/services/worker/SearchManager.ts`, inside `search()`, after the `let chromaFailed = false;` line.

  **Why a shared prefix constant (C5-T1 hardening):** the rank map is written in Step 4 (keyed by `doc_type`) and read in Step 5 (keyed by `CombinedResult.type`, which is `'observation' | 'session' | 'prompt'`, declared at SearchManager.ts:285-290). If the write-side prefix and the read-side `r.type` vocabulary ever diverged, all lookups would silently return `undefined` → every result gets `MAX_SAFE_INTEGER` rank → deterministic but wrong sort, with no error. To make the correspondence explicit and single-sourced, both sides build the composite key from the SAME `RANK_KEY_PREFIX` vocabulary (`observation`/`session`/`prompt`), and Step 4 maps the Chroma `doc_type` (`session_summary`/`user_prompt`) onto that vocabulary.

  OLD (SearchManager.ts:127-130):
```typescript
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];
    let chromaFailed = false;
```
  NEW:
```typescript
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];
    let chromaFailed = false;
    // Composite-key (typePrefix:id) → Chroma rank index, captured from the semantic
    // search order so the merged result set can restore relevance order. IDs are NOT
    // globally unique across observations/sessions/prompts, so key by type.
    // RANK_KEY_PREFIX is the SINGLE SOURCE for the key vocabulary on BOTH the write
    // side (Step 4, keyed off Chroma doc_type) and the read side (Step 5, keyed off
    // CombinedResult.type). Keeping them identical avoids silent lookup misses.
    const RANK_KEY_PREFIX = {
      observation: 'observation',
      session: 'session',
      prompt: 'prompt',
    } as const;
    let chromaRankByKey: Map<string, number> | null = null;
```

- [ ] **Step 4 — Populate the rank map from recentMetadata.** In the Chroma categorize block, in the `for (const item of recentMetadata)` loop that fills obsIds/sessionIds/promptIds. `recentMetadata` is in scope (defined at SearchManager.ts:189). The Chroma `doc_type` values (`observation`/`session_summary`/`user_prompt`) are mapped onto the `RANK_KEY_PREFIX` vocabulary so the keys match Step 5's `r.type`.

  OLD (SearchManager.ts:200-213):
```typescript
        const promptIds: number[] = [];

        for (const item of recentMetadata) {
          const docType = item.meta?.doc_type;
          if (docType === 'observation' && searchObservations) {
            obsIds.push(item.id);
          } else if (docType === 'session_summary' && searchSessions) {
            sessionIds.push(item.id);
          } else if (docType === 'user_prompt' && searchPrompts) {
            promptIds.push(item.id);
          }
        }

        logger.debug('SEARCH', 'Categorized results by type', { observations: obsIds.length, sessions: sessionIds.length, prompts: prompts.length });
```
  NEW:
```typescript
        const promptIds: number[] = [];

        // Capture Chroma rank order before hydration (which re-sorts by date).
        // Re-applied to the merged result set below when orderBy is relevance (default).
        // Keys use RANK_KEY_PREFIX (same vocabulary as CombinedResult.type in Step 5).
        chromaRankByKey = new Map<string, number>();
        let rankIndex = 0;
        for (const item of recentMetadata) {
          const docType = item.meta?.doc_type;
          if (docType === 'observation' && searchObservations) {
            obsIds.push(item.id);
            chromaRankByKey.set(`${RANK_KEY_PREFIX.observation}:${item.id}`, rankIndex++);
          } else if (docType === 'session_summary' && searchSessions) {
            sessionIds.push(item.id);
            chromaRankByKey.set(`${RANK_KEY_PREFIX.session}:${item.id}`, rankIndex++);
          } else if (docType === 'user_prompt' && searchPrompts) {
            promptIds.push(item.id);
            chromaRankByKey.set(`${RANK_KEY_PREFIX.prompt}:${item.id}`, rankIndex++);
          }
        }

        logger.debug('SEARCH', 'Categorized results by type', { observations: obsIds.length, sessions: sessionIds.length, prompts: prompts.length });
```

- [ ] **Step 5 — Re-sort allResults by relevance when orderBy is not date_*.** In the sort block. The `CombinedResult` type carries a `type` field (`'observation' | 'session' | 'prompt'`, declared at SearchManager.ts:285-290), and `RANK_KEY_PREFIX[r.type]` produces the exact same prefix written in Step 4 — so the composite key `${RANK_KEY_PREFIX[r.type]}:${r.data.id}` always matches. (`r.type` is a member of `RANK_KEY_PREFIX`, so the index access is type-safe with no missing-key path.)

  OLD (SearchManager.ts:313-318):
```typescript
    // Sort by date
    if (options.orderBy === 'date_desc') {
      allResults.sort((a, b) => b.epoch - a.epoch);
    } else if (options.orderBy === 'date_asc') {
      allResults.sort((a, b) => a.epoch - b.epoch);
    }
```
  NEW:
```typescript
    // Sort by date when explicitly requested; otherwise preserve Chroma
    // semantic-rank order (relevance) using the captured rank map. Falls back
    // to date_desc when no rank map exists (filter-only / non-Chroma paths).
    if (options.orderBy === 'date_desc') {
      allResults.sort((a, b) => b.epoch - a.epoch);
    } else if (options.orderBy === 'date_asc') {
      allResults.sort((a, b) => a.epoch - b.epoch);
    } else if (chromaRankByKey) {
      const rankOf = (r: CombinedResult): number => {
        // RANK_KEY_PREFIX[r.type] mirrors the Step 4 write side exactly.
        const rank = chromaRankByKey!.get(`${RANK_KEY_PREFIX[r.type]}:${r.data.id}`);
        return rank === undefined ? Number.MAX_SAFE_INTEGER : rank;
      };
      allResults.sort((a, b) => rankOf(a) - rankOf(b));
    } else {
      allResults.sort((a, b) => b.epoch - a.epoch);
    }
```

- [ ] **Step 6 — Run, see PASS.**
  - Command: `bun test tests/worker/search/search-param-normalization.test.ts`
  - Expected: all tests pass including the new relevance test AND the pre-existing `'Chroma query path applies unified offset+limit for json results'` (which uses `orderBy: 'date_desc'`, so it still date-sorts via the first branch — `chromaRankByKey` is ignored, behavior unchanged).

- [ ] **Step 7 — Build check.** Command: `npm run build` — Expected: completes with no TypeScript errors.

- [ ] **Step 8 — Commit.**
```
git add src/services/worker/SearchManager.ts tests/worker/search/search-param-normalization.test.ts
git commit -m "fix(search): preserve Chroma semantic rank order in main search hydration

The main Chroma path hydrated by date_desc and never restored vector-similarity
order, so default (relevance) searches were silently re-sorted by date. Capture
the Chroma rank per type-prefix:id (single-sourced RANK_KEY_PREFIX shared by the
write and read sides) and re-sort the merged results when orderBy is not an
explicit date ordering, reusing the fork's existing rankedIds pattern.

Upstream: thedotmack/claude-mem@46d204ee9 (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: fts5-fallback — fall back to FTS5/LIKE in SessionSearch when ChromaDB is ABSENT

**Problem (verified):** `SessionSearch.searchObservations` (text path :306-309), `searchSessions` (:345-348), `searchUserPrompts` (:584-587) all `logger.warn('Text search not supported')` and `return []` for query-text searches. When Chroma is **not initialized**, `SearchManager.search()` hits the `else if (query)` branch (SearchManager.ts:250) and sets `observations=[]` — so text search yields nothing even though FTS5 tables exist and `isFts5Available()` exists (:174). The distinction at SearchManager.ts:244-247 ("Chroma returned 0" → no fallback) vs :249-257 ("Chroma not initialized" → currently empties) must be preserved: only the ABSENT path falls back. **Upstream-confirmed:** `be99a5d69` carries the "returned 0 results … don't fall back to FTS5" branch UNCHANGED (context-only in the diff) and edits ONLY the ABSENT branch — so preserving the 0-result branch is upstream parity, not a fork-only choice (see chunk pre-flight note). FTS5 column/table facts verified: `observations_fts(title,subtitle,narrative,text,facts,concepts)` content='observations' content_rowid='id' (:82-92); `session_summaries_fts(request,investigated,learned,completed,next_steps,notes)` content='session_summaries' content_rowid='id' (:123-133); `user_prompts` has NO FTS table (use LIKE on `prompt_text`, default `is_redacted = 0`); prompts alias is `up` with `up.created_at_epoch`, joined to `sdk_sessions s` on `up.content_session_id = s.content_session_id` (:574); `buildOrderClause(orderBy, hasFTS, ftsTable)` returns `ORDER BY <ftsTable>.rank ASC` when `hasFTS && orderBy==='relevance'`, and `ORDER BY o.created_at_epoch ...` for date orders (:263-274). `TableNameRow` is already imported at SessionSearch.ts:3.

**Files:**
- Modify: `src/services/sqlite/SessionSearch.ts` (three text-search guards + add a private `hasFtsTables()` helper after `isFts5Available()`)
- Modify: `src/services/worker/SearchManager.ts` (the `else if (query)` ABSENT branch at :249-257 — call the SessionSearch FTS5 fallback instead of emptying, WITHOUT pre-paginating; add a named ceiling constant)
- Test: new `tests/services/sqlite/session-search-fts5-fallback.test.ts`

**Steps:**

- [ ] **Step 1 — Write failing test.** Create `tests/services/sqlite/session-search-fts5-fallback.test.ts`. Import depth `../../../` matches the neighbor `tests/services/sqlite/migration-runner.test.ts`. The `SessionSearch` constructor's `ensureFTSTables()` builds + populates the FTS tables from the rows inserted before construction (verified — `MigrationRunner` does NOT create FTS tables; `SessionSearch` does):

```typescript
/**
 * FTS5 fallback for text search when ChromaDB is absent.
 * Upstream: thedotmack/claude-mem@be99a5d69 (#2079)
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

const testDir = join(tmpdir(), `test-fts5-fallback-${Date.now()}`);
const dbPath = join(testDir, 'test.db');
let search: SessionSearch;

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  const db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  new MigrationRunner(db).runAllMigrations();

  const now = Date.now();
  db.run(`INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
          VALUES (1, 'cs-1', 'ms-1', 'p', datetime(? / 1000, 'unixepoch'), ?, 'completed')`, [now, now]);
  db.run(`INSERT INTO observations (memory_session_id, project, type, title, narrative, text, files_read, files_modified, concepts, created_at, created_at_epoch)
          VALUES ('ms-1','p','discovery','Authentication flow refactor','rewrote the login handler','body','[]','[]','[]', datetime(? / 1000, 'unixepoch'), ?)`, [now, now]);
  db.run(`INSERT INTO observations (memory_session_id, project, type, title, narrative, text, files_read, files_modified, concepts, created_at, created_at_epoch)
          VALUES ('ms-1','p','feature','Unrelated caching change','added an LRU cache','body','[]','[]','[]', datetime(? / 1000, 'unixepoch'), ?)`, [now - 1000, now - 1000]);
  db.run(`INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
          VALUES ('ms-1','p','Authentication audit','looked at login','it leaks','done','none','[]','[]','', datetime(? / 1000, 'unixepoch'), ?)`, [now, now]);
  db.run(`INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
          VALUES ('cs-1', 1, 'please fix the authentication bug', datetime(? / 1000, 'unixepoch'), ?)`, [now, now]);
  db.close();

  // Constructing SessionSearch runs ensureFTSTables(), which CREATEs + populates
  // observations_fts / session_summaries_fts from the rows inserted above.
  search = new SessionSearch(dbPath);
});

afterAll(() => {
  search.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe('SessionSearch FTS5 fallback', () => {
  it('searchObservations matches title/narrative via FTS5 when given query text', () => {
    const results = search.searchObservations('authentication', { project: 'p' });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Authentication flow refactor');
  });

  it('searchSessions matches summary fields via FTS5', () => {
    const results = search.searchSessions('authentication', { project: 'p' });
    expect(results.length).toBe(1);
    expect(results[0].request).toBe('Authentication audit');
  });

  it('searchUserPrompts matches prompt_text via LIKE', () => {
    const results = search.searchUserPrompts('authentication', { project: 'p' });
    expect(results.length).toBe(1);
    expect(results[0].prompt_text).toContain('authentication');
  });

  it('non-matching query returns empty', () => {
    expect(search.searchObservations('zzznomatch', { project: 'p' }).length).toBe(0);
  });
});
```

- [ ] **Step 2 — Run it, see it FAIL.**
  - Command: `bun test tests/services/sqlite/session-search-fts5-fallback.test.ts`
  - Expected: FAILS — `searchObservations('authentication')` returns `[]` (current "Text search not supported" path), so `expect(results.length).toBe(1)` fails.

- [ ] **Step 3 — Add a private FTS5 table check helper.** In `src/services/sqlite/SessionSearch.ts`, add after the existing `isFts5Available()` method (after the `}` at line 182). `isFts5Available()` creates a probe table; we additionally need to know the populated FTS *tables* exist (they may be skipped on Windows #791). `this.db` is the private field; `TableNameRow` is already imported.

  Insert after SessionSearch.ts:182 (the closing `}` of `isFts5Available`, before the blank line at :183):
```typescript

  /**
   * Whether the populated FTS5 tables (observations_fts / session_summaries_fts)
   * exist for query-text fallback. Returns false on platforms where FTS5 was
   * unavailable at table-creation time (#791).
   */
  private hasFtsTables(): boolean {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observations_fts','session_summaries_fts')")
      .all() as TableNameRow[];
    return rows.length === 2;
  }
```

- [ ] **Step 4 — searchObservations FTS5 fallback.** Replace the dead text-search guard.

  > **SQL param-order invariant (applies to Steps 4–6):** every FTS5/LIKE template binds parameters in exactly this order: `[query, ...filterClauseParams, limit, offset]`. The `orderClause` (whether built by `buildOrderClause` or inline) MUST NOT introduce any bound `?` placeholder — it only emits a hardcoded `ORDER BY <col> <dir>`. If a future change adds a parameterized ORDER BY, the `LIMIT ? OFFSET ?` binding would shift and silently mis-bind. The inline `/* SQL param order: query, ...filter, limit, offset */` comment in each template documents this.

  OLD (SessionSearch.ts:306-310):
```typescript
    // Vector search with query text should be handled by ChromaDB
    // This method only supports filter-only queries (query=undefined)
    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }
```
  NEW:
```typescript
    // Query-text path: ChromaDB is the primary semantic engine. When it is
    // ABSENT, fall back to local FTS5 full-text search so text queries still work.
    if (!this.hasFtsTables()) {
      logger.warn('DB', 'Text search unavailable - no Chroma and no FTS5 tables');
      return [];
    }
    // SQL param order: query, ...filter, limit, offset (orderClause MUST add no params).
    const ftsParams: any[] = [query];
    const filterClause = this.buildFilterClause(filters, ftsParams, 'o');
    const whereExtra = filterClause ? `AND ${filterClause}` : '';
    const orderClause = this.buildOrderClause(orderBy, true, 'observations_fts');
    const ftsSql = `
      SELECT o.*, o.discovery_tokens
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
      ${whereExtra}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    ftsParams.push(limit, offset);
    return this.db.prepare(ftsSql).all(...ftsParams) as ObservationSearchResult[];
  }
```

- [ ] **Step 5 — searchSessions FTS5 fallback.** `buildOrderClause` references `o.created_at_epoch` for date orders, but sessions use alias `s`, so build the order inline for sessions (matching the existing filter-only session path at :329-331). Strip `type` from the session filters (sessions have no `type` column), mirroring the existing path at :322-323. The inline `orderClause` adds no bound params (same invariant as Step 4).

  OLD (SessionSearch.ts:345-349):
```typescript
    // Vector search with query text should be handled by ChromaDB
    // This method only supports filter-only queries (query=undefined)
    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }
```
  NEW:
```typescript
    // Query-text path: fall back to FTS5 when ChromaDB is absent.
    if (!this.hasFtsTables()) {
      logger.warn('DB', 'Text search unavailable - no Chroma and no FTS5 tables');
      return [];
    }
    // SQL param order: query, ...filter, limit, offset (orderClause MUST add no params).
    const ftsParams: any[] = [query];
    const sessionFilterOptions = { ...filters };
    delete sessionFilterOptions.type;
    const filterClause = this.buildFilterClause(sessionFilterOptions, ftsParams, 's');
    const whereExtra = filterClause ? `AND ${filterClause}` : '';
    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY s.created_at_epoch ASC'
      : orderBy === 'date_desc'
        ? 'ORDER BY s.created_at_epoch DESC'
        : 'ORDER BY session_summaries_fts.rank ASC';
    const ftsSql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries_fts
      JOIN session_summaries s ON s.id = session_summaries_fts.rowid
      WHERE session_summaries_fts MATCH ?
      ${whereExtra}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    ftsParams.push(limit, offset);
    return this.db.prepare(ftsSql).all(...ftsParams) as SessionSummarySearchResult[];
  }
```

- [ ] **Step 6 — searchUserPrompts LIKE fallback.** No prompts FTS table exists, so use LIKE on `prompt_text`. Reuse the existing `baseConditions`/`params` already built above the `if (!query)` block (verified: project + dateRange conditions are pushed at SessionSearch.ts:537-555 BEFORE the `if (!query)` guard, so they are in scope here; the `is_redacted = 0` push at :565 is INSIDE the `if (!query)` block, so it does NOT pollute this path). Param order here is `[...baseConditionParams, likeQuery, limit, offset]`; the inline `orderClause` adds no params.

  OLD (SessionSearch.ts:584-588):
```typescript
    // Vector search with query text should be handled by ChromaDB
    // This method only supports filter-only queries (query=undefined)
    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }
```
  NEW:
```typescript
    // Query-text path: user_prompts has no FTS table — fall back to LIKE on prompt_text
    // when ChromaDB is absent. Redacted placeholders are excluded (no content to match).
    // SQL param order: ...baseConditions, likeQuery, limit, offset (orderClause adds none).
    const likeConditions = [...baseConditions, 'up.is_redacted = 0', 'up.prompt_text LIKE ?'];
    params.push(`%${query}%`);
    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY up.created_at_epoch ASC'
      : 'ORDER BY up.created_at_epoch DESC';
    const likeSql = `
      SELECT up.*
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE ${likeConditions.join(' AND ')}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    return this.db.prepare(likeSql).all(...params) as UserPromptSearchResult[];
  }
```

- [ ] **Step 7 — Run, see PASS (SessionSearch unit).**
  - Command: `bun test tests/services/sqlite/session-search-fts5-fallback.test.ts`
  - Expected: all 4 tests pass.

- [ ] **Step 8 — Wire the ABSENT branch in SearchManager (NO pre-pagination).** Only the "Chroma not initialized" branch falls back; the "Chroma returned 0" branch (SearchManager.ts:244-247) is left untouched. `query`, `obs_type`, `concepts`, `files`, `options`, `searchObservations/Sessions/Prompts` are all in scope (destructured at :126 / defined at :133-135).

  **Critical:** the unified pagination at SearchManager.ts:320-323 (`allResults.slice(startOffset, endIndex)`) runs unconditionally after these branches. The filter-only PATH 1 (:141-155) and the Chroma PATH 2 hydration both deliberately AVOID applying limit/offset in SQL to prevent double-pagination. The FTS fallback MUST do the same: pass a high ceiling limit + offset 0 so the SQL does not pre-slice, leaving the real window to the unified slice.

  **Named ceiling (C5-P1 hardening):** the high ceiling is a named constant `FTS_FALLBACK_MAX_RESULTS` rather than a magic `10000`, with a comment documenting that it is a safe per-project upper bound for the pre-pagination override (per-project SQLite DBs hold a single project's observations, so 10k comfortably exceeds expected matches; if a broad term ever approaches it, results above the ceiling are silently dropped before the unified slice). Define it once at module scope near the other top-of-file constants in `SearchManager.ts`.

  First, add the constant at module scope (top of `SearchManager.ts`, alongside existing module constants):
```typescript
/**
 * Upper bound for the FTS5/LIKE fallback's pre-pagination override. The fallback
 * passes this as `limit` (with offset 0) so the SQL does NOT pre-slice — the real
 * window is applied later by the unified allResults.slice(...). Sized as a safe
 * per-project ceiling (each SQLite DB holds one project's rows); matches beyond
 * this are dropped before the unified slice, which is acceptable for keyword fallback.
 */
const FTS_FALLBACK_MAX_RESULTS = 10000;
```

  Then wire the branch:

  OLD (SearchManager.ts:249-257):
```typescript
    // ChromaDB not initialized - mark as failed to show proper error message
    else if (query) {
      chromaFailed = true;
      logger.debug('SEARCH', 'ChromaDB not initialized - semantic search unavailable', {});
      logger.debug('SEARCH', 'Install UVX/Python to enable vector search', { url: 'https://docs.astral.sh/uv/getting-started/installation/' });
      observations = [];
      sessions = [];
      prompts = [];
    }
```
  NEW:
```typescript
    // ChromaDB not initialized (ABSENT) - fall back to local FTS5 / LIKE text search.
    // Distinct from "Chroma returned 0" above, which is a final answer (no fallback).
    else if (query) {
      logger.debug('SEARCH', 'ChromaDB not initialized - falling back to FTS5/LIKE text search', {});
      // Strip limit/offset and pass a high ceiling so the SQL does NOT pre-paginate.
      // Unified pagination is applied later on allResults.slice(...) (P3 fix) — applying
      // it here too would double-offset, mirroring the PATH 1 filter-only approach.
      const { limit: _ftsL, offset: _ftsO, ...ftsBase } = options;
      const obsFtsOptions = { ...ftsBase, limit: FTS_FALLBACK_MAX_RESULTS, offset: 0, type: obs_type, concepts, files };
      const sessFtsOptions = { ...ftsBase, limit: FTS_FALLBACK_MAX_RESULTS, offset: 0 };
      const promptFtsOptions = { ...ftsBase, limit: FTS_FALLBACK_MAX_RESULTS, offset: 0 };
      if (searchObservations) {
        observations = this.sessionSearch.searchObservations(query, obsFtsOptions);
      }
      if (searchSessions) {
        sessions = this.sessionSearch.searchSessions(query, sessFtsOptions);
      }
      if (searchPrompts) {
        prompts = this.sessionSearch.searchUserPrompts(query, promptFtsOptions);
      }
      // Derive chromaFailed from CAPABILITY, not from result count. A legitimate
      // no-match query (Chroma absent, FTS5 present, zero hits) must NOT be reported
      // as "Vector search failed" — that message fires at SearchManager.ts:267 whenever
      // totalResults===0 && chromaFailed. Only a true absence of text-search capability
      // (no Chroma AND no FTS5) should surface the failure/install-uv guidance; an empty
      // FTS result falls through to the normal "No results found" path.
      chromaFailed = !this.sessionSearch.isFts5Available();
    }
```

- [ ] **Step 8b — Expose `isFts5Available()` for the capability check.** In `src/services/sqlite/SessionSearch.ts:174` change the visibility:
  - OLD: `  private isFts5Available(): boolean {`
  - NEW: `  isFts5Available(): boolean {`
  Grep callers first: `grep -rn "isFts5Available" src/ tests/` — today the only callers are internal to SessionSearch; widening to public is additive and safe. (SearchManager already holds `this.sessionSearch: SessionSearch`, constructor param at SearchManager.ts:32, so the call resolves.)

- [ ] **Step 8c — SearchManager no-match regression test (the B2 guard).** New file `tests/worker/search/search-fts5-fallback-no-match.test.ts`. Assert the two distinct outcomes so the false-failure can never regress:
  ```typescript
  import { describe, it, expect } from 'bun:test';
  import { SearchManager } from '../../../src/services/worker/SearchManager.js';

  // Minimal SessionSearch stub: FTS5 capability per opts, every search returns [] (valid no-match).
  function makeSM(opts: { fts5: boolean }) {
    const emptySearch = {
      isFts5Available: () => opts.fts5,
      searchObservations: () => [],
      searchSessions: () => [],
      searchUserPrompts: () => [],
    } as any;
    const sessionStore = {} as any;       // unused on the zero-result text path
    const chromaSync = null;              // null → with query text, PATH 2 (`else if (this.chromaSync)`) is skipped and the FTS-fallback else-branch runs
    const formatter = {} as any;          // unused: the zero-result branch returns its text inline, not via the formatter
    const timelineService = {} as any;    // unused on this path
    // REAL constructor order (verified SearchManager.ts:31): (sessionSearch, sessionStore, chromaSync, formatter, timelineService)
    return new SearchManager(emptySearch, sessionStore, chromaSync, formatter, timelineService);
  }

  describe('FTS5 fallback no-match vs no-capability (B2)', () => {
    it('FTS5 available + zero matches → normal "No results found", NOT "Vector search failed"', async () => {
      const sm = makeSM({ fts5: true });
      const res: any = await sm.search({ query: 'definitely-no-such-term', format: 'text' }); // omit `type` → !type true → all three searches run → exercises the FTS fallback (search() treats 'all' as a literal that disables all branches)
      const text = res?.content?.[0]?.text ?? '';
      expect(text).not.toContain('Vector search failed');
      expect(text.toLowerCase()).toContain('no results');
    });

    it('no FTS5 capability + zero matches → "Vector search failed" install guidance', async () => {
      const sm = makeSM({ fts5: false });
      const res: any = await sm.search({ query: 'definitely-no-such-term', format: 'text' }); // omit `type` → !type true → all three searches run → exercises the FTS fallback (search() treats 'all' as a literal that disables all branches)
      const text = res?.content?.[0]?.text ?? '';
      expect(text).toContain('Vector search failed');
    });
  });
  ```
  Run: `bun test tests/worker/search/search-fts5-fallback-no-match.test.ts` — Expected: both pass. **Implementer note:** constructor signature verified against `SearchManager.ts:31` = `(sessionSearch, sessionStore, chromaSync: ChromaSync|null, formatter, timelineService)`; passing `chromaSync = null` with a `query` string is what forces the FTS-fallback else-branch (PATH 2 `else if (this.chromaSync)` is skipped). Confirm the `search()` option keys against the real signature; if the zero-result text branch is later changed to route through `formatter`, give `formatter` a stub with the method it calls. This test is the canonical guard for B2 — it must compile and run against the actual constructor.

- [ ] **Step 9 — Run the SearchManager param test (regression).**
  - Command: `bun test tests/worker/search/search-param-normalization.test.ts`
  - Expected: all pass. (These tests use `null` Chroma but always supply filters with NO `query` text — they take PATH 1, not the new query/absent path — so the new branch is unexercised here and behavior is unchanged; the relevance test from Task 1 still passes.)

- [ ] **Step 10 — Build + full sqlite/search dir check.**
  - Command: `npm run build` then `bun test tests/services/sqlite/ tests/worker/search/`
  - Expected: build clean; all sqlite + search tests pass.

- [ ] **Step 11 — Commit.**
```
git add src/services/sqlite/SessionSearch.ts src/services/worker/SearchManager.ts tests/services/sqlite/session-search-fts5-fallback.test.ts tests/worker/search/search-fts5-fallback-no-match.test.ts
git commit -m "fix(search): fall back to FTS5/LIKE text search when ChromaDB is absent

SessionSearch returned [] with 'Text search not supported' for any query text,
so installs without ChromaDB had no working text search despite populated FTS5
tables. Restore FTS5 (observations/session_summaries) + LIKE (user_prompts)
fallback, gated on Chroma being not-initialized (preserving the 'Chroma returned
0 = final answer' branch, which upstream be99a5d69 also left untouched). The
SearchManager wiring passes a named ceiling (FTS_FALLBACK_MAX_RESULTS) so the SQL
does not pre-paginate (unified pagination applies the real window).

Upstream: thedotmack/claude-mem@be99a5d69 (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: normalizeparams-concept — map singular `concept` to plural `concepts`

**Problem (verified):** `normalizeParams` (SearchManager.ts:54-118) maps `filePath→files` and CSV-splits `concepts/files/obs_type` but never maps singular `concept→concepts`. `findByConcept` (:1065) destructures `const { concepts: concept } = normalized` — it needs the plural key. The route `handleSearchByConcept` (`src/services/worker/http/routes/SearchRoutes.ts`, handler registered at :67, documented param at :156) forwards `req.query` where the documented param is `concept` (singular). So `?concept=discovery` → `normalized.concepts=undefined` → `SessionSearch.findByConcept(undefined, filters)` → the concept filter is dropped (buildFilterClause skips falsy `filters.concepts`) → returns ALL project observations, silently ignoring the concept filter.

**Caller-survival check (executed at spec-time — see chunk pre-flight note):** the only consumer of a singular `concept` param-key is `findByConcept` itself (which reads the plural via the destructure-rename `const { concepts: concept } = normalized`). The internal `findByConcept('change', …)`/`findByConcept('what-changed', …)` calls (SearchManager.ts:764-765/:794) pass literal-string concept values, unrelated to the param key. A whole-tree `grep -rn "{ concept" src/` finds no caller destructuring a surviving singular `concept` after normalizeParams. Mapping singular→plural is therefore safe with no contingency redesign needed.

**Files:**
- Modify: `src/services/worker/SearchManager.ts` (`normalizeParams`, add a block after the `filePath→files` map at :58-61)
- Test: extend `tests/worker/search/search-param-normalization.test.ts` (also extend the shared ModeManager mock — `findByConcept` renders via `FormattingService.formatObservationIndex`, which calls `getWorkEmoji`, currently missing from the file's mock)

**Steps:**

- [ ] **Step 1a — Extend the shared ModeManager mock.** `findByConcept` returns text output formatted by `formatObservationIndex` → `ModeManager.getInstance().getWorkEmoji(obs.type)` (FormattingService.ts:62). The mock at the TOP of `tests/worker/search/search-param-normalization.test.ts` provides `getTypeIcon` but NOT `getWorkEmoji`; the new test would crash with `getWorkEmoji is not a function`. Add `getWorkEmoji` to that mock.

  OLD (search-param-normalization.test.ts:26-33):
```typescript
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = {
          discovery: '🔵', bugfix: '🔴', feature: '🟣',
          change: '✅', refactor: '🔄', decision: '⚖️'
        };
        return icons[type] || '📌';
      },
      loadMode: () => {},
```
  NEW:
```typescript
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = {
          discovery: '🔵', bugfix: '🔴', feature: '🟣',
          change: '✅', refactor: '🔄', decision: '⚖️'
        };
        return icons[type] || '📌';
      },
      getWorkEmoji: (_type: string) => '🛠️',
      loadMode: () => {},
```

- [ ] **Step 1b — Write failing test.** Append a new describe block to `tests/worker/search/search-param-normalization.test.ts` (before the final `});` of the file). Drive through the public `findByConcept` (Chroma is null → it falls to the SQLite path at SearchManager.ts:1101-1103). The shared seed observations all carry `concepts: '[]'`, so add one concept-bearing observation via the shared `db` handle. The assertion must distinguish filtered from unfiltered: after the fix only the tagged obs matches; before the fix the dropped filter returns ALL project observations (so a known non-tagged title leaks in).

```typescript
describe('Bug 5: singular concept maps to plural concepts', () => {
  beforeAll(() => {
    // Add an observation carrying a concept tag (shared db from top-level beforeAll)
    const epoch = Date.now();
    db.run(`INSERT INTO observations (memory_session_id, project, type, title, text, files_read, files_modified, concepts, created_at, created_at_epoch)
            VALUES ('test-ms','test-project','discovery','Concept tagged obs','body','[]','[]', ?, datetime(? / 1000, 'unixepoch'), ?)`,
      [JSON.stringify(['authentication']), epoch, epoch]);
  });

  it('findByConcept with singular concept param applies the filter', async () => {
    const result = await searchManager.findByConcept({
      concept: 'authentication',
      project: 'test-project'
    });
    const text = result.content?.[0]?.text || '';
    // After fix: concept→concepts mapping makes the filter apply → only the tagged obs.
    expect(text).toContain('Concept tagged obs');
    // Before fix: concepts=undefined → filter dropped → ALL project observations
    // returned, so a non-tagged seed obs ('Test Observation 1') would leak in.
    expect(text).not.toContain('Test Observation 1');
  });
});
```

- [ ] **Step 2 — Run it, see it FAIL.**
  - Command: `bun test tests/worker/search/search-param-normalization.test.ts`
  - Expected: the new test FAILS on `expect(text).not.toContain('Test Observation 1')` — before the fix `normalized.concepts` is undefined, the concept filter is dropped, and `findByConcept` returns ALL project observations (including the non-tagged seed rows), so 'Test Observation 1' appears in the output.

- [ ] **Step 3 — Add the mapping.** In `src/services/worker/SearchManager.ts`, inside `normalizeParams`, right after the `filePath→files` block (and before the CSV-split loop, so the new plural key is also CSV-split if it arrives as `"a,b"`).

  OLD (SearchManager.ts:55-68):
```typescript
    const normalized: any = { ...args };

    // Map filePath to files (API uses filePath, internal uses files)
    if (normalized.filePath && !normalized.files) {
      normalized.files = normalized.filePath;
      delete normalized.filePath;
    }

    // Parse comma-separated string params into arrays
    for (const key of ['concepts', 'files', 'obs_type'] as const) {
      if (normalized[key] && typeof normalized[key] === 'string') {
        normalized[key] = splitCSV(normalized[key]);
      }
    }
```
  NEW:
```typescript
    const normalized: any = { ...args };

    // Map filePath to files (API uses filePath, internal uses files)
    if (normalized.filePath && !normalized.files) {
      normalized.files = normalized.filePath;
      delete normalized.filePath;
    }

    // Map singular concept to plural concepts (the by-concept endpoint uses the
    // singular query param; findByConcept expects the plural key).
    if (normalized.concept && !normalized.concepts) {
      normalized.concepts = normalized.concept;
      delete normalized.concept;
    }

    // Parse comma-separated string params into arrays
    for (const key of ['concepts', 'files', 'obs_type'] as const) {
      if (normalized[key] && typeof normalized[key] === 'string') {
        normalized[key] = splitCSV(normalized[key]);
      }
    }
```

- [ ] **Step 4 — Run, see PASS.**
  - Command: `bun test tests/worker/search/search-param-normalization.test.ts`
  - Expected: the new "Bug 5" test passes; all other tests in the file still pass.

- [ ] **Step 5 — Build check.** Command: `npm run build` — Expected: no TypeScript errors. (The caller-survival grep was already run at spec-time — see Problem section + chunk pre-flight note — so no runtime re-discovery is needed here.)

- [ ] **Step 6 — Commit.**
```
git add src/services/worker/SearchManager.ts tests/worker/search/search-param-normalization.test.ts
git commit -m "fix(search): map singular concept query param to plural concepts

The /api/search/by-concept endpoint forwards ?concept=X, but findByConcept reads
the plural concepts key — so the filter silently no-opped and returned all
project observations. normalizeParams now copies concept->concepts. Caller
survival verified: findByConcept is the only consumer of a singular concept key
(it destructure-renames the plural); no other caller relies on a surviving singular.

Upstream: thedotmack/claude-mem@be99a5d69 (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: bypasslane-ghost-filter — drop empty-content observations before storing on the bypass path

**Problem (verified):** The main Claude SDK channel filters ghost observations in `src/services/worker/agents/ResponseProcessor.ts:76-84` (keep obs if any of title/narrative/subtitle non-null OR facts/concepts/files_read/files_modified non-empty). The fork-original BypassLane (`processObservation`, BypassLane.ts:759-769) calls `parseObservations()` then only guards `observations.length === 0` — a single bare `<observation><type>discovery</type></observation>` parses to length 1 (parser.ts always pushes; all fields null/empty) and is stored via `storeBypassObservationsForSession` (:777) as an "Untitled" ghost row. Inline the SAME (broader, fork) filter before the length check. Do NOT touch ResponseProcessor's context-overflow detection (it relies on unfiltered `allObservations` at ResponseProcessor.ts:70 — a different file/path, unaffected here). `parseObservations` is already imported in BypassLane (:27).

> **OpenRouter note for Chunk 7 sweep:** BypassLane currently has OpenRouter-specific references (e.g. `OPENROUTER_API_URL` at BypassLane.ts:37, `provider === "openrouter"` branches at :212/:476/:877, `CLAUDE_MEM_OPENROUTER_*` settings at :214-219, comment at :5/:836/:497, error string at :904). This task does NOT modify any of them — the C7 full OpenRouter removal sweep owns generalizing BypassLane's provider/endpoint selection (keep BypassLane + Gemini + OpenCode; add a generic `CLAUDE_MEM_OPENCODE_BASE_URL`; remove all OpenRouter-specific path/URL/probe/classification + settings/env/routes/UI/types). The test below uses `provider: 'openrouter'` ONLY as a placeholder config to construct an ACTIVE lane; after the C7 sweep, update it to a generic/Gemini/OpenCode provider value.

**Files:**
- Modify: `src/services/worker/BypassLane.ts` (`processObservation`, the parse + empty-check at :759-769)
- Test: new `tests/worker/bypass-ghost-filter.test.ts` (uses the `processObservation` harness pattern from `bypass-lane.test.ts` F1 block at lines 373-413, plus a ModeManager mock because the bare observation triggers `parseObservations`→`ModeManager.getActiveMode()`)

**Steps:**

- [ ] **Step 1 — Write failing test.** Create `tests/worker/bypass-ghost-filter.test.ts`. Mirror the F1 harness (BypassLane with stubbed deps + `callRestApi`), returning a bare ghost observation. A ghost that passes parsing but fails the content filter must, after the fix, collapse to length 0 → throw the existing "No observations parsed from bypass response" error BEFORE reaching the store. ModeManager IS needed here (a real `<observation>` tag runs the parse-loop body which calls `getActiveMode()`).

  > Scope note (verified): only the ghost-rejection case is included. A positive "stores a real observation" case is intentionally OMITTED because `storeBypassObservationsForSession` calls `store.db.transaction(...)` / `store.db.prepare(...)` (bypass-observation-store.ts:57-60), and a lightweight `getSessionStore()` stub has no `.db` — the positive path would crash on `store.db` rather than exercise the filter. The ghost-rejection assertion is the load-bearing regression guard (the throw happens at the `observations.length === 0` check, before any store access). To extend the positive path later: mock `store.db` with a `transaction(fn)=>fn` shim and a `prepare(...)=>{ run(){}, all(){return[]} }` stub, then assert the filter keeps a content-bearing observation (its `storeObservations` IS invoked).

```typescript
/**
 * BypassLane ghost-observation filter parity with the main channel.
 * Upstream: thedotmack/claude-mem@e39821298 (#1625) — adapted: filter inlined in
 * BypassLane (fork keeps ResponseProcessor's unfiltered context-overflow path).
 */
import { describe, it, expect, mock } from 'bun:test';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        observation_types: [{ id: 'discovery' }],
      }),
    }),
  },
}));

import { BypassLane } from '../../src/services/worker/BypassLane.js';

function makeLane() {
  const lane = new BypassLane();
  (lane as any).state = 'ACTIVE';
  // NOTE: provider 'openrouter' is a placeholder config to build an ACTIVE lane.
  // After the Chunk 7 OpenRouter removal sweep, switch to a generic/Gemini/OpenCode value.
  (lane as any).config = { provider: 'openrouter', apiKey: 'test', model: 'test', cooldownMs: 5000 };
  const storeSpy = mock(() => ({ observationIds: [1] }));
  (lane as any).sessionManager = {
    getPendingMessageStore: () => ({
      claimNextObservation: mock(() => null),
      markFailed: mock(() => {}),
      confirmProcessed: mock(() => {}),
    }),
  };
  (lane as any).dbManager = {
    getSessionStore: () => ({ storeObservations: storeSpy }),
    getChromaSync: () => null,
  };
  return { lane, storeSpy };
}

const message = {
  id: 1, session_db_id: 1, content_session_id: 'cs-1',
  message_type: 'observation', tool_name: 'Read', tool_input: '{}',
  tool_response: '{}', cwd: '/test', prompt_number: 1,
  status: 'processing', retry_count: 0, created_at_epoch: Date.now(),
  last_assistant_message: null, started_processing_at_epoch: Date.now(),
  completed_at_epoch: null,
};
const session = {
  sessionDbId: 1, contentSessionId: 'cs-1', memorySessionId: 'mem-1',
  project: 'test', dbPath: '/test/mem.db', abortController: new AbortController(),
} as any;

describe('BypassLane ghost-observation filter', () => {
  it('throws (treats as empty) when only ghost observations are returned', async () => {
    const { lane, storeSpy } = makeLane();
    // Bare observation: type only, no title/narrative/facts/concepts/files → ghost.
    (lane as any).callRestApi = async () =>
      '<observation><type>discovery</type></observation>';

    await expect(
      (lane as any).processObservation(message, session, 'mem-1', AbortSignal.timeout(5000))
    ).rejects.toThrow('No observations parsed from bypass response');
    expect(storeSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2 — Run it, see it FAIL.**
  - Command: `bun test tests/worker/bypass-ghost-filter.test.ts`
  - Expected: FAILS — the bare ghost parses to length 1, passes the `length === 0` guard, and proceeds to `storeBypassObservationsForSession` (which then crashes on the stub's missing `store.db`), so it does NOT throw `'No observations parsed from bypass response'`. The `rejects.toThrow(...)` assertion fails.

- [ ] **Step 3 — Inline the ghost filter.** In `src/services/worker/BypassLane.ts`, between `parseObservations` and the empty-check. Use the SAME predicate as `src/services/worker/agents/ResponseProcessor.ts:76-84` (broader fork filter). `ParsedObservation` fields (sdk/parser.ts:9-18): `title|subtitle|narrative` are `string|null`; `facts|concepts|files_read|files_modified` are `string[]`.

  OLD (BypassLane.ts:759-769):
```typescript
    // Parse observations from XML response
    const observations = parseObservations(
      responseText,
      session.contentSessionId,
    );

    // F1 fix: Throw on empty observations — consumeLoop catch calls markFailed + recordFailure.
    // After 3 failures, circuit breaker trips and main channel takes over.
    if (observations.length === 0) {
      throw new Error("No observations parsed from bypass response");
    }
```
  NEW:
```typescript
    // Parse observations from XML response
    const parsedObservations = parseObservations(
      responseText,
      session.contentSessionId,
    );

    // Ghost filter (parity with the main Claude SDK channel, ResponseProcessor.ts):
    // drop observations whose every content field is null/empty. A true ghost is a
    // context-overflow artifact (<observation><type>X</type></observation>) that would
    // otherwise store as an "Untitled" row. Observations with ANY content are kept.
    const observations = parsedObservations.filter(
      (obs) =>
        obs.title !== null ||
        obs.narrative !== null ||
        obs.subtitle !== null ||
        obs.facts.length > 0 ||
        obs.concepts.length > 0 ||
        obs.files_read.length > 0 ||
        obs.files_modified.length > 0,
    );

    // F1 fix: Throw on empty observations — consumeLoop catch calls markFailed + recordFailure.
    // After 3 failures, circuit breaker trips and main channel takes over.
    if (observations.length === 0) {
      throw new Error("No observations parsed from bypass response");
    }
```

- [ ] **Step 4 — Run, see PASS.**
  - Command: `bun test tests/worker/bypass-ghost-filter.test.ts`
  - Expected: ghost-rejection test passes — the filter collapses the bare ghost to length 0, the `length === 0` guard throws `'No observations parsed from bypass response'` before any store access, and `storeSpy` is never called.

- [ ] **Step 5 — Bypass regression + build.**
  - Command: `bun test tests/worker/bypass-lane.test.ts && npm run build`
  - Expected: existing bypass-lane tests (including the F1 empty-observation defense at bypass-lane.test.ts:374) still pass; build clean. The F1 test's "no observation tags" response → `parsedObservations=[]` → filter no-op → length 0 → throws as before.

- [ ] **Step 6 — Commit.**
```
git add src/services/worker/BypassLane.ts tests/worker/bypass-ghost-filter.test.ts
git commit -m "fix(bypass): filter ghost observations before storing on bypass lane

The bypass (Gemini/OpenCode) path stored bare <observation> blocks as 'Untitled'
ghost rows because it only checked observations.length===0. Inline the same
content filter the main Claude SDK channel uses (ResponseProcessor), leaving
ResponseProcessor's unfiltered context-overflow detection untouched.

Upstream: thedotmack/claude-mem@e39821298 (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Chunk 5 final verification

- [ ] Run the full suite to confirm no cross-file regressions:
  - Command: root-test command from the Tech Stack section.
  - Expected: pass count = implementation-day root-test baseline **plus** the new tests added in this chunk; 0 fail. Skip count should not increase unless intentionally documented.
- [ ] `npm run build-and-sync` once at the end to deploy + restart worker (only if a live smoke check is desired; CI verification uses `npm run build`).


---


---

## Chunk 6: P1 sqlite & 杂项 (sqlite-misc)

This chunk ports nine small upstream fixes into the fork. They are independent; do them in order, one commit each. Every code block below was verified against the current fork source (line anchors confirmed by reading the files). No DB migration is introduced — schema stays v33.

Build/test commands used throughout:
- Type/bundle only: `npm run build`
- Full build + deploy + worker restart: `bun run build-and-sync`
- Test: `bun test <path>`

License of each upstream commit was determined with `git -C <clone> merge-base --is-ancestor 36b0929f <hash>` (exit 0 → Apache-2.0, else AGPL-3.0). Results are baked into each commit trailer below.

---

### Task 1: journal-size-limit — cap WAL growth on the SessionStore pooled connection

Adds `PRAGMA journal_size_limit = 4194304` (4MB) to the SessionStore constructor so every pooled per-project connection bounds its WAL file. The fork has no migration for PRAGMAs; this is a runtime setting applied on open. Upstream `be99a5d69` (AGPL-3.0) added the same PRAGMA right after `foreign_keys = ON`.

**Files**
- Modify: `src/services/sqlite/SessionStore.ts` (PRAGMA block, lines 37-42)

**Steps**

- [ ] 1. Open `src/services/sqlite/SessionStore.ts` and read the constructor PRAGMA block (lines 37-42) to confirm the anchor. The fork currently has:
```ts
    this.db.run('PRAGMA busy_timeout = 5000');
    // Ensure optimized settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
```

- [ ] 2. This is a one-line runtime PRAGMA; no new test. The existing in-memory DB tests still exercise this path. Apply the change — OLD block:
```ts
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
```
NEW block:
```ts
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    // Cap WAL growth at 4MB per DB so the journal doesn't balloon unbounded
    // under sustained writes (multiple processes share the file). Upstream #1956.
    this.db.run('PRAGMA journal_size_limit = 4194304');
    this.db.run('PRAGMA temp_store = memory');
```

- [ ] 3. Verify it typechecks and the sqlite suite still passes:
```
bun test tests/sqlite/
```
Expected: all tests pass, 0 fail (the journal_size_limit PRAGMA does not change any assertion; it just must not throw on open).

- [ ] 4. Commit:
```
git add src/services/sqlite/SessionStore.ts
git commit -m "fix(sqlite): cap WAL growth with journal_size_limit on pooled connection

Upstream: thedotmack/claude-mem@be99a5d6 (AGPL-3.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: changes-assertion — throw on phantom completion in storeObservationsAndMarkComplete

After the `UPDATE pending_messages ... WHERE id = ? AND status = 'processing'`, assert that exactly one row changed. If the row was already gone or not in `processing` state, the UPDATE silently affects 0 rows and the function would falsely report success ("phantom completion"). Upstream `65f2fd8c` (AGPL-3.0) switched UPDATE→DELETE and added the assertion. **Per the audit decision we KEEP the fork's UPDATE** (the fork retains processed rows on purpose) and add ONLY the `changes !== 1` guard.

**Files**
- Modify: `src/services/sqlite/transactions.ts` (lines 136-145, inside `storeObservationsAndMarkComplete`)
- Modify (test): `tests/sqlite/transactions.test.ts` (append to the existing `storeObservationsAndMarkComplete` describe block at lines 203-308)

Caller note: `storeObservationsAndMarkComplete` is called by the worker after a message has been claimed to `'processing'`, so in the normal path `changes` is always 1. The new throw only fires on a genuine bug (message vanished / wrong status), which is exactly what we want to surface. The throw happens inside the `db.transaction()` callback; bun:sqlite rolls back the inserted observations and re-throws the error message verbatim (verified empirically), so the test's `toThrow(/.../)` regex matches and no partial rows leak.

`.changes` API note (confirmed at write-time): bun:sqlite's `Statement.run()` returns `{ changes, lastInsertRowid }`, and the fork already relies on `result.changes` for run() results across `src/services/sqlite/PendingMessageStore.ts` (e.g. lines 120, 378, 414, 420, 683, 699) and `src/services/sqlite/migrations/runner.ts:1289-1290`. The `updateResult.changes !== 1` guard uses the identical, established API — no `SELECT changes()` fallback needed.

**Steps**

- [ ] 1. Write a failing test. Open `tests/sqlite/transactions.test.ts` and add this `it` block immediately before line 308 (the closing `});` of the `storeObservationsAndMarkComplete` describe). It inserts NO matching `processing` row, so the UPDATE matches 0 rows and the function must throw. The shared `createSessionWithMemoryId(contentSessionId, memorySessionId)` helper (defined at line 66) creates the session so the observation insert's `memory_session_id` FK is satisfied — the function gets far enough to run the UPDATE and hit the guard:
```ts
    it('throws when the pending message is not in processing state (no phantom completion)', () => {
      const { memorySessionId } = createSessionWithMemoryId('content-phantom', 'phantom-session');
      const project = 'test-project';
      const observations = [createObservationInput({ title: 'Phantom Obs' })];

      // messageId 999999 does not exist as a 'processing' row, so the UPDATE
      // affects 0 rows and the function must reject instead of reporting success.
      expect(() =>
        storeObservationsAndMarkComplete(
          db,
          memorySessionId,
          project,
          observations,
          null,
          999999
        )
      ).toThrow(/failed to complete pending message 999999/);
    });
```

- [ ] 2. Run the test, see it FAIL (the current code does not throw — it returns normally):
```
bun test tests/sqlite/transactions.test.ts
```
Expected: the new test FAILS with something like `expected [Function] to throw matching /failed to complete pending message 999999/ but it didn't throw`. (The other transactions tests still pass.)

- [ ] 3. Apply the minimal implementation. In `src/services/sqlite/transactions.ts`, the OLD block (lines 136-145) is:
```ts
    const updateStmt = db.prepare(`
      UPDATE pending_messages
      SET
        status = 'processed',
        completed_at_epoch = ?,
        tool_input = NULL,
        tool_response = NULL
      WHERE id = ? AND status = 'processing'
    `);
    updateStmt.run(timestampEpoch, messageId);
```
NEW block:
```ts
    const updateStmt = db.prepare(`
      UPDATE pending_messages
      SET
        status = 'processed',
        completed_at_epoch = ?,
        tool_input = NULL,
        tool_response = NULL
      WHERE id = ? AND status = 'processing'
    `);
    const updateResult = updateStmt.run(timestampEpoch, messageId);
    // Guard against phantom completion: if the message vanished or is no longer
    // 'processing', 0 rows change. Throwing rolls back the whole transaction so
    // we never report success on observations that weren't really committed
    // against a live queue row. Upstream #65f2fd8c (kept as UPDATE per fork).
    if (updateResult.changes !== 1) {
      throw new Error(`storeObservationsAndMarkComplete: failed to complete pending message ${messageId}`);
    }
```

- [ ] 4. Run the suite, see it PASS:
```
bun test tests/sqlite/transactions.test.ts
```
Expected: all tests pass, 0 fail (new test passes; the 3 pre-existing `storeObservationsAndMarkComplete` tests insert a real `'processing'` row so `changes === 1`).

- [ ] 5. Commit:
```
git add src/services/sqlite/transactions.ts tests/sqlite/transactions.test.ts
git commit -m "fix(sqlite): assert single row changed on pending-message completion

Upstream: thedotmack/claude-mem@65f2fd8c (AGPL-3.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: schema-readability-probe — assertSchemaReadable() before any PRAGMA in the open path

A malformed on-disk `sqlite_master` makes the very first statement throw — including a PRAGMA — so the fork's existing repair only triggers when a non-PRAGMA statement fails. Add a tiny `assertSchemaReadable(db)` that runs `SELECT count(*) FROM sqlite_master` immediately after opening, BEFORE the PRAGMA block, so a malformed schema is caught deterministically. **We keep the fork's existing Python3 `repairMalformedSchema` (lines 62-125) and its catch-and-repair logic in the constructor (lines 161-180).** We do NOT adopt upstream's `SchemaRepair.ts` / `sqlite3 .recover` module. The probe just throws the same "malformed database schema (...)" message the constructor already pattern-matches on.

This is a fork-original adaptation of upstream `a8cf6716` (Apache-2.0), which introduced an `assertSchemaReadable` probe (it used `SELECT name FROM sqlite_master WHERE type='table' LIMIT 1`; ours uses `SELECT count(*)` — both force the lazy `sqlite_master` parse). We keep the probe but pair it with the fork's existing repair path instead of upstream's new `SchemaRepair.ts`.

**Files**
- Modify: `src/services/sqlite/Database.ts` — add `assertSchemaReadable()` and call it first inside `openAndConfigure` (lines 187-199)

Verification of existing behavior: the constructor (`ClaudeMemDatabase`, lines 155-180) wraps `openAndConfigure` in try/catch and, on `errorMessage.includes('malformed database schema')`, calls the fork's `repairMalformedSchema` then re-runs `openAndConfigure`. The probe throwing a "malformed database schema (...)" error therefore flows straight into the existing repair path with no other changes. Both the normal and post-repair paths call `openAndConfigure`, so adding the probe there covers both.

**Steps**

- [ ] 1. Write a failing test. Create `tests/sqlite/schema-readable-probe.test.ts` (new file). bun:sqlite forbids `INSERT INTO sqlite_master` even with `PRAGMA writable_schema = ON` (it errors `table sqlite_master may not be modified`), so we corrupt the schema by byte-patching the CREATE-TABLE SQL stored on disk with a same-length malformed variant. This was verified to make `SELECT count(*) FROM sqlite_master` throw `malformed database schema (...)`, while a healthy DB does not throw. Copy import style from `tests/sqlite/transactions.test.ts`:
```ts
/**
 * Schema-readability probe (assertSchemaReadable) regression.
 * A malformed sqlite_master makes even the first PRAGMA throw, so the probe
 * must run a SELECT against sqlite_master BEFORE any PRAGMA to detect it.
 *
 * bun:sqlite refuses INSERT INTO sqlite_master (even with writable_schema=ON),
 * so we corrupt the schema by patching the on-disk CREATE-TABLE SQL bytes with
 * a same-length malformed variant — this surfaces as "malformed database
 * schema (...)" the moment sqlite_master is parsed.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, readFileSync, writeFileSync } from 'fs';
import { assertSchemaReadable } from '../../src/services/sqlite/Database.js';

describe('assertSchemaReadable', () => {
  let dbPath: string;

  afterEach(() => {
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + '-wal', { force: true });
      rmSync(dbPath + '-shm', { force: true });
    }
  });

  it('does not throw on a healthy database', () => {
    dbPath = join(tmpdir(), `schema-probe-ok-${Date.now()}.db`);
    const db = new Database(dbPath, { create: true, readwrite: true });
    db.run('CREATE TABLE t (id INTEGER)');
    expect(() => assertSchemaReadable(db)).not.toThrow();
    db.close();
  });

  it('throws a malformed-schema error when sqlite_master SQL is corrupt', () => {
    dbPath = join(tmpdir(), `schema-probe-bad-${Date.now()}.db`);
    const setup = new Database(dbPath, { create: true, readwrite: true });
    // Distinct table name so we can locate its CREATE SQL in the raw file.
    setup.run('CREATE TABLE marker_table_aaaa (id INTEGER)');
    setup.close();

    // Patch the on-disk CREATE-TABLE SQL with a SAME-LENGTH malformed variant
    // so page offsets stay valid but sqlite_master fails to parse.
    const buf = readFileSync(dbPath);
    const orig = Buffer.from('CREATE TABLE marker_table_aaaa (id INTEGER)');
    const bad = Buffer.from('CREATE TABLE marker_table_aaaa (id INTEGERX');
    const idx = buf.indexOf(orig);
    expect(idx).toBeGreaterThan(-1);
    expect(bad.length).toBe(orig.length);
    bad.copy(buf, idx);
    writeFileSync(dbPath, buf);

    const db = new Database(dbPath, { create: true, readwrite: true });
    expect(() => assertSchemaReadable(db)).toThrow(/malformed database schema/);
    db.close();
  });
});
```

- [ ] 2. Run the test, see it FAIL (import error — `assertSchemaReadable` does not exist yet):
```
bun test tests/sqlite/schema-readable-probe.test.ts
```
Expected: failure such as `assertSchemaReadable is not a function` / export not found.

- [ ] 3. Implement. In `src/services/sqlite/Database.ts`, add the helper just before the `Migration` interface / `ClaudeMemDatabase` class (i.e., right after `let dbInstance: Database | null = null;` at line 133). Insert this OLD→NEW around line 133:
OLD:
```ts
let dbInstance: Database | null = null;
```
NEW:
```ts
let dbInstance: Database | null = null;

/**
 * Probe that the on-disk schema is readable.
 *
 * A malformed `sqlite_master` (orphaned index, dropped column, corrupt CREATE
 * SQL) makes the very first statement throw — even a PRAGMA. Running a SELECT
 * against sqlite_master up front guarantees a malformed schema is detected
 * deterministically, so the constructor's existing repair path
 * (repairMalformedSchema) is reached even when the first real statement would
 * have been a PRAGMA. Throws the native "malformed database schema (...)"
 * error, which the caller pattern-matches.
 *
 * @internal Exported only so the schema-probe test can import it. Not part of
 *   the public Database.ts API surface (the only public export is the
 *   `ClaudeMemDatabase` class) — do NOT depend on this from production code.
 */
export function assertSchemaReadable(db: Database): void {
  db.query('SELECT count(*) FROM sqlite_master').get();
}
```

- [ ] 4. Wire it into the open path. In `openAndConfigure` (lines 187-199), call the probe before the first PRAGMA. OLD block:
```ts
  private openAndConfigure(dbPath: string): Database {
    const db = new Database(dbPath, { create: true, readwrite: true });
    // busy_timeout first: wait for contended locks rather than failing fast
    // with SQLITE_BUSY — see SessionStore constructor for the rationale.
    db.run('PRAGMA busy_timeout = 5000');
```
NEW block:
```ts
  private openAndConfigure(dbPath: string): Database {
    const db = new Database(dbPath, { create: true, readwrite: true });
    // Probe schema readability BEFORE any PRAGMA: a malformed sqlite_master
    // makes even a PRAGMA throw, so this guarantees the constructor's repair
    // path is reached for malformed on-disk schemas. Upstream #2433 groundwork.
    assertSchemaReadable(db);
    // busy_timeout first: wait for contended locks rather than failing fast
    // with SQLITE_BUSY — see SessionStore constructor for the rationale.
    db.run('PRAGMA busy_timeout = 5000');
```

- [ ] 5. Run the probe test, see it PASS:
```
bun test tests/sqlite/schema-readable-probe.test.ts
```
Expected: both tests pass.

- [ ] 6. Run the broader sqlite suite to confirm no open-path regression (the probe runs on every `ClaudeMemDatabase` open, including `:memory:`):
```
bun test tests/sqlite/
```
Expected: all tests pass, 0 fail.

- [ ] 7. Commit:
```
git add src/services/sqlite/Database.ts tests/sqlite/schema-readable-probe.test.ts
git commit -m "fix(sqlite): probe schema readability before PRAGMA in open path

Upstream: thedotmack/claude-mem@a8cf6716 (Apache-2.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: parsesummary-allnull — return null when a <summary> has no sub-tags

When an observation response accidentally contains a `<summary>plain text</summary>` block with none of the 5 sub-tags, `parseSummary` currently returns an all-null `ParsedSummary`, creating empty summary records. Add an all-null guard AFTER field extraction. This must run AFTER the existing `VerbatimEchoRejectionError` throw (lines 173-177) — that throw is preserved and runs first. This is distinct from the commented-out "some fields missing" validation (lines 182-193), which stays commented per the maintainer's note. Upstream `93a30c5c8` (AGPL-3.0).

Caller note (grep verified — 3 callers, all handle a `null` return safely):
- `src/services/worker/fresh-summarize.ts:216` — `parseSummary(trimmed)`; already treats `null` as `parse_failed`/`no_text`.
- `src/bin/import-xml-observations.ts:337` — guarded by `if (summary) { ... }`.
- `src/services/worker/agents/ResponseProcessor.ts:97` — passed to `normalizeSummaryForStorage(summary)`, which returns `null` for a `null` input (line 275).

So the new `null` path is handled at every call site with no other changes. Before implementing, re-enumerate the call sites and confirm each guards `null` (the existing all-null `ParsedSummary` object was always falsy-on-fields but truthy-as-object, so any caller that did `if (summary)` previously got a truthy object; the new `null` return is strictly safer for those guards):
```
grep -rn 'parseSummary(' src/ | grep -v 'function parseSummary'
```
Expected: exactly the 3 lines above. Read each cited line to confirm the `null` branch is handled (fresh-summarize maps `null`→failure, import-xml guards with `if (summary)`, ResponseProcessor forwards to `normalizeSummaryForStorage` which is null-safe at parser/normalizer line 275). If the grep returns a 4th caller, inspect it before proceeding.

**Files**
- Modify: `src/sdk/parser.ts` (insert after line 177, before the THEDOTMACK note at line 179)
- Create (test): `tests/sdk/parse-summary.test.ts` (adapted from upstream)

**Steps**

- [ ] 1. Create the test file `tests/sdk/parse-summary.test.ts` (adapted from upstream `93a30c5c8`; the fork's `parseSummary(text, sessionId?, opts?)` signature accepts the single-arg calls used here):
```ts
/**
 * Tests for parseSummary all-null guard (upstream fix for #1360).
 *
 * Validates that false-positive summary matches (no sub-tags) are rejected
 * while real summaries — even with some missing fields — are still saved.
 */
import { describe, it, expect } from 'bun:test';
import { parseSummary } from '../../src/sdk/parser.js';

describe('parseSummary', () => {
  it('returns null when no <summary> tag present', () => {
    expect(parseSummary('<observation><title>foo</title></observation>')).toBeNull();
  });

  it('returns null when <summary> has no sub-tags (false positive)', () => {
    expect(parseSummary('<observation>done <summary>some content here</summary></observation>')).toBeNull();
  });

  it('returns null for bare <summary> with only plain text, no sub-tags', () => {
    expect(parseSummary('<summary>This session was productive.</summary>')).toBeNull();
  });

  it('returns summary when at least one sub-tag is present (respects maintainer note)', () => {
    const result = parseSummary('<summary><request>Fix the bug</request></summary>');
    expect(result).not.toBeNull();
    expect(result?.request).toBe('Fix the bug');
    expect(result?.investigated).toBeNull();
    expect(result?.learned).toBeNull();
  });

  it('returns full summary when all fields are present', () => {
    const text = `<summary>
      <request>Fix login bug</request>
      <investigated>Auth flow and JWT expiry</investigated>
      <learned>Token was expiring too soon</learned>
      <completed>Extended token TTL to 24h</completed>
      <next_steps>Monitor error rates</next_steps>
    </summary>`;
    const result = parseSummary(text);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('Fix login bug');
    expect(result?.investigated).toBe('Auth flow and JWT expiry');
    expect(result?.learned).toBe('Token was expiring too soon');
    expect(result?.completed).toBe('Extended token TTL to 24h');
    expect(result?.next_steps).toBe('Monitor error rates');
  });

  it('returns null when skip_summary tag is present', () => {
    expect(parseSummary('<skip_summary reason="no work done"/>')).toBeNull();
  });
});
```

- [ ] 2. Run the test, see it FAIL on the no-sub-tags cases (current code returns an all-null object, not null):
```
bun test tests/sdk/parse-summary.test.ts
```
Expected: the "no sub-tags" / "bare <summary> plain text" tests FAIL (received a non-null object); the all-fields-present and skip cases pass.

- [ ] 3. Implement. In `src/sdk/parser.ts`, insert the guard between the VerbatimEcho throw (ends line 177) and the THEDOTMACK note (line 179). OLD block (lines 173-179):
```ts
  if (request && opts?.userRequest && isVerbatimEcho(request, opts.userRequest)) {
    throw new VerbatimEchoRejectionError(
      '<request> field is a verbatim/near-verbatim echo of <user_request>. Rejecting to force retry with stronger prompting.',
    );
  }

  // NOTE FROM THEDOTMACK: 100% of the time we must SAVE the summary, even if fields are missing. 10/24/2025
```
NEW block:
```ts
  if (request && opts?.userRequest && isVerbatimEcho(request, opts.userRequest)) {
    throw new VerbatimEchoRejectionError(
      '<request> field is a verbatim/near-verbatim echo of <user_request>. Rejecting to force retry with stronger prompting.',
    );
  }

  // Guard: if NO sub-tags matched at all, the <summary> match is a false positive
  // (e.g. <summary> appeared inside an observation response with only plain text).
  // This is NOT the same as missing SOME fields (intentionally allowed below per
  // the maintainer note). Upstream fix for #1360.
  if (!request && !investigated && !learned && !completed && !next_steps) {
    logger.warn('PARSER', 'Summary match has no sub-tags — skipping false positive', { sessionId });
    return null;
  }

  // NOTE FROM THEDOTMACK: 100% of the time we must SAVE the summary, even if fields are missing. 10/24/2025
```

- [ ] 4. Run the test, see it PASS:
```
bun test tests/sdk/parse-summary.test.ts
```
Expected: all 6 tests pass. (`extractField` returns `null` for missing/empty fields — confirmed at parser.ts:218-219 — so the `!field` checks are exact. `notes` is intentionally excluded from the guard, matching upstream: a summary that has only `<notes>` is still treated as a false positive.)

- [ ] 5. Commit:
```
git add src/sdk/parser.ts tests/sdk/parse-summary.test.ts
git commit -m "fix(parser): skip summary false positives with no sub-tags

Upstream: thedotmack/claude-mem@93a30c5c (AGPL-3.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: concept-log-debug — downgrade concept-cleanup log from error to debug

Stripping the observation type from the concepts array is routine data normalization, not an error. Change `logger.error` → `logger.debug` at `src/sdk/parser.ts:78` (the only line). Upstream `29ef3f560` (AGPL-3.0). One-line change; the verification is a typecheck plus the logger-usage-standards suite (parser.ts already imports `logger`, so no coverage-gate impact).

**Files**
- Modify: `src/sdk/parser.ts` (line 78, inside `parseObservations`)

**Steps**

- [ ] 1. Confirm anchor by reading `src/sdk/parser.ts` lines 77-84. Current:
```ts
    if (cleanedConcepts.length !== concepts.length) {
      logger.error('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
    }
```

- [ ] 2. Apply the one-line change. OLD:
```ts
      logger.error('PARSER', 'Removed observation type from concepts array', {
```
NEW:
```ts
      logger.debug('PARSER', 'Removed observation type from concepts array', {
```

- [ ] 3. Verify it typechecks and the logger-usage standards still hold:
```
bun test tests/logger-usage-standards.test.ts tests/sdk/parse-summary.test.ts
```
Expected: all pass (no behavior change beyond log level).

- [ ] 4. Commit:
```
git add src/sdk/parser.ts
git commit -m "fix(parser): downgrade concept-type cleanup log from error to debug

Upstream: thedotmack/claude-mem@29ef3f56 (AGPL-3.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: cwdtodashed-dot — encode both '/' and '.' to '-' in cwdToDashed

Claude Code encodes a project's transcript directory by replacing BOTH path separators AND dots with dashes (e.g. `/Users/john.doe/proj` → `-Users-john-doe-proj`). The fork's `cwdToDashed` replaces only `/`, so any cwd component containing a dot makes the "Include last message" lookup silently no-op. Change the regex from `/\//g` to `/[/.]/g`. Upstream `daf6d9dc0` (Apache-2.0). The function must be EXPORTED so the test can import it (upstream also exported it).

Caller note: `cwdToDashed` is a private helper, used at `ObservationCompiler.ts:205` (`const dashedCwd = cwdToDashed(cwd)`) for the transcript path join at line 207. Exporting it does not change that call site. No other callers exist (grep: only the definition at :131 and the use at :205).

**Files**
- Modify: `src/services/context/ObservationCompiler.ts` (lines 128-133)
- Create (test): `tests/context/include-last-message-dot-path.test.ts` (cwdToDashed unit tests; adapted from upstream — only the pure-function `describe`, since the fork's getPriorSessionMessages signature is not verified here)

**Steps**

- [ ] 1. Create the test file `tests/context/include-last-message-dot-path.test.ts`:
```ts
// #2401 — "Include last message" silently no-ops when a cwd component contains
// a ".". Claude Code encodes its per-project transcript directory by replacing
// BOTH path separators AND dots with dashes (e.g. /Users/john.doe/proj ->
// -Users-john-doe-proj). cwdToDashed used to replace only "/", leaving a literal
// "." in the directory name, so the transcript file was never found.
import { describe, it, expect } from 'bun:test';
import { cwdToDashed } from '../../src/services/context/ObservationCompiler.js';

describe('cwdToDashed (#2401)', () => {
  it('replaces both slashes and dots with dashes (matches Claude Code encoding)', () => {
    expect(cwdToDashed('/Users/john.doe/my-project')).toBe('-Users-john-doe-my-project');
  });

  it('still handles paths with no dots', () => {
    expect(cwdToDashed('/Users/jane/app')).toBe('-Users-jane-app');
  });

  it('encodes dotted directory components (e.g. version dirs)', () => {
    expect(cwdToDashed('/srv/app.v2.1/src')).toBe('-srv-app-v2-1-src');
  });
});
```

- [ ] 2. Run the test, see it FAIL — both because `cwdToDashed` is not exported yet AND because the dot is not replaced:
```
bun test tests/context/include-last-message-dot-path.test.ts
```
Expected: import/export failure (`cwdToDashed` not exported) — fix that first, then the dot assertions would still fail on the old regex.

- [ ] 3. Implement. In `src/services/context/ObservationCompiler.ts`, OLD block (lines 128-133):
```ts
/**
 * Convert cwd path to dashed format for transcript lookup
 */
function cwdToDashed(cwd: string): string {
  return cwd.replace(/\//g, '-');
}
```
NEW block:
```ts
/**
 * Convert cwd path to dashed format for transcript lookup.
 *
 * Claude Code encodes a project's transcript directory by replacing BOTH path
 * separators AND dots with dashes (e.g. `/Users/john.doe/proj` ->
 * `-Users-john-doe-proj`). Replacing only `/` left a literal `.` in the dir
 * name, so "Include last message" silently no-opped for any cwd component
 * containing a dot — Unix usernames like `john.doe`, dotted dirs, etc. (#2401).
 *
 * @internal Exported only so the dot-path test can import it. The sole
 *   production caller is `ObservationCompiler.ts:205`; do NOT treat this as a
 *   stable public helper (upstream also exports it solely for its test).
 */
export function cwdToDashed(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}
```

- [ ] 4. Run the test, see it PASS:
```
bun test tests/context/include-last-message-dot-path.test.ts
```
Expected: all 3 tests pass.

- [ ] 5. Run the existing observation-compiler test to confirm no regression from the export change:
```
bun test tests/context/observation-compiler.test.ts
```
Expected: all pass.

- [ ] 6. Commit:
```
git add src/services/context/ObservationCompiler.ts tests/context/include-last-message-dot-path.test.ts
git commit -m "fix(context): encode dots in cwdToDashed to match transcript dir naming

Upstream: thedotmack/claude-mem@daf6d9dc (Apache-2.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: logger-stringify-guard — wrap the debug JSON.stringify in try/catch

The debug-mode object dump at `src/utils/logger.ts:283` calls `JSON.stringify(data, null, 2)` unguarded; a circular structure throws and crashes the logger. Wrap it in try/catch and fall back to `this.formatData(data)` (defined at line 125). Only this branch changes — the date-rolling logic and other branches are untouched. Upstream `46d204ee9` (AGPL-3.0).

**Files**
- Modify: `src/utils/logger.ts` (lines 281-286, inside the private `log` method)

This branch only executes when `getLevel() === LogLevel.DEBUG`. Rather than add a test that toggles global log level (the level is cached from settings and shared across the suite — risky), verify via typecheck + the existing logger suite. Per briefing rule 5, this trivial guard may skip a new test.

**Steps**

- [ ] 1. Confirm anchor by reading `src/utils/logger.ts` lines 281-287:
```ts
      } else if (this.getLevel() === LogLevel.DEBUG && typeof data === 'object') {
        // In debug mode, show full JSON for objects
        dataStr = '\n' + JSON.stringify(data, null, 2);
      } else {
        dataStr = ' ' + this.formatData(data);
      }
```

- [ ] 2. Apply the guard. OLD block (lines 281-283):
```ts
      } else if (this.getLevel() === LogLevel.DEBUG && typeof data === 'object') {
        // In debug mode, show full JSON for objects
        dataStr = '\n' + JSON.stringify(data, null, 2);
```
NEW block:
```ts
      } else if (this.getLevel() === LogLevel.DEBUG && typeof data === 'object') {
        // In debug mode, show full JSON for objects.
        // Wrap stringify in try/catch so circular structures don't crash the
        // logger; fall back to formatData (safe array/key-count summary).
        try {
          dataStr = '\n' + JSON.stringify(data, null, 2);
        } catch {
          dataStr = ' ' + this.formatData(data);
        }
```

- [ ] 3. Verify it typechecks and the logger suite passes:
```
npm run build && bun test tests/logger-usage-standards.test.ts
```
Expected: build succeeds (no type errors); logger-usage test passes.

- [ ] 4. Commit:
```
git add src/utils/logger.ts
git commit -m "fix(logger): guard debug JSON.stringify against circular structures

Upstream: thedotmack/claude-mem@46d204ee (AGPL-3.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: remove-dead-exitcode — remove the unused USER_MESSAGE_ONLY exit code

`USER_MESSAGE_ONLY: 3` was used by the removed `user-message-hook.js`. Claude Code only honors exit codes 0 and 2; any other non-zero code is treated as a hook failure. Remove the constant at `src/shared/hook-constants.ts:27`. Keep `FAILURE: 1`. Upstream `4aa7119d7` (AGPL-3.0).

Caller note (grep verified): there are NO `.USER_MESSAGE_ONLY` property accesses anywhere in `src/` or `tests/`. Three test files (`tests/cli/hook-allowlist-guard.test.ts:44`, `tests/cli/handlers/dbpath-threading.test.ts:115`, `tests/services/transcript-processor-dbpath.test.ts:146`) define their OWN standalone mock literal `HOOK_EXIT_CODES: { ..., USER_MESSAGE_ONLY: 3 }` via `mock.module`. These are independent objects that do not import the real constant, so removing the source key does NOT break them — they keep their own literal. They are left as-is (out of scope; the extra mock key is harmless). This is flagged in notes.

**Files**
- Modify: `src/shared/hook-constants.ts` (lines 26-28)

**Steps**

- [ ] 1. Confirm anchor by reading `src/shared/hook-constants.ts` lines 21-28:
```ts
export const HOOK_EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  /** Blocking error - for SessionStart, shows stderr to user only */
  BLOCKING_ERROR: 2,
  /** Show stderr to user only, don't inject into context. Used by user-message handler (Cursor). */
  USER_MESSAGE_ONLY: 3,
} as const;
```

   Then confirm the three test files define their OWN mock literal and do NOT import the real constant (so removing the source key is safe):
```
grep -rn 'USER_MESSAGE_ONLY' tests/cli/hook-allowlist-guard.test.ts tests/cli/handlers/dbpath-threading.test.ts tests/services/transcript-processor-dbpath.test.ts
grep -rn 'import.*HOOK_EXIT_CODES' tests/cli/hook-allowlist-guard.test.ts tests/cli/handlers/dbpath-threading.test.ts tests/services/transcript-processor-dbpath.test.ts
```
Expected (confirmed at write-time): each file has exactly one `HOOK_EXIT_CODES: { ..., USER_MESSAGE_ONLY: 3 }` mock literal (lines 44 / 115 / 146 respectively) and ZERO `import ... HOOK_EXIT_CODES` lines — they self-define via `mock.module`, so the source deletion does not touch them. If any file shows an `import` of `HOOK_EXIT_CODES`, do NOT delete the source key until that test's mock is updated to redefine it.

- [ ] 2. Remove the dead entry. OLD block (lines 25-27):
```ts
  BLOCKING_ERROR: 2,
  /** Show stderr to user only, don't inject into context. Used by user-message handler (Cursor). */
  USER_MESSAGE_ONLY: 3,
```
NEW block:
```ts
  BLOCKING_ERROR: 2,
```

- [ ] 3. Verify it typechecks (no consumer means no compile break) and run the three mock-bearing test files to confirm they're unaffected:
```
npm run build && bun test tests/cli/hook-allowlist-guard.test.ts tests/cli/handlers/dbpath-threading.test.ts tests/services/transcript-processor-dbpath.test.ts
```
Expected: build succeeds; all three test files pass (their mocks are self-contained).

- [ ] 4. Commit:
```
git add src/shared/hook-constants.ts
git commit -m "fix(hooks): remove dead USER_MESSAGE_ONLY exit code

Upstream: thedotmack/claude-mem@4aa7119d (AGPL-3.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: trusted-deps-treesitter — add trustedDependencies + overrides in both plugin/package.json and the generator

`bun install` fails on Node 25+ compiling tree-sitter's native bindings; claude-mem only uses the prebuilt `tree-sitter-cli` Rust binary. Add `trustedDependencies: ["tree-sitter-cli"]` AND `overrides: { "tree-sitter": "^0.25.0" }` to BOTH the checked-in `plugin/package.json` and the `pluginPackageJson` object generated by `scripts/build-hooks.js`, so the two stay in sync (the build regenerates `plugin/package.json`). Upstream `99ff296f` (AGPL-3.0). NOTE: upstream already had the `overrides` block pre-existing; the FORK has NEITHER `overrides` NOR `trustedDependencies` (verified — `plugin/package.json` jumps straight from `dependencies` to `engines`), so we add both keys. Key order matches upstream: `overrides` then `trustedDependencies` then `engines`, in both files.

**Files**
- Modify: `plugin/package.json` (checked-in; lines 17-22)
- Modify: `scripts/build-hooks.js` (`pluginPackageJson` object, lines 55-77)

**Steps**

- [ ] 1. Confirm anchors. `plugin/package.json` currently ends the deps block then jumps straight to `engines` (lines 17-22):
```json
    "tree-sitter-typescript": "^0.23.2"
  },
  "engines": {
    "node": ">=18.0.0",
    "bun": ">=1.0.0"
  }
}
```
And `scripts/build-hooks.js` `pluginPackageJson` (lines 71-77):
```js
        'tree-sitter-typescript': '^0.23.2',
      },
      engines: {
        node: '>=18.0.0',
        bun: '>=1.0.0'
      }
    };
```

- [ ] 2. Edit `plugin/package.json` — insert `overrides` and `trustedDependencies` between the `dependencies` block close and `engines`. OLD block (lines 17-19):
```json
    "tree-sitter-typescript": "^0.23.2"
  },
  "engines": {
```
NEW block:
```json
    "tree-sitter-typescript": "^0.23.2"
  },
  "overrides": {
    "tree-sitter": "^0.25.0"
  },
  "trustedDependencies": [
    "tree-sitter-cli"
  ],
  "engines": {
```

- [ ] 3. Edit `scripts/build-hooks.js` — mirror the same keys into the generated object so the next build regenerates `plugin/package.json` identically. OLD block (lines 71-74):
```js
        'tree-sitter-typescript': '^0.23.2',
      },
      engines: {
        node: '>=18.0.0',
```
NEW block:
```js
        'tree-sitter-typescript': '^0.23.2',
      },
      overrides: {
        'tree-sitter': '^0.25.0'
      },
      trustedDependencies: [
        'tree-sitter-cli'
      ],
      engines: {
        node: '>=18.0.0',
```

- [ ] 4. Verify the two stay in sync. First do a static source-level check that the GENERATOR itself emits both keys (this catches divergence before any build runs, since `plugin/package.json` is a regenerated artifact and the generator is the source of truth):
```
grep -n "overrides:\|'tree-sitter':\|trustedDependencies:\|'tree-sitter-cli'" scripts/build-hooks.js
```
Expected: the `pluginPackageJson` object contains `overrides:` → `'tree-sitter': '^0.25.0'` and `trustedDependencies:` → `'tree-sitter-cli'`. If either is missing from the generator, Step 3 was not applied — re-do it before building.

   Then run the build and confirm the regenerated file matches. Because `build-hooks.js` rewrites `plugin/package.json`, the regenerated file must contain both new keys exactly:
```
npm run build
grep -A4 '"overrides"' plugin/package.json
grep -A3 '"trustedDependencies"' plugin/package.json
```
Expected: build succeeds; `plugin/package.json` shows `"overrides": { "tree-sitter": "^0.25.0" }` and `"trustedDependencies": [ "tree-sitter-cli" ]`. If the generator output differs from the hand-edit, the generator is the source of truth — re-check Step 3. (Note: the generator also rewrites the `version` field from the build version, which is expected and unrelated to this change.)

- [ ] 5. Commit (include the regenerated plugin/package.json):
```
git add plugin/package.json scripts/build-hooks.js
git commit -m "fix(build): skip tree-sitter native build via trustedDependencies allowlist

Upstream: thedotmack/claude-mem@99ff296f (AGPL-3.0)
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Chunk wrap-up

- [ ] After all 9 commits, run the full suite once to confirm the chunk introduced no cross-file regression:
```
find "$PWD/tests" -type f \( -name '*.test.ts' -o -name '*test.ts' \) -print0 | xargs -0 bun test
```
Expected: all root tests pass, 0 fail (implementation-day baseline + this chunk's parse-summary, dot-path, schema-probe, and one transactions test, plus is net-neutral or net-positive on counts).


---


---

## Chunk 7: P2 功能/增强 (features)

Four logical items. Order matters for the bypass items (Task 2 generic base-url MUST land before Task 3 OpenRouter removal). Tasks 1 and 4 are independent.

**License determination (verified via `git -C <clone> merge-base --is-ancestor 36b0929f <hash>`):**
- `7e072106` (context-compression) → exit 1 → **AGPL-3.0**
- `d13fc437` (bypass base-url) → exit 0 → **Apache-2.0**
- `65607897` (write-json-atomic) → exit 1 → **AGPL-3.0**
- `09e74bbf` (weekly-digests) → exit 0 → **Apache-2.0**
- Task 3 is fork-original cleanup (no upstream hash, no provenance trailer).

Clone for diffs: `/Users/shinewine/Coding/proj-claude-mem/attn_sink/upstream-claude-mem`.

**Build note:** `npm run build` uses esbuild (transpile + bundle), NOT `tsc`. It catches unresolved imports / syntax / duplicate-identifier errors, but does NOT fully type-check. Where steps below say "no TS errors," read it as "no esbuild resolution/syntax errors." `npm run build` also runs `scripts/verify-settings-alignment.ts`, which compares FRONTEND `DEFAULT_SETTINGS` keys against BACKEND `SettingsDefaultsManager` (phantom-key + value-mismatch gate).

---

### Task 1: Compress markdown context output (flat lines, no tables) — keep `# [project] recent context` header

Port upstream `7e072106`'s markdown compaction into `MarkdownFormatter.ts` and the markdown/color split in `TimelineRenderer.ts`. **DO NOT carry the `$CMEM` header** — keep our existing `# [project] recent context, <datetime>` header and `# [project] recent context` empty-state. The color/terminal path is unchanged (ColorFormatter.ts functions all exist and are not touched). The `full=true` backend path is already present in our fork (ContextBuilder.ts:143, SearchRoutes.ts:265) — do NOT re-port it.

**Files:**
- Modify: `src/services/context/formatters/MarkdownFormatter.ts`
- Modify: `src/services/context/sections/TimelineRenderer.ts`
- Test (rewrite): `tests/context/formatters/markdown-formatter.test.ts`

Steps:

- [ ] **1.1 — Update the failing tests first (RED).** The existing test file asserts the OLD verbose format (tables, `**Legend:**`, `**Column Key**`, `**Context Index:**`, `**#42**`, `25 observations`). Rewrite the affected `describe` blocks in `tests/context/formatters/markdown-formatter.test.ts` to assert the NEW compact format. Keep the header tests AS-IS (we keep `# [project] recent context`). Replace these blocks:

  `renderMarkdownLegend` block (OLD asserts `**Legend:**` + `session-request`). The NEW legend returns EXACTLY 4 elements (`Legend: ...`, `Format: ...`, `Fetch details: ...`, `''`), so assert the exact length:
  ```typescript
  describe('renderMarkdownLegend', () => {
    it('should produce compact legend with format + fetch lines', () => {
      const result = renderMarkdownLegend();
      expect(result).toHaveLength(4);
      expect(result[0]).toContain('Legend:');
      expect(result[0]).toContain('🎯session');
      expect(result[1]).toBe('Format: ID TIME TYPE TITLE');
      expect(result[2]).toContain('get_observations');
      expect(result[2]).toContain('mem-search');
      expect(result[3]).toBe('');
    });
  });
  ```

  `renderMarkdownColumnKey` block (OLD asserts `**Column Key**`):
  ```typescript
  describe('renderMarkdownColumnKey', () => {
    it('returns empty array in compact format', () => {
      expect(renderMarkdownColumnKey()).toEqual([]);
    });
  });
  ```

  `renderMarkdownContextIndex` block (OLD asserts `**Context Index:**`):
  ```typescript
  describe('renderMarkdownContextIndex', () => {
    it('returns empty array in compact format (folded into legend)', () => {
      expect(renderMarkdownContextIndex()).toEqual([]);
    });
  });
  ```

  `renderMarkdownContextEconomics` block — replace its assertions to match the new `Stats: ...` line:
  ```typescript
  describe('renderMarkdownContextEconomics', () => {
    it('should include observation count and read tokens', () => {
      const economics = createTestEconomics({ totalObservations: 25, totalReadTokens: 1500 });
      const config = createTestConfig();
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).toContain('Stats:');
      expect(joined).toContain('25 obs');
      expect(joined).toContain('1,500t read');
    });

    it('should include work tokens', () => {
      const economics = createTestEconomics({ totalDiscoveryTokens: 10000 });
      const config = createTestConfig();
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).toContain('10,000t work');
    });

    it('should show saved amount when only showSavingsAmount', () => {
      const economics = createTestEconomics({ savings: 4500, savingsPercent: 90, totalDiscoveryTokens: 5000 });
      const config = createTestConfig({ showSavingsAmount: true, showSavingsPercent: false });
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).toContain('4,500t saved');
    });

    it('should show savings percent when showSavingsPercent', () => {
      const economics = createTestEconomics({ savingsPercent: 85, totalDiscoveryTokens: 1000 });
      const config = createTestConfig({ showSavingsAmount: false, showSavingsPercent: true });
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).toContain('85% savings');
    });

    it('should not show savings when discovery tokens is 0', () => {
      const economics = createTestEconomics({ totalDiscoveryTokens: 0, savings: 0, savingsPercent: 0 });
      const config = createTestConfig({ showSavingsAmount: true, showSavingsPercent: true });
      const joined = renderMarkdownContextEconomics(economics, config).join('\n');
      expect(joined).not.toContain('saved');
      expect(joined).not.toContain('savings');
    });
  });
  ```

  `renderMarkdownDayHeader` block — OLD asserts length 2 with trailing `''`; NEW has no trailing blank:
  ```typescript
  describe('renderMarkdownDayHeader', () => {
    it('should render day as h3 heading without trailing blank', () => {
      const result = renderMarkdownDayHeader('2025-01-01');
      expect(result).toEqual(['### 2025-01-01']);
    });
  });
  ```

  `renderMarkdownFileHeader` block — NEW returns `[]`:
  ```typescript
  describe('renderMarkdownFileHeader', () => {
    it('returns empty array in compact format (no table headers)', () => {
      expect(renderMarkdownFileHeader('src/index.ts')).toEqual([]);
    });
  });
  ```

  `renderMarkdownTableRow` block — NEW is a flat line `ID time icon title` (no pipes, no `#` prefix, no token columns):
  ```typescript
  describe('renderMarkdownTableRow', () => {
    it('should produce a flat line with id time icon title', () => {
      const obs = createTestObservation({ id: 42, title: 'Important Discovery' });
      const config = createTestConfig();
      const result = renderMarkdownTableRow(obs, '10:30 AM', config);
      expect(result).toContain('42');
      expect(result).toContain('Important Discovery');
      expect(result).not.toContain('|');
    });

    it('should compact AM/PM in time', () => {
      const obs = createTestObservation();
      const config = createTestConfig();
      expect(renderMarkdownTableRow(obs, '10:30 AM', config)).toContain('10:30a');
      expect(renderMarkdownTableRow(obs, '2:05 PM', config)).toContain('2:05p');
    });

    it('should use "Untitled" when title is null', () => {
      const obs = createTestObservation({ title: null });
      const config = createTestConfig();
      expect(renderMarkdownTableRow(obs, '10:00 AM', config)).toContain('Untitled');
    });

    it('should use quote mark for repeated (empty) time', () => {
      const obs = createTestObservation();
      const config = createTestConfig();
      expect(renderMarkdownTableRow(obs, '', config)).toContain('"');
    });
  });
  ```

  `renderMarkdownFullObservation` "token info" test — NEW uses `~Nt` and bare discoveryDisplay (no `Read:`/`Work:` labels). Replace ONLY that one `it`:
  ```typescript
    it('should include token info when enabled', () => {
      const obs = createTestObservation({ discovery_tokens: 250 });
      const config = createTestConfig({ showReadTokens: true, showWorkTokens: true });
      const joined = renderMarkdownFullObservation(obs, '10:00 AM', null, config).join('\n');
      expect(joined).toContain('~');
      expect(joined).toContain('t');
    });
  ```
  Also update the "should include observation ID and title" test: NEW prefix is `**7**` not `**#7**`:
  ```typescript
    it('should include observation ID and title', () => {
      const obs = createTestObservation({ id: 7, title: 'Full Observation' });
      const config = createTestConfig();
      const joined = renderMarkdownFullObservation(obs, '10:00 AM', 'Detail content', config).join('\n');
      expect(joined).toContain('**7**');
      expect(joined).toContain('**Full Observation**');
    });
  ```

  `renderMarkdownSummaryItem` "session ID" test — NEW prefix is `S5` not `**#S5**`, AND the time is now compacted (see 1.3(j)). Use a verbose `formattedTime` and assert the compacted output:
  ```typescript
    it('should include session ID with S prefix and compacted time', () => {
      const summary = { id: 5, request: 'Implement feature' };
      const joined = renderMarkdownSummaryItem(summary, '10:00 AM').join('\n');
      expect(joined).toContain('S5');
      expect(joined).toContain('10:00a'); // compactTime applied to summary time too (uniform format)
    });
  ```
  Keep the `renderMarkdownHeader`, `renderMarkdownSummaryField`, `renderMarkdownPreviouslySection`, `renderMarkdownFooter`, `renderMarkdownEmptyState` blocks UNCHANGED — but DELETE the footer test `should mention claude-mem skill` assertion of `claude-mem` (the new footer text drops the word "claude-mem"; see 1.3). Replace it with:
  ```typescript
    it('should mention get_observations and mem-search', () => {
      const joined = renderMarkdownFooter(5000, 100).join('\n');
      expect(joined).toContain('get_observations');
      expect(joined).toContain('mem-search');
    });
  ```

- [ ] **1.2 — Run the rewritten test, see it FAIL.**
  ```bash
  bun test tests/context/formatters/markdown-formatter.test.ts
  ```
  Expected: multiple failures (e.g. `expect(received).toContain("Stats:")` and `renderMarkdownColumnKey toEqual []`) because the source still emits the old verbose format.

- [ ] **1.3 — Apply the MarkdownFormatter compaction (GREEN).** In `src/services/context/formatters/MarkdownFormatter.ts`:

  (a) Leave `renderMarkdownHeader` (line 35-40) EXACTLY as-is — keep `# [${project}] recent context, ${formatHeaderDateTime()}`. Do NOT change to `$CMEM`.

  (b) `renderMarkdownLegend` (lines 45-53) — OLD:
  ```typescript
  export function renderMarkdownLegend(): string[] {
    const mode = ModeManager.getInstance().getActiveMode();
    const typeLegendItems = mode.observation_types.map(t => `${t.emoji} ${t.id}`).join(' | ');

    return [
      `**Legend:** session-request | ${typeLegendItems}`,
      ''
    ];
  }
  ```
  NEW:
  ```typescript
  export function renderMarkdownLegend(): string[] {
    const mode = ModeManager.getInstance().getActiveMode();
    const typeLegendItems = mode.observation_types.map(t => `${t.emoji}${t.id}`).join(' ');

    return [
      `Legend: 🎯session ${typeLegendItems}`,
      `Format: ID TIME TYPE TITLE`,
      `Fetch details: get_observations([IDs]) | Search: mem-search skill`,
      ''
    ];
  }
  ```

  (c) `renderMarkdownColumnKey` (lines 58-65) — OLD body returns the 3-line Column Key. NEW:
  ```typescript
  export function renderMarkdownColumnKey(): string[] {
    return [];
  }
  ```

  (d) `renderMarkdownContextIndex` (lines 70-80) — OLD returns the multi-line Context Index. NEW:
  ```typescript
  export function renderMarkdownContextIndex(): string[] {
    return [];
  }
  ```

  (e) `renderMarkdownContextEconomics` (lines 85-109) — replace the body. OLD body builds `**Context Economics**:` multi-line. NEW (keep the function signature with `economics: TokenEconomics, config: ContextConfig`):
  ```typescript
  export function renderMarkdownContextEconomics(
    economics: TokenEconomics,
    config: ContextConfig
  ): string[] {
    const output: string[] = [];

    const parts: string[] = [
      `${economics.totalObservations} obs (${economics.totalReadTokens.toLocaleString()}t read)`,
      `${economics.totalDiscoveryTokens.toLocaleString()}t work`
    ];

    if (economics.totalDiscoveryTokens > 0 && (config.showSavingsAmount || config.showSavingsPercent)) {
      if (config.showSavingsPercent) {
        parts.push(`${economics.savingsPercent}% savings`);
      } else if (config.showSavingsAmount) {
        parts.push(`${economics.savings.toLocaleString()}t saved`);
      }
    }

    output.push(`Stats: ${parts.join(' | ')}`);
    output.push('');

    return output;
  }
  ```

  (f) `renderMarkdownDayHeader` (lines 114-119) — OLD returns `['### ' + day, '']`. NEW (drop the trailing blank):
  ```typescript
  export function renderMarkdownDayHeader(day: string): string[] {
    return [
      `### ${day}`,
    ];
  }
  ```

  (g) `renderMarkdownFileHeader` (lines 124-130) — OLD returns the bold filename + table-header rows. NEW (rename param to `_file`, return empty; ADD the `compactTime` helper right after this function):
  ```typescript
  export function renderMarkdownFileHeader(_file: string): string[] {
    // File grouping eliminated in compact format - file context is in observation titles
    return [];
  }

  /**
   * Format compact time: "9:23 AM" -> "9:23a", "12:05 PM" -> "12:05p"
   */
  function compactTime(time: string): string {
    return time.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
  }
  ```

  (h) `renderMarkdownTableRow` (lines 135-148) — OLD builds a `| ... |` pipe row with token columns. NEW (rename `config` to `_config`):
  ```typescript
  export function renderMarkdownTableRow(
    obs: Observation,
    timeDisplay: string,
    _config: ContextConfig
  ): string {
    const title = obs.title || 'Untitled';
    const icon = ModeManager.getInstance().getTypeIcon(obs.type);
    const time = timeDisplay ? compactTime(timeDisplay) : '"';

    return `${obs.id} ${time} ${icon} ${title}`;
  }
  ```

  (i) `renderMarkdownFullObservation` (lines 153-184) — OLD prefixes `**#${obs.id}**`, pads blank lines around detail, and labels tokens `Read:`/`Work:`. NEW (keep signature; replace the whole body). NOTE: `formatObservationTokenDisplay` is STILL imported (line 15) and STILL used here — only the `renderMarkdownTableRow` call to it was dropped; do NOT remove the import:
  ```typescript
  export function renderMarkdownFullObservation(
    obs: Observation,
    timeDisplay: string,
    detailField: string | null,
    config: ContextConfig
  ): string[] {
    const output: string[] = [];
    const title = obs.title || 'Untitled';
    const icon = ModeManager.getInstance().getTypeIcon(obs.type);
    const time = timeDisplay ? compactTime(timeDisplay) : '"';
    // formatObservationTokenDisplay stays imported & used here (removed only from renderMarkdownTableRow)
    const { readTokens, discoveryDisplay } = formatObservationTokenDisplay(obs, config);

    output.push(`**${obs.id}** ${time} ${icon} **${title}**`);
    if (detailField) {
      output.push(detailField);
    }

    const tokenParts: string[] = [];
    if (config.showReadTokens) {
      tokenParts.push(`~${readTokens}t`);
    }
    if (config.showWorkTokens) {
      tokenParts.push(discoveryDisplay);
    }
    if (tokenParts.length > 0) {
      output.push(tokenParts.join(' '));
    }
    output.push('');

    return output;
  }
  ```

  (j) `renderMarkdownSummaryItem` (lines 189-198) — OLD returns `**#S${id}** title (time)` + blank. NEW wraps `formattedTime` in `compactTime` so summary times match observation-row times (uniform compact format; without this, summaries leak the verbose `formatDateTime` " AM"/" PM" form — see 1.4 note):
  ```typescript
  export function renderMarkdownSummaryItem(
    summary: { id: number; request: string | null },
    formattedTime: string
  ): string[] {
    return [
      `S${summary.id} ${summary.request || 'Session started'} (${compactTime(formattedTime)})`,
    ];
  }
  ```

  (k) `renderMarkdownFooter` (lines 228-234) — OLD second line mentions "claude-mem skill". NEW:
  ```typescript
  export function renderMarkdownFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
    const workTokensK = Math.round(totalDiscoveryTokens / 1000);
    return [
      '',
      `Access ${workTokensK}k tokens of past work via get_observations([IDs]) or mem-search skill.`
    ];
  }
  ```

  (l) `renderMarkdownEmptyState` (lines 239-241) — KEEP the `# [${project}] recent context` form (do NOT use `$CMEM`). OLD message says "No previous sessions found for this project yet." Leave it UNCHANGED.

  Also update the file's top doc comment (lines 1-5) to the upstream wording but keep it accurate — change nothing functional. (Optional; leave as-is is acceptable since it's a comment.)

- [ ] **1.4 — Split TimelineRenderer into markdown/color paths.** In `src/services/context/sections/TimelineRenderer.ts`, replace the single `renderDayTimeline` (lines 55-150) with three functions. OLD: one `renderDayTimeline(day, dayItems, fullObservationIds, config, cwd, useColors)` that branches on `useColors` inside a shared `tableOpen` loop. NEW (paste these three in place of the OLD lines 52-150):
  ```typescript
  /**
   * Render a single day's timeline items (markdown/LLM mode - flat compact lines)
   *
   * Note: the markdown path intentionally has NO file grouping (unlike the color
   * path below). Context is flat lines; file info lives in the observation titles,
   * so there is no `currentFile` tracking here on purpose.
   */
  function renderDayTimelineMarkdown(
    day: string,
    dayItems: TimelineItem[],
    fullObservationIds: Set<number>,
    config: ContextConfig,
  ): string[] {
    const output: string[] = [];

    output.push(...Markdown.renderMarkdownDayHeader(day));

    let lastTime = '';

    for (const item of dayItems) {
      if (item.type === 'summary') {
        lastTime = '';

        const summary = item.data as SummaryTimelineItem;
        // formatDateTime returns a verbose "Mon DD, H:MM AM/PM"; renderMarkdownSummaryItem
        // compacts it via compactTime so summary times match the flat row times.
        const formattedTime = formatDateTime(summary.displayTime);
        output.push(...Markdown.renderMarkdownSummaryItem(summary, formattedTime));
      } else {
        const obs = item.data as Observation;
        const time = formatTime(obs.created_at);
        const showTime = time !== lastTime;
        const timeDisplay = showTime ? time : '';
        lastTime = time;

        const shouldShowFull = fullObservationIds.has(obs.id);

        if (shouldShowFull) {
          const detailField = getDetailField(obs, config);
          output.push(...Markdown.renderMarkdownFullObservation(obs, timeDisplay, detailField, config));
        } else {
          output.push(Markdown.renderMarkdownTableRow(obs, timeDisplay, config));
        }
      }
    }

    return output;
  }

  /**
   * Render a single day's timeline items (color/terminal mode - file grouped with tables)
   */
  function renderDayTimelineColor(
    day: string,
    dayItems: TimelineItem[],
    fullObservationIds: Set<number>,
    config: ContextConfig,
    cwd: string,
  ): string[] {
    const output: string[] = [];

    output.push(...Color.renderColorDayHeader(day));

    let currentFile: string | null = null;
    let lastTime = '';

    for (const item of dayItems) {
      if (item.type === 'summary') {
        currentFile = null;
        lastTime = '';

        const summary = item.data as SummaryTimelineItem;
        const formattedTime = formatDateTime(summary.displayTime);
        output.push(...Color.renderColorSummaryItem(summary, formattedTime));
      } else {
        const obs = item.data as Observation;
        const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);
        const time = formatTime(obs.created_at);
        const showTime = time !== lastTime;
        lastTime = time;

        const shouldShowFull = fullObservationIds.has(obs.id);

        if (file !== currentFile) {
          output.push(...Color.renderColorFileHeader(file));
          currentFile = file;
        }

        if (shouldShowFull) {
          const detailField = getDetailField(obs, config);
          output.push(...Color.renderColorFullObservation(obs, time, showTime, detailField, config));
        } else {
          output.push(Color.renderColorTableRow(obs, time, showTime, config));
        }
      }
    }

    output.push('');

    return output;
  }

  /**
   * Render a single day's timeline items
   */
  export function renderDayTimeline(
    day: string,
    dayItems: TimelineItem[],
    fullObservationIds: Set<number>,
    config: ContextConfig,
    cwd: string,
    useColors: boolean
  ): string[] {
    if (useColors) {
      return renderDayTimelineColor(day, dayItems, fullObservationIds, config, cwd);
    }
    return renderDayTimelineMarkdown(day, dayItems, fullObservationIds, config);
  }
  ```
  Note: `renderTimeline` (lines 155-170) calls `renderDayTimeline(...)` with the same 6-arg signature — UNCHANGED, still correct. The color path keeps `currentFile` tracking (file-grouped tables); the markdown path deliberately omits it (asymmetry is intentional, documented in the markdown function's doc comment).

- [ ] **1.5 — Run the formatter test, see it PASS.**
  ```bash
  bun test tests/context/formatters/markdown-formatter.test.ts
  ```
  Expected: all tests in this file pass (0 fail).

- [ ] **1.5b — Grep for old verbose substrings across all context tests BEFORE running the suite.** This makes the "no other test pins the old format" claim explicit rather than a passive defensive note:
  ```bash
  grep -rn "\*\*Legend:\*\*\|\*\*Column Key\*\*\|\*\*Context Index:\*\*\|| ID |\|claude-mem skill\|\*\*#" \
    tests/context/ tests/services/context/ || true
  ```
  Expected: ZERO matches OUTSIDE the markdown-formatter.test.ts you just rewrote. If any other file matches, update those assertions to the new compact strings the same way as 1.1 and list each change in the commit body.

- [ ] **1.6 — Run the context-builder integration tests to catch downstream breakage.** Run the whole context suite:
  ```bash
  bun test tests/services/context/
  ```
  Expected: pass. (Verified during plan authoring: `tests/services/context/context-builder-full.test.ts` only asserts the `input.full` flag — it has NO markdown-format string assertions — and the other files in this dir are retention tests; none pin the old verbose substrings. Step 1.5b confirms this with a grep rather than relying on the claim.)

- [ ] **1.7 — Type/bundle check.**
  ```bash
  npm run build
  ```
  Expected: build succeeds, no esbuild resolution/syntax errors. The `_file`/`_config` renames are accounted for, and `formatObservationTokenDisplay` is still imported and used by `renderMarkdownFullObservation` (only its `renderMarkdownTableRow` call was removed), so the import stays.

- [ ] **1.8 — Commit.**
  ```bash
  git add src/services/context/formatters/MarkdownFormatter.ts \
          src/services/context/sections/TimelineRenderer.ts \
          tests/context/formatters/markdown-formatter.test.ts
  git commit -m "feat(context): compress markdown context output to flat lines

Tables -> flat 'ID time icon title' lines; drop Column Key / Context Index /
table headers; terse Stats line. Split TimelineRenderer into markdown (flat)
and color (file-grouped) paths. Compact summary times to match row times.
Keep the '# [project] recent context' header (no \$CMEM). Color/terminal
output unchanged.

Upstream: thedotmack/claude-mem@7e072106 (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: Generic OpenAI-compatible base-URL resolver for the OpenCode bypass path

Port upstream `d13fc437`'s standalone base-URL resolver (generalized name), add ONE generic setting, and route the hardcoded OpenCode fetch URLs through it. This makes the OpenCode bypass path point at any OpenAI-compatible endpoint (DeepSeek / LM Studio / custom gateway). **We deliberately do NOT add a `CLAUDE_MEM_OPENROUTER_BASE_URL` key** — OpenRouter is being removed entirely in Task 3, so the only override is the provider-agnostic `CLAUDE_MEM_OPENCODE_BASE_URL`.

**Files:**
- Create: `src/shared/openai-compatible-base-url.ts`
- Modify: `src/shared/SettingsDefaultsManager.ts` (interface + DEFAULTS)
- Modify: `src/services/worker/BypassLane.ts` (probe URL line 498, callRestApi URL line 913)
- Test (new): `tests/shared/openai-compatible-base-url.test.ts`

Steps:

- [ ] **2.1 — Write the resolver test (RED).** New file `tests/shared/openai-compatible-base-url.test.ts`. Import pattern matches sibling unit tests (`import { describe, it, expect } from 'bun:test'`):
  ```typescript
  import { describe, it, expect } from 'bun:test';
  import {
    DEFAULT_OPENCODE_API_URL,
    resolveOpenAICompatibleChatCompletionsUrl,
  } from '../../src/shared/openai-compatible-base-url.js';

  describe('resolveOpenAICompatibleChatCompletionsUrl', () => {
    it('returns the provided default when base URL is unset/blank', () => {
      expect(resolveOpenAICompatibleChatCompletionsUrl('', DEFAULT_OPENCODE_API_URL)).toBe(DEFAULT_OPENCODE_API_URL);
      expect(resolveOpenAICompatibleChatCompletionsUrl(undefined, DEFAULT_OPENCODE_API_URL)).toBe(DEFAULT_OPENCODE_API_URL);
      expect(resolveOpenAICompatibleChatCompletionsUrl('   ', DEFAULT_OPENCODE_API_URL)).toBe(DEFAULT_OPENCODE_API_URL);
    });

    it('uses a full chat-completions URL verbatim', () => {
      const full = 'https://api.deepseek.com/v1/chat/completions';
      expect(resolveOpenAICompatibleChatCompletionsUrl(full, DEFAULT_OPENCODE_API_URL)).toBe(full);
    });

    it('strips a trailing slash from a full chat-completions URL', () => {
      // Documents the normalization branch: trailing slash is stripped before the
      // ".../chat/completions" suffix check, so the result has no trailing slash.
      const fullWithSlash = 'https://api.deepseek.com/v1/chat/completions/';
      expect(resolveOpenAICompatibleChatCompletionsUrl(fullWithSlash, DEFAULT_OPENCODE_API_URL))
        .toBe('https://api.deepseek.com/v1/chat/completions');
    });

    it('appends /chat/completions to a base URL', () => {
      expect(resolveOpenAICompatibleChatCompletionsUrl('https://api.deepseek.com/v1', DEFAULT_OPENCODE_API_URL))
        .toBe('https://api.deepseek.com/v1/chat/completions');
    });

    it('normalizes trailing slashes before appending', () => {
      expect(resolveOpenAICompatibleChatCompletionsUrl('http://localhost:1234/v1/', DEFAULT_OPENCODE_API_URL))
        .toBe('http://localhost:1234/v1/chat/completions');
    });

    it('exports the OpenCode Go default endpoint', () => {
      expect(DEFAULT_OPENCODE_API_URL).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    });
  });
  ```

- [ ] **2.2 — Run it, see it FAIL.**
  ```bash
  bun test tests/shared/openai-compatible-base-url.test.ts
  ```
  Expected: failure — `Cannot find module '../../src/shared/openai-compatible-base-url.js'`.

- [ ] **2.3 — Create the resolver (GREEN).** New file `src/shared/openai-compatible-base-url.ts` (generalized from upstream `src/shared/openrouter-base-url.ts`; this file has no imports — note `src/shared/` is NOT subject to the logger-usage gate, so no logger import is needed):
  ```typescript
  // SPDX-License-Identifier: Apache-2.0

  /**
   * Shared base-URL resolution for OpenAI-compatible providers.
   *
   * The bypass OpenCode path (BypassLane.ts) uses this to turn an optional
   * CLAUDE_MEM_OPENCODE_BASE_URL setting into a concrete `/chat/completions`
   * endpoint, making it a generic OpenAI-compatible client (DeepSeek, LM Studio,
   * any custom gateway). Default behavior is unchanged when the setting is unset.
   *
   * Generalized from upstream thedotmack/claude-mem (commit d13fc437, Apache-2.0):
   * the upstream resolver was provider-specific; this version takes the default
   * endpoint as a parameter so it works for any OpenAI-compatible provider.
   * (No provider name appears in this file so the Task 3 removal grep stays clean.)
   */

  export const DEFAULT_OPENCODE_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

  const CHAT_COMPLETIONS_PATH = '/chat/completions';

  /**
   * Resolve the chat-completions endpoint from an optional configured base URL.
   *
   * Rules:
   *   - unset/blank  -> defaultUrl (behavior unchanged)
   *   - a full URL already ending in `/chat/completions` -> used verbatim
   *     (trailing slashes are stripped first, so a trailing-slash variant collapses
   *     to the no-trailing-slash form)
   *   - a base URL (e.g. `https://api.deepseek.com/v1`) -> `/chat/completions` appended
   */
  export function resolveOpenAICompatibleChatCompletionsUrl(
    baseUrl: string | undefined | null,
    defaultUrl: string,
  ): string {
    const trimmed = (baseUrl ?? '').trim();
    if (!trimmed) {
      return defaultUrl;
    }

    const normalized = trimmed.replace(/\/+$/, '');

    if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
      return normalized;
    }

    return `${normalized}${CHAT_COMPLETIONS_PATH}`;
  }
  ```

- [ ] **2.4 — Run it, see it PASS.**
  ```bash
  bun test tests/shared/openai-compatible-base-url.test.ts
  ```
  Expected: 6 pass, 0 fail.

- [ ] **2.5 — Add the single generic setting to SettingsDefaultsManager.** In `src/shared/SettingsDefaultsManager.ts`, add to the interface immediately after line 34 (`CLAUDE_MEM_OPENCODE_MAX_TOKENS: string;`):
  ```typescript
    CLAUDE_MEM_OPENCODE_BASE_URL: string;
  ```
  And add to the DEFAULTS object immediately after line 120 (`CLAUDE_MEM_OPENCODE_MAX_TOKENS: "100000", ...`):
  ```typescript
    CLAUDE_MEM_OPENCODE_BASE_URL: "", // Optional OpenAI-compatible base URL override for the OpenCode bypass path (blank = default opencode.ai endpoint)
  ```
  **Do NOT add `CLAUDE_MEM_OPENROUTER_BASE_URL`** — OpenRouter keys are being removed in Task 3.

  Verification sub-step (confirm before relying on auto-env-pickup):
  ```bash
  grep -n "applyEnvOverrides" src/shared/SettingsDefaultsManager.ts
  grep -n "Object.keys(this.DEFAULTS)\|Object.keys(DEFAULTS)" src/shared/SettingsDefaultsManager.ts
  ```
  Confirmed at write-time: `applyEnvOverrides` loops over `Object.keys(this.DEFAULTS)` (line 224) with no per-key allowlist, so `CLAUDE_MEM_OPENCODE_BASE_URL` auto-picks-up its env override without extra wiring.

  Other notes (verified during plan authoring):
  - `scripts/verify-settings-alignment.ts` (run by `npm run build`) only validates FRONTEND keys against the backend (loops over `Object.keys(DEFAULT_SETTINGS)`); adding a BACKEND-only key does NOT trigger phantom-key/mismatch errors, so the build stays green and no `src/ui/viewer/constants/settings.ts` change is required for this key.
  - `tests/shared/bypass-settings-deadcode.test.ts` only pins `CLAUDE_MEM_BYPASS_MAX_*` strings; the new key does not collide with that guard.

- [ ] **2.6 — Wire the resolver into BypassLane probe + callRestApi.** In `src/services/worker/BypassLane.ts`:

  (a) Add import immediately after line 33 (`import { storeBypassObservationsForSession } ...`):
  ```typescript
  import { resolveOpenAICompatibleChatCompletionsUrl, DEFAULT_OPENCODE_API_URL } from "../../shared/openai-compatible-base-url.js";
  ```
  (`SettingsDefaultsManager` is already imported at line 23 and `USER_SETTINGS_PATH` at line 25.)

  (b) Keep `const OPENCODE_API_URL = "https://opencode.ai/zen/go/v1/chat/completions";` (line 38) — it's now only used as the fallback default passed to the resolver. (Alternatively replace usages with `DEFAULT_OPENCODE_API_URL`; keeping the const is fine and lower-churn.)

  (c) In `probeProvider`, the OpenCode branch (currently `response = await fetch(OPENCODE_API_URL, {` at line 498). OLD:
  ```typescript
        response = await fetch(OPENCODE_API_URL, {
  ```
  NEW (resolve from settings; `this.config` is non-null here, settings reload is cheap and consistent with the rest of the file's `loadFromFile` usage):
  ```typescript
        const opencodeProbeUrl = resolveOpenAICompatibleChatCompletionsUrl(
          SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_OPENCODE_BASE_URL,
          OPENCODE_API_URL,
        );
        response = await fetch(opencodeProbeUrl, {
  ```

  (d) In `callRestApi`, the OpenCode branch (currently `const response = await fetch(OPENCODE_API_URL, {` at line 913). OLD:
  ```typescript
      const response = await fetch(OPENCODE_API_URL, {
  ```
  NEW:
  ```typescript
      const opencodeUrl = resolveOpenAICompatibleChatCompletionsUrl(
        SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_OPENCODE_BASE_URL,
        OPENCODE_API_URL,
      );
      const response = await fetch(opencodeUrl, {
  ```

- [ ] **2.7 — Verify settings-defaults guard tests + opencode bypass test still pass.** Run:
  ```bash
  bun test tests/shared/settings-defaults-manager.test.ts tests/worker/bypass-opencode.test.ts
  ```
  Expected: pass. Verified during plan authoring:
  - `settings-defaults-manager.test.ts` asserts via `getAllDefaults()` dynamically (no hardcoded key count) — adding one key does not break it. (NOTE: this same file pins `CLAUDE_MEM_OPENROUTER_API_KEY` at line 352 — that assertion is REMOVED in Task 3.7, not here.)
  - `bypass-opencode.test.ts` mocks `SettingsDefaultsManager.loadFromFile()` returning an object WITHOUT `CLAUDE_MEM_OPENCODE_BASE_URL`. After 2.6, `.CLAUDE_MEM_OPENCODE_BASE_URL` is `undefined` → resolver returns the `OPENCODE_API_URL` default → `capturedUrl` is `https://opencode.ai/zen/go/v1/chat/completions`, which still satisfies the existing assertions `expect(capturedUrl).toContain('opencode.ai')` and `expect(capturedUrl).toContain('/chat/completions')` (lines 187-188). No mock change needed.

- [ ] **2.8 — Build.**
  ```bash
  npm run build
  ```
  Expected: succeeds (settings-alignment guard passes — see 2.5 note).

- [ ] **2.9 — Commit.**
  ```bash
  git add src/shared/openai-compatible-base-url.ts \
          tests/shared/openai-compatible-base-url.test.ts \
          src/shared/SettingsDefaultsManager.ts \
          src/services/worker/BypassLane.ts
  git commit -m "feat(bypass): configurable OpenAI-compatible base URL for OpenCode path

Add resolveOpenAICompatibleChatCompletionsUrl + CLAUDE_MEM_OPENCODE_BASE_URL.
Swap the hardcoded OpenCode probe + callRestApi endpoints to the resolved value,
turning the OpenCode bypass into a generic OpenAI-compatible client (DeepSeek/
LM Studio/custom). Default behavior unchanged when unset.

Upstream: thedotmack/claude-mem@d13fc437 (Apache-2.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 3: Full OpenRouter removal — BypassLane path + settings/env/routes/UI/types sweep

Now that the OpenCode path is a generic OpenAI-compatible client (Task 2), the OpenRouter provider is fully redundant. **Remove ALL OpenRouter references** across the codebase this round (BypassLane execution path, SettingsDefaultsManager keys, EnvManager credential, SettingsRoutes validation, viewer UI, worker-types union, and the test pin). **KEEP Gemini and OpenCode providers and the generic BypassLane design** — only the OpenRouter-specific code is removed. Update the bypass tests (which use `'openrouter'` as the generic non-gemini test provider) to use `'opencode'`.

**Files:**
- Modify: `src/services/worker/BypassLane.ts`
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Modify: `src/shared/EnvManager.ts`
- Modify: `src/services/worker/http/routes/SettingsRoutes.ts`
- Modify: `src/services/worker-types.ts` (the `currentProvider` union `"claude"|"gemini"|"openrouter"|null` — drop `"openrouter"`, line 35)
- Modify: `src/ui/viewer/types.ts`
- Modify: `src/ui/viewer/constants/settings.ts`
- Modify: `src/ui/viewer/hooks/useSettings.ts`
- Modify: `src/ui/viewer/components/ContextSettingsModal.tsx`
- Modify (comment/doc wording only — required so 3.6's `grep -i openrouter src/ tests/` reaches zero):
  - `src/services/worker/agents/FallbackErrorHandler.ts:6` ("across Gemini and OpenRouter" → "across Gemini and OpenCode")
  - `src/services/worker/agents/ResponseProcessor.ts:47` (agentName example "'Gemini', 'OpenRouter'" → "'Gemini', 'OpenCode'")
  - `src/services/worker/agents/types.ts:2,110` ("SDK, Gemini, and OpenRouter agents" / "Gemini/OpenRouter to fall back" → OpenCode)
  - `src/services/worker/CLAUDE.md:12` (BypassLane description "Gemini/OpenRouter/OpenCode Go" → "Gemini/OpenCode Go")
- Modify: `tests/shared/settings-defaults-manager.test.ts`
- Modify: `tests/worker/bypass-lane.test.ts`
- Modify: `tests/worker/bypass-lane-properties.test.ts`
- Modify: `tests/worker/bypass-sliding-window.test.ts`
- Modify: `tests/worker/bypass-opencode.test.ts` (wording only)

Steps:

- [ ] **3.0 — Inventory all OpenRouter references up front (pre-check).** Before editing, capture the full live inventory so the post-edit grep in 3.6 has a baseline:
  ```bash
  grep -rn -i "openrouter" src/ tests/ | grep -v node_modules
  ```
  Expected references (confirmed at write-time): `src/services/worker/BypassLane.ts` (URL const, provider union, resolveConfig branch, probe branch, callRestApi branch, file-header comment line 5, probe comment line 497, callRestApi jsdoc line 836, error string line 904); `src/shared/SettingsDefaultsManager.ts` (6 keys + the PROVIDER comment line 21 + 2 OPENCODE "Mirrors OpenRouter" comments lines 119-120); `src/shared/EnvManager.ts` (MANAGED_CREDENTIAL_KEYS, ClaudeMemEnv type, load/save/isolate branches, passthrough comment); `src/services/worker/http/routes/SettingsRoutes.ts` (settingKeys block, validProviders, 3 validation blocks); `src/services/worker-types.ts:35`; viewer `types.ts` / `constants/settings.ts` / `hooks/useSettings.ts` / `ContextSettingsModal.tsx`; `tests/shared/settings-defaults-manager.test.ts:352`; the bypass test files (`bypass-lane.test.ts`, `bypass-lane-properties.test.ts`, `bypass-sliding-window.test.ts`, `bypass-opencode.test.ts`); and **descriptive comment/doc refs** that also count toward the zero-match grep: `src/services/worker/agents/FallbackErrorHandler.ts:6`, `src/services/worker/agents/ResponseProcessor.ts:47`, `src/services/worker/agents/types.ts:2,110`, `src/services/worker/CLAUDE.md:12` (reword to drop OpenRouter, keep Gemini/OpenCode — no logic change). NOTE: the repo-root `CLAUDE.md` also describes BypassLane as "Gemini/OpenRouter/OpenCode Go"; it is OUTSIDE the `src/ tests/` grep scope so it will not fail 3.6, but update it too for doc consistency. Anything not on this list found by the grep must be documented and decided before proceeding.

- [ ] **3.1 — Update tests first (RED).** Swap the generic test provider from `'openrouter'` to `'opencode'`, and fix the settings test pin.

  In `tests/worker/bypass-lane.test.ts`: replace every `provider: 'openrouter'` with `provider: 'opencode'` (lines 377, 432, 537, 558, 579, 610, 630, 643, 657, 688, 705, 736 — note 537 and 558 are `resolveConfig` stub overrides). Line 589 `expect(status.provider).toBe('openrouter')` → `expect(status.provider).toBe('opencode')`. The test at line 734 `does not have rate limiting for openrouter provider` → rename to `does not have rate limiting for opencode provider` and its line-741 assertion `.toBe('openrouter')` → `.toBe('opencode')`. IMPORTANT (per C7-T3-001): after the source change in 3.3, `BypassConfig.provider` no longer includes `'openrouter'`, so any stub returning `provider: 'openrouter'` would type-error. Verify with `npx tsc --noEmit` is NOT run by the build, but the bundler/`bun test` will surface a runtime mismatch — so the `'openrouter'`→`'opencode'` swap at the `resolveConfig` stub sites (537, 558) is REQUIRED, not optional. The settings stub at the top of the file (`CLAUDE_MEM_OPENROUTER_API_KEY`/`_MODEL`) should be swapped to the OpenCode equivalents (or removed) since the keys no longer exist — set `CLAUDE_MEM_OPENCODE_API_KEY`/`CLAUDE_MEM_OPENCODE_MODEL` instead. Most tests set `(lane as any).config` directly so `resolveConfig` isn't exercised, but keep the stub keys valid.

  In `tests/worker/bypass-lane-properties.test.ts`: lines 103, 415 `provider: 'openrouter'` → `provider: 'opencode'`. Line 486 `for (const provider of ['gemini', 'openrouter'] as const)` → `for (const provider of ['gemini', 'opencode'] as const)`. Lines 537-539 (secrets-redaction test) `'sk-openrouter-secret-key-67890'` and the `['gemini', 'openrouter']` loop → use `'sk-opencode-secret-key-67890'` and `['gemini', 'opencode']`.

  In `tests/worker/bypass-sliding-window.test.ts`: line 29 `CLAUDE_MEM_PROVIDER: 'openrouter'` → `'opencode'`; lines 30-31 `CLAUDE_MEM_OPENROUTER_API_KEY: 'test-key'` / `CLAUDE_MEM_OPENROUTER_MODEL: 'minimax/minimax-m2.5:free'` → `CLAUDE_MEM_OPENCODE_API_KEY: 'test-key'` / `CLAUDE_MEM_OPENCODE_MODEL: 'deepseek-v4-flash'`.

  In `tests/worker/bypass-opencode.test.ts`: line 170 test title `...and no OpenRouter headers` and line 192 comment `OpenRouter-specific headers must NOT be sent` — these reference the (now removed) openrouter headers as the thing NOT sent. Keep the assertions at lines 193-194 (they verify opencode sends no `HTTP-Referer`/`X-Title`), but update the wording to `...and no referer/title headers` (line 170) and `// referer/title headers must NOT be sent` (line 192) so it doesn't dangle a removed concept. (Assertions unchanged.)

  In `tests/shared/settings-defaults-manager.test.ts`: line 352 `expect(defaults.CLAUDE_MEM_OPENROUTER_API_KEY).toBeDefined();` — the key is removed in 3.3, so this assertion would fail. Replace it with an OpenCode-key assertion to keep meaningful provider coverage:
  ```typescript
      expect(defaults.CLAUDE_MEM_OPENCODE_API_KEY).toBeDefined();
  ```

- [ ] **3.2 — Run the bypass + settings tests, see the relevant ones FAIL.**
  ```bash
  bun test tests/worker/bypass-lane.test.ts tests/worker/bypass-lane-properties.test.ts tests/worker/bypass-sliding-window.test.ts tests/shared/settings-defaults-manager.test.ts
  ```
  Expected: failures — e.g. `status.provider` is still typed/returned with `'openrouter'` allowed but tests now expect `'opencode'`; settings-defaults still defines `CLAUDE_MEM_OPENROUTER_API_KEY` so the new `CLAUDE_MEM_OPENCODE_API_KEY` assertion may already pass (OpenCode key exists), but the source removal in 3.3 is what makes the suite internally consistent.

- [ ] **3.3 — Remove the OpenRouter execution path from BypassLane.ts (GREEN).** In `src/services/worker/BypassLane.ts`:

  (a) Remove the URL const (line 37). OLD:
  ```typescript
  const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
  ```
  NEW: delete the line entirely.

  (b) Narrow the `BypassConfig.provider` union (line 144). OLD:
  ```typescript
    provider: "gemini" | "openrouter" | "opencode";
  ```
  NEW:
  ```typescript
    provider: "gemini" | "opencode";
  ```

  (c) Remove the `resolveConfig` openrouter branch (lines 212-221). OLD:
  ```typescript
      if (provider === "openrouter") {
        const apiKey =
          settings.CLAUDE_MEM_OPENROUTER_API_KEY ||
          getCredential("OPENROUTER_API_KEY") ||
          "";
        if (!apiKey) return null;
        const model =
          settings.CLAUDE_MEM_OPENROUTER_MODEL || "minimax/minimax-m2.5:free";
        return { provider: "openrouter", apiKey, model, cooldownMs };
      }

  ```
  NEW: delete the whole block (leave the `if (provider === "opencode")` block that follows intact).

  (d) Remove the probe openrouter branch (lines 476-493). After Task 2.6 the structure is `if (gemini) {...} else if (openrouter) {...} else { ...opencode... }`. Delete the `} else if (this.config.provider === "openrouter") { ... }` arm so it reads `if (gemini) {...} else { ...opencode... }`. Verify the trailing `else` OpenCode block (now containing `opencodeProbeUrl` from Task 2.6) is preserved.

  (e) Remove the callRestApi openrouter branch (lines 877-909). Delete the `} else if (this.config.provider === "openrouter") { ... return data?.choices?.[0]?.message?.content || ""; }` arm (including its `OpenRouter API error: ...` string at line 904) so the dispatch is `if (gemini) {...} else { ...opencode... }`. Verify the OpenCode block (now using `opencodeUrl` from Task 2.6) is preserved.

  (f) Update the THREE doc comments that mention OpenRouter:
  - file header **line 5** (`Uses Gemini or OpenRouter REST API`) → `Uses Gemini or OpenCode REST API`.
  - probe OpenCode-branch comment **line 497** (`// empty content → probe fails. Skip OpenRouter-specific headers.`) → `// empty content → probe fails. No referer/title headers needed.` (this comment is INSIDE the KEPT opencode probe `else` block and would otherwise leave a stray "OpenRouter" token that fails the 3.6 grep).
  - callRestApi jsdoc **line 836** (`/** Call Gemini or OpenRouter REST API. Returns response text. */`) → `/** Call Gemini or OpenCode REST API. Returns response text. */`.

  Note: `getCredential` import (line 24) is still used by the gemini and opencode branches (`getCredential("GEMINI_API_KEY")` / `getCredential("OPENCODE_API_KEY")`) — do NOT remove the import.

- [ ] **3.3b — Remove the OpenRouter settings keys.** In `src/shared/SettingsDefaultsManager.ts`:

  (a) Interface — delete lines 25-30 (the 6 `CLAUDE_MEM_OPENROUTER_*` declarations):
  ```typescript
    CLAUDE_MEM_OPENROUTER_API_KEY: string;
    CLAUDE_MEM_OPENROUTER_MODEL: string;
    CLAUDE_MEM_OPENROUTER_SITE_URL: string;
    CLAUDE_MEM_OPENROUTER_APP_NAME: string;
    CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: string;
    CLAUDE_MEM_OPENROUTER_MAX_TOKENS: string;
  ```
  (b) Update the PROVIDER comment (line 21): `// 'claude' | 'gemini' | 'openrouter' | 'opencode'` → `// 'claude' | 'gemini' | 'opencode'`.

  (c) DEFAULTS — delete lines 111-116 (the 6 `CLAUDE_MEM_OPENROUTER_*` default entries).

  (d) Update the 2 OPENCODE "Mirrors OpenRouter" comments (lines 119-120): replace `// Mirrors OpenRouter (history budget is fixed in code; ...)` with `// History budget is fixed in code; reserved for future tunability` on both lines (drops the stale OpenRouter reference).

- [ ] **3.3c — Remove the OpenRouter credential from EnvManager.** In `src/shared/EnvManager.ts`:
  - `MANAGED_CREDENTIAL_KEYS` (line 43): delete `'OPENROUTER_API_KEY',`.
  - `ClaudeMemEnv` interface (line 51): delete `OPENROUTER_API_KEY?: string;`.
  - `loadClaudeMemEnv` (line 128): delete `if (parsed.OPENROUTER_API_KEY) result.OPENROUTER_API_KEY = parsed.OPENROUTER_API_KEY;`.
  - `saveClaudeMemEnv` (lines 171-177): delete the whole `if (env.OPENROUTER_API_KEY !== undefined) { ... }` block.
  - passthrough comment (line 231): `// Note: GEMINI_API_KEY / OPENROUTER_API_KEY / OPENCODE_API_KEY pass through` → `// Note: GEMINI_API_KEY / OPENCODE_API_KEY pass through`.
  - isolation branch (lines 236-238): delete `if (credentials.OPENROUTER_API_KEY) { isolatedEnv.OPENROUTER_API_KEY = credentials.OPENROUTER_API_KEY; }`.

- [ ] **3.3d — Remove the OpenRouter validation from SettingsRoutes.** In `src/services/worker/http/routes/SettingsRoutes.ts`:
  - settingKeys block (lines 82-88): delete the `// OpenRouter Configuration` comment + the 6 `'CLAUDE_MEM_OPENROUTER_*'` entries.
  - `validProviders` (line 153) → `['claude', 'gemini', 'opencode']`; error string (line 155) → `'CLAUDE_MEM_PROVIDER must be "claude", "gemini", or "opencode"'`.
  - delete the three OpenRouter validation blocks: `CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES` (lines 240-246), `CLAUDE_MEM_OPENROUTER_MAX_TOKENS` (lines 248-254), and `CLAUDE_MEM_OPENROUTER_SITE_URL` (lines 256-265).

- [ ] **3.3e — Narrow the worker-types currentProvider union.** In `src/services/worker-types.ts` line 35. OLD:
  ```typescript
    currentProvider: "claude" | "gemini" | "openrouter" | null; // Track which provider is currently running
  ```
  NEW:
  ```typescript
    currentProvider: "claude" | "gemini" | "opencode" | null; // Track which provider is currently running
  ```
  (Verify no assignment of `"openrouter"` to `currentProvider` remains — grep `currentProvider` in src; the field is set from the active bypass provider, which is now gemini/opencode only.)

- [ ] **3.3f — Remove OpenRouter from the viewer UI.**
  - `src/ui/viewer/types.ts`: update the PROVIDER comment (line 102) to drop `openrouter`; delete the 4 `CLAUDE_MEM_OPENROUTER_*?:` fields (lines 106-109).
  - `src/ui/viewer/constants/settings.ts`: delete the 4 `CLAUDE_MEM_OPENROUTER_*` entries (lines 15-18). (This keeps the settings-alignment guard green: backend no longer has the keys, frontend no longer has them either.)
  - `src/ui/viewer/hooks/useSettings.ts`: delete the `// OpenRouter Configuration` comment + the 4 `CLAUDE_MEM_OPENROUTER_*` lines (lines 29-33).
  - `src/ui/viewer/components/ContextSettingsModal.tsx`: delete the `<option value="openrouter">OpenRouter (multi-model)</option>` line (346); delete the entire `{formState.CLAUDE_MEM_PROVIDER === 'openrouter' && ( ... )}` block (lines 405-452).

- [ ] **3.4 — Run the bypass + settings tests, see them PASS.**
  ```bash
  bun test tests/worker/bypass-lane.test.ts tests/worker/bypass-lane-properties.test.ts tests/worker/bypass-sliding-window.test.ts tests/worker/bypass-opencode.test.ts tests/shared/settings-defaults-manager.test.ts
  ```
  Expected: all pass. (Circuit-breaker, probe, sliding-window, secrets-redaction behavior is provider-agnostic — swapping the test provider to `opencode` exercises the same code paths.)

- [ ] **3.5 — Run the broader env/routes suites to catch downstream breakage.**
  ```bash
  bun test tests/shared/ tests/services/
  ```
  Expected: pass. If any test still references a removed `CLAUDE_MEM_OPENROUTER_*` key or the `openrouter` provider, update or remove that assertion and note it in the commit body.

- [ ] **3.6 — Grep to confirm ZERO OpenRouter references remain anywhere.**
  ```bash
  grep -rn -i "openrouter" src/ tests/ | grep -v node_modules
  ```
  Expected: ZERO matches. If any remain, they are leftover and must be cleaned (compare against the 3.0 inventory).

- [ ] **3.7 — Build + worker suite.**
  ```bash
  npm run build && bun test tests/worker/
  ```
  Expected: build succeeds (settings-alignment guard passes — backend and frontend both have no OpenRouter keys now); all worker tests pass.

- [ ] **3.8 — Commit.**
  ```bash
  git add src/services/worker/BypassLane.ts \
          src/shared/SettingsDefaultsManager.ts \
          src/shared/EnvManager.ts \
          src/services/worker/http/routes/SettingsRoutes.ts \
          src/services/worker-types.ts \
          src/services/worker/agents/FallbackErrorHandler.ts \
          src/services/worker/agents/ResponseProcessor.ts \
          src/services/worker/agents/types.ts \
          src/services/worker/CLAUDE.md \
          src/ui/viewer/types.ts \
          src/ui/viewer/constants/settings.ts \
          src/ui/viewer/hooks/useSettings.ts \
          src/ui/viewer/components/ContextSettingsModal.tsx \
          tests/shared/settings-defaults-manager.test.ts \
          tests/worker/bypass-lane.test.ts \
          tests/worker/bypass-lane-properties.test.ts \
          tests/worker/bypass-sliding-window.test.ts \
          tests/worker/bypass-opencode.test.ts
  # (also: repo-root CLAUDE.md — drop "OpenRouter" from the BypassLane description; outside the 3.6 grep scope but keep docs consistent)
  git commit -m "refactor: remove OpenRouter provider entirely, keep Gemini+OpenCode

The OpenCode path is now a generic OpenAI-compatible client (base-URL override),
making OpenRouter fully redundant. Remove the OpenRouter execution path from
BypassLane (URL const, resolveConfig/probe/callRestApi branches, narrow
BypassConfig provider to gemini|opencode) AND sweep all remaining references:
SettingsDefaultsManager keys, EnvManager credential, SettingsRoutes validation,
worker-types currentProvider union, and the viewer UI. Tests that used
'openrouter' as the generic non-gemini provider now use 'opencode'. BypassLane
stays generic (Gemini + OpenCode/OpenAI-compatible).

Fork cleanup (no upstream hash).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```
  (No `Upstream:` trailer — this is fork-original cleanup.)

---

### Task 4: Crash-safe + symlink-safe atomic JSON config writer

Port upstream `65607897`'s `writeJsonFileAtomic` into a shared `src/utils/json-utils.ts`, then route the `project-allowlist.ts` allowlist writer through it. The symlink-safety matters because `~/.claude/settings.json` is sometimes a symlink (dotfile managers / symlinked configs). **Scope is project-allowlist only** for routing — `SettingsDefaultsManager` writers and `sync-to-cache.cjs` are flagged in notes (circular-import risk and CJS-vs-ESM, respectively).

**Files:**
- Create: `src/utils/json-utils.ts`
- Modify: `src/shared/project-allowlist.ts` (`writeAllowlist`, lines 55-61 + import lines 9-10)
- Test (new): `tests/utils/json-utils.test.ts`

Steps:

- [ ] **4.1 — Write the atomic-writer test (RED).** New file `tests/utils/json-utils.test.ts`. Follows the temp-dir convention (every `mkdirSync` has a matching `rmSync` in `afterAll` on the SAME variable; use `tmpdir()`):
  ```typescript
  import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
  import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readdirSync, statSync, lstatSync } from 'fs';
  import { join } from 'path';
  import { tmpdir } from 'os';
  import { writeJsonFileAtomic } from '../../src/utils/json-utils.js';

  const baseDir = join(tmpdir(), `json-utils-test-${Date.now()}`);

  beforeEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    mkdirSync(baseDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  describe('writeJsonFileAtomic', () => {
    it('writes JSON with trailing newline', () => {
      const f = join(baseDir, 'a.json');
      writeJsonFileAtomic(f, { hello: 'world' });
      const raw = readFileSync(f, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ hello: 'world' });
      expect(raw.endsWith('\n')).toBe(true);
    });

    it('creates the parent directory if missing', () => {
      const f = join(baseDir, 'nested', 'deep', 'b.json');
      writeJsonFileAtomic(f, { x: 1 });
      expect(existsSync(f)).toBe(true);
    });

    it('leaves no temp files behind on success', () => {
      const f = join(baseDir, 'c.json');
      writeJsonFileAtomic(f, { a: 1 });
      const leftovers = readdirSync(baseDir).filter((n) => n.includes('.tmp'));
      expect(leftovers).toEqual([]);
    });

    it('writes THROUGH a symlinked destination (does not replace the link)', () => {
      const realTarget = join(baseDir, 'real.json');
      writeFileSync(realTarget, '{"v":0}\n');
      const link = join(baseDir, 'link.json');
      symlinkSync(realTarget, link);

      writeJsonFileAtomic(link, { v: 42 });

      // The symlink must still be a symlink...
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      // ...and the real target must hold the new content.
      expect(JSON.parse(readFileSync(realTarget, 'utf-8'))).toEqual({ v: 42 });
    });

    it('preserves existing file mode bits AND replaces content', () => {
      const f = join(baseDir, 'mode.json');
      writeFileSync(f, '{}\n', { mode: 0o640 });
      writeJsonFileAtomic(f, { y: 2 });
      expect(statSync(f).mode & 0o777).toBe(0o640);
      // Verify the OLD content is actually REPLACED with the NEW content (guards
      // against a future refactor that skips/partially-writes the file).
      expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual({ y: 2 });
    });
  });
  ```

- [ ] **4.2 — Run it, see it FAIL.**
  ```bash
  bun test tests/utils/json-utils.test.ts
  ```
  Expected: failure — `Cannot find module '../../src/utils/json-utils.js'`.

- [ ] **4.3 — Create the writer (GREEN).** New file `src/utils/json-utils.ts`. Import block mirrors upstream paths.ts and the neighbor files in `src/utils/` (flat named `fs` imports + `path` + `crypto`), self-contained `ensureDirectoryExists` + `IS_WINDOWS` so it has no dependency on `src/npx-cli` (which the fork lacks). (`src/utils/` is NOT subject to the logger-usage gate, so no logger import is required.):
  ```typescript
  // SPDX-License-Identifier: AGPL-3.0
  /**
   * Atomic, symlink-safe JSON config writer.
   *
   * Ported from upstream thedotmack/claude-mem src/npx-cli/utils/paths.ts
   * (65607897, AGPL-3.0). A crash mid-write leaves old-or-new contents, never a
   * truncated config. rename(2) writes THROUGH a symlinked destination instead
   * of replacing the link — important because ~/.claude/settings.json is often a
   * symlink (dotfile managers / symlinked configs).
   *
   * Best-effort durability caveat: after the rename we fsync the parent directory
   * so the directory-entry change survives a crash. On some filesystems (Windows,
   * network mounts) or when the open/fsync is denied, the directory fsync may fail;
   * those errors are SILENTLY IGNORED (the file itself is already fsynced + renamed,
   * so contents are safe — only the cross-crash durability of the rename is
   * best-effort, not guaranteed, on all filesystems).
   */

  import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readlinkSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
  } from 'fs';
  import { basename, dirname, join, resolve } from 'path';
  import { randomBytes } from 'crypto';

  const IS_WINDOWS = process.platform === 'win32';

  function ensureDirectoryExists(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  export function writeJsonFileAtomic(filepath: string, data: unknown): void {
    // POSIX rename(2) operates on the symlink itself, so an atomic rename over
    // a symlinked destination would replace the link rather than writing through
    // it. Resolve up front so temp + rename both live on the real target's fs.
    let resolved = filepath;
    try {
      if (lstatSync(filepath).isSymbolicLink()) {
        try {
          resolved = realpathSync(filepath);
        } catch {
          const linkTarget = readlinkSync(filepath);
          resolved = resolve(dirname(filepath), linkTarget);
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      // Destination doesn't exist yet - write directly to the literal path.
    }

    ensureDirectoryExists(dirname(resolved));

    const dir = dirname(resolved);
    const base = basename(resolved);
    const tmpPath = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const payload = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8');

    // Preserve existing mode if the destination already exists; otherwise let
    // the OS apply the standard new-file default.
    let mode: number | undefined;
    try {
      mode = statSync(resolved).mode & 0o777;
    } catch {
      // File doesn't exist yet — fall through to default mode.
    }

    let fd: number | undefined;
    try {
      fd = mode !== undefined ? openSync(tmpPath, 'w', mode) : openSync(tmpPath, 'w');

      // writeSync wraps POSIX write(2), which may short-write — loop until the
      // full payload is committed before fsync.
      let written = 0;
      while (written < payload.length) {
        const n = writeSync(fd, payload, written, payload.length - written);
        if (n === 0) {
          throw new Error(`writeSync stalled at ${written}/${payload.length} bytes`);
        }
        written += n;
      }

      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, resolved);

      // fsync the parent directory so the rename's directory-entry change
      // survives a crash. Best-effort: Windows can't fsync a directory and
      // some filesystems disallow it — skip silently in those cases (see the
      // durability caveat in the file-level doc comment).
      if (!IS_WINDOWS) {
        let dirFd: number | undefined;
        try {
          dirFd = openSync(dir, 'r');
          fsyncSync(dirFd);
        } catch {
          // Best-effort directory durability — see file-level doc comment.
        } finally {
          if (dirFd !== undefined) {
            try { closeSync(dirFd); } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore close-after-error */ }
      }
      try { unlinkSync(tmpPath); } catch { /* tempfile may not exist */ }
      throw err;
    }
  }
  ```

- [ ] **4.4 — Run it, see it PASS.**
  ```bash
  bun test tests/utils/json-utils.test.ts
  ```
  Expected: 5 pass, 0 fail.

- [ ] **4.5 — Route the allowlist writer through it.** In `src/shared/project-allowlist.ts`:

  (a) Add the import immediately after line 13 (`import { resolveProjectRoot, resolveProjectDbPath } from './paths.js';`):
  ```typescript
  import { writeJsonFileAtomic } from '../utils/json-utils.js';
  ```

  (b) Replace `writeAllowlist` (lines 55-61). OLD:
  ```typescript
  function writeAllowlist(data: Allowlist): void {
    const path = getEnabledProjectsPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = path + '.tmp.' + process.pid;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, path);
  }
  ```
  NEW:
  ```typescript
  function writeAllowlist(data: Allowlist): void {
    writeJsonFileAtomic(getEnabledProjectsPath(), data);
  }
  ```

  (c) Clean up now-orphaned imports — but VERIFY they are orphaned BEFORE deleting (pre-check, not post-hoc). Run the grep FIRST:
  ```bash
  grep -n "writeFileSync\|renameSync\|mkdirSync\|dirname" src/shared/project-allowlist.ts
  ```
  Expected: after the 4.5(b) edit, the ONLY matches are the import line(s) themselves (lines 9-10) — i.e. no live USES outside the old `writeAllowlist` body. If any live use is found elsewhere (e.g. a hidden `renameSync` in `acquireLock`), do NOT drop that symbol; keep it. Verified during plan authoring: `writeFileSync`, `mkdirSync`, `renameSync` (from `fs`, line 9) and `dirname` (from `path`, line 10) were used ONLY in the old `writeAllowlist` body. `writeSync`, `openSync`, `closeSync`, `unlinkSync`, `constants`, `existsSync`, `readFileSync` are still used by `acquireLock`/`releaseLock`/`readAllowlist` — KEEP them. `basename`, `join`, `resolve`, `sep` (from `path`) are still used elsewhere — KEEP them.
  - Line 9 OLD:
    ```typescript
    import { existsSync, readFileSync, writeFileSync, writeSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, constants } from 'fs';
    ```
    Line 9 NEW (drop `writeFileSync`, `mkdirSync`, `renameSync`):
    ```typescript
    import { existsSync, readFileSync, writeSync, openSync, closeSync, unlinkSync, constants } from 'fs';
    ```
  - Line 10 OLD:
    ```typescript
    import { basename, dirname, join, resolve, sep } from 'path';
    ```
    Line 10 NEW (drop `dirname`):
    ```typescript
    import { basename, join, resolve, sep } from 'path';
    ```

- [ ] **4.6 — Run the allowlist + project-isolation tests.**
  ```bash
  bun test tests/shared/
  ```
  Expected: pass. The allowlist read-modify-write behavior is unchanged (atomic writer is a drop-in for the temp-file+rename it replaced, plus fsync/symlink-safety).

- [ ] **4.7 — Build.**
  ```bash
  npm run build
  ```
  Expected: succeeds (no unresolved-import errors after the line-9/10 cleanup).

- [ ] **4.8 — Commit.**
  ```bash
  git add src/utils/json-utils.ts tests/utils/json-utils.test.ts src/shared/project-allowlist.ts
  git commit -m "feat(utils): crash-safe symlink-safe atomic JSON writer

Add writeJsonFileAtomic (lstat/realpath symlink resolve -> same-dir temp ->
writeSync loop -> fsync -> rename -> best-effort parent-dir fsync; preserve
mode). Route the project-allowlist writer through it. Writes THROUGH symlinked
configs (dotfile managers / symlinked settings).

Upstream: thedotmack/claude-mem@65607897 (AGPL-3.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 5: Weekly-digests serial-narrative skill (mem-weekly-digests)

Port upstream `09e74bbf`'s `weekly-digests` SKILL.md as `plugin/skills/mem-weekly-digests/SKILL.md`, swapping the port-resolution and DB-path snippets to our `mem-timeline` conventions (port from `~/.claude-mem/worker.port`, per-project `<repo>/.claude/mem.db`). Pure markdown — the backend `/api/context/inject?full=true` already exists (verified: SearchRoutes.ts:265 reads `full`, ContextBuilder.ts:143 handles it). No DB/code change; smoke-verify the endpoint only.

**Files:**
- Create: `plugin/skills/mem-weekly-digests/SKILL.md`

Steps:

- [ ] **5.1 — Smoke-verify the backend endpoint exists (no test file needed).**
  ```bash
  grep -n "req.query.full\|input?.full" \
    src/services/worker/http/routes/SearchRoutes.ts \
    src/services/context/ContextBuilder.ts
  ```
  Expected (verified during plan authoring): match at `SearchRoutes.ts:265` (`const full = req.query.full === 'true';`) and `ContextBuilder.ts:143` (`if (input?.full) {`). This confirms the skill's `?full=true` fetch is backed.

- [ ] **5.1b — Verify the port-resolution convention matches the established fork skill.** The fork does NOT write `~/.claude-mem/worker.port` from worker-service.ts, so the `cat ~/.claude-mem/worker.port 2>/dev/null || echo "37777"` snippet relies on the default fallback unless that file exists. Confirm the sibling skill uses the exact same convention before copying:
  ```bash
  grep -n "worker.port\|WORKER_PORT" plugin/skills/mem-timeline/SKILL.md
  ```
  Expected: `WORKER_PORT=$(cat ~/.claude-mem/worker.port 2>/dev/null || echo "37777")` plus matching `${WORKER_PORT}` curls (mem-timeline lines 53-54). This is the established fork convention — mem-weekly-digests reuses it verbatim, so behavior is consistent with the shipped mem-timeline skill. (Flag: a non-default `CLAUDE_MEM_WORKER_PORT` setting falls back to 37777 unless `worker.port` is present — same limitation mem-timeline already has; out of scope to change here.)

- [ ] **5.2 — Fetch the upstream skill source.** The upstream skill lives at `plugin/skills/weekly-digests/SKILL.md` in commit `09e74bbf` (262 lines). Dump it to the new path as the starting point:
  ```bash
  mkdir -p plugin/skills/mem-weekly-digests
  git -C attn_sink/upstream-claude-mem show 09e74bbf:plugin/skills/weekly-digests/SKILL.md \
    > plugin/skills/mem-weekly-digests/SKILL.md
  ```
  Then apply the mem-* adaptations below by editing `plugin/skills/mem-weekly-digests/SKILL.md` in place.

- [ ] **5.3 — Apply the mem-* adaptations.** Edit `plugin/skills/mem-weekly-digests/SKILL.md`:

  (a) Frontmatter `name: weekly-digests` → `name: mem-weekly-digests` (mem-* prefix, matching `mem-timeline`).

  (b) Replace the upstream "Resolve the worker port" node one-liner block (upstream uses a `node -e` JSON-read fallback) with our `mem-timeline` convention:
  ````markdown
  **Resolve the worker port** (do this once, reuse `$WORKER_PORT`):

  ```bash
  WORKER_PORT=$(cat ~/.claude-mem/worker.port 2>/dev/null || echo "37777")
  ```
  ````

  (c) In every `curl` against the worker, use `${WORKER_PORT}` (already the upstream variable name) — confirm the fetch in Step 2 reads:
  ````markdown
  ```bash
  mkdir -p .scratch
  curl -s "http://localhost:${WORKER_PORT}/api/context/inject?project=PROJECT_NAME&full=true" \
    > .scratch/cm-timeline.md
  wc -l .scratch/cm-timeline.md
  ```
  ````

  (d) Keep upstream's Step 1 worktree-detection bash block AS-IS — it is identical to our `mem-timeline` Step 1 (same `git rev-parse --git-dir` / `--git-common-dir` parent-project logic).

  (e) Add a "### Step 1.5: Resolve the Database Path" section (copied verbatim from `mem-timeline` Step 3.5, verified against `plugin/skills/mem-timeline/SKILL.md` lines 78-98) so the skill resolves the per-project DB the same way, in case a subagent needs direct DB access. Insert after Step 1:
  ````markdown
  ### Step 1.5: Resolve the Database Path (per-project)

  claude-mem stores per-project data at `<repo>/.claude/mem.db` (not the global
  `~/.claude-mem/claude-mem.db`). Resolve it so any subagent that needs raw DB
  access targets the right file:

  ```bash
  if [ -n "$CLAUDE_MEM_PROJECT_DB_PATH" ]; then
    echo "$CLAUDE_MEM_PROJECT_DB_PATH"
  else
    git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
    git_dir=$(git rev-parse --git-dir 2>/dev/null)
    if [ -n "$git_common_dir" ]; then
      if [ "$git_dir" != "$git_common_dir" ]; then
        echo "$(dirname "$git_common_dir")/.claude/mem.db"
      else
        echo "$(git rev-parse --show-toplevel)/.claude/mem.db"
      fi
    else
      echo "$PWD/.claude/mem.db"
    fi
  fi
  ```
  ````

  (f) Update the cross-reference in the upstream text: every mention of the sibling skill `timeline-report` → `mem-timeline` (verified upstream has it in 2 places — the description line "If the user wants a single sweeping report, use `timeline-report` instead." and "Same worktree-detection pattern as `timeline-report`.").

  (g) Keep all of Steps 3-7 (split-timeline guidance, weekly index README, consecutive subagent pipeline, narrative-budget table, rename step, completion report), Pipeline Discipline, Error Handling, and Examples sections verbatim — they are provider/port-agnostic narrative instructions. In Error Handling, the verify curl `http://localhost:${WORKER_PORT}/api/search?query=*&limit=1` is correct for our worker (the `/api/search` route exists; matches `mem-timeline`'s health check).

- [ ] **5.4 — Validate the SKILL.md is well-formed (frontmatter + headings).**
  ```bash
  head -5 plugin/skills/mem-weekly-digests/SKILL.md
  grep -c "^### Step" plugin/skills/mem-weekly-digests/SKILL.md
  grep -n "timeline-report" plugin/skills/mem-weekly-digests/SKILL.md
  ```
  Expected: frontmatter shows `name: mem-weekly-digests`; the `^### Step` count is 8 (upstream's 7 numbered `### Step N` headings + the added `### Step 1.5`); the last grep shows ZERO stray `timeline-report` references. If `timeline-report` still appears, fix per 5.3(f).

- [ ] **5.5 — Live smoke test (optional but recommended — requires a running worker with data).** Pick a project name that has observations:
  ```bash
  WORKER_PORT=$(cat ~/.claude-mem/worker.port 2>/dev/null || echo "37777")
  curl -s "http://localhost:${WORKER_PORT}/api/context/inject?project=proj-claude-mem&full=true" | head -20
  ```
  Expected: pre-formatted compact markdown (after Task 1: `# [proj-claude-mem] recent context, ...` header, `### <date>` day headers, flat `<id> <time> <icon> <title>` lines). If the worker isn't running, skip — the skill is markdown-only and ships independently.

- [ ] **5.6 — Build-and-sync so the skill deploys to the marketplace/cache mirrors.**
  ```bash
  npm run build-and-sync
  ```
  Expected: build + sync succeeds; the new skill dir appears under the cache + marketplace mirrors. (Skills are copied 1:1 from `plugin/` by the sync step.)

- [ ] **5.7 — Commit.**
  ```bash
  git add plugin/skills/mem-weekly-digests/SKILL.md
  git commit -m "feat(skill): add mem-weekly-digests serial-narrative skill

Port upstream weekly-digests as mem-weekly-digests: fetches the full timeline
via /api/context/inject?full=true (already supported), splits per ISO week, and
runs one consecutive carry-forward subagent per week. Port-resolution reads
~/.claude-mem/worker.port and DB path resolves per-project <repo>/.claude/mem.db,
matching mem-timeline conventions.

Upstream: thedotmack/claude-mem@09e74bbf (Apache-2.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 6: Create `docs/PROVENANCE.md` — the item→commit→license index (round-closing)

**Why:** hardening §6 and the governance appendix require a standalone provenance index. This is the artifact that records, for the whole round, which fork commit derived from which upstream hash and under which license — the durable record beyond the per-commit trailers. Run this **last**, after all P0/P1/P2 commits exist, so it indexes their real hashes. The file is fork-original documentation → its own commit carries **no** `Upstream:` trailer.

**Files**
- Create: `docs/PROVENANCE.md`

**Steps**

- [ ] **6.1 — Generate the upstream-source rows from the actual landed commits.** After all chunks are merged, list this round's commits and their trailers:
  ```bash
  git -C /Users/shinewine/Coding/proj-claude-mem log --no-merges --grep="Upstream: thedotmack" \
    --pretty=format:'%h %s%n%b%n---' <P0-base>..HEAD
  ```
  (Replace `<P0-base>` with the commit before the first P0 commit.) Each block gives the fork short-hash, subject, and the `Upstream: thedotmack/claude-mem@<hash> (<license>)` trailer(s).

- [ ] **6.2 — Write `docs/PROVENANCE.md`.** Use this structure (fill the rows from 6.1; one row per adopted item, including the dual-trailer tree-kill row and the fork-original rows):
  ```markdown
  # Upstream Provenance — 2026-06 Cherry-Pick Round

  > **范围**: 本轮(41 项)移植自上游 `thedotmack/claude-mem` 的来源与许可证追溯。
  > fork 维持 **AGPL-3.0**;上游自 `36b0929f`(v13.0.0)起为 Apache-2.0,之前为 AGPL-3.0。
  > 许可证判定:`git -C attn_sink/upstream-claude-mem merge-base --is-ancestor 36b0929f <hash>`(exit 0 ⇒ Apache-2.0,否则 AGPL-3.0)。

  | Fork commit | 移植项 | Upstream hash(es) | 源许可证 |
  |-------------|--------|-------------------|----------|
  | `<short>` | content_hash \x00 分隔 | `9cfa57d49` | AGPL-3.0 |
  | … | … | … | … |
  | `<short>` | chroma tree-kill(单 commit 双源) | `d384d3c5` + `55334129` | AGPL-3.0 + Apache-2.0 |
  | `<short>` | writeJsonFileAtomic | `65607897` | AGPL-3.0 |

  ## Fork-original(无上游来源,无 trailer)
  - `agent_id` 探针日志(C2)— 本地诊断 instrumentation。
  - OpenRouter 完整移除(C7 Task 3)— fork 自有清理(上游未移除 OpenRouter)。
  - `docs/PROVENANCE.md` 本身。
  ```
  Cross-check: every commit from 6.1 that has an `Upstream:` trailer appears as a row; the two fork-original commits (agent_id probe, OpenRouter removal) appear only under "Fork-original".

- [ ] **6.3 — Commit (fork-original doc, no `Upstream:` trailer).**
  ```bash
  git -C /Users/shinewine/Coding/proj-claude-mem add docs/PROVENANCE.md
  git -C /Users/shinewine/Coding/proj-claude-mem commit -m "docs(provenance): add upstream cherry-pick provenance index for the 2026-06 round

Index of fork-commit → upstream-hash → source-license for the 41-item
upstream cherry-pick round. Fork remains AGPL-3.0; Apache-2.0-sourced
items (>= v13.0.0 / 36b0929f) are tracked per-row.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## 附录 A:spec-review 修订记录(逐 chunk)

### Chunk 1
- Task 3 / T3-PREDICATE-SAFETY (HIGH): added verification sub-step 3.0 (read-only) that confirms (a) the exact processAgentResponse signature, (b) parseSummary returns null on skip_summary at src/sdk/parser.ts:143-153, (c) CLAIM-CONFIRM uses getPendingMessageStore(session.dbPath) @226, (d) empty-ob-detection non-XML cases use processingMessageIds:[] and assert only forceInit/conversationHistory. Did NOT rewrite logic — the skip_summary no-misfire test already exists in step 3.1. Fixed the parser citation from bare 'parser.ts:144' to the correct fork path 'src/sdk/parser.ts:144' (regex /<skip_summary\s+reason="([^"]+)"\s*\/>/), per 'add citation/verify' guidance.
- Task 3 / T3-TEST-FUNCTION-SIGNATURE-MISMATCH (MEDIUM): step 3.0(a) now pins the verified 8-positional-arg signature (text, session, dbManager, sessionManager, worker, discoveryTokens, originalTimestamp, agentName, projectRoot?) and maps each test call's args to it; added a note in step 3.1 that all calls use the verified form. No test call values changed (they were already correct).
- Task 2 / T2-IMPORT-PATH-OFF-BY-ONE (MEDIUM): rewrote step 2.6 to show OLD lines 13-14 (both observations/store and summaries/store imports) and insert parseFileList as a standalone new line between them — an unambiguous anchor — instead of the vague 'after line 13'. Added a write-time confirmation of the surrounding import lines.
- Task 1 / T1-MEMORYID-NULL-GUARD (LOW): added step 1.0 — the quick sed visual-confirm of the unguarded first field that the finding recommended (no logic change; the fix in 1.3 is unchanged).
- Task 2 / T2-LOGGER-IMPORT-RETENTION (LOW): in step 2.5 cited the actual logger-gate include pattern at tests/logger-usage-standards.test.ts:56 confirming observations/files.ts is covered; added the explicit logger-gate run to step 2.9 as proof (was already implied).
- Task 3 / T3-GETPENDINGMESSAGESTORE-DBPATH (LOW): added the fork-adaptation note in step 3.3 explaining that getPendingMessageStore(session.dbPath) is fork-specific (per-project isolation) and matches the existing CLAIM-CONFIRM call @226, vs upstream which passes no arg.
- Task 3 Why/CRITICAL/callers notes: expanded the empty-ob-detection 'unaffected' justification to also state the processingMessageIds:[] reason (markFailed loop never runs), and pointed those notes at step 3.0 for the trace.
- No DB migration introduced (schema stays v33). All provenance trailers and AGPL-3.0 determinations preserved unchanged (commit hashes 9cfa57d49 / 2a304d59e / be99a5d69 / 92f800d4 verified to exist in the upstream clone).

  备注: No OpenRouter references in Chunk 1 — nothing to flag for the C7 sweep. No observer-privacy (C2-F3) surface here. No anchor-coercion (C5) or settings.json 0600 (C2) content here. All verification was read-only against the fork; no fork files were modified. The predicate regex and all four upstream commit hashes were verified directly in the upstream clone (be99a5d69 ships the byte-identical predicate `!/<observation>|<summary>|<skip_summary\\b/.test(text)`). One cross-cutting observation for the assembler: historical pass counts must not be hard-coded across chunks; reconcile against the implementation-day root-test baseline (this chunk adds net +13 cases: +1, +9, +3).

### Chunk 2
- C2-F6 (MEDIUM, real correctness): Task 2 Step 3 — changed the logger component from 'SECURITY' to 'SYSTEM' in buildHardenedSdkOptions' canUseTool WARN log, plus an explanatory inline comment. 'SECURITY' is not in the logger Component union (verified src/utils/logger.ts:18); 'SYSTEM' is. Updated the post-code NOTE to mandate 'SYSTEM' (was 'offer it as an alternative'). Updated Task 2 commit body to say component 'SYSTEM'.
- C2-F1 (MEDIUM, verify sub-step): Task 2 Step 0 — added a 'Record the result in code' bullet requiring the Step 0 dontAsk verification outcome to be written as a one-line comment above the permissionMode line; added matching guidance comment in the hardened-options.ts code block. Noted the existing Step 1 test already pins the behavioral contract so a future SDK bump is CI-caught (no separate type-introspection test added — minimal diff).
- C2-F3 (HIGH, per DECISIONS C2 — NO new code, add 'already covered' note): added an 'Observer-output privacy (already covered)' subsection to Task 2 and a 'Scope note (observer path already covered)' to Task 5, documenting that observer input is stripped at SessionRoutes.ts:819-820 cleanToolField -> observation-utils.ts:46 stripMemoryTagsFromJson (verified), so no second defensive strip on observer output. Explicitly cites DECISIONS C2.
- C2-F2 (HIGH, verify sub-step): Task 4 — added a 'Convergence check' subsection with a static grep guard sub-step confirming all observation/summary persistence paths funnel through cleanToolField / stripMemoryTags* wrappers (verified callsites: SessionRoutes.ts:819-820, :1073; Task 5). Framed as a regression guard, not a refactor — no code change unless a new bypass appears.
- C2-F4 (MEDIUM, JSDoc/test-comment): Task 4 Step 1 — added a NOTE comment in the test file clarifying that stripMemoryTagsFromJson/stripMemoryTagsFromPrompt label caller context (JSON payload vs prompt text), not behavior (both delegate to stripTagsInternal); do not add divergent logic.
- C2-F4/export-as-internal (JSDoc marker): Task 4 Step 3 — expanded the SYSTEM_REMINDER_REGEX export JSDoc to mark it @internal (exported only for transcript-parser reuse, not a stable public API) and cross-reference the /g lastIndex caveat. Updated Task 4 commit body to say 'SYSTEM_REMINDER_REGEX (internal)'.
- C2-F7 (LOW, probe cleanup condition): Task 1 — replaced the vague 'Remove once Q23 is resolved' with an explicit TODO(Q23) marker plus a removal condition (close once pod evidence collected and Q23 closed in audit report §6.3/6.4); added a Step 1 test assertion pinning the TODO(Q23) marker; updated the commit body.
- C2-F5 (LOW, comment clarity): Task 3 Steps 4/5/7 — clarified the mkdirSync/writeFileSync 'mode only applies on creation' comments to explicitly state that the mode param is silently ignored for pre-existing dirs/files (so chmodSync is required and must not be removed).
- DECISIONS C2 (settings.json 0600, no sync step): Task 3 — added a 'Sync note' stating the repo syncs via git (no OneDrive), so no external-sync verification step is needed; the 0600/0700 work is unchanged. No OneDrive/sync verification step was present to remove, but the note pre-empts adding one.
- Preserved: all provenance trailers (fork-original NO-trailer on Task 1; AGPL/Apache determinations on Tasks 2-6), TDD bite-sized RED-GREEN format, exact file paths/line numbers, the 10-pass / 8-new test counts (verified by counting it() blocks), and the no-DB-migration constraint (schema stays v33). No DECISIONS false-positives were touched.

  备注: OpenRouter sweep (Global decision 1 / C7): Task 3's **Why** still lists "OPENROUTER" among the .env keys ("ANTHROPIC/GEMINI/OPENROUTER/OPENCODE keys"). I left it as-is because it is a descriptive enumeration of what currently lands in ~/.claude-mem/.env, not a code change, and C7 owns the full OpenRouter removal sweep. Flagging it here so the C7 sweep / assembler can decide whether to scrub the word "OPENROUTER" from this Task 3 description once the provider is removed (it would then read "ANTHROPIC/GEMINI/OPENCODE keys"). No other OpenRouter references exist in Chunk 2.

C2-F1 deferred type-test: I deliberately did NOT add the "unit test asserting SDK version supports required fields via typeof on sdk.d.ts" that the finding recommended — top-level `sdk.d.ts` is only a re-export in this fork, so the authoritative implement-time check is the package-wide `rg` over `entrypoints/` in C2-T2 Step 0. The existing Step 1 behavioral test (permissionMode === undefined || 'dontAsk', never 'bypassPermissions') already catches enum drift at CI time; I noted this inline.

No DB migration introduced; schema stays v33. Verified at write-time against the fork: observation-utils.ts:46, SessionRoutes.ts:819-820 + :1073, logger.ts:18 Component union, logger.warn signature (logger.ts:325).

### Chunk 3
- Header: added an epoch-units heads-up (F9) documenting that sdk_sessions.started_at_epoch (new Date().getTime(), SessionStore.ts:1559-1564) and session.startTime (Date.now(), SessionManager.ts:263) are BOTH milliseconds, so Task 7 needs no unit conversion.
- Task 1 Step 1 (F11): wrapped the entire isPortInUse describe in `if (process.platform !== 'win32')` so it self-skips on Windows CI (bun:test has no skip decorator); updated the explanatory note accordingly.
- Task 1 Files + Step 5 (F1): pinned the actual fork waitForPortFree test structure (4 cases at lines 186-251, all mock global.fetch). Made case handling concrete: DELETE case 3 ('should succeed when port becomes free' — fetch-call-counting, fetch-coupled), KEEP case 4 ('should use default timeout') but remove its dead global.fetch mock; added the explicit grep-for-residual-global.fetch step.
- Task 2 Files + Step 5 (F2): added a 'Scope confidence' note proving `port` (line 1572) and the catch (line 1766) are in the same `async function main()` (line 1562) — no redeclaration needed; corrected catch line ref to 1766.
- Task 2 Step 3 (F3): marked the `async` keyword on the catch handler as CRITICAL (required for the awaited waitForHealth), with an inline explanation.
- Task 3 Steps 4-5 (F4): replaced absolute line-number edits with grep-driven targeting — first `pid === currentPid` occurrence = Windows guard, then re-grep so the single remaining one = POSIX guard; added a note that the Step-3 insert shifts lines down ~14.
- Task 3 header + Step 2 (F5): documented that readPidFile() returns PidInfo|null (ProcessManager.ts:142) and the production edit guards with optional chaining (pidFileInfo?.pid); strengthened the RED guarantee by noting readPidFile is not yet called inside aggressiveStartupCleanup.
- Task 4 prose + Step 5 (F14): corrected the scaling description (consumer uses getPlatformTimeout, win32-only multiplier; not the hook-side getTimeout 1.5x claim), and gave two concrete grep commands with the exact expected consumer set (hook-constants.ts:4, worker-service.ts:1536/1630, the test) plus the second grep to rule out other 5000 spawn-wait pins.
- Task 5 Step 1 (F6): added an inline confirmation that SessionStore's ctor accepts ':memory:' directly and self-migrates to v33 (SessionStore.ts:25-46), so `new (SessionStore as any)(':memory:')` needs no external Database/MigrationRunner; fixed the updateMemorySessionId null-acceptance citation to SessionStore.ts:48.
- Task 6 Files note (F12): added that tests/worker/ already exists, no mkdir needed.
- Task 6 Step 4 (F13): confirmed logger is imported at ProcessRegistry.ts:21 so logger.warn is in scope.
- Task 6 Step 6 (F15): expanded the stale-abort-controller-guard.test.ts rationale — explains WHY it still passes (stale-recovery path at line 139 runs independently of .catch) and that the myController binding actually fixes the latent bug it guards.
- Task 7 Files + Step 7 (F8): added an explicit 'imports in scope' precondition citing SettingsDefaultsManager/USER_SETTINGS_PATH at SessionRoutes.ts:22-23 and the static loadFromFile at SettingsDefaultsManager.ts:261.
- Task 7 Step 7 (F9): added an epoch-units verification sub-step (both started_at_epoch and session.startTime are ms; no *1000) plus a session.startTime fallback-validity note (SessionManager.ts:263); added an inline 'no conversion' comment in the inserted guard.
- Task 7 Step 1b (F16): turned the vague count-pin instruction into a concrete grep-result interpretation (bump NN by +1 if a toHaveLength pin exists; fork has none).
- Task 8 Files + Step 3 (F10): confirmed mcpReady is declared `mcpReady: boolean = false;` at line 168 and clarified the catch's `this.mcpReady = false` is a safety re-assert, not a new field.

  备注: No OpenRouter references exist anywhere in Chunk 3 (verified via grep over lines 1956-3085) — nothing to flag for the C7 OpenRouter sweep from this chunk. DECISIONS C2 (observer privacy), C5 (anchor-coercion drop/renumber), and C7 (OpenRouter + base-URL) do not touch Chunk 3; no task added/removed/renumbered here, so the chunk's task count stays at 8 (the global 41→40 round-count change is driven entirely by C5 in Chunk 5). No DB migration introduced (schema stays v33). All provenance trailers and AGPL-3.0 determinations preserved verbatim. The only false-positive from DECISIONS relevant here was none specific to c3; all c3 findings were actionable (verify/cite or real correctness) and applied. Verified facts at write-time against the fork: HealthMonitor waitForPortFree has 4 fetch-mocked cases (lines 186-251); worker.start().catch at worker-service.ts:1766 inside async main() at 1562 with port at 1572; readPidFile returns PidInfo|null (ProcessManager.ts:142); SessionStore ctor self-migrates on ':memory:' (lines 25-46); started_at_epoch written as getTime() ms (SessionStore.ts:1559-1564), session.startTime = Date.now() (SessionManager.ts:263); SettingsDefaultsManager imports at SessionRoutes.ts:22-23, static loadFromFile at 261; tests/worker/ exists; stale-abort-controller-guard.test.ts is at tests/services/ (not tests/worker/) — Task 6 Step 6 path reference is correct.

### Chunk 4
- C4-T1-001 (apply, real correctness — win32 test platform guard per DECISIONS): added `if (process.platform === 'win32') return;` guard to the `does NOT add a Windows quoteForCmdExe helper` test in chroma-mcp-onnx-pin.test.ts, with an explanatory comment, using the fork's existing early-return win32 idiom (tests/infrastructure/process-manager.test.ts:513). Updated Step 2 expected counts to '4 fail, 1 pass' to reflect the now-guarded assertion.
- C4-T4-001 (add comment — substring-match fragility): expanded the Task 4 Step 3 NEW code comment to document the detection contract (chroma-mcp returns a plain Error, no structured code; on wording drift the branch falls through to the generic else == pre-fix drop, no corruption; Step-1 test pins the wording). Added a one-line lead-in to Step 3 prose. No logic change.
- C4-T5-001 (add comment — placement rationale): appended 'Must be set BEFORE the combinedCertPath early-return below so it applies to both the cert and no-cert paths.' to the ANONYMIZED_TELEMETRY comment in Task 5 NEW code, and a matching note in the Step 1 prose. No logic change.
- C4-T6-001 (add comment — regression-not-audit scope): added a scope note to the mcp-tool-schemas.test.ts JSDoc and a one-line lead-in to Task 6 Step 1 prose clarifying it is a regression guard, not an exhaustive parameter audit. No logic change.
- C4-T2-001/002/003/004 (DECISIONS false-positives — citation only, no restructure): added concise 'confirmed correct' inline notes referencing the DECISIONS findings: execFileAsync module-level shared definition (Step 3), disposeCurrentSubprocess connected=false + await ordering (Step 4 connectInternal comment), PID-captured-after-connect + intentional null-guard (Step 6 prose). No logic change.
- Export-as-internal JSDoc markers (DECISIONS real-correctness item, applied to this chunk's static helpers): added '`private static` by intent — ... NOT part of the public API' JSDoc markers to killProcessTree and collectDescendantPids in Step 9, clarifying they are exercised only via public abandon paths (test observes indirectly).
- Pre-flight block: added write-time re-confirmation of the verified anchors (DEFAULT_CHROMA_DATA_DIR line 29, class at line 31, getCombinedCertPath inline at line 362, no quoteForCmdExe) per the 'add citation/verify' guidance — no rewrite of working logic.

  备注: No OpenRouter references exist anywhere in Chunk 4 (grep over lines 3087-4307 returned empty), so nothing to flag for the C7 sweep from this chunk. No DB migration introduced (schema stays v33). No anchor-coercion task lives in this chunk (that is C5). Observer-privacy (C2-F3) is not relevant here (no observation-storage code in this chunk). All six provenance trailers preserved unchanged; AGPL/Apache determinations untouched. Verified against the fork (read-only): src/services/sync/ChromaMcpManager.ts confirms DEFAULT_CHROMA_DATA_DIR@29, `export class ChromaMcpManager`@31, getCombinedCertPath@362, no quoteForCmdExe, no src/supervisor/ dir. Fork win32 test idiom confirmed as `if (process.platform === 'win32') return;` (process-manager.test.ts:513, 535, 553, 567); no `it.skipIf` usage exists in the repo, so I used the established early-return idiom rather than introducing a new construct. Total round/task count for Chunk 4 unchanged (6 tasks) — none of the DECISIONS task-drop/renumber items apply to this chunk.

### Chunk 5
- DECISIONS #3 (anchor-coercion): DROPPED the old Task 3 (timeline-anchor-coercion / parseNumericAnchor in timeline() + getContextTimeline()) entirely. Renumbered old Task 4 (normalizeparams-concept) -> Task 3 and old Task 5 (bypasslane-ghost-filter) -> Task 4. Round/task count for this chunk now 4 tasks (was 5).
- Group provenance updated: now THREE upstream refs (46d204ee9, be99a5d69, e39821298) instead of four (dropped ff0793f7). 'four tasks map to three hashes' with be99a5d69 shared by Task 2 and Task 3 (was five tasks/four hashes shared by Task 2 and Task 4). Re-verified all three are AGPL-3.0 (NOT descendants of 36b0929f — they predate the relicense).
- Pre-flight notes: removed the Task 3 (timeline-anchor-coercion) discrepancy note (task gone). Changed 'All other four tasks fix live fork defects' -> 'All four tasks fix live fork defects'.
- C5-T2 (Chroma-absent-vs-zero uncited, HIGH): added a pre-flight verification note citing fork source (SearchManager.ts:244-247 'returned 0' branch vs :249-257 ABSENT branch) AND upstream evidence (git show be99a5d69 -- SearchManager.ts shows the 'returned 0 ... don't fall back' branch carried UNCHANGED, edits only on the ABSENT branch). Echoed the citation in Task 2 Problem + commit body.
- C5-T4 / Task 3 (singular-concept survival not verified, MEDIUM): executed the caller-survival grep at spec-time and recorded results in BOTH the chunk pre-flight note and the Task 3 Problem section. Removed the runtime-only Step 5 caller check (folded the verified conclusion into the spec; renumbered Step 6/7 -> 5/6). Corrected the SearchRoutes path to the real src/services/worker/http/routes/SearchRoutes.ts (handler :67, doc :156).
- C5-T1 (cache-key inconsistency, HIGH): extracted a single-sourced RANK_KEY_PREFIX const in SearchManager.search() used on BOTH the write side (Step 4) and read side (Step 5), with a comment explaining it prevents silent lookup misses if the enum/prefix vocabulary diverged. r.type is a member of RANK_KEY_PREFIX so the index is type-safe (no missing-key path). Updated commit body to mention RANK_KEY_PREFIX.
- C5-P1 (high-ceiling limit justification, MEDIUM): replaced magic 10000 with named module-scope constant FTS_FALLBACK_MAX_RESULTS plus a JSDoc explaining it is a safe per-project ceiling and that matches beyond it are dropped before the unified slice. Used the constant in all three fts options in Step 8. Updated commit body.
- C5-FTSPARAMS-PUSH-ORDER (param-order vulnerability, MEDIUM): added an explicit SQL param-order invariant callout above Steps 4-6 ('[query, ...filter, limit, offset]; orderClause MUST add no params') and an inline /* SQL param order: ... */ comment in each FTS5/LIKE template (observations, sessions, user_prompts).
- C5-T5 / Task 4 (ghost-filter harness incomplete, MEDIUM): kept the verified scope note (positive path omitted because store.db is unmockable in the light stub) and added concrete extension guidance for the positive case (transaction(fn)=>fn + prepare stub). No behavior change to the load-bearing ghost-rejection test.
- OpenRouter (Global decision #1): added an explicit 'OpenRouter note for Chunk 7 sweep' callout in Task 4 listing the BypassLane OpenRouter-specific references (OPENROUTER_API_URL:37, provider branches :212/:476/:877, CLAUDE_MEM_OPENROUTER_* :214-219, comments/error string) that C7 owns. This task does NOT touch them. Flagged the test's provider:'openrouter' as a placeholder to be generalized post-C7, and removed 'OpenRouter' from the Task 4 commit body (now 'Gemini/OpenCode'). KEPT BypassLane + Gemini + OpenCode generic design intact.
- Corrected ResponseProcessor path reference in Task 4 from 'ResponseProcessor.ts:75-84' to the real src/services/worker/agents/ResponseProcessor.ts:76-84 (verified predicate matches the inlined filter exactly).

  备注: OpenRouter references to sweep in Chunk 7 (C7 owns full removal; verified live in fork at write-time): src/services/worker/BypassLane.ts -> OPENROUTER_API_URL const (:37), provider union type includes "openrouter" (:144), provider==="openrouter" branches at :212/:476/:877, CLAUDE_MEM_OPENROUTER_API_KEY (:214) + OPENROUTER_API_KEY credential (:215) + CLAUDE_MEM_OPENROUTER_MODEL (:219), header comment (:5), method comment (:836), probe comment (:497), error string "OpenRouter API error" (:904). Per DECISIONS: generalize provider/endpoint selection (add generic CLAUDE_MEM_OPENCODE_BASE_URL + generalized resolver; do NOT add CLAUDE_MEM_OPENROUTER_BASE_URL), keep BypassLane + Gemini + OpenCode. The bypass-ghost-filter test added in Chunk 5 Task 4 uses provider:'openrouter' as a placeholder ACTIVE-lane config and must be updated to a generic/Gemini/OpenCode provider value when C7 lands, or it will fail after the union type drops "openrouter".

Path corrections discovered (for assembler awareness; the plan's shorthand was content-accurate): SearchRoutes is at src/services/worker/http/routes/SearchRoutes.ts (NOT src/services/worker/SearchRoutes.ts); ResponseProcessor is at src/services/worker/agents/ResponseProcessor.ts (predicate :76-84). I corrected these inline in the chunk.

No DB migration introduced (schema stays v33) — confirmed unchanged. All provenance trailers and AGPL-3.0 determinations preserved. The dropped Task 3 freed up ff0793f7 (#2176) — if the timeline-anchor parity is still desired elsewhere it is NOT in this chunk anymore; the global round count drops by 1 (41 -> 40 per DECISIONS #3) and this chunk's task count drops 5 -> 4. The assembler should verify no other chunk or appendix cross-references 'Chunk 5 Task 3/4/5' by old number or references ff0793f7 as part of Chunk 5.

### Chunk 6
- C6-T2-CHANGES-TYPE (MEDIUM, ruled FALSE POSITIVE in DECISIONS): added a '.changes API note (confirmed at write-time)' paragraph to Task 2 citing the verified existing fork usages of result.changes (PendingMessageStore.ts lines 120/378/414/420/683/699 and migrations/runner.ts:1289-1290). No logic rewrite; no SELECT changes() fallback. Verified via grep against the fork.
- C6-T3-EXPORT-MISSING (HIGH): applied Option A — kept assertSchemaReadable as an export but added an @internal JSDoc marker stating it is exported only for the schema-probe test and is not part of the public Database.ts API surface (only ClaudeMemDatabase is public).
- C6-T3-SCHEMA-PROBE-PLACEMENT (LOW): no change (finding's own recommendation was 'Placement is correct. Proceed as planned.').
- C6-T4-NO-CALLER-GREP (LOW): added a broad grep verification sub-step to Task 4's caller note (grep -rn 'parseSummary(' src/ | grep -v 'function parseSummary'), with the expected 3 call sites enumerated and a 'inspect a 4th caller' guard. Verified the 3 call sites against the fork (fresh-summarize.ts:216, import-xml-observations.ts:337 guarded by if(summary), ResponseProcessor.ts:97).
- C6-T6-EXPORT-REGRESSION (MEDIUM): applied Option A — kept cwdToDashed as an export but added an @internal JSDoc marker stating it is exported only for the dot-path test, sole production caller ObservationCompiler.ts:205, not a stable public helper.
- C6-T8-MOCK-INDEPENDENCE (LOW): added a grep verification sub-step to Task 8 step 1 (two greps confirming each of the three test files has its own USER_MESSAGE_ONLY mock literal and ZERO 'import ... HOOK_EXIT_CODES'). Verified against the fork: confirmed self-defined mock literals at lines 44/115/146, no real-constant imports.
- C6-T9-SYNC-GUARANTEE (MEDIUM): added a static source-level sync check to Task 9 step 4 (grep scripts/build-hooks.js for the generator-emitted overrides/trustedDependencies keys) BEFORE the build, so generator/artifact divergence is caught at development time, per the recommendation. Kept the existing post-build verification.
- C6-T1-T7-NO-TEST (LOW): no structural change — Task 1 already cites be99a5d69 and verifies via the sqlite suite; Task 7 already verifies via build + logger suite per briefing rule 5. Both acceptable as-is.

  备注: No DECISIONS items directly modify Chunk 6 (C5 anchor-coercion, C7 OpenRouter sweep, C2 settings 0600/observer-privacy all belong to other chunks). Chunk 6 contains ZERO OpenRouter references (verified by full read), so nothing here needs to feed the C7 OpenRouter sweep. Round count for this chunk is unchanged at 9 tasks (the 41→40 renumber from DECISIONS C5 applies to Chunk 5, not here). DECISIONS confirmed both FALSE POSITIVES touching my chunk: (1) '.changes on bun:sqlite run() (C6-T2)' — handled by adding a citation only; (2) the verification of the three self-contained test mocks. All upstream commit-hash provenance trailers and AGPL/Apache determinations are preserved unchanged. No DB migration introduced (schema stays v33). The harmless extra USER_MESSAGE_ONLY key left in the three test mocks remains out of scope (already flagged in Task 8's caller note) — a future cleanup could remove it but it does not affect correctness.

### Chunk 7
- Global decision #1 (full OpenRouter removal): expanded Task 3 from BypassLane-only to a complete sweep — added removal sub-steps for SettingsDefaultsManager keys (3.3b), EnvManager credential (3.3c), SettingsRoutes validation (3.3d), worker-types currentProvider union (3.3e), and viewer UI types/constants/hooks/modal (3.3f). Added the file list, a pre-check inventory step (3.0), an env/routes suite run (3.5), and a codebase-wide ZERO-match grep (3.6). Updated commit message + git add to cover all swept files. Kept BypassLane generic + Gemini/OpenCode.
- Global decision #1 (no OPENROUTER_BASE_URL): removed the CLAUDE_MEM_OPENROUTER_BASE_URL key from Task 2.5 (interface + DEFAULTS) and the reserved-key comment; Task 2 now adds only the generic CLAUDE_MEM_OPENCODE_BASE_URL. Updated Task 2 title/intro, commit message, and the 2.4 expected count (5->6 with the added trailing-slash test).
- Task 3.1: updated settings-defaults-manager.test.ts:352 pin (CLAUDE_MEM_OPENROUTER_API_KEY -> CLAUDE_MEM_OPENCODE_API_KEY) since the OpenRouter key is now removed; swapped the bypass-lane.test.ts top-level settings stub keys to OpenCode equivalents.
- C7-T1-001: changed renderMarkdownLegend test from toBeGreaterThanOrEqual(4) to toHaveLength(4) (new legend returns exactly 4 elements) and asserted result[3]==='' and result[1] exact value.
- C7-T1-004 (+ DECISIONS 'compactTime on summary times'): wrapped formattedTime in compactTime inside renderMarkdownSummaryItem (1.3j) so summary times match the compact observation-row times; updated the summary test (1.1) to assert '10:00a'; added an explanatory comment in TimelineRenderer's markdown path about formatDateTime being verbose and compacted downstream.
- C7-T1-002: documented in 1.3(i) and 1.7 that formatObservationTokenDisplay stays imported and used by renderMarkdownFullObservation (only the renderMarkdownTableRow call was dropped); added inline comment.
- C7-T1-003: added a doc comment to renderDayTimelineMarkdown stating the markdown path intentionally has no file grouping (no currentFile), unlike the color path; added a closing note to step 1.4.
- C7-T1-005: added step 1.5b — explicit grep for old verbose substrings across tests/context and tests/services/context BEFORE the suite run, replacing the passive defensive note; referenced it from 1.6.
- C7-T2-002: added the trailing-slash full-URL test case to 2.1 and a rule note in the resolver JSDoc (2.3); bumped 2.4 expected to 6 pass.
- C7-T3-001: noted in 3.1 that the resolveConfig stub provider swaps (lines 537/558) are REQUIRED (not optional) because the narrowed union drops 'openrouter'.
- C7-T3-002: added pre-check step 3.0 (upfront inventory grep) and kept the post-edit ZERO-match grep at 3.6.
- C7-T4-001: extended the mode-preservation test (4.1) to also assert content replacement (JSON.parse equals { y: 2 }).
- C7-T4-002: added a best-effort-durability caveat to the json-utils file-level JSDoc and the dir-fsync catch comment, documenting that directory fsync failure is silently ignored (file contents already safe).
- C7-T4-003: reordered 4.5(c) so the orphaned-import grep runs BEFORE deleting symbols (pre-check), with explicit guidance to keep any symbol with a live use elsewhere.
- DECISIONS #4 (no OneDrive/sync verify): softened the OneDrive references in Task 4's intro, the json-utils doc comment, and the commit message to 'dotfile managers / symlinked configs' (repo syncs via git). Kept the 0600/atomic-write logic. No verify-on-sync step existed to remove.
- C7-T5-001: added step 5.1b verifying the worker.port convention matches the established mem-timeline skill (fork does not write worker.port; fallback to 37777 is the documented default), with a flag about non-default CLAUDE_MEM_WORKER_PORT.
- Build-note accuracy: added a chunk-level build note clarifying npm run build is esbuild (not tsc); reworded Task 1/2/4 'no TS errors' to 'no esbuild resolution/syntax errors'. Reframed the chunk intro (dropped the now-obsolete 'see notes for why left intentionally' scoping since the full sweep is now in-scope).

  备注: OpenRouter sweep cross-chunk impact: Task 3 now removes ALL OpenRouter references in src/ and tests/. Chunk 2 (security-privacy) touches EnvManager.ts and SettingsRoutes.ts and Chunk 3 (worker-lifecycle) touches SettingsDefaultsManager.ts/SettingsRoutes.ts/worker-types.ts — if those chunks land BEFORE Chunk 7, the OpenRouter line anchors cited in Task 3.3b-3.3f will shift; the executor must re-grep (step 3.0 inventory) before applying each removal block. Recommend Chunk 7 Task 3 run its 3.0 inventory + 3.6 zero-match grep as the authoritative check regardless of ordering.

Verified at write-time against the fork: applyEnvOverrides loops Object.keys(this.DEFAULTS) at SettingsDefaultsManager.ts:224 (confirms DECISIONS false-positive C7-T2-001); verify-settings-alignment.ts flags only FRONTEND phantom keys (so removing OPENROUTER from both backend DEFAULTS and frontend constants/settings.ts keeps the build green); formatDateTime (src/shared/timeline-formatting.ts:31) returns verbose 'Mon DD, H:MM AM/PM' — this is why compactTime is now applied to summary times. The fork's mem-timeline skill already uses `cat ~/.claude-mem/worker.port` (lines 53-54), so mem-weekly-digests inherits the same (pre-existing) port convention; no worker.port writer exists in worker-service.ts — that is a documented mem-timeline-shared limitation, not introduced here.

Test-count delta after the chunk: json-utils +5, openai-compatible-base-url +6 (added trailing-slash case). settings-defaults-manager.test.ts:352 changed from an OpenRouter to an OpenCode key assertion (net 0). markdown-formatter.test.ts is a rewrite (net change depends on consolidated assertions). No DB migration introduced anywhere (schema stays v33).

## 附录 B:本轮 open items / 待办说明

以下为 spec-review 提出的 round-level scope gaps + 维护者决策结果,实施时留意:

- **PROVENANCE**:每个移植 commit 带 `Upstream: thedotmack/claude-mem@<hash> (<license>)` trailer;另在仓库根新增 `docs/PROVENANCE.md` 索引表(项→commit→许可证),fork 维持 AGPL-3.0。
- **agent_id 探针(C2)**:纯 instrumentation,无固定日期;部署到 pod 后由维护者观察日志,若确认子 agent 触发多余 summarize 再回收 Q23(a),否则删除探针。代码注释已标 TEMPORARY PROBE。
- **按批 rollback**:solo 维护,采用「revert 整个批次 PR + 后续重做」;无需正式 rollback 流程。批内顺序 load-bearing(P0→P1→P2;批内 Chunk 顺序见执行顺序节)。
- **settings.json 同步**:仓库走 git 同步,无 OneDrive;0600 + 原子写无冲突,**不需要** sync 验证步骤。
- **python3 依赖(C6 schema 修复)**:为既有代码(非本轮引入);C6 新增的可读性探测为纯 SQL 无此依赖。提醒:pod/CI 上确保 python3 可用,否则既有 malformed-schema 修复路径会受限。
- **OpenRouter 清扫范围(C7)**:本轮**全量清扫且全部本轮完成** —— BypassLane 路径 + SettingsDefaults/EnvManager/SettingsRoutes/viewer UI/worker-types。viewer UI 在 `src/` 下,而 Task 3.6 要求 `grep -i openrouter src/ tests/ == 0`,故 viewer UI **必须一并清除,不可延后**(无"文档说明 + 后续 sweep"降级选项)。

以下为 spec-review 原始 findings 的**resolved archive**。这些不再是 open blockers;若后续重新打开,必须同步改正文任务与治理约束:

- **PROVENANCE.md file creation — RESOLVED.** C7-T6 创建 `docs/PROVENANCE.md`;commit trailers + index file 双轨保留来源/许可证。
- **Agent_id probe post-verification — RESOLVED.** C2-T1 的代码注释含 `TEMPORARY PROBE` + `TODO(Q23)` + 删除条件;附录 B 规定由维护者观察 pod 日志后关闭 Q23 并删除探针。
- **Settings.json + OneDrive sync interaction — RESOLVED.** 维护者决策:仓库走 git 同步,无 OneDrive 验证步骤;0600 + atomic write 保留。
- **Rollback/revert strategy per batch — RESOLVED.** solo 维护采用 revert 整个批次/风险子 PR + 后续重做;P0/P1 风险子 PR 不改变优先级。
- **Weekly-digests skill import path — RESOLVED.** C7-T5 已验证 fork 现有 `SearchRoutes.ts:265` 与 `ContextBuilder.ts:143` 支持 `/api/context/inject?full=true`;任务只导入 markdown skill 并做 endpoint smoke。
- **Chunk 6 Task 3 Python3 dependency — RESOLVED AS PRE-EXISTING RISK.** C6 schema-readability-probe 本身纯 SQL;python3 只是既有 malformed-schema 修复路径依赖,附录 B 保留环境提醒。
- **FileSystem hygiene for test cleanup — RESOLVED BY GATE.** Go criteria 要求共享符号/test sweep;执行时所有新增 tmpdir/mkdirSync 测试必须遵守 `tests/CLAUDE.md` afterAll cleanup,否则 chunk 不得合入。
- **Weekly-digests step-count — RESOLVED.** C7-T5 当前步骤以正文编号为准;不要从 appendix 的历史 step-count 推断执行顺序。
- **BypassLane base-url settings integration — RESOLVED.** C7-T2 只新增 `CLAUDE_MEM_OPENCODE_BASE_URL`;绝不新增 `CLAUDE_MEM_OPENROUTER_BASE_URL`。C7-T3 的 zero-match grep 覆盖 `src/` 下 viewer UI/settings/routes/types,因此 UI 清扫必须随任务完成;是否给 base-url 加 viewer 控件是产品选择,不是本轮 OpenRouter 清扫 blocker。

## 附录 C:治理约束(governance,实施全程遵守)

- TEST BASELINE MAINTENANCE: Plan enforces **0 fail** on the implementation-day root-test baseline. CLAUDE.md's `1933 pass` is historical context only; do not hard-code it as the expected final count. Each chunk is expected to maintain the then-current root-test pass set and add its net-new cases. When `attn_sink/` exists locally, use the root-test command from the Tech Stack section instead of bare `bun test` so ignored upstream clones are excluded.
- SCHEMA VERSION LOCK: Plan explicitly maintains schema v33 (per CLAUDE.md / fork baseline). NO migration items are permitted in this round. Every chunk appendix verifies 'no DB migration introduced'. If a future requirement necessitates schema changes, a NEW migration (v34+) must be created separately.
- BUILD COMMAND DISCIPLINE: Plan enforces `npm run build` (esbuild, type+bundle) for verification of bundle resolution and syntax. Does NOT perform full type checking (use IDE/CI for that). P0/P1 batches use `npm run build-and-sync` (deploy+restart) before final PR merge to verify worker integration.
- PROVENANCE TRAILER REQUIREMENT: Every upstream-derived commit MUST carry a `Upstream: thedotmack/claude-mem@<hash> (<license>)` trailer. License is determined via `git merge-base --is-ancestor 36b0929f <hash>`: exit 0 = Apache-2.0, else = AGPL-3.0. Only genuinely **fork-original** work MUST NOT have a trailer — namely the `agent_id` probe (C2) and the OpenRouter removal (C7 Task 3, our own cleanup). **`writeJsonFileAtomic` (C7 Task 4) is upstream-DERIVED** (ports `65607897`, AGPL-3.0) and therefore DOES carry an `Upstream:` trailer — do not strip it.
- PROVENANCE INDEX FILE: `docs/PROVENANCE.md` MUST be created (C7 Task 6) as the item→commit→license index; it is itself fork-original documentation (no trailer on its own commit).
- NO CHANGELOG EDITS: Per CLAUDE.md:74 'No need to edit the changelog ever, it's generated automatically.' Plan does NOT require or permit manual changelog updates.
- SMOKE TEST FOR CRITICAL BEHAVIOR: Plan requires 'P0/P1 关键行为变更项合入前跑一次真实 observe/summarize 冒烟' (line 31). Critical items (ResponseProcessor markFailed, session-lifecycle guards, context-overflow reset) MUST be tested in live environment before PR merge, not just unit tests.
- PER-PROJECT SQLITE ISOLATION: Chunk 3-7 tasks must not violate the fork's per-project database design (DbConnectionPool, resolveProjectDbPath per src/shared/project-allowlist.ts). Any task touching session/observation storage MUST use dbPath parameter patterns already established in fork.
- CROSS-CHUNK EXECUTION ORDER: The stated order P0→P1→P2 is load-bearing. Within-batch serial order is specified (e.g., 'Chunk 3 before Chunk 4 before Chunk 5'). If a later chunk is applied before an earlier one, anchors/line-numbers may drift and contradictions may occur (e.g., BypassLane edits in Chunk 7 Task 3 assume Chunk 7 Task 2 has landed first).
- 41-ITEM AUDIT MAPPING: Plan must deliver all **41** confirmed audit items (Catch list §0; lineage: original 41 − anchor-coercion (already-covered) + chroma-cwd-homedir (codex-audit restoration) = 41) or explicitly defer them (with rationale). The **42 `### Task` headings** map to 41 items (NOT 1:1): session-lifecycle-guards is split across 2 tasks (+1); non-XML markFailed + preview-log share one task (−1) and system-reminder + persisted-output share one task (−1); base-url generalization + OpenRouter removal is 1 item across 2 tasks (+1); and `docs/PROVENANCE.md` is a round-closing process task (+1) — net 41 items ↔ 42 headings. Dropping any item without updating the audit decision record is a governance violation.
- NO AGPL→APACHE LICENSE CHANGE: Fork remains AGPL-3.0. Upstream Apache-2.0 code is ported with Apache provenance trailers, but fork's overall license does not change. Commit messages MUST respect this boundary.
