# Claude-Mem Cursor Hooks Integration

> **创建日期**: 2026-04-12
> **更新日期**: 2026-06-06
> **状态**: 维护（继承自上游；本 fork 经**统一 CLI 模式**工作，旧的 `.sh` 脚本式安装已弃用）
> **范围**: 把 Cursor 的 hook 系统桥接到 claude-mem worker API，让 Cursor 也能有跨会话记忆
> **适用环境**: 已构建并安装本插件（`bun run build-and-sync`）；worker 在 `127.0.0.1:37777` 运行

---

## 1. 概述

这些 hook 让 Cursor 在每次提交 prompt / 执行 MCP 工具 / 跑 shell / 改文件 / 结束会话时，调用 claude-mem worker，从而：

- **会话管理**：初始化会话、生成摘要。
- **观察捕获**：记录 MCP 工具调用、shell 命令、文件编辑。
- **上下文注入**：把历史上下文写入 `.cursor/rules/claude-mem-context.mdc`，Cursor 在所有会话里自动带上它。

> ⚠️ **统一 CLI 模式 vs 遗留 `.sh` 模式（重要）**
> 本 fork 的安装器 `src/services/integrations/CursorHooksInstaller.ts` 生成的 `hooks.json` 直接调用
> `"<bun>" "<worker-service.cjs>" hook cursor <command>`（统一 CLI 模式），**不**使用独立 shell 脚本。
> 本目录里**没有** `session-init.sh` / `save-observation.sh` 等 `.sh` 文件——它们是上游早期的脚本式做法，已被统一 CLI 模式取代。
> 仓库内提交的 `cursor-hooks/hooks.json`（其命令写成 `./cursor-hooks/*.sh`）是**遗留模板**，不代表实际安装产物；请用下方 §3 的安装命令，由安装器生成真实的 `hooks.json`。

## 2. 文件清单

本目录现存的是**文档 + 一个遗留模板**，没有可执行脚本：

- `README.md` — 性质：doc — 本集成的导航入口（你正在读）。
- `QUICKSTART.md` — 性质：doc — 5 分钟上手。
- `STANDALONE-SETUP.md` — 性质：doc — 不装 Claude Code、仅 Cursor 时的免费 provider（Gemini / OpenCode Go）配置。
- `CONTEXT-INJECTION.md` — 性质：doc — 上下文如何注入到 `.cursor/rules/`。
- `INTEGRATION.md` — 性质：doc — 集成细节。
- `PARITY.md` — 性质：doc — 与 Claude Code 集成的功能对齐。
- `REVIEW.md` — 性质：doc — 评审记录。
- `cursorrules-template.md` — 性质：模板 — `.cursorrules` 文件模板。
- `hooks.json` — 性质：**遗留模板**（命令引用不存在的 `./cursor-hooks/*.sh`）；真实 `hooks.json` 由安装器生成，勿直接拷贝此文件。

> 实现真源在 `src/services/integrations/CursorHooksInstaller.ts`（生成 / 校验 / 卸载 `.cursor/hooks.json` 与 `.cursor/mcp.json`）。

## 3. 使用 / 工作流

安装（推荐用统一 CLI，安装器会生成正确的 `hooks.json`）：

```bash
# 经 npm 脚本（底层即 worker-service.cjs cursor ...）
bun run cursor:setup        # 交互式：配置 provider + 安装 hooks
bun run cursor:install      # 安装到当前项目（.cursor/）
bun run cursor:status       # 查看安装状态
bun run cursor:uninstall    # 卸载

# 或直接调底层命令（user 级 = 所有项目）
bun plugin/scripts/worker-service.cjs cursor install user
```

安装后：启动 worker（`bun run worker:start` 或 `bun plugin/scripts/worker-service.cjs start`）→ 重启 Cursor 加载 hooks → `bun run cursor:status` 验证。

### Hook → 统一 CLI 命令映射

安装器写入的 `hooks.json` 把 Cursor 事件映射到 `worker-service.cjs hook cursor <command>`：

| Cursor 事件 | 统一 CLI 命令 | 作用 |
|-------------|---------------|------|
| `beforeSubmitPrompt` | `session-init` | 初始化 claude-mem 会话 |
| `beforeSubmitPrompt` | `context` | 确保 worker 就绪 |
| `afterMCPExecution` | `observation` | 捕获 MCP 工具调用 |
| `afterShellExecution` | `observation` | 捕获 shell 命令 |
| `afterFileEdit` | `file-edit` | 捕获文件编辑 |
| `stop` | `summarize` | 生成摘要 + 更新上下文文件 |

上下文文件 `.cursor/rules/claude-mem-context.mdc` 在每次会话结束（`stop` → `summarize`）后更新，下次会话即可见。

## 4. 关键约束 / 已知坑

- **不要手抄 `cursor-hooks/hooks.json`**：它引用了本 fork 不存在的 `.sh` 文件；务必用安装器生成。
- hook 命令用**绝对路径**指向 bun 与 `worker-service.cjs`（安装器在写入时解析），故插件版本升级或 cache 路径变化后需重新 `cursor:install`。
- 与 Claude Code 集成相比：摘要在 Cursor 侧的 `stop` hook 无 transcript（见 `PARITY.md`）。

## 5. Cross-Ref

- 实现：`src/services/integrations/CursorHooksInstaller.ts`。
- 上手：[`QUICKSTART.md`](QUICKSTART.md)、免费 provider [`STANDALONE-SETUP.md`](STANDALONE-SETUP.md)、上下文注入 [`CONTEXT-INJECTION.md`](CONTEXT-INJECTION.md)、功能对齐 [`PARITY.md`](PARITY.md)。
- 参考：[`../docs/context/cursor-hooks-reference.md`](../docs/context/cursor-hooks-reference.md)。
- 根 [`README.md`](../README.md)、[`CLAUDE.md`](../CLAUDE.md)。
