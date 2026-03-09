# proj-claude-mem

基于 [claude-mem](https://github.com/thedotmack/claude-mem) 的 fork，实现了 **per-project SQLite 数据库隔离** 和 **per-project opt-in 白名单** 机制。

上游 claude-mem 将所有项目的记忆存储在一个全局数据库 `~/.claude-mem/claude-mem.db` 中。本 fork 改造后，每个 git 仓库拥有独立的数据库文件 `<repo>/.claude/mem.db`，且需要显式启用才会记录，实现项目间记忆完全隔离。

## 核心特性

### Per-Project DB 隔离

**问题**：多个项目共用一个全局数据库，项目 A 的记忆会污染项目 B 的上下文注入。

**方案**：每个 git 仓库自动获得独立的 SQLite 数据库。

```
# 改造前（全局共享）
~/.claude-mem/claude-mem.db    ← 所有项目混在一起

# 改造后（按项目隔离）
~/projects/proj-a/.claude/mem.db   ← 项目 A 独立数据库
~/projects/proj-b/.claude/mem.db   ← 项目 B 独立数据库
```

**DB 路径解析优先级**（`resolveProjectDbPath()`）：

1. `CLAUDE_MEM_PROJECT_DB_PATH` 环境变量（显式覆盖）
2. Git worktree → 父仓库的 `.claude/mem.db`（同一仓库的 worktree 共享数据库）
3. Git 仓库根目录 → `<git-root>/.claude/mem.db`
4. 非 git 目录 → 向上搜索 workspace 标记（`CLAUDE.md` 或 `.claude/`），找到则使用该目录的 `.claude/mem.db`；否则 `<cwd>/.claude/mem.db`

**关键特性**：
- 同一仓库的所有 worktree 共享同一个数据库
- `.claude/mem.db*` 自动加入 `.gitignore`（包括 WAL/SHM 文件）
- 无 `.gitignore` 时自动创建
- 连接池管理（`DbConnectionPool`），FIFO 淘汰，最大 10 个并发连接
- 完全向后兼容：无 `dbPath` 时 fallback 到全局数据库

### Per-Project Opt-In

记忆录制**默认关闭**，必须通过 `/mem-enable` 显式启用。

- **白名单文件**：`~/.claude-mem/enabled-projects.json`
- **Guard 机制**：所有 hook 事件（SessionStart, UserPromptSubmit, PostToolUse, Stop）在执行前检查白名单，未启用的项目静默退出
- **Workspace Root 推断**：嵌套 git 仓库场景下，会检查父目录是否包含 `CLAUDE.md` 或 `.claude/` 来确定真正的项目根目录
- **懒加载路径解析**：`getEnabledProjectsPath()` 在调用时动态读取环境变量，避免 ES module hoisting 导致测试清理误删生产白名单

### 多会话并发安全

多个 Claude Code 会话在同一目录下安全共享 `mem.db`：

- **Worker 守护进程**：单例，端口 37777，检测端口占用和 PID 存活后复用已有实例
- **SQLite WAL 模式**：读写互不阻塞
- **Session 隔离**：每个会话独立 `sessionDbId`，`Map<sessionDbId, ActiveSession>` 无共享可变状态
- **消息队列**：`pending_messages` 表使用 claim-confirm 模式，60 秒超时自动重置

## 安装与部署

### 前置条件

- [Bun](https://bun.sh/) >= 1.0.0
- Node.js >= 18.0.0
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/ShinewineW/proj-claude-mem.git
cd proj-claude-mem

# 安装依赖
bun install

# 构建并同步到 Claude Code 插件目录
bun run build-and-sync
```

构建完成后，插件会被同步到 `~/.claude/plugins/marketplaces/thedotmack/` 和版本化缓存目录，自动注册到 Claude Code 插件系统（marketplace、installed_plugins、enabledPlugins），worker 服务自动重启。

### 启用项目

安装后需要在每个想要记录记忆的项目中执行一次：

```
/mem-enable
```

重启 Claude Code 会话后生效。使用 `/mem-disable` 可随时关闭录制。

### 配置

设置文件位于 `~/.claude-mem/settings.json`，首次运行时自动创建。

## 卸载

完全移除插件（代码、注册信息和进程）：

```bash
bash ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/uninstall.sh
```

脚本会先预览所有即将执行的操作，确认后才会执行。

**会被删除：**
- 插件目录（`~/.claude/plugins/marketplaces/thedotmack/`、`~/.claude/plugins/cache/thedotmack/`）
- 插件注册条目（`installed_plugins.json`、`known_marketplaces.json`、`settings.json` 中的 `enabledPlugins` 和 `extraKnownMarketplaces`）
- 全局数据目录（`~/.claude-mem/` — 数据库、配置、日志、向量索引）
- Worker 和 MCP server 进程
- Shell alias（`.zshrc` / `.bashrc` 中的 `alias claude-mem=...`）

**不会被删除（如需清理请手动处理）：**
- `<project>/.claude/mem.db*` — 各项目的独立数据库
- `<project>/.gitignore` 中的 `mem.db*` 条目
- shell 配置中的 `CLAUDE_MEM_*` 环境变量

## 使用方式

启用后无需额外操作。claude-mem 通过 Claude Code 的 hook 系统自动工作：

1. **SessionStart** — 启动 worker 服务，注入历史上下文
2. **UserPromptSubmit** — 初始化会话，自动检测当前项目并打开对应数据库
3. **PostToolUse** — 捕获工具调用（文件编辑、命令执行等）作为观察记录
4. **Stop** — 会话结束时生成记忆摘要并关闭会话

下次在同一项目中启动 Claude Code 时，会自动注入该项目的历史上下文。不同项目的记忆互不干扰。

### 内置技能

| 技能 | 说明 |
|------|------|
| `/mem-enable` | 将当前项目加入记忆录制白名单 |
| `/mem-disable` | 从白名单移除当前项目，停止录制（已有数据保留） |
| `/mem-search` | 搜索当前项目的历史记忆 |
| `/smart-explore` | 基于 tree-sitter AST 的 token 优化代码结构搜索 |
| `/make-plan` | 创建分阶段实施计划（含文档发现） |
| `/do` | 使用 subagents 执行分阶段计划 |

### 隐私控制

使用 `<private>` 标签包裹不希望被记录的内容：

```
<private>这段内容不会被存储</private>
```

## 项目结构

```
proj-claude-mem/
├── src/
│   ├── cli/handlers/          # Hook 处理器（session-init, observation, context）
│   ├── services/
│   │   ├── sqlite/            # SessionStore, SessionSearch, 数据库迁移
│   │   ├── worker/            # Worker 服务核心（DatabaseManager, SDKAgent, SessionManager）
│   │   │   ├── http/routes/   # Express API 路由（Session, Search, Data）
│   │   │   └── agents/        # ResponseProcessor 等
│   │   ├── sync/              # ChromaSync 向量搜索
│   │   └── context/           # 上下文构建器
│   ├── shared/
│   │   ├── paths.ts           # resolveProjectDbPath(), resolveProjectRoot(), resolveWorkspaceRoot()
│   │   ├── project-db.ts      # DbConnectionPool, ensureGitignore()
│   │   └── project-allowlist.ts  # 白名单 CRUD（getEnabledProjectsPath(), isProjectEnabled 等）
│   ├── servers/
│   │   └── mcp-server.ts      # MCP 搜索服务器（白名单驱动的 dbPath 解析）
│   └── utils/                 # 日志、标签处理等工具
├── tests/
│   ├── shared/                # 路径解析、连接池、白名单、env override 测试
│   ├── integration/           # 项目隔离集成测试
│   ├── cli/                   # Hook 白名单 guard 测试
│   └── sqlite/                # SessionStore 测试
├── plugin/                    # 构建产物
│   ├── hooks/hooks.json       # Hook 事件注册
│   ├── scripts/               # CJS bundles（worker-service, mcp-server, context-generator）+ uninstall.sh
│   ├── skills/                # 内置技能（mem-enable, mem-disable, mem-search 等）
│   ├── modes/                 # 多语言模式配置
│   └── ui/                    # Viewer 前端（React → 单文件 HTML）
├── scripts/                   # 构建和同步脚本
└── docs/                      # 架构文档
```

## 开发与测试

```bash
# 运行所有测试（1146 pass, 3 skip）
bun test

# 项目隔离专项测试
bun test tests/shared/project-db.test.ts
bun test tests/integration/project-isolation.test.ts

# Opt-in 白名单测试
bun test tests/shared/project-root.test.ts tests/shared/project-allowlist.test.ts tests/cli/hook-allowlist-guard.test.ts

# Env override 回归测试
bun test tests/shared/data-dir-env-override.test.ts

# 按模块运行
bun test tests/sqlite/          # 数据库层
bun test tests/worker/agents/   # Agent 层
bun test tests/context/         # 上下文层

# 构建并部署
bun run build-and-sync

# 查看 worker 日志
bun run worker:logs
```

## 已知问题

- **Viewer 默认视图为空**：`http://localhost:37777/` 在 "All Projects" 模式下不显示 observations，因为默认查询全局 DB（隔离后为空）。需要在 Header 下拉框选择具体项目。待实现多 DB 聚合。
- **MCP server 孤儿进程**：stdio MCP server 偶尔在父进程退出后存活（竞态条件），无害，~40MB 空闲内存，重启后自动清理。

## 致谢

本项目 fork 自 [claude-mem](https://github.com/thedotmack/claude-mem)（作者：Alex Newman），基于 AGPL-3.0 许可证。

上游项目提供了完整的 Claude Code 持久记忆系统，本 fork 在此基础上增加了 per-project 数据库隔离和 opt-in 白名单机制。
