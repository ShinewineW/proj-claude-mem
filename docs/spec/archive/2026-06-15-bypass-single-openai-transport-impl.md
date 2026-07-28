# Bypass 单一 OpenAI 兼容 Transport 改造 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **日期**: 2026-06-15
> **状态**: 活跃
> **作者**: ShinewineW（AI 辅助：Claude Opus 4.8）
> **基准版本**: `proj-claude-mem@b016cf30`
> **目的**: 把旁路（bypass lane）从「每家 provider 一套枚举+键+分支+UI+测试」收敛为单一自由配置的 OpenAI 兼容 transport，删除 Gemini/OpenCode 专属代码，使「换 provider = 改 3 个配置值」。
> 范围: `proj-claude-mem` 仓库 / bypass 旁路子系统 / viewer 前端

---

**Goal:** 旁路只保留两条 transport（`claude` 主通道 + `openai` 唯一旁路），`openai` 由用户自填 `baseUrl/apiKey/model` 三个自由字段驱动，身份从 host 派生；新增连通性测试按钮。

**Architecture:** transport 闭集坍缩为 `{claude, openai}`。删除整条 Gemini transport、OpenCode 专属 cost/subscription 计费机制、两个从未接线的死键。`openai` 路径请求结构不变（OpenAI 兼容 `/chat/completions` + `Bearer` + 硬编码 `thinking:disabled`）。base URL 必填，留空即旁路 disabled。新增 `POST /api/bypass/test` 用未保存的候选配置跑独立探针。

**Tech Stack:** TypeScript / Bun / Express（worker）/ React（viewer）/ `bun test`。

---

## 命名与不变量（贯穿全计划）

- 设置键：`CLAUDE_MEM_OPENCODE_*` → `CLAUDE_MEM_OPENAI_{API_KEY,MODEL,BASE_URL}`。删 `CLAUDE_MEM_OPENCODE_MAX_CONTEXT_MESSAGES`/`_MAX_TOKENS`（死键）。删全部 `CLAUDE_MEM_GEMINI_*`。
- `CLAUDE_MEM_PROVIDER` 取值闭集：`'claude' | 'openai'`（删 `'gemini'`、`'opencode'`）。
- env 凭据：`OPENCODE_API_KEY`/`GEMINI_API_KEY` → `OPENAI_API_KEY`。
- `BypassStatus`/SSE 的 `BypassInfo` 形状：`{ state, endpoint, model, consecutiveFailures, lastFailureReason }`。删 `provider`/`lastOpencodeCost`/`lastOpencodeCostAt`/`opencodeFreeCalls`。`endpoint` = 由 `baseUrl` 派生的 host（`new URL(baseUrl).host`）。
- `resolveConfig()` 返回 `BypassConfig | null`，`BypassConfig = { baseUrl, apiKey, model, cooldownMs }`（删 `provider` 字段）。`PROVIDER!=='openai'` 或 `baseUrl`/`apiKey`/`model` 任一为空 → 返回 null。
- 测试基线（**权威 gate = 全量 `bun test ./tests/`,单文件跑仅供快速迭代**）：单文件跑（如 `bun test ./tests/worker/bypass-openai.test.ts`）只为开发时快速反馈;因 `tests/CLAUDE.md` 明确 `mock.module()` 不可逆且单文件/子集跑会**隐藏全量污染**,**最终判定必须以全量 `bun test ./tests/` 为准**（跑整个 `tests/` 目录、稳定顺序、暴露污染;`./tests/` 而非裸 `bun test` 是因为后者会扫到 `attn_sink/` 上游 clone 的 ~52 个无关失败——见根 `CLAUDE.md`）。
- **🔒 提交纪律（security/隔离,MUST）：禁止 `git add -A` / `git add .`。** 工作树当前含 6/9 未提交的 Engram 改动（`CONTEXT.md`、`.claude/rules/`、`docs/spec/Manual/...`,用户明确要求**不提交**）+ 本次新增的 CONTEXT.md 术语 / 本 impl。每个 commit **只 `git add <该 Task Files 段列出的显式路径>`**,提交前 `git status` 自检无越界。本 impl 的 `git mv` 测试文件也用显式路径。
- **🔒 禁止把真实 API key 写进任何受 git 跟踪的文件**（spec/代码/测试）。计划中一律用占位符 `<DEEPSEEK_API_KEY>`;真实 key 只进运行期的 `~/.claude-mem/settings.json`（仓库外、不跟踪）。
- **类型检查用「基线 diff」,不要求 tsc clean（审计 confirmed）**：`bunx tsc --noEmit -p tsconfig.json` 有 **~321 个既有基线错误**（缺 `bun:sqlite`/DOM lib、`Component` 类型不匹配等,**与本次改造无关**),故**不能**要求 tsc 零错误。统一判定法:① **Task 9 开始前**先存基线 `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | sort > /tmp/tsc-baseline.txt`;② 每个前端 Task 后跑 `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | sort > /tmp/tsc-after.txt && comm -13 /tmp/tsc-baseline.txt /tmp/tsc-after.txt`,要求**无新增行**(未引入新错误);③ 额外硬断言 `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "CLAUDE_MEM_(GEMINI|OPENCODE)|lastOpencode|opencodeFree"` **返回空**(确认没有对已删字段的悬空类型引用)。下文前端各 Task 的「类型检查」步均指此法。

---

## Chunk 1: 后端配置层 + 探针 helper

### Task 1: 简化 `openai-compatible-base-url.ts`（删默认 endpoint，去 defaultUrl 参数）

**Files:**
- Modify: `src/shared/openai-compatible-base-url.ts`
- Test: `tests/shared/openai-compatible-base-url.test.ts`
- Test（**审计回归套件，必须一并改**）: `tests/audit/phase3-openai-base-url.test.ts`
- Doc-sync: `src/shared/CLAUDE.md`（其 `openai-compatible-base-url.ts` 行仍提 `CLAUDE_MEM_OPENCODE_BASE_URL`，见 Step 7）

> ⚠️ Blocker 修复（审计确认）：`tests/audit/phase3-openai-base-url.test.ts`（当前 19 passing）硬 `import { DEFAULT_OPENCODE_API_URL }` 并用双参 `(input, DEF)` 签名断言「空/非法 → defaultUrl」。本 Task 删除该常量并改单参返回 null，若不同步改这个文件，其 import 在 Bun/ESM 下加载即抛错，导致 `bun test ./tests/` 无法全绿（破坏 Final Gate #2）。`tests/audit/` 是 `tests/CLAUDE.md` 明确保留的长期回归套件，不能当过期脚手架忽略。

- [ ] **Step 1: 读取并改测试** — 打开 `tests/shared/openai-compatible-base-url.test.ts`，把所有传 `defaultUrl`（第二参）与断言「空 baseUrl 回退到默认 opencode endpoint」的用例删除/改写为新契约：

```ts
// 新契约：函数只收一个参数；空/非法 baseUrl 抛错或返回 null（见下）
import { resolveOpenAICompatibleChatCompletionsUrl } from '../../src/shared/openai-compatible-base-url.js';

test('appends /chat/completions to a base URL', () => {
  expect(resolveOpenAICompatibleChatCompletionsUrl('https://api.deepseek.com'))
    .toBe('https://api.deepseek.com/chat/completions');
});
test('uses a full chat/completions URL verbatim (strips trailing slash)', () => {
  expect(resolveOpenAICompatibleChatCompletionsUrl('https://x.ai/v1/chat/completions/'))
    .toBe('https://x.ai/v1/chat/completions');
});
test('returns null for blank / non-http(s) / hostless input', () => {
  expect(resolveOpenAICompatibleChatCompletionsUrl('')).toBeNull();
  expect(resolveOpenAICompatibleChatCompletionsUrl('file:///etc/passwd')).toBeNull();
  expect(resolveOpenAICompatibleChatCompletionsUrl('not a url')).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `bun test ./tests/shared/openai-compatible-base-url.test.ts` Expected: FAIL（签名不符 / 返回值不符）。

- [ ] **Step 3: 改实现** — 替换函数签名与逻辑。OLD（`resolveOpenAICompatibleChatCompletionsUrl` 整个函数 + 顶部 `DEFAULT_OPENCODE_API_URL` 常量）→ NEW：

```ts
// 删除这一行常量（不再有「默认 endpoint」概念）：
//   export const DEFAULT_OPENCODE_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions';

/**
 * Resolve the chat-completions endpoint from a user-supplied base URL.
 * Returns null when the input is blank, malformed, or not http(s) — the
 * caller treats null as "bypass not configured" (base URL is required).
 */
