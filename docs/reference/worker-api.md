# Worker HTTP API & MCP 参考

> **范围**: `src/services/worker/http/routes/*` + `src/servers/mcp-server.ts` + `plugin/.mcp.json` — worker 暴露的 HTTP 入口、MCP 搜索服务器与工具、Viewer 入口。

---

## 1. 入口概览

claude-mem 的所有运行期入口都经由 **worker 服务**（Express，默认 `http://127.0.0.1:37777`，Bun 守护进程）：

- **HTTP API** — hooks / 脚本 / 外部集成调用（§2）
- **MCP 服务器 `mcp-search`** — Claude Code 经 `plugin/.mcp.json` 加载，提供检索工具（§3）
- **Web Viewer** — `GET /`（§4）

启停：`bun run worker:start` / `worker:stop` / `worker:restart` / `worker:status`（底层 `plugin/scripts/worker-service.cjs <cmd>`）。

> 多数读接口支持 `?dbPath=<repo>/.claude/mem.db` 指定按项目 DB；缺省走全局 DB。未 opt-in 的项目返回 `{"error":"Project not enabled"}`。

## 2. HTTP API

### 健康 / 元信息
```bash
curl http://127.0.0.1:37777/api/health        # {"status":"ok",...}
curl http://127.0.0.1:37777/api/readiness      # {"status":"ready","mcpReady":true}
curl http://127.0.0.1:37777/api/stats          # worker + database 统计
```

### 搜索 / 上下文（GET）
- `GET /api/search?query=<q>[&type=observations&limit=20&dbPath=...]` — 统一搜索（需 `query` 或至少一个 filter，否则 400）
- `GET /api/search/by-concept?concept=<c>` ·  `…/by-file?filePath=<p>` · `…/by-type?type=<t>` — 必填对应参数，缺失返回 400
- `GET /api/search/observations|sessions|prompts?query=...`
- `GET /api/search/help` — 各搜索接口的参数说明
- `GET /api/context/recent?project=...&limit=3` · `/api/context/timeline` · `/api/context/inject` · `/api/context/preview`
- `GET /api/timeline[?anchor=<id> | ?query=...]` · `/api/decisions` · `/api/changes`

```bash
curl "http://127.0.0.1:37777/api/search?query=worker&limit=5&dbPath=$PWD/.claude/mem.db"
```

### 数据 / 设置（GET）
- `GET /api/observations` · `/api/summaries` · `/api/prompts` · `/api/recent`
- `GET /api/observation/:id` · `/api/prompt/:id` · `/api/session/:id`
- `GET /api/projects` · `/api/stats/trend` · `/api/logs` · `/api/pending-queue` · `/api/processing-status`
- `GET /api/settings`

### 写接口（POST/DELETE）
- `POST /api/sessions/init` · `/api/sessions/observations` · `/api/sessions/summarize` · `/api/sessions/complete` — 会话生命周期（hooks 使用）
- `POST /api/observations/batch` · `/api/sdk-sessions/batch` — 批量写入
- `POST /api/import` — 导入记忆 JSON
- `POST /api/memory/save` — 保存单条记忆
- `POST /api/settings` — 更新设置（写 `~/.claude-mem/settings.json`，owner-only 0600）
- `POST /api/logs/clear` · `POST /api/pending-queue/process`

### SSE 流
- `GET /stream` · `GET /sessions/:sessionDbId/status` — 实时 observation / 会话状态推送（Viewer 使用）

> 错误约定：缺参/坏请求 → `400 {"error":...}`；其余失败 → `500`（`src/services/worker/http/BaseRouteHandler.ts`）。

## 3. MCP 服务器 `mcp-search`

`plugin/.mcp.json` 注册一个 stdio MCP 服务器，命令 `${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs`（构建自 `src/servers/mcp-server.ts`），Claude Code 启动时加载。它把工具调用代理到 worker HTTP API。

工具（7 个，见 `mcp-server.ts`）：
- `search` — 统一搜索过去的工作
- `timeline` — 按时间线/锚点浏览会话与记忆
- `get_observations` — 取指定会话/条件的 observation
- `list_projects` — 列出启用记忆的项目
- `smart_search` — token 优化的结构化搜索（AST 辅助）
- `smart_outline` — 代码/会话结构提纲
- `smart_unfold` — 按需展开提纲节点

`mem-search` 技能（`plugin/skills/mem-search/SKILL.md`）即驱动这些工具，用户问“历史/之前做过什么”时自动触发。

## 4. Web Viewer

- `GET http://localhost:37777/` — React 单页（构建自 `src/ui/viewer`，产物 `plugin/ui/viewer.html`）
- 默认 “All Projects” 视图查询全局 DB（隔离后通常为空）；在 Header 下拉选具体项目查看其记忆。

## 5. Cross-Ref
- 路由实现：`src/services/worker/http/routes/`（`SearchRoutes`/`DataRoutes`/`SessionRoutes`/`SettingsRoutes`/`ViewerRoutes`/`LogsRoutes`）
- MCP：`src/servers/mcp-server.ts`、`plugin/.mcp.json`
- 配置/环境变量：[`configuration.md`](configuration.md)
- 子系统导航：[`../../src/services/worker/CLAUDE.md`](../../src/services/worker/CLAUDE.md)
