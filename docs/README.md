# docs/ — 项目文档索引

> **创建日期**: 2026-06-06
> **更新日期**: 2026-06-06
> **状态**: 活跃
> **范围**: `docs/` 下所有文档的导航入口，按「参考 / 报告 / 设计 / 外部参考快照」分类

---

## 1. 概述

本目录存放 proj-claude-mem 的长青参考文档、时间点报告、设计/实施计划，以及从上游与 Claude Code/Cursor 官方抓取的参考快照。本页是导航入口（meta 文档，不受文档四分类元数据约束）。

代码子系统的导航文档不在此处，而是各目录下的 `CLAUDE.md`（见 §3 Cross-Ref）。

## 2. 文件清单

### 参考文档（References，常青）
- `reference/worker-api.md`
  - 作用：worker HTTP API 端点（搜索/上下文/数据/会话/设置）、MCP `mcp-search` 工具、Web Viewer 入口。
  - 何时读：对接 API、调用 MCP 工具、或排查入口可用性时。
- `reference/configuration.md`
  - 作用：全部 58 个 `CLAUDE_MEM_*` 设置项（按功能分组）、provider 凭证、配置优先级、数据路径。
  - 何时读：配置 Chroma/Gemini/OpenCode、调参、或定位数据/凭证路径时。
- `PROVENANCE.md`
  - 作用：本轮 v10.6.1→v13.4.0 cherry-pick 的逐条上游来源 + 许可证追溯索引（fork 维持 AGPL-3.0，Apache-2.0 部分逐项署名）。
  - 何时读：判断某段移植代码来自哪个上游 commit / 适用哪个许可证时。
- `SESSION_ID_ARCHITECTURE.md`
  - 作用：解释 claude-mem 使用的两类 session ID（content session vs memory session）及其追踪关系。
  - 何时读：改 session 生命周期、summarize 路径或 resume 逻辑前。

### 外部参考快照（context/）
- `context/agent-sdk-v2-preview.md` + `context/agent-sdk-v2-examples.ts` — Claude Agent SDK V2 接口预览与示例。
- `context/cursor-hooks-reference.md` — Cursor hooks 系统参考。
- `context/hooks-reference-2026-01-07.md` — Claude Code hooks 官方参考快照（抓取于 2026-01-07）。
  - 性质：外部文档定点快照，供离线对照；非本项目契约，可能滞后于上游官方文档。

### 报告（Reports，时间点产物）
- `reports/2026-06-04-upstream-cherry-pick-audit.md` — v10.6.1→v13.4.0 可移植性审计报告（多 Agent 工作流编排）。
- `reports/2026-06-05-cherrypick-plan-meta-audit.md` — 对实施计划 + 审计报告的二次独立元审计（42 task 合理性 + 合法性复核）。

### 设计文档（Specs，有生命周期）
- `spec/2026-06-04-upstream-cherrypick-impl-plan.md` — 本轮 cherry-pick 实施计划（41 项；状态：活跃；经 spec-review + codex 交叉审计修订）。

## 3. Cross-Ref

- 根 [`README.md`](../README.md) — 项目总览；其「致谢」段链接 `PROVENANCE.md`。
- [`CLAUDE.md`](../CLAUDE.md) — 架构总览与文件位置。
- 子系统导航：[`src/services/worker/CLAUDE.md`](../src/services/worker/CLAUDE.md)、[`src/services/sqlite/CLAUDE.md`](../src/services/sqlite/CLAUDE.md)、[`src/shared/CLAUDE.md`](../src/shared/CLAUDE.md)、[`src/cli/handlers/CLAUDE.md`](../src/cli/handlers/CLAUDE.md)、[`scripts/CLAUDE.md`](../scripts/CLAUDE.md)、[`tests/CLAUDE.md`](../tests/CLAUDE.md)。
- [`plugin/README.md`](../plugin/README.md) — 插件载荷的生成物 vs 手写源边界。