export function resolveOpenAICompatibleChatCompletionsUrl(
  baseUrl: string | undefined | null,
): string | null {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed || !isSafeHttpUrl(trimmed)) {
    if (trimmed) {
      logger.warn('WORKER', 'Configured base URL is not a valid http(s) URL — bypass disabled', {
        prefix: trimmed.slice(0, 12),
      });
    }
    return null;
  }
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return normalized;
  }
  return `${normalized}${CHAT_COMPLETIONS_PATH}`;
}
```

保留 `isSafeHttpUrl()` 与 `CHAT_COMPLETIONS_PATH` 不变。更新文件顶部注释，去掉对 OpenCode 默认 endpoint 的描述。

- [ ] **Step 4: 跑测试确认通过** — Run: `bun test ./tests/shared/openai-compatible-base-url.test.ts` Expected: PASS。

- [ ] **Step 4b: 重写审计回归套件 `tests/audit/phase3-openai-base-url.test.ts`** — 删除 `DEFAULT_OPENCODE_API_URL` import 与 `const DEF = DEFAULT_OPENCODE_API_URL`；把所有 `resolveOpenAICompatibleChatCompletionsUrl(input, DEF)` 改为单参 `resolveOpenAICompatibleChatCompletionsUrl(input)`；把「空/`null`/`undefined`/非法 → DEF」的断言（U1 + G-block）改为「→ `null`」；保留 normalization / 大小写 / 去尾斜杠 等单参用例。Run: `bun test ./tests/audit/phase3-openai-base-url.test.ts` Expected: PASS。

- [ ] **Step 5: grep 旧符号** — Run: `grep -rn "DEFAULT_OPENCODE_API_URL\|resolveOpenAICompatibleChatCompletionsUrl" src/ tests/` 记录所有调用点。Expected: `DEFAULT_OPENCODE_API_URL` 零残留；`resolveOpenAICompatibleChatCompletionsUrl` 仅剩 `BypassLane.ts` 两处（后续 Task 6 改）+ **两个**测试文件（`tests/shared/openai-compatible-base-url.test.ts`、`tests/audit/phase3-openai-base-url.test.ts`，本 Task 已改）。

- [ ] **Step 6: doc-sync `src/shared/CLAUDE.md`** — 把 `openai-compatible-base-url.ts` 那行里的 `CLAUDE_MEM_OPENCODE_BASE_URL` 改为 `CLAUDE_MEM_OPENAI_BASE_URL`，措辞由「OpenCode bypass」改为「OpenAI-compatible bypass」。（该文件的「58 unique CLAUDE_MEM_* settings」计数会在 Task 3 后变为 53，见 Task 3 Step 7。）

- [ ] **Step 7: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "refactor(bypass): base-url resolver returns null for blank/invalid, drop default endpoint"`

---

### Task 2: 新增独立探针 helper `openai-compatible-probe.ts`（测试端点 + BypassLane 共用）

**Files:**
- Create: `src/services/worker/openai-compatible-probe.ts`
- Test: `tests/worker/openai-compatible-probe.test.ts`

> 放在 `src/services/worker/` 旁路代码同目录（与它服务的 BypassLane 同位）。导入风格参考邻居 `BypassLane.ts`（`.js` 扩展、`../../utils/logger.js`）。

- [ ] **Step 1: 写失败测试** — `tests/worker/openai-compatible-probe.test.ts`：

```ts
import { probeOpenAICompatible } from '../../src/services/worker/openai-compatible-probe.js';

const okFetch = async () => new Response(
  JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

test('returns ok=true on HTTP 200', async () => {
  const r = await probeOpenAICompatible(
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-v4-flash' },
    { fetchImpl: okFetch },
  );
  expect(r.ok).toBe(true);
});

test('returns ok=false with status+message on HTTP error, sanitized', async () => {
  const errFetch = async () => new Response(
    JSON.stringify({ type: 'error', error: { type: 'CreditsError', message: 'Insufficient balance' } }),
    { status: 401 },
  );
  const r = await probeOpenAICompatible(
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-secret', model: 'm' },
    { fetchImpl: errFetch },
  );
  expect(r.ok).toBe(false);
  expect(r.status).toBe(401);
  expect(r.message).toContain('CreditsError');
  expect(JSON.stringify(r)).not.toContain('sk-secret'); // never echo the key
});

test('redacts a NON-sk-prefixed key echoed in the error body', async () => {
  const KEY = 'deepseek-rawkey-abcdef123456'; // no sk- prefix
  const errFetch = async () => new Response(
    JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 403 },
  );
  const r = await probeOpenAICompatible(
    { baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: 'm' },
    { fetchImpl: errFetch },
  );
  expect(r.ok).toBe(false);
  expect(JSON.stringify(r)).not.toContain(KEY); // exact-key redaction, not just sk-
});

test('returns ok=false when baseUrl is invalid (no fetch attempted)', async () => {
  let called = false;
  const r = await probeOpenAICompatible(
    { baseUrl: 'not-a-url', apiKey: 'k', model: 'm' },
    { fetchImpl: async () => { called = true; return okFetch(); } },
  );
  expect(r.ok).toBe(false);
  expect(called).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `bun test ./tests/worker/openai-compatible-probe.test.ts` Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现** — `src/services/worker/openai-compatible-probe.ts`：

> ⚠️ 必须 `import { logger }`（审计 confirmed）：`tests/logger-usage-standards.test.ts` 对 `src/services/worker/` 下文件有 logger 覆盖 gate（high-priority files missing logger import 会抛错），新文件不引 logger 会让 `bun test ./tests/` 挂。下方实现已在失败路径 `logger.debug`。

```ts
import { resolveOpenAICompatibleChatCompletionsUrl } from '../../shared/openai-compatible-base-url.js';
import { logger } from '../../utils/logger.js';

export interface OpenAICompatProbeInput {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OpenAICompatProbeResult {
  ok: boolean;
  status?: number;
  message?: string;
}

/**
 * Redact a string for safe logging/return: removes the EXACT configured key
 * (providers vary — keys are not always `sk-` prefixed) AND any bearer-looking
 * token, then caps length. Exported so BypassLane.callRestApi reuses it.
 */
export function redactSecret(s: string, secret?: string): string {
  let out = s;
  if (secret && secret.length >= 8) out = out.split(secret).join('***');
  return out.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 300);
}

/**
 * One-shot connectivity probe for an OpenAI-compatible endpoint. Independent of
 * BypassLane's circuit-breaker state — used by the viewer "Test" button and by
 * BypassLane.probeProvider(). `thinking:disabled` is sent to match the real
 * request shape (reasoning models like deepseek-v4-flash need it).
 */
export async function probeOpenAICompatible(
  input: OpenAICompatProbeInput,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenAICompatProbeResult> {
  const url = resolveOpenAICompatibleChatCompletionsUrl(input.baseUrl);
  if (!url) return { ok: false, message: 'Invalid or missing base URL' };
  if (!input.apiKey) return { ok: false, message: 'Missing API key' };
  if (!input.model) return { ok: false, message: 'Missing model' };

  const doFetch = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_tokens: 10,
        thinking: { type: 'disabled' },
      }),
      signal,
    });
    if (response.ok) return { ok: true, status: response.status };
    const body = redactSecret(await response.text(), input.apiKey);
    return { ok: false, status: response.status, message: body || response.statusText };
  } catch (error) {
    const isTimeout = error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError');
    const message = isTimeout ? 'timeout (15s)' : redactSecret(error instanceof Error ? error.message : 'unknown error', input.apiKey);
    logger.debug('BYPASS', 'probeOpenAICompatible failed', { message });
    return { ok: false, message };
  }
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `bun test ./tests/worker/openai-compatible-probe.test.ts` Expected: PASS。

- [ ] **Step 5: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "feat(bypass): standalone openai-compatible probe helper (shared by test endpoint + lane)"`

---

### Task 3: `SettingsDefaultsManager.ts` 键改名 + 删死键/Gemini

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts:21-29`（interface）、`:104-112`（defaults）
- Doc-sync: `src/shared/CLAUDE.md`（Step 6 改 58→53;**提交时必须 stage**）
- Test: `tests/shared/settings-defaults-manager.test.ts`

- [ ] **Step 1: 改 interface（21-29）** — OLD → NEW：

```ts
  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER: string; // 'claude' | 'openai'
  CLAUDE_MEM_OPENAI_API_KEY: string;
  CLAUDE_MEM_OPENAI_MODEL: string;
  CLAUDE_MEM_OPENAI_BASE_URL: string;
```

（删除 `CLAUDE_MEM_GEMINI_API_KEY/_MODEL/_RATE_LIMITING_ENABLED` 三行 + `CLAUDE_MEM_OPENCODE_*` 五行，整体替换成上面四行。）

- [ ] **Step 2: 改 defaults（104-112）** — OLD → NEW：

```ts
    // AI Provider Configuration
    CLAUDE_MEM_PROVIDER: "claude", // Default to Claude
    CLAUDE_MEM_OPENAI_API_KEY: "", // Empty by default, set via UI or OPENAI_API_KEY env
    CLAUDE_MEM_OPENAI_MODEL: "deepseek-v4-flash", // User-overridable; any OpenAI-compatible model id
    CLAUDE_MEM_OPENAI_BASE_URL: "", // Required to enable the openai bypass (blank = bypass disabled)
```

- [ ] **Step 3: grep 残留** — Run: `grep -n "GEMINI\|OPENCODE" src/shared/SettingsDefaultsManager.ts` Expected: 无输出。

- [ ] **Step 4: 改测试** — 在 `tests/shared/settings-defaults-manager.test.ts` 把任何引用 `CLAUDE_MEM_OPENCODE_*`/`CLAUDE_MEM_GEMINI_*` 的断言改为 `CLAUDE_MEM_OPENAI_*`；删除针对已移除键的断言。

- [ ] **Step 5: 跑测试** — Run: `bun test ./tests/shared/settings-defaults-manager.test.ts` Expected: PASS。

- [ ] **Step 6: doc-sync 计数** — `src/shared/CLAUDE.md` 把「58 unique CLAUDE_MEM_* settings」改为「53 unique」（58 − 8 删（3 gemini + 5 opencode）+ 3 加（openai）= 53）。

