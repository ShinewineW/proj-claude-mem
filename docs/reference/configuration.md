# 配置与环境变量参考

> **范围**: `src/shared/SettingsDefaultsManager.ts` + `src/shared/EnvManager.ts` — claude-mem 的全部 `CLAUDE_MEM_*` 设置项、provider 凭证、配置优先级与数据路径。

---

## 1. 配置来源与优先级

配置按以下优先级解析（高 → 低，见 `SettingsDefaultsManager.ts`）：

1. **环境变量** `CLAUDE_MEM_*`（最高）
2. **`~/.claude-mem/settings.json`**（首次运行自动创建，owner-only `0600`）
3. **内置默认值**（`SettingsDefaultsManager.ts` 的 `DEFAULTS`）

Provider 凭证单独存放在 **`~/.claude-mem/.env`**（owner-only `0600`，由 `EnvManager.ts` 管理；observer/summarize 子进程用隔离环境，剥离项目级 `ANTHROPIC_API_KEY` 防污染）。

**权威默认值以 `src/shared/SettingsDefaultsManager.ts` 为准**：59 个 `CLAUDE_MEM_*` 键，另有 `CLAUDE_CODE_PATH`。Viewer 只暴露其中适合交互修改的子集；`scripts/verify-settings-alignment.ts` 在构建时核对该子集与后端默认值，并不代表 Viewer 可修改全部设置。

`CLAUDE_MEM_PROJECT_DB_PATH` 是 `paths.ts` 直接读取的环境变量覆盖项，不属于上述 59 个持久化默认键。

## 2. 设置项分组（59 个 `CLAUDE_MEM_*`）

### Worker / 数据路径（5）

- `CLAUDE_MEM_WORKER_PORT`（默认 `37777`）
- `CLAUDE_MEM_WORKER_HOST`（默认 `127.0.0.1`）
- `CLAUDE_MEM_DATA_DIR`（默认 `~/.claude-mem`）
- `CLAUDE_MEM_LOG_LEVEL`（默认 `INFO`）
- `CLAUDE_MEM_EXCLUDED_PROJECTS`（默认空）
- `CLAUDE_MEM_PROJECT_DB_PATH`（仅环境变量；显式覆盖当前项目 DB 路径，不计入 59）
- `CLAUDE_CODE_PATH`（默认空，自动发现 Claude CLI；不是 `CLAUDE_MEM_*`，不计入 59）

### Provider / observer（8）

- `CLAUDE_MEM_PROVIDER`（默认 `claude`；`openai` 启用 OpenAI-compatible Bypass Lane）
- `CLAUDE_MEM_MODEL`（默认 `claude-sonnet-5`）
- `CLAUDE_MEM_MAX_CONCURRENT_AGENTS`（默认 `4`）
- `CLAUDE_MEM_OPENAI_API_KEY`（默认空；凭证也可放在 `~/.claude-mem/.env` 的 `OPENAI_API_KEY`）
- `CLAUDE_MEM_OPENAI_BASE_URL`（默认空；空值表示 Bypass 未配置）
- `CLAUDE_MEM_OPENAI_MODEL`（默认 `deepseek-v4-flash`）
- `CLAUDE_MEM_OBSERVER_RESUME`（默认 `false`）
- `CLAUDE_MEM_RESPONSE_WATCHDOG_MS`（默认 `300000`）

`CLAUDE_MEM_OBSERVER_RESUME=false` 时，新 session 在创建时获得稳定的 `cm-<uuid>` worker anchor，observer 不 resume，也不会用 SDK id 覆盖 anchor。设为 `true` 可恢复旧版 SDK resume + SDK-seeded id。该值只在 session 出生时读取，所以切换后只影响新 session；已有 session 不迁移。它刻意不在 Viewer 中展示，也不在 `POST /api/settings` 白名单中：请手工编辑 `~/.claude-mem/settings.json` 或在启动 worker 前设置环境变量，然后重启 worker。

### Bypass Lane（6）

