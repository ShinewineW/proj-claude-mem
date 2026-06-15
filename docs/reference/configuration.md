# 配置与环境变量参考

> **范围**: `src/shared/SettingsDefaultsManager.ts` + `src/shared/EnvManager.ts` — claude-mem 的全部 `CLAUDE_MEM_*` 设置项、provider 凭证、配置优先级与数据路径。

---

## 1. 配置来源与优先级

配置按以下优先级解析（高 → 低，见 `SettingsDefaultsManager.ts`）：

1. **环境变量** `CLAUDE_MEM_*`（最高）
2. **`~/.claude-mem/settings.json`**（首次运行自动创建，owner-only `0600`）
3. **内置默认值**（`SettingsDefaultsManager.ts` 的 `DEFAULTS`）

Provider 凭证单独存放在 **`~/.claude-mem/.env`**（owner-only `0600`，由 `EnvManager.ts` 管理；observer/summarize 子进程用隔离环境，剥离项目级 `ANTHROPIC_API_KEY` 防污染）。

**权威默认值以 `src/shared/SettingsDefaultsManager.ts` 为准**（共 53 个 `CLAUDE_MEM_*` 键，前端 `src/ui/viewer/constants/settings.ts` 对齐，由 `scripts/verify-settings-alignment.ts` 在构建时校验）。

## 2. 设置项分组（53 个 `CLAUDE_MEM_*`）

### Worker / 数据路径
- `CLAUDE_MEM_WORKER_PORT`（默认 37777）、`CLAUDE_MEM_WORKER_HOST`（默认 127.0.0.1）
- `CLAUDE_MEM_DATA_DIR`（默认 `~/.claude-mem`）
- `CLAUDE_MEM_PROJECT_DB_PATH`（显式覆盖单个项目的 DB 路径；见 `src/shared/paths.ts`）
- `CLAUDE_MEM_EXCLUDED_PROJECTS`、`CLAUDE_MEM_LOG_LEVEL`

### Provider（observation 处理通道）
- `CLAUDE_MEM_PROVIDER`（`claude` 默认；取值闭集 `claude` / `openai`；设为 `openai` 时启用 Bypass Lane 旁路）
- `CLAUDE_MEM_MODEL`、`CLAUDE_MEM_MAX_CONCURRENT_AGENTS`
- **OpenAI 兼容**：`CLAUDE_MEM_OPENAI_API_KEY`、`CLAUDE_MEM_OPENAI_BASE_URL`（必填，留空即旁路禁用）、`CLAUDE_MEM_OPENAI_MODEL`
- 凭证也可放 `~/.claude-mem/.env`（`OPENAI_API_KEY`，见 `EnvManager.ts`）

### Chroma 向量搜索（语义检索）
- `CLAUDE_MEM_CHROMA_ENABLED`、`CLAUDE_MEM_CHROMA_MODE`
- `CLAUDE_MEM_CHROMA_HOST`、`CLAUDE_MEM_CHROMA_PORT`、`CLAUDE_MEM_CHROMA_SSL`
- `CLAUDE_MEM_CHROMA_API_KEY`、`CLAUDE_MEM_CHROMA_TENANT`、`CLAUDE_MEM_CHROMA_DATABASE`
- 未启用 / 不可用时搜索自动回退到 SQLite FTS5/LIKE。

### SDK token 优化 & 历史控制
- `CLAUDE_MEM_SKIP_TOOLS`、`CLAUDE_MEM_SKIP_TOOL_PATTERNS`（Layer A 预过滤）
- `CLAUDE_MEM_BATCH_MAX_SIZE`、`CLAUDE_MEM_OBS_MAX_FIELD_CHARS`
- `CLAUDE_MEM_MAX_HISTORY_LENGTH`（默认 50）、`CLAUDE_MEM_MAX_HISTORY_TOKENS`（默认 100000）
- `CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS`

### 会话 / Pool starvation 防御 / watchdog
- `CLAUDE_MEM_SESSION_MAX_AGE_MS`（默认 4h 墙钟上限）
- `CLAUDE_MEM_BACKPRESSURE_L1`、`CLAUDE_MEM_BACKPRESSURE_L2`、`CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE`
- `CLAUDE_MEM_POOL_COOLDOWN_MS`、`CLAUDE_MEM_MAX_POOL_RETRIES`、`CLAUDE_MEM_BYPASS_COOLDOWN_MS`
- `CLAUDE_MEM_STALE_INIT_THRESHOLD_MS`、`CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS`、`CLAUDE_MEM_RESPONSE_WATCHDOG_MS`

### Context 注入显示
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS`、`CLAUDE_MEM_CONTEXT_SESSION_COUNT`、`CLAUDE_MEM_CONTEXT_FULL_COUNT`、`CLAUDE_MEM_CONTEXT_FULL_FIELD`
- `CLAUDE_MEM_CONTEXT_SHOW_*`（LAST_MESSAGE / LAST_SUMMARY / READ_TOKENS / WORK_TOKENS / SAVINGS_AMOUNT / SAVINGS_PERCENT / TERMINAL_OUTPUT）

### 保留策略 & folder CLAUDE.md
- `CLAUDE_MEM_RETENTION_ENABLED`、`CLAUDE_MEM_RETENTION_DAYS`、`CLAUDE_MEM_RETENTION_MAX_KEPT`、`CLAUDE_MEM_RETENTION_SCORE_THRESHOLD`
- `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED`、`CLAUDE_MEM_FOLDER_MD_EXCLUDE`

### 上游 Anthropic（SDK 主通道）
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`（也可走 Claude Code 登录态，无需 key）

## 3. 数据路径

- 每项目 DB：`<repo>/.claude/mem.db`（自动 gitignore；WAL 模式）
- 全局 fallback DB：`~/.claude-mem/claude-mem.db`
- 启用白名单：`~/.claude-mem/enabled-projects.json`（`/mem-enable` 写入）
- 凭证：`~/.claude-mem/.env`；设置：`~/.claude-mem/settings.json`
- Chroma：`~/.claude-mem/chroma/`；日志：`~/.claude-mem/logs/worker-<YYYY-MM-DD>.log`

## 4. Cross-Ref
- 权威默认值：`src/shared/SettingsDefaultsManager.ts`
- 凭证隔离：`src/shared/EnvManager.ts`
- DB 路径解析：`src/shared/paths.ts`、`src/shared/project-allowlist.ts`
- HTTP API / MCP：[`worker-api.md`](worker-api.md)