- [ ] **Step 7: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "refactor(settings): collapse provider keys to CLAUDE_MEM_OPENAI_*, drop gemini + dead keys"`

---

### Task 4: `EnvManager.ts` 凭据 `OPENCODE/GEMINI` → `OPENAI`

**Files:**
- Modify: `src/shared/EnvManager.ts:46-57`、`:130-132`、`:173-186`、`:238-245`
- Test: `tests/shared/env-manager-opencode.test.ts` → 重命名为 `tests/shared/env-manager-openai.test.ts`

- [ ] **Step 1: MANAGED_CREDENTIAL_KEYS（46-50）** — OLD → NEW：

```ts
export const MANAGED_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];
```

- [ ] **Step 2: ClaudeMemEnv interface（52-57）** — OLD → NEW：

```ts
export interface ClaudeMemEnv {
  // Credentials (optional - empty means use CLI billing for Claude)
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}
```

- [ ] **Step 3: loadClaudeMemEnv（130-132）** — OLD（三行 parsed.*）→ NEW：

```ts
    if (parsed.ANTHROPIC_API_KEY) result.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
    if (parsed.OPENAI_API_KEY) result.OPENAI_API_KEY = parsed.OPENAI_API_KEY;
```

- [ ] **Step 4: saveClaudeMemEnv（173-186）** — 删除 GEMINI_API_KEY 与 OPENCODE_API_KEY 两个 update 块，替换为单个 OPENAI 块：

```ts
    if (env.OPENAI_API_KEY !== undefined) {
      if (env.OPENAI_API_KEY) {
        updated.OPENAI_API_KEY = env.OPENAI_API_KEY;
      } else {
        delete updated.OPENAI_API_KEY;
      }
    }
```

- [ ] **Step 5: buildIsolatedEnv（238-245）** — 删除 GEMINI/OPENCODE 注释与两个注入块（openai 旁路 key 由 BypassLane 经 settings/getCredential 直接读取，SDK 子进程无需注入）。即删去原 238-245 行整段（保留其后的 OAuth 透传块 247+）。

- [ ] **Step 6: 重命名并改测试** — `git mv tests/shared/env-manager-opencode.test.ts tests/shared/env-manager-openai.test.ts`，把文件内所有 `OPENCODE_API_KEY`/`GEMINI_API_KEY` 断言改为 `OPENAI_API_KEY`，删除针对已移除键的用例。

- [ ] **Step 7: 跑测试** — Run: `bun test ./tests/shared/env-manager-openai.test.ts` Expected: PASS。

- [ ] **Step 8: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "refactor(env): managed credential OPENCODE/GEMINI -> OPENAI"`

---

### Task 5: `SettingsRoutes.ts` 键白名单 + 校验

**Files:**
- Modify: `src/services/worker/http/routes/SettingsRoutes.ts:79-87`、`:151-182`
- Test: `tests/worker/settings-persistence.test.ts`

- [ ] **Step 1: settingKeys 数组（79-87）** — OLD（gemini 三键 + opencode 五键，含注释行 77/82）→ NEW：

```ts
      // AI Provider Configuration
      'CLAUDE_MEM_PROVIDER',
      'CLAUDE_MEM_OPENAI_API_KEY',
      'CLAUDE_MEM_OPENAI_MODEL',
      'CLAUDE_MEM_OPENAI_BASE_URL',
```

- [ ] **Step 2: validProviders + GEMINI_MODEL 校验（151-165）** — OLD → NEW：

```ts
    // Validate CLAUDE_MEM_PROVIDER
    if (settings.CLAUDE_MEM_PROVIDER) {
      const validProviders = ['claude', 'openai'];
      if (!validProviders.includes(settings.CLAUDE_MEM_PROVIDER)) {
        return { valid: false, error: 'CLAUDE_MEM_PROVIDER must be "claude" or "openai"' };
      }
    }
```

（同时删除整段 `CLAUDE_MEM_GEMINI_MODEL` 校验块 159-165。）

- [ ] **Step 3: BASE_URL 校验改名（167-182）** — 把三处 `CLAUDE_MEM_OPENCODE_BASE_URL` 改为 `CLAUDE_MEM_OPENAI_BASE_URL`，注释里的 "OpenCode" 改为 "OpenAI-compatible"，错误信息改为 `'CLAUDE_MEM_OPENAI_BASE_URL must be a valid http(s) URL'`。

- [ ] **Step 4: 改测试** — `tests/worker/settings-persistence.test.ts` 中 `CLAUDE_MEM_OPENCODE_*` → `CLAUDE_MEM_OPENAI_*`，`provider:'opencode'` → `'openai'`，删 gemini provider 持久化用例。

- [ ] **Step 5: 跑测试** — Run: `bun test ./tests/worker/settings-persistence.test.ts` Expected: PASS。

- [ ] **Step 6: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "refactor(settings-routes): openai provider keys + validation, drop gemini/opencode"`

---

## Chunk 2: BypassLane 核心 + 状态序列化 + 测试端点

### Task 6: `BypassLane.ts` 坍缩为 openai-only + 删 cost 机制

**Files:**
- Modify: `src/services/worker/BypassLane.ts`（多处，见下）
- Test: `tests/worker/bypass-opencode.test.ts` → `tests/worker/bypass-openai.test.ts`（git mv）；`tests/worker/bypass-lane.test.ts`；`tests/worker/bypass-lane-properties.test.ts`、`tests/worker/bypass-ghost-filter.test.ts`、`tests/worker/bypass-sliding-window.test.ts`（Step 13 (e)/尾段同步改,**提交时全部 stage**）

> 通读 `BypassLane.ts` 全文后再改。本 Task 是核心，逐块替换。

- [ ] **Step 1: 顶部常量 + import（34-56）** — 把 **第 34 行** `import { resolveOpenAICompatibleChatCompletionsUrl, DEFAULT_OPENCODE_API_URL } from "../../shared/openai-compatible-base-url.js"` 改为只导入 `resolveOpenAICompatibleChatCompletionsUrl`（注意 import 在 34 行，常量在 37/43 行）；删 `GEMINI_API_URL`（37）、`GEMINI_RATE_LIMIT_INTERVAL_MS`（43）。保留 `FETCH_TIMEOUT_MS`、tiered cooldown 常量、`BypassFailureCategory`、`parseBypassErrorBody`、`classifyBypassFailure`。

- [ ] **Step 2: BypassStatus interface（117-140）** — OLD → NEW（删 `provider`、cost 三字段；加 `endpoint`）：

```ts
export interface BypassStatus {
  state: BypassState;
  endpoint: string | null;  // host derived from baseUrl, e.g. "api.deepseek.com"
  model: string | null;
  activeConsumers: number;
  consecutiveFailures: number;
  totalClaimed: number;
  totalSucceeded: number;
  totalFailed: number;
  totalTrips: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastTripAt: string | null;
  lastProbeAt: string | null;
  lastFailureReason: string | null;
}
```

- [ ] **Step 3: BypassConfig interface（142-147）** — OLD → NEW（删 `provider` 字段）：

```ts
interface BypassConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  cooldownMs: number;
}
```

- [ ] **Step 4: counters（163-176）** — 删 `lastOpencodeCost`/`lastOpencodeCostAt`/`opencodeFreeCalls` 三个字段。删字段 `lastGeminiRequestTime`（161）。

- [ ] **Step 5: resolveConfig（191-223）** — OLD 整个方法 → NEW：

```ts
  private resolveConfig(): BypassConfig | null {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_PROVIDER !== "openai") return null;

    const cooldownMs = parseInt(settings.CLAUDE_MEM_BYPASS_COOLDOWN_MS) || 1200000;
    const apiKey = settings.CLAUDE_MEM_OPENAI_API_KEY || getCredential("OPENAI_API_KEY") || "";
    const baseUrl = (settings.CLAUDE_MEM_OPENAI_BASE_URL || "").trim();
    const model = settings.CLAUDE_MEM_OPENAI_MODEL || "";
    if (!apiKey || !baseUrl || !model) return null;
    if (!resolveOpenAICompatibleChatCompletionsUrl(baseUrl)) return null; // reject malformed early
    return { baseUrl, apiKey, model, cooldownMs };
  }
```

- [ ] **Step 6: getStatus（264-284）** — 返回新形状：`provider` 行删除，加 `endpoint`：

```ts
      state: this.state,
      endpoint: this.config ? new URL(this.config.baseUrl).host : null,
      model: this.config?.model ?? null,
```

删除 `lastOpencodeCost`/`lastOpencodeCostAt`/`opencodeFreeCalls` 三行。其余计数字段保留。

- [ ] **Step 7: transitionToActive / 日志（286-295）** — 把 `provider: this.config?.provider` 日志字段改为 `endpoint: this.config ? new URL(this.config.baseUrl).host : null`。全文搜 `this.config?.provider` / `this.config.provider` 一并改。

- [ ] **Step 8: probeProvider（444-505）** — 删 gemini 分支，复用 Task 2 的 helper：

```ts
  private async probeProvider(): Promise<ProbeResult> {
    if (!this.config) return { ok: false, failureReason: "no config" };
    this.counters.lastProbeAt = new Date().toISOString();
    const r = await probeOpenAICompatible(
      { baseUrl: this.config.baseUrl, apiKey: this.config.apiKey, model: this.config.model },
    );
    if (r.ok) return { ok: true };
    return { ok: false, failureReason: r.status ? `HTTP ${r.status} ${r.message ?? ''}`.trim() : (r.message ?? 'probe failed') };
  }
