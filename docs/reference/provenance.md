# Upstream Provenance — 2026-06 Cherry-Pick Round

> **范围**: 本轮移植自上游 `thedotmack/claude-mem` 的来源与许可证追溯。
> fork 维持 **AGPL-3.0**；上游自 `36b0929f`（v13.0.0）起为 Apache-2.0，之前为 AGPL-3.0。
> 许可证判定：`git merge-base --is-ancestor 36b0929f <hash>`（exit 0 ⇒ Apache-2.0，否则 AGPL-3.0）。
>
> **License decision**: The fork remains AGPL-3.0. Apache-2.0-derived portions are attributed
> via per-file SPDX headers and this PROVENANCE index. See the repository root `NOTICE` file for
> the combined-work attribution notice.
>
> 每行的 `Upstream hash(es)` 与 `源许可证` 直接取自对应 fork 提交的 `Upstream:` trailer
> （`git log <commit> --format=%B | grep Upstream:`），为权威来源。

---

| Fork commit | 移植项 | Upstream hash(es) | 源许可证 |
|-------------|--------|-------------------|----------|
| `a0d8edac` | null-byte delimiter in observation content_hash | `9cfa57d49` | AGPL-3.0 |
| `ee0ab7a5` | handle bare-path strings in files_read/files_modified | `2a304d59e` | AGPL-3.0 |
| `e8bf1b37` | mark pending messages failed + log preview on non-XML | `be99a5d69` + `92f800d4` | AGPL-3.0 |
| `e941395d` | real no-tools lockdown for observer + fresh-summarize SDK | `ce13c887` + `703c64c7` + `46d204ee9` | Apache-2.0 + AGPL-3.0 |
| `bfd99228` | restrict .env + settings.json to owner-only (0600/0700) | `31ee1024c` | AGPL-3.0 |
| `cdcc7330` | strip `<system-reminder>` and `<persisted-output>` tags | `a66b98bcd` + `f81684c61` | AGPL-3.0 |
| `894f187c` | strip privacy tags from last_assistant_message | `46d204ee9` | AGPL-3.0 |
| `8375ca64` | block CLAUDE_CODE_EFFORT_LEVEL/ALWAYS_ENABLE_EFFORT from SDK subprocess | `9c56dda79` | Apache-2.0 |
| `5be5308f` | atomic socket-bind isPortInUse to kill TOCTOU spawn race | `64cce2bf` | AGPL-3.0 |
| `9d6e2b80` | exit cleanly when duplicate daemon loses port bind race | `08cf2ba3` | AGPL-3.0 |
| `e0a79834` | protect parent hook + PID-file worker in aggressiveStartupCleanup | `88b47f9e` | AGPL-3.0 |
| `a0fa91d6` | raise POST_SPAWN_WAIT 5s→15s for macOS ARM64 cold starts | `88b47f9e` | AGPL-3.0 |
| `6e984aa6` | reset memorySessionId + forceInit on context overflow | `703c64c7` | AGPL-3.0 |
| `8292fd24` | stale-controller binding, SIGTERM-as-intentional, kill-dup-before-spawn | `f97c50bf` | AGPL-3.0 |
| `131c95ca` | CLAUDE_MEM_SESSION_MAX_AGE_MS wall-clock age cap (default 4h) | `f97c50bf` | AGPL-3.0 |
| `27248b56` | make MCP loopback self-check non-fatal | `4589b34e` | AGPL-3.0 |
| `00361d7c` | pin chroma-mcp==0.2.6 + onnxruntime/protobuf overrides | `55334129` | Apache-2.0 |
| `d1af69e0` | enforce single chroma-mcp subprocess via tree-kill (dual-source commit) | `d384d3c5` + `55334129` | AGPL-3.0 + Apache-2.0 |
| `cac0c3ba` | spawn chroma-mcp from $HOME to avoid pydantic .env crash | `c7c4fd54` | AGPL-3.0 |
| `a8870ce9` | reconcile duplicate-ID batch conflict via delete+add | `64cce2bf` | AGPL-3.0 |
| `8ac99c3d` | default ANONYMIZED_TELEMETRY=false in spawn env | `39f11026` | AGPL-3.0 |
| `a39e76bd` | declare inputSchema properties for search and timeline MCP tools | `8cdabe63` | AGPL-3.0 |
| `78961b18` | preserve Chroma semantic rank order in main search hydration | `46d204ee9` | AGPL-3.0 |
| `793331c9` | fall back to FTS5/LIKE text search when ChromaDB is absent | `be99a5d69` | AGPL-3.0 |
| `8dc10638` | map singular concept query param to plural concepts | `be99a5d69` | AGPL-3.0 |
| `0b65995f` | filter ghost observations before storing on bypass lane | `e39821298` | AGPL-3.0 |
| `49ea074e` | cap WAL growth with journal_size_limit on pooled connection | `be99a5d6` | AGPL-3.0 |
| `6600a89e` | assert single row changed on pending-message completion | `65f2fd8c` | AGPL-3.0 |
| `e8710021` | probe schema readability before PRAGMA in open path | `a8cf6716` | Apache-2.0 |
| `f325db32` | skip summary false positives with no sub-tags | `93a30c5c` | AGPL-3.0 |
| `f077b0bf` | downgrade concept-type cleanup log from error to debug | `29ef3f56` | AGPL-3.0 |
| `ae4bc6c0` | encode dots in cwdToDashed to match transcript dir naming | `daf6d9dc` | Apache-2.0 |
| `5ab508d1` | guard debug JSON.stringify against circular structures | `46d204ee` | AGPL-3.0 |
| `d17be1fb` | remove dead USER_MESSAGE_ONLY exit code | `4aa7119d` | AGPL-3.0 |
| `6bfcd6c2` | skip tree-sitter native build via trustedDependencies allowlist | `99ff296f` | AGPL-3.0 |
| `8f550102` | compress markdown context output to flat lines | `7e072106` | AGPL-3.0 |
| `23514f1d` | configurable OpenAI-compatible base URL (CLAUDE_MEM_OPENCODE_BASE_URL) | `d13fc437` | Apache-2.0 |
| `8b68663a` | `writeJsonFileAtomic` — crash-safe symlink-safe JSON writer | `65607897` | AGPL-3.0 |
| `d9e64074` | `mem-weekly-digests` serial-narrative skill | `09e74bbf` | Apache-2.0 |