- `CLAUDE_MEM_BYPASS_COOLDOWN_MS`（默认 `1200000`，20 分钟）
- `CLAUDE_MEM_BYPASS_QUOTA_COOLDOWN_MS`（默认 `1800000`，30 分钟）
- `CLAUDE_MEM_BYPASS_AUTH_COOLDOWN_MS`（默认 `21600000`，6 小时）
- `CLAUDE_MEM_BYPASS_MAX_FAILURES`（默认 `3`）
- `CLAUDE_MEM_BYPASS_CONCURRENCY`（默认 `1`，每 session consumer 数）
- `CLAUDE_MEM_BYPASS_MAX_CONSUMERS`（默认 `6`，全局 REST consumer 上限）

### Chroma 向量搜索（8）

- `CLAUDE_MEM_CHROMA_ENABLED`（默认 `true`）
- `CLAUDE_MEM_CHROMA_MODE`（默认 `local`）
- `CLAUDE_MEM_CHROMA_HOST`（默认 `127.0.0.1`）
- `CLAUDE_MEM_CHROMA_PORT`（默认 `8000`）
- `CLAUDE_MEM_CHROMA_SSL`（默认 `false`）
- `CLAUDE_MEM_CHROMA_API_KEY`（默认空）
- `CLAUDE_MEM_CHROMA_TENANT`（默认 `default_tenant`）
- `CLAUDE_MEM_CHROMA_DATABASE`（默认 `default_database`）

Chroma 未启用或不可用时，搜索自动回退到 SQLite FTS5/LIKE。

### SDK token 优化 / 历史控制（7）

- `CLAUDE_MEM_SKIP_TOOLS`（内置低价值工具名列表）
- `CLAUDE_MEM_SKIP_TOOL_PATTERNS`（内置 `tool:glob` 预过滤模式）
- `CLAUDE_MEM_BATCH_MAX_SIZE`（默认 `5`）
- `CLAUDE_MEM_OBS_MAX_FIELD_CHARS`（默认 `8000`）
- `CLAUDE_MEM_MAX_HISTORY_LENGTH`（默认 `50`）
- `CLAUDE_MEM_MAX_HISTORY_TOKENS`（默认 `100000`）
- `CLAUDE_MEM_MAX_SUMMARY_OBSERVATIONS`（默认 `150`，SummaryLane 自适应序列首档）

### 会话 / Pool starvation / backpressure（8）

- `CLAUDE_MEM_SESSION_MAX_AGE_MS`（默认 `14400000`，4 小时）
- `CLAUDE_MEM_POOL_COOLDOWN_MS`（默认 `120000`）
- `CLAUDE_MEM_MAX_POOL_RETRIES`（默认 `5`）
- `CLAUDE_MEM_STALE_RESPONSE_THRESHOLD_MS`（默认 `180000`）
- `CLAUDE_MEM_STALE_INIT_THRESHOLD_MS`（默认 `120000`）
- `CLAUDE_MEM_BACKPRESSURE_L1`（默认 `20`）
- `CLAUDE_MEM_BACKPRESSURE_L2`（默认 `50`）
- `CLAUDE_MEM_BACKPRESSURE_SAMPLE_RATE`（默认 `3`）

### Context 注入与显示（11）

- `CLAUDE_MEM_CONTEXT_OBSERVATIONS`（默认 `50`）
- `CLAUDE_MEM_CONTEXT_SESSION_COUNT`（默认 `10`）
- `CLAUDE_MEM_CONTEXT_FULL_COUNT`（默认 `0`）
- `CLAUDE_MEM_CONTEXT_FULL_FIELD`（默认 `narrative`）
- `CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY`（默认 `true`）
- `CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE`（默认 `false`）
- `CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT`（默认 `true`）
- `CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS`（默认 `false`）
- `CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS`（默认 `false`）
- `CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT`（默认 `false`）
- `CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT`（默认 `true`）

### 保留策略 / folder CLAUDE.md（6）

- `CLAUDE_MEM_RETENTION_ENABLED`（默认 `true`）
- `CLAUDE_MEM_RETENTION_DAYS`（默认 `30`）
- `CLAUDE_MEM_RETENTION_MAX_KEPT`（默认 `3000`）
- `CLAUDE_MEM_RETENTION_SCORE_THRESHOLD`（默认 `0.3`）
- `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED`（默认 `false`）
- `CLAUDE_MEM_FOLDER_MD_EXCLUDE`（默认 `[]`）

### 上游 Anthropic（SDK 主通道，不计入 59）

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