```

文件顶部加 `import { probeOpenAICompatible, redactSecret } from "./openai-compatible-probe.js";`（`redactSecret` 供 Step 10 callRestApi 脱敏用）。

- [ ] **Step 9: 删 gemini 限速块（consumeLoop 632-648）** — 删除 `if (this.config?.provider === "gemini") { ... }` 整段（含 `GEMINI_RATE_LIMIT_INTERVAL_MS` 用法）。

- [ ] **Step 10: callRestApi（828-922）** — 删 gemini 分支，只留 openai 路径，去掉 cost 捕获：

```ts
  private async callRestApi(
    prompt: string,
    systemPrompt: string,
    signal: AbortSignal,
    history: ConversationMessage[] = [],
  ): Promise<string> {
    if (!this.config) throw new Error("BypassLane not configured");
    const url = resolveOpenAICompatibleChatCompletionsUrl(this.config.baseUrl);
    if (!url) throw new Error("BypassLane base URL invalid");
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        // 16384 (2x default): reasoning models truncate long observations at 8192
        // (finish_reason=length), leaving unclosed <observation> tags.
        max_tokens: 16384,
        // Hardcoded: deepseek-v4-flash etc. emit CoT-only empty content without it.
        // FOOTGUN: providers that reject unknown fields (vanilla OpenAI/Groq) will 400 —
        // the Test button surfaces that. If a non-thinking provider is ever needed,
        // promote this to a CLAUDE_MEM_OPENAI_DISABLE_THINKING toggle (YAGNI for now).
        thinking: { type: "disabled" },
      }),
      signal,
    });
    if (!response.ok) {
      const rawText = (await response.text()).substring(0, 500);
      const parsed = parseBypassErrorBody(rawText);
      const category = classifyBypassFailure(response.status, parsed);
      // Redact the configured key before it lands in the thrown error / logs / lastFailureReason.
      const errorText = redactSecret(rawText, this.config.apiKey);
      const err = new Error(`OpenAI-compatible API error: ${response.status} - ${errorText}`) as Error & { bypassCategory: BypassFailureCategory };
      err.bypassCategory = category;
      throw err;
    }
    const data = (await response.json()) as any;
    return data?.choices?.[0]?.message?.content || "";
  }
```

- [ ] **Step 11: 文件头注释（1-21）** — 把 "Gemini or OpenCode" 改为 "any OpenAI-compatible provider"。

- [ ] **Step 12: grep 残留** — Run: `grep -n "gemini\|Gemini\|opencode\|OpenCode\|Opencode\|lastOpencode\|opencodeFree\|\.provider" src/services/worker/BypassLane.ts` Expected: 仅剩 `BypassFailureCategory`/`parseBypassErrorBody` 等与 provider 无关的命名；无 gemini/opencode/cost 残留。

- [ ] **Step 13: 重命名 + 改核心测试** — `git mv tests/worker/bypass-opencode.test.ts tests/worker/bypass-openai.test.ts`。更新该文件与 `tests/worker/bypass-lane.test.ts`。**关键:这两个文件里有两类完全不同的 mock 站点,必须分别处理(审计 confirmed):**

  **(a) 模块级 `SettingsDefaultsManager.loadFromFile` mock(走 `resolveConfig` 路径)** — `bypass-opencode.test.ts:31-40` 与 `bypass-lane.test.ts:28-34` 的 mock 当前返回 `CLAUDE_MEM_PROVIDER:'opencode'/'gemini'` + `CLAUDE_MEM_OPENCODE_*`,**无 `CLAUDE_MEM_OPENAI_BASE_URL`**。新 `resolveConfig` 要求 `provider==='openai'` 且 `baseUrl/apiKey/model` 三者非空,否则返回 null。必须把 mock 整体改为:
```ts
{ CLAUDE_MEM_PROVIDER: 'openai',
  CLAUDE_MEM_OPENAI_BASE_URL: 'https://api.deepseek.com',
  CLAUDE_MEM_OPENAI_API_KEY: 'sk-test',
  CLAUDE_MEM_OPENAI_MODEL: 'deepseek-v4-flash',
  CLAUDE_MEM_BYPASS_COOLDOWN_MS: '1200000' }
```
  ⚠️ `BASE_URL` 是**净新增**字段(opencode 时代没有对应物),漏掉它会让 `resolveConfig()===null`,使 happy-path 断言 `expect(config).not.toBeNull()` 直接挂。若要 per-case 变更 settings(见下 null 用例),把该 mock 改为引用一个**可变闭包变量**(`let mockSettings = {...}`),因为 `mock.module()` 不可逆、单次返回固定对象无法表达多分支。

  **(b) 直接注入 `(lane as any).config = {...}`(绕过 resolveConfig,如 :178/228/253/275/293/331/350/368)** — 这些**不是** settings 键,是 `BypassConfig` 字面量。逐个改为:
```ts
(lane as any).config = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-flash', cooldownMs: 1200000 };
```
  即**删掉 `provider` 字段、补上 `baseUrl`**。同时把 `:187` 的 `expect(capturedUrl).toContain('opencode.ai')` 改为 `.toContain('api.deepseek.com')`。

  **(c) 删除** 所有 cost/`opencodeFreeCalls`/subscription 断言;删除 gemini-specific(限速、URL-key)用例;`config.provider==='opencode'` 类断言删除;`getStatus()` 断言改用 `endpoint`('api.deepseek.com')/`model`。

  **(d) 新增 `resolveConfig` null 分支用例(审计 confirmed 缺失,这是本次改造的核心行为)** — 用可变 mock 变量分别测:
```ts
test('resolveConfig returns null when base URL is blank', () => {
  mockSettings = { CLAUDE_MEM_PROVIDER: 'openai', CLAUDE_MEM_OPENAI_BASE_URL: '', CLAUDE_MEM_OPENAI_API_KEY: 'sk', CLAUDE_MEM_OPENAI_MODEL: 'm' };
  expect((lane as any).resolveConfig()).toBeNull();
});
test('resolveConfig returns null when base URL is malformed', () => {
  mockSettings = { CLAUDE_MEM_PROVIDER: 'openai', CLAUDE_MEM_OPENAI_BASE_URL: 'not-a-url', CLAUDE_MEM_OPENAI_API_KEY: 'sk', CLAUDE_MEM_OPENAI_MODEL: 'm' };
  expect((lane as any).resolveConfig()).toBeNull(); // covers resolveOpenAICompatibleChatCompletionsUrl early-reject
});
test('resolveConfig returns null when provider is claude', () => {
  mockSettings = { CLAUDE_MEM_PROVIDER: 'claude' };
  expect((lane as any).resolveConfig()).toBeNull();
});
```

  其余 `bypass-ghost-filter` / `bypass-sliding-window` 同步:按 (a)/(b) 规则把 provider mock 与直接注入改为 openai 形状(这些主要测过滤/窗口逻辑,与 provider 名无关,改配置即可)。

  **(e) `bypass-lane-properties.test.ts` 特别处理(审计 confirmed,防静默丢覆盖)** — 该文件 `:486` 与 `:539` 有两处 `for (const provider of ['gemini','opencode'] as const)` 循环,注入的 `config` **无 baseUrl**。改造后 `BypassConfig` 无 `provider`、`probeProvider()` 委托 `probeOpenAICompatible()` 需真实 baseUrl,若仅删 provider 不补 baseUrl,probe 会在 "Invalid or missing base URL" 早退。**必须**:把两个双-provider 循环**坍缩为单一 openai case**,每个 config 字面量补 `baseUrl:'https://api.deepseek.com'`、删 `provider`。尤其 `:539` 的「`failureReason` 永不含原始 API key」property test:它原先把密钥 `'my-secret-gemini-key-12345'` 埋进 Gemini-URL 格式错误里验证旧的 gemini 专属脱敏;新 `sanitize()` 用 `/sk-.../` 模式,该密钥既不匹配、probe 又早退 → **测试会 vacuously 通过、脱敏覆盖静默丢失**。必须把该用例改用真实 `sk-` 前缀密钥 + 让 stub 返回含该密钥的错误体,断言 `lastFailureReason`/抛错 message 不含它(确保 `sanitize()` 真生效),否则删除该用例并在 commit message 注明原因。

- [ ] **Step 14: 跑 bypass 测试** — Run: `bun test ./tests/worker/bypass-openai.test.ts ./tests/worker/bypass-lane.test.ts ./tests/worker/bypass-lane-properties.test.ts ./tests/worker/bypass-ghost-filter.test.ts ./tests/worker/bypass-sliding-window.test.ts` Expected: PASS。

- [ ] **Step 15: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "refactor(bypass): collapse BypassLane to single openai transport, remove gemini + cost machinery"`

---

### Task 7: 状态序列化收口（worker-types / worker-service / DataRoutes）

**Files:**
- Modify: `src/services/worker-types.ts:35`、`src/services/worker-service.ts:1410-1417`、`src/services/worker/http/routes/DataRoutes.ts:563-570`

> 可追溯性说明（审计 confirmed）：`/api/health`（worker-service.ts:295 `bypass: this.bypassLane.getStatus()`，经 Server.ts:191 `getAiStatus()` 透传）**逐字返回 `getStatus()` 整个对象**，因此 Task 6 Step 6 改了 `getStatus()` 形状后，`/api/health` 的 `bypass` 自动变为 `{state,endpoint,model,...}`，**本 Task 无需再改 :295**。Final Gate #3 由 Task 6 满足，不依赖本 Task 的额外编辑。

- [ ] **Step 1: worker-types.ts:35** — OLD → NEW：

```ts
  currentProvider: "claude" | "openai" | null; // Track which transport is currently running
```