## Fork-original（无上游来源，无 Upstream: trailer）

- **`cc37e220`** — agent_id/agent_type stdin probe（C2 Chunk 2）— 纯 instrumentation，TEMPORARY PROBE，TODO(Q23)，由维护者观察 pod 日志后关闭。
- **`2a9dbe6f`** — OpenRouter 完整移除（C7 Task 3）— fork 自有清理，上游保留 OpenRouter；本 fork 将 OpenCode 泛化为通用 OpenAI-compatible 客户端后 OpenRouter 冗余。
- **file-to-prod Stage 3–6 审计修复 + 测试隔离修复** — 均为 fork-original（无上游来源）：non-XML 解析守门、per-project kill 作用域 + captured-controller、logger 循环引用守护、FTS5 MATCH 容错、OpenCode base-URL 校验/接线、summary content-hash `\x00` 分隔、parseFileList 字符串契约、`tests/audit/phase3-*` 属性回归、ProcessRegistry/ChromaMcpManager 测试 mock 污染隔离、`OPENCODE_API_URL` 去重、可读性精简。
- **`docs/reference/provenance.md` 本身** — round-closing 文档，fork-original。

## 附注

- 本文件覆盖全轮所有 **39 个 upstream-derived 提交**（带 `Upstream:` trailer）+ fork-original 提交（上方列出）。校验命令：`git log 4028f4bc..HEAD --grep='Upstream: thedotmack' --format=%h | while read h; do grep -q "$h" docs/reference/provenance.md || echo MISSING $h; done`（应无输出），表格数据行数应等于 39。
- 同一上游 hash 在多个 fork 提交中出现（`be99a5d69` × 4, `46d204ee9` × 3, `88b47f9e` × 2, `55334129` × 2, `f97c50bf` × 2, `64cce2bf` × 2）属正常情况 — 同一上游修复被拆分为独立 fork 提交，或被多处复用。
- 多上游源提交：`e941395d`（observer 锁死 = `ce13c887` Apache + `703c64c7`/`46d204ee9` AGPL）、`d1af69e0`（tree-kill = `d384d3c5` AGPL + `55334129` Apache）、`e8bf1b37`（markFailed + preview-log = `be99a5d69` + `92f800d4`）、`cdcc7330`（双标签剥离 = `a66b98bcd` + `f81684c61`）。combined 派生作品整体受 AGPL-3.0 约束，per-source 许可证已逐一追溯。
- Apache-2.0 派生新文件携带 per-file SPDX 标识：`src/shared/openai-compatible-base-url.ts`（`d13fc437`）与 `src/sdk/hardened-options.ts`（`ce13c887`）在文件顶部带 `SPDX-License-Identifier: Apache-2.0` 注释头；`plugin/skills/mem-weekly-digests/SKILL.md`（`09e74bbf`）因 Markdown 无注释头惯例，SPDX 置于 frontmatter 后的 HTML 注释中。AGPL-3.0 派生与 fork-original 文件带 `SPDX-License-Identifier: AGPL-3.0` 或无头（默认 fork 的 AGPL-3.0）。
