# proj-claude-mem

基于 [claude-mem](https://github.com/thedotmack/claude-mem) 的 fork，实现了 **per-project SQLite 数据库隔离**。

上游 claude-mem 将所有项目的记忆存储在一个全局数据库 `~/.claude-mem/claude-mem.db` 中。本 fork 改造后，每个 git 仓库拥有独立的数据库文件 `<repo>/.claude/mem.db`，实现项目间记忆完全隔离。

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
4. 非 git 目录 → `<cwd>/.claude/mem.db`

**关键特性**：
- 同一仓库的所有 worktree 共享同一个数据库
- `.claude/mem.db*` 自动加入 `.gitignore`（包括 WAL/SHM 文件）
- 无 `.gitignore` 时自动创建
- 连接池管理（`DbConnectionPool`），FIFO 淘汰，最大 10 个并发连接
- 完全向后兼容：无 `dbPath` 时 fallback 到全局数据库

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

构建完成后，插件会被同步到 `~/.claude/plugins/marketplaces/thedotmack/`，worker 服务自动重启。

### 配置

设置文件位于 `~/.claude-mem/settings.json`，首次运行时自动创建。

## 使用方式

安装后无需额外操作。claude-mem 通过 Claude Code 的 hook 系统自动工作：

1. **SessionStart** — 初始化会话，自动检测当前项目并打开对应数据库
2. **PostToolUse** — 捕获工具调用（文件编辑、命令执行等）作为观察记录
3. **Summary** — 会话结束时生成记忆摘要
4. **SessionEnd** — 关闭会话

下次在同一项目中启动 Claude Code 时，会自动注入该项目的历史上下文。不同项目的记忆互不干扰。

### 搜索历史记忆

使用 claude-mem 内置的搜索技能：

```
/mem-search 上次修改了哪些文件？
```

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
│   │   │   └── http/routes/   # Express API 路由（SessionRoutes, SearchRoutes）
│   │   └── context/           # 上下文构建器
│   ├── shared/
│   │   ├── paths.ts           # resolveProjectDbPath(), findGitRoot()
│   │   └── project-db.ts      # DbConnectionPool, ensureGitignore()
│   └── utils/                 # 日志、标签处理等工具
├── tests/
│   ├── shared/                # 路径解析、连接池单元测试
│   ├── integration/           # 项目隔离集成测试
│   └── sqlite/                # SessionStore 测试
├── plugin/                    # 构建产物（hooks, skills, UI）
├── cursor-hooks/              # Cursor IDE 集成（实验性）
├── docs/
│   ├── SESSION_ID_ARCHITECTURE.md   # Session ID 双 ID 架构
│   └── context/                     # hooks/agent-sdk 参考文档
└── scripts/                   # 构建和同步脚本
```

## 开发与测试

```bash
# 运行所有测试
bun test

# 运行项目隔离相关测试
bun test tests/shared/resolve-project-db-path.test.ts
bun test tests/shared/project-db.test.ts
bun test tests/sqlite/session-store-dbpath.test.ts
bun test tests/integration/project-isolation.test.ts

# 按模块运行
bun test tests/sqlite/          # 数据库层
bun test tests/worker/agents/   # Agent 层
bun test tests/context/         # 上下文层

# 构建并部署
bun run build-and-sync

# 查看 worker 日志
bun run worker:logs
```

### 测试覆盖

- 18 个项目隔离专项测试，覆盖路径解析、连接池、gitignore 管理、worktree 共享、数据隔离
- 完整测试套件 1042 个测试

## 致谢

本项目 fork 自 [claude-mem](https://github.com/thedotmack/claude-mem)（作者：Alex Newman），基于 AGPL-3.0 许可证。

上游项目提供了完整的 Claude Code 持久记忆系统，本 fork 在此基础上增加了 per-project 数据库隔离功能。