- [ ] **Step 2: worker-service.ts:1410-1417（broadcast bypass）** — OLD → NEW：

```ts
      bypass: {
        state: bypass.state,
        endpoint: bypass.endpoint,
        model: bypass.model,
        consecutiveFailures: bypass.consecutiveFailures,
        lastFailureReason: bypass.lastFailureReason,
      },
```

- [ ] **Step 3: DataRoutes.ts:563-570（GET /api/processing-status）** — 同样替换 bypass 对象为 `{ state, endpoint, model, consecutiveFailures, lastFailureReason }`。

- [ ] **Step 4: grep(限后端,审计 confirmed)** — Run: `grep -rn "lastOpencodeCost\|opencodeFreeCalls\|bypass.provider" src/services/` Expected: 无输出。**注意**:此时前端 `src/ui/`（`types.ts:74`、`DashboardHeader.tsx:24`）仍有这些字段,要到 Task 9-11 才删,故 grep **只限 `src/services/`**,不能扫全 `src/`。全 `src/` 清零由 Final Gate 在 Task 11 后统一验。

- [ ] **Step 5: 跑相关测试** — Run: `bun test ./tests/worker/` Expected: PASS（无新失败）。

- [ ] **Step 6: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "refactor(worker): bypass status carries endpoint, drop provider/cost fields"`

---

### Task 8: 新增 `POST /api/bypass/test` 端点

**Files:**
- Modify: `src/services/worker/http/routes/DataRoutes.ts`（加 handler + 路由注册）
- Test: `tests/worker/bypass-test-endpoint.test.ts`（新建）

> 路由注册（审计 confirmed，**纠正原计划**）：DataRoutes **没有** `this.router`，**没有** `registerRoutes()`。它在 `setupRoutes(app: express.Application)`（:37）里用 `app.<verb>('/path', this.handlerX.bind(this))` 注册（参考 :57 `app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this))`）。本 Task 在 `setupRoutes(app)` 内、紧挨 processing-status 注册处加：`app.post('/api/bypass/test', this.handleBypassTest.bind(this));`。

> 测试策略（审计 confirmed，**禁止 `mock.module`**）：`tests/CLAUDE.md` 明确 `mock.module()` 不可逆（`mock.restore()` 不清除）且污染同进程所有文件——而 `probeOpenAICompatible` 被 DataRoutes 与 BypassLane 两处生产代码 import，进程级打桩会让 Task 2 的真实 probe 测试在全量套件里失败。故**不 mock 该模块**：① 缺字段 `400` 分支是同步的，直接构造 mock `req/res` 调 handler 断言即可；② `ok`/`fail` 分支用一个**本地 stub HTTP server**（`Bun.serve({port:0})` 取随机端口）做 `baseUrl`，让真实 `probeOpenAICompatible` 打这个 stub。注意 handler 经 `wrapHandler` 包装后是 fire-and-forget 的同步 `(req,res):void`（`BaseRouteHandler.ts:22-32` 不返回内部 promise），所以 `ok`/`fail` 这类 **post-await** 断言**不能**用 `await handler(req,res)`——必须走「真实 express app + 真实 HTTP 请求」让框架等响应（参考 `tests/integration/worker-api-endpoints.test.ts`），或在断言前 flush microtask（`await new Promise(r=>setImmediate(r))`）。优先用真实 app + stub server。

- [ ] **Step 1: 写失败测试** — `tests/worker/bypass-test-endpoint.test.ts`：
  - **400 分支(同步)**:构造 `req={body:{}}` + spy `res`,直接调 `handleBypassTest`,断言 `res.status(400)` 且 body `{ok:false}`。
  - **ok 分支**:起 `const stub = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({choices:[{message:{content:'OK'}}]}), {status:200}) })`;把 DataRoutes 挂到一个真实 express app(**必须 `app.use(express.json())`**——审计 confirmed:生产从 `middleware.ts:25` 拿 `req.body`,裸 `express()` 不解析 JSON,会让 ok/fail POST 全部落到 400 分支;`new DataRoutes(...)` 构造器需 6 个 dep:`paginationHelper, databaseManager, sessionManager, sseBroadcaster, workerService, startTime`——`handleBypassTest` 一个都不用,测试里传 `{} as any` / `0` stub 即可,然后 `routes.setupRoutes(app)`),`POST /api/bypass/test` body `{baseUrl:'http://127.0.0.1:'+stub.port, apiKey:'sk', model:'m'}`,断言 `200 {ok:true}`;`afterAll(()=>stub.stop())`。
  - **fail 分支**:stub 返回 `status:401` + `{type:'error',error:{type:'CreditsError',message:'Insufficient balance'}}`,断言 `200 {ok:false, status:401}` 且 `message` 含 `CreditsError`、不含传入的 key。
  - 不调用 `mock.module`。

- [ ] **Step 2: 跑测试确认失败** — Run: `bun test ./tests/worker/bypass-test-endpoint.test.ts` Expected: FAIL。

- [ ] **Step 3: 写 handler** — 在 DataRoutes 内新增（紧接 `handleGetProcessingStatus` 后）：

```ts
  /**
   * Test connectivity of a candidate openai-compatible config (unsaved form values).
   * Independent of the running BypassLane circuit breaker. POST /api/bypass/test
   */
  private handleBypassTest = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { baseUrl, apiKey, model } = req.body ?? {};
    if (!baseUrl || !apiKey || !model) {
      res.status(400).json({ ok: false, message: 'baseUrl, apiKey and model are required' });
      return;
    }
    const result = await probeOpenAICompatible({ baseUrl, apiKey, model });
    res.json(result);
  });
```

文件顶部 import：`import { probeOpenAICompatible } from "../../openai-compatible-probe.js";`（核对从 `routes/` 到 `worker/` 的相对深度：`http/routes/` → `worker/` 是 `../../`）。在 `setupRoutes(app)` 内紧挨 processing-status 注册处加：`app.post('/api/bypass/test', this.handleBypassTest.bind(this));`（`handleBypassTest` 是箭头函数字段已预绑定，`.bind(this)` 仅为对齐本文件既有约定）。

- [ ] **Step 4: 跑测试确认通过** — Run: `bun test ./tests/worker/bypass-test-endpoint.test.ts` Expected: PASS。

- [ ] **Step 5: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "feat(bypass): POST /api/bypass/test connectivity probe endpoint"`

---

## Chunk 3: 前端 viewer + 散落注释 + 收尾验证

### Task 9: viewer 类型与默认值（types.ts / constants / useSettings）

**Files:**
- Modify: `src/ui/viewer/types.ts:70-77`、`:101-107`；`src/ui/viewer/constants/settings.ts:11-17`；`src/ui/viewer/hooks/useSettings.ts:23-31`

- [ ] **Step 0: 存 tsc 基线** — Run: `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | sort > /tmp/tsc-baseline.txt`（~321 行,见命名与不变量;后续前端 Task 据此做 diff）。

- [ ] **Step 1: types.ts BypassInfo（70-77）** — OLD → NEW：

```ts
export interface BypassInfo {
  state: string | null;
  endpoint: string | null;
  model: string | null;
  consecutiveFailures?: number;
  lastFailureReason?: string | null;
}
```

- [ ] **Step 2: types.ts Settings provider 段（101-107）** — OLD → NEW：

```ts
  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER?: string;  // 'claude' | 'openai'
  CLAUDE_MEM_OPENAI_API_KEY?: string;
  CLAUDE_MEM_OPENAI_MODEL?: string;
  CLAUDE_MEM_OPENAI_BASE_URL?: string;
```

- [ ] **Step 3: constants/settings.ts（11-17）** — OLD → NEW：

```ts
  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER: 'claude',
  CLAUDE_MEM_OPENAI_API_KEY: '',
  CLAUDE_MEM_OPENAI_MODEL: 'deepseek-v4-flash',
  CLAUDE_MEM_OPENAI_BASE_URL: '',
```

- [ ] **Step 4: useSettings.ts（23-31）** — 把 gemini 三行 + opencode 两行替换为：

```ts
          // AI Provider Configuration
          CLAUDE_MEM_PROVIDER: data.CLAUDE_MEM_PROVIDER ?? DEFAULT_SETTINGS.CLAUDE_MEM_PROVIDER,
          CLAUDE_MEM_OPENAI_API_KEY: data.CLAUDE_MEM_OPENAI_API_KEY ?? DEFAULT_SETTINGS.CLAUDE_MEM_OPENAI_API_KEY,
          CLAUDE_MEM_OPENAI_MODEL: data.CLAUDE_MEM_OPENAI_MODEL ?? DEFAULT_SETTINGS.CLAUDE_MEM_OPENAI_MODEL,
          CLAUDE_MEM_OPENAI_BASE_URL: data.CLAUDE_MEM_OPENAI_BASE_URL ?? DEFAULT_SETTINGS.CLAUDE_MEM_OPENAI_BASE_URL,
```

- [ ] **Step 5: 类型检查(基线 diff,非 tsc clean)** — Run: `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | sort > /tmp/tsc-after.txt && comm -13 /tmp/tsc-baseline.txt /tmp/tsc-after.txt`。Expected: 此时 Task 10/11 待改文件（`ContextSettingsModal.tsx`/`DashboardHeader.tsx`）对已删 gemini/opencode 字段的引用**会作为新增行出现**（下一 Task 修）;**确认新增行只来自这两个文件**,无其它意外新错误。**说明(审计 confirmed)**:`bun run build` 是 esbuild,**不做类型检查**;且 `tsc` 有 ~321 既有基线错误,故用 baseline diff（见命名与不变量），不能要求 clean。

