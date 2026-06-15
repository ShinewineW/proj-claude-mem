# 0003 — 旁路收敛为单一自由配置的 OpenAI 兼容 transport

> Status: accepted — 2026-06-15
> Relates to: ADR 0002(冻结内部 `CLAUDE_MEM_*` 前缀——本 ADR 在该前缀内重命名子键,不违背)

过去每接/换一家旁路 provider(OpenRouter→删、Gemini、OpenCode Go)都要全量改名 ~28 个文件:新枚举值 + 新 `CLAUDE_MEM_XXX_*` 键 + 新请求分支 + 新 UI 字段 + 新测试。根因是 provider 被建模成**闭枚举 + 每家一套代码**。但 DeepSeek / OpenCode / OpenRouter / Moonshot / Groq 等**全是同一套 OpenAI 兼容协议**(`POST {baseUrl}/chat/completions` + `Authorization: Bearer`),差异只有 baseUrl / apiKey / model 三个值。

**决定**:把旁路收敛成**两层模型**——
- **Transport(代码,闭集只剩 2 个)**:`claude`(主 Agent SDK)、`openai`(唯一旁路,任意 OpenAI 兼容 endpoint)。`CLAUDE_MEM_PROVIDER` 取这两个值。
- **Provider 身份(数据,自由)**:不设厂商枚举、不设预置 catalog、不设 `displayName` 字段;**身份一律从用户自填的 `baseUrl` host 自动派生**(如 `api.deepseek.com`)。"连哪个 host 就是哪个",连不通是用户自己的事。

配套:① 通用键 `CLAUDE_MEM_OPENAI_{API_KEY,MODEL,BASE_URL}`,base URL 必填(留空即旁路 disabled);删两个从未接线的死键 `CLAUDE_MEM_OPENCODE_MAX_{CONTEXT_MESSAGES,TOKENS}`。② **彻底删除 Gemini transport**(确定不再使用)及其键/路径/UI/测试,等同当年删 OpenRouter。③ 删 OpenCode 专属的 `cost`/`subscription`/`opencodeFreeCalls` 计费机制(通用化后是死代码)。④ `thinking:{type:"disabled"}` 在 `openai` 路径**硬编码发送**(`deepseek-v4-flash` 等推理模型必需),代码注释标注其对非推理家可能 400 的 footgun;不加开关(YAGNI)。⑤ 前端新增**连通性测试按钮** → `POST /api/bypass/test`,以表单中**未保存**的候选 `{baseUrl,apiKey,model}` 跑一次独立探针(不碰运行中熔断状态),失败时摊出脱敏后的原始错误供用户自查。⑥ 不做旧键 back-compat shim——现存安装仅本机一台,直接重写 settings.json。

## Considered Options

- **预置 catalog / 厂商枚举**(deepseek/openrouter/… 内置表):否决。base URL 与默认 model 会过期,需持续维护,且制造"表内 vs 表外"两个等级。改用纯自由字段,任意 OpenAI 兼容家(含小众/自建)开箱即用。
- **独立 `displayName` 字段**:否决。多一个必填框且可被乱填,自定义 endpoint 反而失去可信身份;host 本就是天然且不可伪造的身份。
- **保留 Gemini 作为休眠 transport**:否决。半维护的旁路正是 churn 之源;确定不用就删干净。

## Consequences

- transport 从 `if provider==='gemini'/'opencode'` 改为按 transport 的两分支(`claude` 主通道 + `openai` 唯一旁路);此后接任何 OpenAI 兼容家 = **只改 settings 的 baseUrl/apiKey/model 三个值,零代码、零改名、零新测试**。
- `BypassConfig` 坍缩为 `{baseUrl, apiKey, model, cooldownMs}`;`resolveConfig()` 在非 `openai` 或 baseUrl/apiKey 缺失时返回 null。
- 与 ADR 0002 同向:中性、命名一次、永久冻结的键名,杜绝 provider 改名引发的内部命名抖动。
