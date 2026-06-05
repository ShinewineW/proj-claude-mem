# plugin/ — Claude Code 插件载荷

> **创建日期**: 2026-06-06
> **更新日期**: 2026-06-06
> **状态**: 活跃
> **范围**: 部署给 Claude Code 的插件目录——手写插件资产 + 由 `src/` 构建出的产物的混合体
> **适用环境**: 通过 `bun run build` / `bun run build-and-sync` 生成与部署；勿直接编辑生成物

---

## 1. 概述

`plugin/` 是 claude-mem 作为 Claude Code 插件被加载的**完整载荷**。`scripts/sync-to-cache.cjs` 会把整个目录 1:1 rsync 到两个 Claude Code 读取位置：

- `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/`（含 `node_modules`）
- `~/.claude/plugins/marketplaces/thedotmack/plugin/`（CC 实际从这里读 hooks / skills / MCP）

**关键边界**：本目录里一部分文件是**手写源**（在这里编辑），另一部分是**从 `src/` 构建出的产物**（不要手改，改 `src/` 后重新构建）。混淆两者是本目录最大的坑——见 §2 的「性质」标注与 §5。

目标读者：要改插件行为（hooks/skills/modes/MCP 注册）或排查「为什么我改了代码插件没变」的人和 AI。

## 2. 文件清单

- `.claude-plugin/plugin.json`
  - 性质：手写源（manifest）
  - 作用：Claude Code 读取的插件描述符（`name: claude-mem`、`version: 10.5.2`、`license: AGPL-3.0`、`repository: ShinewineW/proj-claude-mem`）。
  - 主 caller / 入口：Claude Code 插件系统。

- `.mcp.json`
  - 性质：手写源
  - 作用：注册 stdio MCP 服务器 `mcp-search`，命令为 `${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs`。`/mem-search` 等技能经此访问搜索 API。
  - 主 caller / 入口：Claude Code MCP 客户端。

- `hooks/hooks.json`
  - 性质：手写源
  - 作用：注册 **4 个 Claude Code 生命周期事件**——`SessionStart`、`UserPromptSubmit`、`PostToolUse`、`Stop`。各事件经 `bun-runner.js` 调用 `hook-client.cjs hook claude-code <command>`，对应命令为 `context` / `session-init` / `observation` / `stop`（`stop` 是复合 handler，内部跑 summarize + session-complete）。另外 `SessionStart` 会先用 `node` 直接跑 `smart-install.js`（不经 bun-runner）再跑 context。命令含 `${CLAUDE_PLUGIN_ROOT}` 为空时回退到硬编码的 `…/claude-mem/10.5.2` 路径——版本升级时须同步该数字。
  - 主 caller / 入口：Claude Code hook 引擎。

- `skills/`（8 个）
  - 性质：手写源（**唯一副本**，`src/` 下没有对应物）
  - 作用：插件技能定义。包含 `mem-enable` / `mem-disable`（per-project opt-in 开关）、`mem-search`、`mem-timeline`、`mem-weekly-digests`、`smart-explore`、`make-plan`、`do`，每个为一个 `<skill>/SKILL.md`。
  - 主 caller / 入口：用户 `/skill-name`；Claude Code 技能系统。

- `modes/`（32 个 JSON）
  - 性质：手写源
  - 作用：observation 类型分类（taxonomy）配置，被 `src/services/domain/ModeManager.ts` 消费。共 32 个：`code.json` 为默认模式；30 个 `code--<…>.json`（29 语言 + `code--chill` 语气变体）经 `parent--override` 继承覆盖；另有 `email-investigation.json` 领域模式。
  - 主 caller / 入口：`ModeManager.loadMode()`。

- `scripts/`
  - 性质：**混合目录**（手写 + 拷贝 + 生成）
  - 手写源（在此编辑）：`bun-runner.js`（用 bun 运行时启动 hook/worker）、`statusline-counts.js`（statusline）、`worker-wrapper.cjs`、`uninstall.sh`。
  - 构建拷贝：`smart-install.js` —— 由 `bun run build` 从 `scripts/smart-install.js` 拷贝过来，**改源在 `scripts/`**。
  - **生成产物（gitignore，勿编辑）**：`worker-service.cjs`、`hook-client.cjs`、`mcp-server.cjs`、`context-generator.cjs` —— 由 `scripts/build-hooks.js` 经 esbuild 从 `src/` 打包；改逻辑请改 `src/`。
  - 主 caller / 入口：`hooks/hooks.json`、`.mcp.json`、Claude Code statusline。

- `ui/`
  - 性质：**生成产物**（已提交，但来自 `src/ui/viewer`）
  - 作用：Viewer 前端（`viewer-bundle.js`、`viewer.html`）由 `scripts/build-viewer.js` 构建；勿手改这两个文件，改 `src/ui/viewer/` 后重新构建。同目录的字体 / logo / `icon-thick-*.svg` 为静态资产。
  - 主 caller / 入口：worker 在 `http://localhost:37777` 提供服务。

- `package.json`
  - 性质：**生成产物**（已提交，但由 `scripts/build-hooks.js` 生成）
  - 作用：缓存目录安装依赖用的插件级 manifest；勿手改。

## 3. 使用 / 工作流

```bash
bun run build            # 仅构建：src/ → plugin/scripts/*.cjs、plugin/ui/*、plugin/package.json
bun run build-and-sync   # 构建 + rsync 到 CC cache/marketplace + 重启 worker（日常用这个）
```

不要直接编辑 `~/.claude/plugins/cache/...` 或 `marketplaces/...` 下的镜像——它们会在下次 `build-and-sync` 被覆盖。

## 4. 关键约束 / 已知坑

- **改逻辑改 `src/`，不要改 `plugin/scripts/*.cjs` 或 `plugin/ui/viewer*`**——它们是生成物，会被构建覆盖。
- **改插件配置改本目录的手写源**：`skills/`、`modes/`、`hooks/hooks.json`、`.mcp.json`、`.claude-plugin/plugin.json`。
- `hooks/hooks.json` 中 `${CLAUDE_PLUGIN_ROOT}` 为空时的回退路径硬编码了版本号 `10.5.2`，须与 `.claude-plugin/plugin.json` 的 `version` 及 cache 目录一致。
- 本 fork 与上游 claude-mem 共用同一 marketplace 键名，不能共存（见根 README）。

## 5. Cross-Ref

- 根 [`README.md`](../README.md) — 项目总览、安装、技能列表。
- [`CLAUDE.md`](../CLAUDE.md) — 架构与文件位置（`Built Plugin` / `Plugin (cache)` / `Plugin (marketplace)`）。
- [`scripts/CLAUDE.md`](../scripts/CLAUDE.md) — 构建 / 同步脚本说明（生成本目录产物的脚本）。
- `src/services/domain/ModeManager.ts` — 消费 `modes/` 的代码入口。
- 各 `src/**/CLAUDE.md` — 对应子系统的导航文档（worker / sqlite / shared / cli/handlers）。