- [ ] **Step 6: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "refactor(viewer): openai provider settings types + defaults, bypass info endpoint"`

---

### Task 10: viewer 设置弹窗（自由字段 + 测试按钮）

**Files:**
- Create: `src/ui/viewer/components/BypassTestButton.tsx`（Step 2b;**提交时必须 stage**）
- Modify: `src/ui/viewer/components/ContextSettingsModal.tsx:336-429`
- Modify（条件）: `src/ui/viewer/constants/api.ts`（若统一走 `API_ENDPOINTS`,加 `BYPASS_TEST` 常量）

- [ ] **Step 1: provider 下拉（336-348）** — OLD → NEW：

```tsx
              <FormField
                label="AI Provider"
                tooltip="Claude (via Agent SDK) or an OpenAI-compatible endpoint (DeepSeek, etc.)"
              >
                <select
                  value={formState.CLAUDE_MEM_PROVIDER ?? DEFAULT_SETTINGS.CLAUDE_MEM_PROVIDER}
                  onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}
                >
                  <option value="claude">Claude (uses your Claude account)</option>
                  <option value="openai">OpenAI-compatible (DeepSeek / self-host / …)</option>
                </select>
              </FormField>
```

- [ ] **Step 2: 删 gemini 整块（366-402）+ opencode 整块（404-429）**，替换为 openai 自由字段 + 测试按钮块：

```tsx
              {formState.CLAUDE_MEM_PROVIDER === 'openai' && (
                <>
                  <FormField label="Base URL" tooltip="OpenAI-compatible endpoint, e.g. https://api.deepseek.com. Required.">
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENAI_BASE_URL ?? ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_BASE_URL', e.target.value)}
                      placeholder="https://api.deepseek.com"
                    />
                  </FormField>
                  <FormField label="API Key" tooltip="Bearer key for the endpoint above (or set OPENAI_API_KEY env var)">
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_OPENAI_API_KEY ?? ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_API_KEY', e.target.value)}
                      placeholder="sk-..."
                    />
                  </FormField>
                  <FormField label="Model" tooltip="Model id, e.g. deepseek-v4-flash. Reasoning models receive thinking:disabled automatically.">
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENAI_MODEL ?? ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_MODEL', e.target.value)}
                      placeholder="deepseek-v4-flash"
                    />
                  </FormField>
                  <BypassTestButton
                    baseUrl={formState.CLAUDE_MEM_OPENAI_BASE_URL ?? ''}
                    apiKey={formState.CLAUDE_MEM_OPENAI_API_KEY ?? ''}
                    model={formState.CLAUDE_MEM_OPENAI_MODEL ?? ''}
                  />
                </>
              )}
```

> 注意：claude 分支（350-364）保留不动。

- [ ] **Step 2b: 新增 `BypassTestButton` 组件** — 在 `src/ui/viewer/components/` 新建 `BypassTestButton.tsx`，仿邻居组件 import 风格：

```tsx
import React, { useState } from 'react';
// 直接用相对路径 '/api/bypass/test'(审计 confirmed: constants/api.ts 只导出 API_ENDPOINTS,无 API_BASE;
// 不要 import 不存在的符号。若想统一,可在 constants/api.ts 的 API_ENDPOINTS 里加 BYPASS_TEST 再引,见 Files 的条件 Modify)。

export function BypassTestButton({ baseUrl, apiKey, model }: { baseUrl: string; apiKey: string; model: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [msg, setMsg] = useState('');
  const run = async () => {
    setStatus('testing'); setMsg('');
    try {
      const res = await fetch('/api/bypass/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, model }),
      });
      const data = await res.json();
      if (data.ok) { setStatus('ok'); setMsg('Connected'); }
      else { setStatus('fail'); setMsg(`${data.status ?? ''} ${data.message ?? 'failed'}`.trim()); }
    } catch (e) {
      setStatus('fail'); setMsg(e instanceof Error ? e.message : 'request failed');
    }
  };
  return (
    <div style={{ marginTop: '8px' }}>
      <button type="button" onClick={run} disabled={status === 'testing' || !baseUrl || !apiKey || !model}>
        {status === 'testing' ? 'Testing…' : 'Test connection'}
      </button>
      {status === 'ok' && <span style={{ color: 'var(--success, #2ea043)', marginLeft: 8 }}>✅ {msg}</span>}
      {status === 'fail' && <span style={{ color: 'var(--error, #cf222e)', marginLeft: 8 }}>❌ {msg}</span>}
    </div>
  );
}
```

在 ContextSettingsModal 顶部加 `import { BypassTestButton } from './BypassTestButton';`。核对 `/api/bypass/test` 是否需要 host 前缀（参考其它 fetch 用 `API_ENDPOINTS`；若有统一常量则在 `constants/api.ts` 加一条 `BYPASS_TEST` 并改用之）。

> 已知限制(审计 confirmed,**有意接受、不加复杂度**)：测试按钮在表单 API Key 为空时禁用,故「仅靠 `OPENAI_API_KEY` 环境变量、表单不填 key」的 env-only 配置无法从 UI 测试。这是**有意设计**——按钮测的是「你当前填进表单的凭据」;env-only 用户改用 Final Gate Step 4 的 `/api/health` live bypass state 验证连通性即可。不为此放宽按钮的 disabled 条件(否则会拿空 key 发探针、误报)。

- [ ] **Step 3: 类型检查(基线 diff)** — Run: `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | sort > /tmp/tsc-after.txt && comm -13 /tmp/tsc-baseline.txt /tmp/tsc-after.txt`。Expected: 相对基线**无新增行**来自 `ContextSettingsModal.tsx`（formState 上 gemini/opencode 字段已不存在,须确保无残引用;`DashboardHeader.tsx` 的残引用留到 Task 11 修）。

- [ ] **Step 4: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "feat(viewer): free-form openai provider fields + connectivity Test button"`

---

### Task 11: DashboardHeader badge（host·model，删 cost）

**Files:**
- Create: `src/ui/viewer/components/bypassBadgeView.ts`（纯函数，可测）
- Modify: `src/ui/viewer/components/DashboardHeader.tsx:19-41`
- Test: `tests/ui/bypass-badge-view.test.ts`（新建）

> 测试覆盖说明（审计 confirmed）：badge 分支判定从旧的 `provider !== 'opencode'` **反转**为 `!endpoint && !model`，是结构性新分支;且仓库**无 `.tsx` 测试基建**（`find tests -name '*.tsx'` 为空）。故把纯展示逻辑抽到 `.ts` 文件单测三分支（claude-fallback / active host·model / tripped），React 组件本身只做渲染、由 Final Gate #5 人工核对——`.tsx` 单测显式 scope-out。

- [ ] **Step 1: 写失败测试** — `tests/ui/bypass-badge-view.test.ts`：

```ts
import { bypassBadgeView } from '../../src/ui/viewer/components/bypassBadgeView.js';

test('claude fallback when no endpoint/model', () => {
  expect(bypassBadgeView({ state: null, endpoint: null, model: null })).toEqual(
    expect.objectContaining({ label: 'main (claude)', tone: 'disabled' }),
  );
});
test('active host·model label', () => {
  const v = bypassBadgeView({ state: 'ACTIVE', endpoint: 'api.deepseek.com', model: 'deepseek-v4-flash' });
  expect(v.label).toBe('api.deepseek.com · deepseek-v4-flash');
  expect(v.tone).toBe('active');
});
test('tripped tone + failure reason in title', () => {
  const v = bypassBadgeView({ state: 'TRIPPED', endpoint: 'api.deepseek.com', model: 'm', consecutiveFailures: 3, lastFailureReason: 'HTTP 401' });
  expect(v.tone).toBe('tripped');
  expect(v.title).toContain('HTTP 401');
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `bun test ./tests/ui/bypass-badge-view.test.ts` Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写纯 helper** — `src/ui/viewer/components/bypassBadgeView.ts`：

```ts
import type { BypassInfo } from '../types';

export interface BypassBadgeView { label: string; tone: 'active' | 'tripped' | 'disabled'; title: string; }

export function bypassBadgeView(info: BypassInfo): BypassBadgeView {
  if (!info.endpoint && !info.model) {
    return { label: 'main (claude)', tone: 'disabled', title: `Bypass state: ${info.state ?? 'n/a'}` };
  }
  const label = `${info.endpoint ?? '?'}${info.model ? ' · ' + info.model : ''}`;
  const tone = info.state === 'ACTIVE' ? 'active' : info.state === 'TRIPPED' ? 'tripped' : 'disabled';
  const title = [`State: ${info.state ?? 'n/a'}`,
    info.consecutiveFailures ? `failures: ${info.consecutiveFailures}` : '',
    info.lastFailureReason ? `last: ${info.lastFailureReason}` : ''].filter(Boolean).join(' · ');
  return { label, tone, title };
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `bun test ./tests/ui/bypass-badge-view.test.ts` Expected: PASS。

- [ ] **Step 5: 替换 BypassBadge（19-41）消费 helper** — OLD 整个函数 → NEW：

```tsx
function BypassBadge({ info }: { info: BypassInfo }) {
  const { label, tone, title } = bypassBadgeView(info);
  return <span className={`bypass-badge bypass-${tone}`} title={title}>{label}</span>;
}
```

文件顶部加 `import { bypassBadgeView } from './bypassBadgeView';`。（`formatTime` helper 若不再被引用则删除；grep 确认。）

- [ ] **Step 6: 类型检查(基线 diff 归零) + grep** — 分别跑(注意 no-match 的 grep 退出码为 1,用 `! grep` 断言「无匹配」,**不要**用 `&& grep` 链——审计 confirmed):
```bash
bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | sort > /tmp/tsc-after.txt
comm -13 /tmp/tsc-baseline.txt /tmp/tsc-after.txt           # 期望: 空(无新增行)
! grep -nE "CLAUDE_MEM_(GEMINI|OPENCODE)|lastOpencode|opencodeFree" /tmp/tsc-after.txt   # 期望: 退出0(无悬空引用)
! grep -n "lastOpencode\|OpenCode Go\|formatTime" src/ui/viewer/components/DashboardHeader.tsx  # 期望: 退出0(无残留)
```

- [ ] **Step 7: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "feat(viewer): bypass badge shows host·model via tested pure helper, drop cost line"`

---

### Task 12: 散落注释/文档收口（Final Gate #1 grep 全清）

**Files（审计 confirmed 全清单——少一个 Final Gate #1 的 `grep -rni "opencode\|gemini" src/` 就过不了）:**
- Modify: `src/services/worker/agents/types.ts:2,110`、`FallbackErrorHandler.ts:6`、`ResponseProcessor.ts:47`（agent 注释 "Gemini/OpenCode" → "OpenAI-compatible"）
- Modify: `src/services/worker/SDKAgent.ts:518`（注释 `provider switching (Claude→Gemini)` → `(Claude→OpenAI-compatible)`）
- Modify: `src/services/worker-types.ts:13`（注释 `Claude↔Gemini` → `Claude↔OpenAI-compatible`）
- Modify: `src/services/worker/CLAUDE.md:12`（`Parallel REST consumer ... (Gemini/OpenCode Go)` → `(OpenAI-compatible)`）
- Modify: `tests/shared/settings-file-permissions.test.ts:3`（注释里的示例键名 `CLAUDE_MEM_GEMINI_API_KEY`/`CLAUDE_MEM_OPENCODE_API_KEY` → `CLAUDE_MEM_OPENAI_API_KEY`；纯注释，断言不变）
- **Modify（用户文档,审计 confirmed 不是 provenance 而是当前操作文档）: `docs/reference/configuration.md`**（`:17`/`:19` 的「58 个键」→「53 个键」;删 `:30` Gemini 组、`:31` OpenCode 组,替换为单一 **OpenAI 兼容** 组 `CLAUDE_MEM_OPENAI_API_KEY`/`_BASE_URL`/`_MODEL`;`:32` 的 `.env` 凭据 `GEMINI_API_KEY` → `OPENAI_API_KEY`）
- **Modify（用户文档）: `README.md`**（`:64` Bypass Lane 描述 `Gemini / OpenCode Go` → `任意 OpenAI 兼容 endpoint`;`:116` 凭据 `Gemini / OpenCode / Anthropic` → `OpenAI 兼容 / Anthropic`;`:118` 常用键 `CLAUDE_MEM_GEMINI_API_KEY / CLAUDE_MEM_OPENCODE_*` → `CLAUDE_MEM_OPENAI_*`,「58 个」→「53 个」）
- **Modify（项目 CLAUDE.md,Final-round 备注）: `CLAUDE.md:15`**（Bypass Lane 描述 `Parallel REST consumer for observations (Gemini/OpenCode Go)` → `(any OpenAI-compatible endpoint)`;`OpenCode path sends thinking:disabled` → `the openai path sends thinking:disabled`,保留失败分类/冷却描述不变）
- 注：`src/shared/CLAUDE.md:20` 已在 Task 1 Step 6 改、`:` 设置计数 58→53 已在 Task 3 Step 6 改；`src/services/worker/BypassLane.ts` 头注释已在 Task 6 Step 11 改。

- [ ] **Step 1: 改上述注释/文档** — 全部纯注释/文档，无逻辑改动。

- [ ] **Step 2: grep 全仓残留(src/ + tests/)** — Run: `grep -rniE "opencode|gemini" src/ tests/ | grep -v node_modules` Expected: **返回空**（src/+tests/ 内每处都已清；provenance 在 `docs/` 下不在此范围）。**Final Gate #1 凭此判定。**

- [ ] **Step 3: 校对用户文档无残留** — Run: `grep -rniE "opencode|gemini|openrouter" docs/reference/configuration.md README.md` Expected: 无输出（这两个用户文档已全部改为 OpenAI 兼容口径）。

- [ ] **Step 4: Commit** — `git add <本 Task Files 段列出的显式路径> && git commit -m "docs: drop residual gemini/opencode references across comments, subsystem + user docs"`

---

### Task 13: 重写 settings.json + 全量构建/测试/重启/验证

**Files:**
- Modify: `~/.claude-mem/settings.json`（运行期配置，非仓库内）

- [ ] **Step 1: 重写用户配置** — 编辑 `~/.claude-mem/settings.json`：删 `CLAUDE_MEM_GEMINI_*`、`CLAUDE_MEM_OPENROUTER_*`、`CLAUDE_MEM_OPENCODE_*`；设：

```jsonc
"CLAUDE_MEM_PROVIDER": "openai",
"CLAUDE_MEM_OPENAI_API_KEY": "<DEEPSEEK_API_KEY>",   // 真实 key 只进此文件(仓库外);执行时填用户提供的实际值
"CLAUDE_MEM_OPENAI_BASE_URL": "https://api.deepseek.com",
"CLAUDE_MEM_OPENAI_MODEL": "deepseek-v4-flash"
```

若 `~/.claude-mem/.env` 含 `OPENCODE_API_KEY`/`GEMINI_API_KEY`，删除（可选保留 `OPENAI_API_KEY`）。

- [ ] **Step 2: 全量构建** — Run: `bun run build-and-sync` Expected: 构建成功，cache/marketplace 同步，worker 重启。

- [ ] **Step 3: 全量测试（权威 gate）** — Run: `bun test ./tests/` Expected: 全绿（0 fail）。这是 mock 污染的权威判定（见命名与不变量）。逐项核对：无 `bypass-opencode`/`env-manager-opencode` 旧文件名残留；新文件名生效。

- [ ] **Step 4: 重启并轮询验证旁路激活（避免 sleep 竞态）** — `/api/health` 是即时 liveness，固定 `sleep 2` 不能证明 bypass 探针已完成。改用轮询：
```bash
bun run worker:restart
for i in $(seq 1 15); do
  s=$(curl -s http://127.0.0.1:37777/api/health | grep -o '"state":"[A-Z]*"' | head -1)
  echo "poll $i: $s"; echo "$s" | grep -q ACTIVE && break; sleep 1
done
curl -s http://127.0.0.1:37777/api/health   # 最终核对完整 bypass 对象（state/endpoint/model）
```
Expected: 轮询内出现 `"bypass":{"state":"ACTIVE","endpoint":"api.deepseek.com","model":"deepseek-v4-flash",...}`；若 15s 仍非 ACTIVE,打印 `lastFailureReason` 诊断（多半是 key/余额问题——属用户配置,非代码缺陷）。

- [ ] **Step 5: 验证测试端点** — key **既不进 argv 也不进受跟踪文件**：用 `jq` 构造 JSON 并经 **stdin (`--data @-`)** 传给 curl（审计 confirmed:`-d "...$KEY..."` 会把 key 暴露到进程 argv）：
```bash
# key 在 jq 内部从 settings 文件直接读取,既不进 jq argv 也不进 curl argv
# (审计 confirmed: `--arg "$KEY"` 仍会把 key 暴露到 jq 进程 argv):
jq '{baseUrl:"https://api.deepseek.com", apiKey:.CLAUDE_MEM_OPENAI_API_KEY, model:"deepseek-v4-flash"}' ~/.claude-mem/settings.json \
  | curl -s -X POST http://127.0.0.1:37777/api/bypass/test -H 'Content-Type: application/json' --data @-
# 期望 {"ok":true,"status":200}
# 错误 key(走 stdin,同样不进 argv):
echo '{"baseUrl":"https://api.deepseek.com","apiKey":"sk-wrong","model":"deepseek-v4-flash"}' \
  | curl -s -X POST http://127.0.0.1:37777/api/bypass/test -H 'Content-Type: application/json' --data @-
# 期望 {"ok":false,...} 且 message 脱敏(不含真实 key)
```

- [ ] **Step 6: 最终提交** — `git add <本 Task Files 段列出的显式路径> && git commit -m "chore(bypass): finalize single openai transport migration"`（settings.json 不入库；仅记录仓库内收尾改动若有）。

---

## Final Gate（执行完成判定）

全部勾选后须同时满足：
1. `grep -rniE "opencode|gemini" src/ tests/`（含 tests/）**返回空**（provenance 文档在 `docs/` 下，不在此 grep 范围内；src/+tests/ 内每处引用都已被某 Task 清除，故应零命中）。
2. `bun test ./tests/` 全绿（0 fail）。
3. `/api/health` 报 `bypass.state=ACTIVE`、`endpoint=api.deepseek.com`、`model=deepseek-v4-flash`。
4. `POST /api/bypass/test`：正确 key → `ok:true`；错误 key → `ok:false` 且 message 脱敏。
5. viewer 设置弹窗显示 Base URL / API Key / Model 三个自由字段 + Test 按钮；badge 显示 `host · model`。
6. `CLAUDE_MEM_PROVIDER` 仅接受 `claude`/`openai`；填 `gemini`/`opencode` 被校验拒绝。
7. transport 闭集为 `{claude, openai}`，`BypassConfig` 无 `provider` 字段，`BypassStatus` 无 cost 字段。

---

## Review Log

### Round 1 (Codex / gpt-5.5, Initial)

Verdict: **REVISIONS NEEDED**. Findings:
1. **Security blocker** — spec embeds real API key (Task 13 Step 1 + Step 5 curl); repeated `git add -A` while worktree has unrelated dirty/untracked files.
2. Task 2 `openai-compatible-probe.ts` has no `logger` import → `tests/logger-usage-standards.test.ts` gate fails.
3. Task 8 endpoint tests not runnable: bare `express()` skips JSON parsing → ok/fail POSTs hit the 400 branch (need `express.json()`).
4. Final Gate test command: repo convention says full `bun test` is the trustworthy gate (mock.module pollution/ordering), not a scoped run.
5. Viewer verification too weak: `bun run build` is esbuild bundling, not typecheck — won't catch stale type refs after deleting gemini/opencode fields.
6. Test button conflicts with runtime `OPENAI_API_KEY` env fallback: button disabled when form key blank, so env-only configs can't be UI-tested.
7. Several intermediate grep expectations false at step boundaries (Task 7 expects no `lastOpencodeCost|bypass.provider` in `src/` before frontend Tasks 9-11 remove `types.ts:74`/`DashboardHeader.tsx:24`).
8. Final Gate #3 race-prone: `/api/health` is immediate liveness; fixed `sleep 2` doesn't prove bypass init.

### Response to Round 1

- **#1 ACCEPTED (highest priority).** Added two global constraints in 命名与不变量: (a) 🔒 forbid `git add -A`/`git add .` — every commit stages only the explicit paths from its Task's Files section (protects the user's uncommitted 6/9 Engram work); replaced all `git add -A` commands accordingly. (b) 🔒 no real API key in any git-tracked file — Task 13 key → placeholder `<DEEPSEEK_API_KEY>`, Step 5 curl reads key from settings.json via shell var.
- **#2 ACCEPTED.** Task 2: added `import { logger }` + a `logger.debug('BYPASS', ...)` on the probe failure path; noted the logger-usage gate.
- **#3 ACCEPTED.** Task 8 Step 1: test app must `app.use(express.json())` (cited `middleware.ts:25`); else ok/fail land on 400.
- **#4 PARTIALLY ACCEPTED / largely REJECTED with evidence.** Root `CLAUDE.md:43` mandates `bun test ./tests/` (bare `bun test` pulls ~52 unrelated failures from the `attn_sink/` upstream clone), so the command stays `./tests/`. BUT Codex's real concern (mock.module pollution hidden by subset runs) is valid: clarified that the **authoritative gate is the full `bun test ./tests/` dir run** (stable order, full pollution surface), per-Task single-file runs are fast-iteration only. `./tests/` is the full fork suite, not a subset, so pollution is surfaced while excluding attn_sink/.
- **#5 ACCEPTED.** Viewer compile checks (Task 9 Step 5, Task 10 Step 3, Task 11 Step 6) switched from `bun run build` to `bunx tsc --noEmit -p tsconfig.json` (tsconfig `include: src/**/*` covers `src/ui`, `jsx:react`).
- **#6 PARTIALLY ACCEPTED.** Documented as an intentional, accepted limitation in Task 10: the button tests the form-entered creds; env-only configs validate via Final Gate Step 4 live bypass state. Deliberately not relaxing the disabled condition (blank key → false probe).
- **#7 ACCEPTED.** Task 7 Step 4 grep scoped to `src/services/` (frontend `src/ui/` fields removed later in Tasks 9-11); full-`src/` zero-check deferred to Final Gate after Task 11.
- **#8 ACCEPTED.** Task 13 Step 4 replaced fixed `sleep 2` with a 15× poll loop on `/api/health` bypass state, with `lastFailureReason` diagnostics on timeout.

### Round 2 (Codex / gpt-5.5, Focused)

Verdict: **REVISIONS NEEDED**. Acknowledged Round 1 fixes as adequate (logger import, express.json, `bun test ./tests/` gate, scoped Task 7 grep, env-only UI limitation, /api/health poll). New findings:
1. **High** — `bunx tsc --noEmit -p tsconfig.json` already fails with a large pre-existing baseline (no DOM/Bun libs, ~321 unrelated errors); a "tsc clean" gate is unachievable.
2. **High** — the strict explicit-staging rule exposes incomplete Task `Files` lists: Task 3 edits `src/shared/CLAUDE.md` (unlisted), Task 6 edits 3 more test files (only 2 listed), Task 10 creates `BypassTestButton.tsx` (unlisted) → those edits wouldn't be committed.
3. **High** — secret redaction incomplete: probe `sanitize()` only strips `sk-…` (generic providers have non-sk keys); `callRestApi` error path embeds unsanitized response text; final curl still expands the real key into argv.
4. **Medium** — user-facing docs stale: `docs/reference/configuration.md` + `README.md` still advertise 58 keys + Gemini/OpenCode (current operator docs, not provenance).

### Response to Round 2

- **#1 ACCEPTED.** Verified locally: `tsc --noEmit` = 321 pre-existing errors. Replaced "tsc clean" with a **baseline-diff** discipline (命名与不变量 + Task 9 Step 0 captures `/tmp/tsc-baseline.txt`; each viewer Task asserts `comm -13` shows no new lines + a hard grep that no error references removed identifiers `CLAUDE_MEM_(GEMINI|OPENCODE)|lastOpencode|opencodeFree`).
- **#2 ACCEPTED.** Updated Files lists: Task 3 (+`src/shared/CLAUDE.md`), Task 6 (+`bypass-lane-properties`/`bypass-ghost-filter`/`bypass-sliding-window`.test.ts), Task 10 (+`BypassTestButton.tsx`, conditional `constants/api.ts`). Each marked "提交时必须 stage".
- **#3 ACCEPTED.** Probe `sanitize()` → exported `redactSecret(s, secret)` that strips the EXACT configured key (any prefix) + `sk-…` pattern; used in both probe (response body + error) and `BypassLane.callRestApi` (redacts `this.config.apiKey` from the thrown error). Added a probe test for a non-`sk` key. Task 13 Step 5 curl now sends JSON via stdin (`--data @-`, `jq -n --arg`), never argv.
- **#4 ACCEPTED.** Task 12 extended with `docs/reference/configuration.md` (58→53, drop Gemini/OpenCode groups → single OpenAI group) + `README.md` (Bypass Lane / 凭据 / 常用键), plus a Step 3 grep over both docs to confirm no residue.

### Round 3 (Codex / gpt-5.5, Focused)

Verdict: **REVISIONS NEEDED**. Acknowledged Round 2 fixes adequate (baseline-diff replaces tsc-clean, Files lists completed, redactSecret covers exact-key + callRestApi, README/config docs included). New findings:
1. **High** — `jq -n --arg k "$KEY"` still places the key in the `jq` process argv (Task 13 Step 5).
2. **High** — `BypassTestButton.tsx` sample imports `API_BASE`, but `constants/api.ts` only exports `API_ENDPOINTS` → build/typecheck fails if copied literally.
3. **Medium** — Task 11 Step 6 `&&`-chains a no-match grep; a successful "no matches" grep exits 1, so the validation fails exactly when the desired condition holds.

### Response to Round 3

- **#1 ACCEPTED.** Task 13 Step 5 jq now reads the key from `~/.claude-mem/settings.json` inside the filter (`jq '{... apiKey:.CLAUDE_MEM_OPENAI_API_KEY ...}' file`), no `--arg`, so the key never appears in any process argv (jq or curl).
- **#2 ACCEPTED.** Removed the `import { API_BASE }` line from `BypassTestButton.tsx`; the component fetches the literal `'/api/bypass/test'` (optional `API_ENDPOINTS.BYPASS_TEST` path documented as the unify option in Files).
- **#3 ACCEPTED.** Task 11 Step 6 split into separate commands using `! grep -nE ...` to assert no-match (exit 0 on the desired empty result), instead of an `&&`-chained `grep`.

### Round 4 (Codex / gpt-5.5, Focused)

Verdict: **APPROVED**. No blocking findings. All Round 3 fixes verified adequate (jq reads key from settings.json inside the filter + curl --data @-; BypassTestButton uses literal '/api/bypass/test'; Task 11 uses separate `! grep` no-match assertions). Independently re-verified surrounding assumptions: DataRoutes `setupRoutes(app)`, middleware JSON parsing, `build-and-sync` restart, tsc baseline = 321 error lines. No new problems.

### Final Round (Codex / gpt-5.5, fresh-eyes gate — Template C, no history)

Verdict: **APPROVED**. Fresh-eyes verification against the current tree (DataRoutes registration, phase3 audit test, tests/CLAUDE.md mock warnings, settings allowlists, build scripts, bypass tests, viewer/typecheck path) all line up. Two non-blocking notes: (1) root `CLAUDE.md:15` had stale Gemini/OpenCode wording → **now added to Task 12**; (2) Final Gate #3/#4 depend on a valid DeepSeek key/account state in `~/.claude-mem/settings.json` — an operational prerequisite, already covered by Task 13 Step 4 diagnostics.

---

## Review Outcome

**APPROVED** by cross-model review (Codex / gpt-5.5) after 4 focused rounds + 1 fresh-eyes final round (budget was 12). Findings converged 8 → 4 → 3 → 0. All accepted findings folded into the spec body above; the post-approval note (root CLAUDE.md) is incorporated into Task 12. Plan is implementation-ready.
