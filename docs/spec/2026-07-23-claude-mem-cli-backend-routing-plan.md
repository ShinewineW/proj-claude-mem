# Claude-Mem 双 CLI 后端路由设计与实施计划

> **日期**: 2026-07-23
> **状态**: 草稿
> **作者**: Claude Code
> **基准版本**: `proj-claude-mem@bca99e66`
> **目的**: 在保留原生 Claude 通路的前提下，以显式二态字段统一选择 SDK Observer 与 fresh Summary 使用的 CLI 后端，并定义可验证、可回滚、不会混跑或损伤队列的切换流程。
> 范围: Claude-Mem CLI backend 配置与运行时快照、Observer/Summary/Bypass 边界、claudex 机器协议、共享 worker 与双 profile 部署、测试、启用和回滚

---

## 1. 结论前置

本设计**技术上可行，但当前版本不能直接照旧计划启用**。完整审查发现，问题不只是把 executable 从 `claude` 改成 `claudex`：

1. Claude-Mem 的 OB 与 SUM 都通过 Claude Agent SDK 的 stream-json 子进程协议工作，业务代码中不存在可直接替换的 `claude -p`。正确接入点是 SDK 的 executable，而不是新增文本式 `claudex -p` adapter。
2. `claudex` 最终 `exec` 同一个 Claude Code 二进制，协议主体已经可用；当前已验证的 framing 阻塞是 wrapper 在第一条 JSON 事件前向 stdout 输出 gateway 状态行。
3. 新字段必须默认 `claude`，原生 executable override 必须保留；`claudex` 不能替代或删除原通路。
4. `CLAUDE_MEM_PROVIDER` 与 CLI backend 是两个独立轴：前者只控制 OpenAI-compatible BypassLane，后者控制 SDK Observer 和 fresh Summary。
5. backend 不能作为可热切换的普通 UI 设置。当前代码在每次 spawn 前重新读取设置，热改会使旧 Observer 继续使用旧后端，而新 Summary 使用新后端。第一版必须采用 **worker-lifetime immutable** 语义：worker 启动时解析一次，只有完整重启才生效。
6. CLI 配置错误必须在任何消费者 claim 队列前被阻断。否则 Summary 会为确定性错误消耗三次 retry、进入 dead-letter，并可能写入 `[salvaged]` summary；这不是“启动失败后回滚配置”能够完全恢复的状态。
7. native 与 claudex 两个 Claude profile 只隔离 plugin cache/discovery，**不隔离 Claude-Mem runtime**。它们共享一个 settings/data root、一个 PID、一个端口、一个 worker 和同一批数据库。
8. 当前 Pod 还有两个启用前阻塞项：
   - 配置控制面与实际 runtime settings 已分叉；先前计划读取了错误的 settings 文件，因此“当前 provider=claude”的结论不成立。
   - 当前模型值是 `claude-sonnet-5`，而已完成的 claudex SDK framing 探针没有传 `--model`；模型映射尚未验证。
9. 当前两个 profile 的 Claude-Mem 均为 disabled，worker health 不可达。本文仍只是一份设计草稿；**本会话不修改源码、wrapper、配置、cache、profile 或 worker**。

因此实施应拆成三个可独立归因和回滚的阶段：

- **协议前置阶段**：只修复并加固 claudex wrapper 的机器输出契约；
- **运行时路由阶段**：实现严格配置、worker-lifetime backend 快照与配置错误阻塞；
- **部署阶段**：实现双 profile/单 worker 的 ownership、可靠 restart 与 provenance 验证，然后才允许启用。

---

## 2. 问题陈述与已验证证据

### 2.1 用户目标

需要同时保留两种状态：

- `claude`：OB 与 SUM 使用原生 Claude Code executable，行为与已有安装一致；
- `claudex`：OB 与 SUM 仍由 Claude Agent SDK 驱动，但 SDK executable 指向 claudex wrapper，由 wrapper 注入本地 gateway、认证、模型 alias 和隔离的 Claude profile；
- 默认值必须是 `claude`；
- OpenAI-compatible bypass 不被新字段合并、重命名或强制关闭；
- 当前会话只完善设计，不实施或启用。

### 2.2 独立复核后的当前状态

以下是 2026-07-23 对实际文件和运行状态的重新核对，不沿用早先会话推断：

| 项目 | 已验证状态 | 设计含义 |
|---|---|---|
| repo baseline | `HEAD=bca99e66`，与 spec 基准无提交差距 | 本文没有时间漂移 |
| repo 工作树 | 4 个既有 `docs/spec/*.md` 删除、`docs/spec/archive/` 未跟踪、本 spec 未跟踪 | 后续实施不得恢复、覆盖或误提交这些既有状态 |
| native profile plugin | disabled | 不能把“已安装”误当“已启用” |
| claudex profile plugin | disabled | 当前没有 hook intake |
| worker | `127.0.0.1:37777/api/health` 不可达；两个候选 data root 均无 `worker.pid` | 当前没有可复用的健康 worker 证据 |
| claudex 安装记录 | claudex profile cache 中记录 Claude-Mem `10.5.2@bca99e66` | 已安装 bundle 与是否运行是两件事 |
| Agent SDK | 已安装 `@anthropic-ai/claude-agent-sdk@0.1.77` | 设计以这个实际版本的 subprocess contract 为准 |
| `claudex` executable | `/usr/local/bin/claudex` 解析到持久 GPFS wrapper；target 为 root 所有、`0755` | 当前 Pod 路径可执行，但 wrapper 没有版本化生成源 |
| native `claude` executable | PATH 中存在 root 所有的 Claude Code ELF | “原生通路不可用”不是“文件不存在”，而是上层模型/认证通路不可用 |
| control settings | `/root/.claude-mem/settings.json` 中 provider 为 `claude`，但其中 `CLAUDE_MEM_DATA_DIR` 指向另一个目录 | 该文件不是 worker 实际 resolver 的最终 settings |
| effective runtime settings | `src/shared/paths.ts::resolveDataDir` 解析到 `/home/shinewine/.claude-mem`；该目录的 settings 中 provider 为 `openai`、backend 缺失、path 为空、model 为 `claude-sonnet-5`、resume 为 `false` | 早先“provider=claude、bypass disabled”的基线错误；若直接启用，bypass 配置完整且可能启动 |
| data root durability | `/root/.claude-mem` 和 `/home/shinewine/.claude-mem` 都位于 Pod overlay，不在 GPFS | 可支持进程级重启，但不能声称 Pod 替换后记忆持久 |
| worker bind | effective/default host 为 `127.0.0.1` | 当前 Settings API 风险被 loopback 边界限制；不得改成 `0.0.0.0` 后启用 |

有效 runtime settings 中 OpenAI key/base URL/model 均为非空；这里只记录存在性，没有读取或输出任何凭据值。

### 2.3 已完成的 claudex 协议探针证明了什么

已完成两层低风险探针：

1. 文本式 `claudex -p` 能返回目标短文本，但 stdout 夹带 gateway 状态；这只能证明 wrapper 后面的模型通路可达，不能证明 Agent SDK 可解析。
2. 与 SDK 0.1.77 同形的 stream-json 直接探针产生 8 个非空 stdout 行：7 行是有效 NDJSON，且包含 `system`、`assistant` 和成功 `result`；第 1 行是 gateway 状态文本。Agent SDK 在读到第 1 行时立即 JSON parse 失败，因此上层看不到后续成功事件。

安装版 SDK 的事实：

- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 固定传入 `--output-format stream-json`、`--verbose`、`--input-format stream-json`；
- `canUseTool` 存在时使用 stdio permission protocol；
- `sdk.mjs::isNativeBinary` 只把 `.js/.mjs/.ts/.tsx/.jsx` 视为脚本，故无扩展名且有 shebang 的 `claudex` 被直接 spawn，而不是交给 Node/Bun；
- wrapper 最终 `exec "$claude_binary" "$@"`，因此 SDK 参数会原样到达同一个 Claude Code 二进制。

这组证据支持“修复 stdout framing 后复用现有 SDK 协议”，但**没有证明以下事项**：

- 探针没有传当前 `CLAUDE_MEM_MODEL=claude-sonnet-5`，所以没有验证该完整 model ID 经 claudex gateway 可用；
- 探针显式使用了 no-session-persistence，而当前生产 `buildHardenedSdkOptions` 没有设置 `persistSession:false`；
- 探针没有验证 active Observer、Summary backlog、profile restart 或 hook fallback；
- 探针没有证明损坏配置、环境覆盖或两个 profile 同时操作 worker 时安全。

---

## 3. 术语与现有架构

### 3.1 四个不能混淆的配置轴

| 术语 | 控制内容 | 不控制内容 |
|---|---|---|
| Claude host profile | 外层 `claude`/`claudex` 会话从哪个 config root 加载 plugin、hooks 与用户设置 | 不创建独立 Claude-Mem worker 或 DB |
| CLI backend | Claude-Mem 内部 Agent SDK spawn `claude` 还是 `claudex` | 不直接决定 BypassLane，也不自动改模型 |
| provider | `CLAUDE_MEM_PROVIDER=claude|openai`，决定 OpenAI-compatible BypassLane 是否配置/启动 | 不替代 SDK Summary，也不选择 SDK executable |
| model | `CLAUDE_MEM_MODEL` 传给 Agent SDK 的 `model` option | 不由 backend 字段自动重写 |

`claudex` 是环境和 gateway wrapper，不是第二种 Summary 协议。它与 native `claude` 使用同一个 Claude Code CLI stream-json contract。

### 3.2 三消费者结构

```text
Claude Code host hooks
        │
        ▼
shared HTTP worker + per-project SQLite pending_messages
        │
        ├── SDK Observer
        │     claim observation
        │     Agent SDK → selected CLI backend
        │
        ├── BypassLane
        │     claim observation only
        │     OpenAI-compatible REST
        │
        └── SummaryLane
              claim summarize only
              fresh Agent SDK → selected CLI backend
```

关键源码锚点：

- `src/services/worker/SDKAgent.ts::SDKAgent.startSession`
  - 每个 Observer generator 启动时取得 executable；
  - 使用 PID-tracked spawn、response watchdog 与 SDK event loop；
  - legacy resume 只在 raw SDK session ID 等条件满足时发生。
- `src/services/worker/BypassLane.ts::BypassLane.resolveConfig`
  - 只读取 provider/OpenAI 配置；
  - 与主 Observer 竞争 observation，不处理 summarize。
- `src/services/worker/SummaryLane.ts::SummaryLane.consumeLoop`
  - 全局单消费者；
  - claim summarize 后等待 observation drain，再执行 fresh query；
  - 普通失败会 retry，耗尽后 dead-letter，并在当前源码中尝试 salvage。
- `src/services/worker/fresh-summarize.ts::runFreshSummarizeQuery`
  - 每次 Summary 是 fresh query，不 resume Observer history；
  - 仍使用 Agent SDK，而不是 REST bypass。
- `src/sdk/hardened-options.ts::buildHardenedSdkOptions`
  - OB/SUM 共享 no-tools、deny-all permission、空 MCP、空 setting sources 与 cwd jail。

### 3.3 双 profile、单运行面

native 与 claudex profile 目前是：

```text
/root/.claude                         ┐
                                     ├── plugin cache/discovery 各自独立
/root/.claudecpa/claudex             ┘

                    但共同指向
                           │
                           ▼
                one ~/.claude-mem DATA_DIR
                one worker.pid
                one worker port (37777)
                one set of per-project DBs
                one backend setting
```

因此：

- 不能同时运行“native worker”和“claudex worker”；
- profile enabled bool 不能证明 worker 来自该 profile；
- 后执行的任一部署脚本都可能替换全局 worker；
- 同版本号不能证明 bundle provenance，必须核对 PID、workerPath 和 bundle hash/commit。

---

## 4. 结构化设计意图（Spec-IR）

| ID | 类型 | 精确定义 | 隐含前提/需验证项 |
|---|---|---|---|
| ACT-001 | actor | operator 是唯一可修改 backend、profile、wrapper 和部署 metadata 的主体 | 当前进程以 root 运行，必须限制误配置面 |
| ACT-002 | actor | 外层 Claude host 只通过 plugin hooks 向 shared worker 提交消息 | hook fallback 必须从正确 profile 加载 |
| FLOW-001 | flow | SDK Observer 与 fresh Summary 从同一个 worker-lifetime backend snapshot 取得 executable 与 child env | 不能在每次 spawn 重新解析可变设置 |
| FLOW-002 | flow | BypassLane 在配置有效时只消费 observation，且不读取 CLI backend | 配置错误时第一版选择整体 BLOCKED，不承诺 bypass-only 降级 |
| INV-001 | invariant | 缺失 backend 的行为等同于 `claude` | 保持升级兼容 |
| INV-002 | invariant | 同一 worker epoch 只允许一个 backend；所有 OB/SUM spawn 一致 | backend 变更必须完整 restart |
| INV-003 | invariant | startup routing配置无静默fallback；非法值、配置损坏、path冲突均不lookup、不spawn、不做queue maintenance/claim或mutating intake | 需要strict/provenance-aware reader、typed error与HTTP intake gate |
| INV-004 | invariant | claudex stdout的每个非空行都是SDK可接受的NDJSON；人类诊断仅走受控stderr | wrapper/gateway banner不能进入stdout |
| INV-005 | security | 切换executable不得扩大tools、permissions、MCP、settings source或cwd访问 | `buildHardenedSdkOptions`继续作为唯一安全SSOT |
| INV-006 | data | routing配置错误在稳定状态不得改变pending业务status/retry，不得产生salvage；claim后防御错误必须CAS release | preflight必须早于maintenance/consumer，release后必须stop lane |
| INV-007 | deployment | 任一时刻只有一个activation事务拥有Pod-global worker启停权；fence期间普通hook不得自动start | 需要全事务lock、nonce fence、fence-aware hook和expected workerPath |
| INV-008 | security | 实际credential/child env只存在于不可序列化private selection；status只显式投影非敏感identity | provider=claude时不读取不需要的OpenAI secret |
| CFG-001 | interface | `CLAUDE_MEM_CLI_BACKEND` 只接受精确字符串 `claude|claudex` | 不 trim、不大小写归一化 |
| CFG-002 | interface | backend 是 restart-required 管理配置，不通过普通 POST `/api/settings` 热改 | GET 可返回非敏感 effective 值 |
| CFG-003 | interface | `CLAUDE_CODE_PATH` 只保留为 native backend 的兼容 override | claudex 下任何非空/非字符串 path 均为配置错误 |
| ERR-001 | error | 配置类错误有稳定 error code，不以消息 substring 判断 | OB、SUM、readiness 和部署脚本共享分类 |
| DEP-001 | dependency | claudex wrapper、gateway、OAuth 文件和本地代理是 repo 外依赖 | 部署前需验证；本 spec 不复制凭据或 wrapper SSOT |
| DEP-002 | dependency | `CLAUDE_MEM_MODEL` 必须同时被 selected backend/gateway 接受 | 当前完整 model ID 尚未实测 |
| OPS-001 | operation | live cutover只在fence生效、旧host兼容性已审计、旧worker完全退出、配置与bundle已staged后进行 | lock不约束hook；`commitActivation`是唯一commit执行者 |

---

## 5. 目标、非目标与明确限制

### 5.1 目标

1. 以一个显式字段保留 `claude` 与 `claudex` 两种 SDK executable 状态。
2. OB 与 SUM 在同一 worker epoch 内始终使用相同 backend。
3. 默认、原生 path override 和现有安全选项保持兼容。
4. Bypass provider 与 backend 语义正交。
5. 配置错误在队列消费前可见、可诊断、无数据副作用。
6. claudex profile 部署不会误触 native profile，并能证明运行的是目标 bundle。
7. 真实验收同时证明正常 OB 与正常 fresh Summary，而不是只证明进程退出码或 salvage 行存在。

### 5.2 非目标

1. 不新增 `claudex -p` 文本 adapter。
2. 不让 native 与 claudex worker 并行运行。
3. 不实现 backend 热切换或 per-session backend。
4. 不让 OpenAI-compatible bypass 生成 Summary。
5. 不重写 prompts、parser、SQLite schema、Chroma 或 observation 内容。
6. 不改变 no-tools / permission / MCP / cwd 安全模型。
7. 不在本次 feature 中彻底重构所有 Settings API 认证；但 live activation 强制要求 loopback，且新 backend 不开放普通 POST。
8. 不在未获用户确认时选择新的持久 data root、修改模型、提交、部署、启用或启动 worker。

### 5.3 当前已知限制

- claudex wrapper 位于持久 GPFS，但没有版本化生成源；只能通过 preimage checksum、精确 patch 与验收记录补足审计，不能假装已有代码仓库 SSOT。
- 当前 data root 在 overlay。进程重启与 Pod 重建是两个不同承诺；未迁移前只允许声明前者。
- 当前 source 仍有 `SummaryLane.salvageAfterDeadLetter` 和对应测试；任何“salvage 已完全移除”的旧说明均不符合当前源码。
- Settings API 当前会返回完整 resolved settings，且 host 校验允许 `0.0.0.0`。本次启用必须验证 host 为 `127.0.0.1`；远程暴露必须先做独立认证/脱敏设计。

---

## 6. 锁定的配置语义

### 6.1 新字段

新增：

- 名称：`CLAUDE_MEM_CLI_BACKEND`
- 类型：string
- 合法值：精确 `claude` 或 `claudex`
- 默认值：`claude`
- 优先级：environment > effective runtime settings file > default
- 生效边界：worker startup only；运行中的 worker 不重新加载
- API：GET 可见；普通 POST 不可写。请求体只要包含该字段，整次更新必须以 HTTP 409 和 `restartRequired=true` 拒绝，且不得写入同一请求中的任何其他字段；不能成功后静默忽略

不接受：

- 空串或纯空白；
- `Claude`、`CLAUDEX` 等大小写变体；
- `null`、boolean、number、array 或 object；
- 未知字符串；
- 配置文件不可读、JSON 损坏或根对象类型错误。

“settings 文件缺失”与“settings 文件存在但损坏”必须区分：前者使用默认 `claude`，后者进入 `CONFIG_BLOCKED`，不得静默回退 native。

strict reader 必须兼容当前 flat schema 与项目已有的 legacy `{env: {...}}` schema，但不能另写一套漂移的迁移规则：应从现有 settings migration 逻辑提取共享的纯解析器，生成 normalized view 和 provenance。startup preflight 只读，不得在 readiness 检查中隐式改写 settings；若需要把 legacy schema 落盘为新格式，应作为单独、可回滚的原子 migration 执行。解析或 migration 失败均 blocked，不得以部分内存值继续启动。

### 6.2 settings、data 与 control state 的单一所有权模型

当前代码把 bootstrap settings、effective settings、host/port、PID 和 credential `.env` 分散在不同路径。实施前必须按下表收敛；不能只修 `SettingsRoutes` 就宣称 data-root 问题已解决。

| 实体 | canonical source / location | 是否随 data root 迁移 | 约束 |
|---|---|---:|---|
| bootstrap/control settings | 固定 Pod-local control root 的 settings；只负责解析 `CLAUDE_MEM_DATA_DIR` pointer | 否 | 环境变量可覆盖 pointer；不得继续承载会与 runtime file 分叉的 provider/backend/model 真值 |
| effective runtime settings | `src/shared/paths.ts::USER_SETTINGS_PATH`，即 `<effective DATA_DIR>/settings.json` | 是 | backend/provider/model/resume/host/port 等运行值的唯一文件真值 |
| DB、log、vector 与 session data | `src/shared/paths.ts::DATA_DIR` 派生 | 是 | 迁移时按 manifest 校验，不把“进程重启”混称为“Pod 重建持久” |
| worker PID | 固定 Pod-local runtime-state root | 否 | PID 不应跨 Pod 持久化；必须与 effective data root 明确分离 |
| deployment lock | 固定 Pod-local runtime-state root | 否 | “global”指本 Pod 内两个 profile 共享；不得放进某个 profile cache |
| credential `.env` | 固定 owner-only credential root | 否 | 不复制到 GPFS data bundle，不进入 rollback manifest 内容或日志 |
| worker host/port | environment > effective runtime settings > default | N/A | `worker-utils`、listener、diagnostics 和 activation 必须调用同一个 resolver |

entrypoint必须先用无写副作用的纯resolver生成不可变`BootstrapResolution`和`RuntimePaths`，再构造`WorkerService`、DB、lanes与HTTP server，并通过依赖注入传递路径/host/port/settings view。不得继续依赖模块加载期冻结的`DATA_DIR`/`USER_SETTINGS_PATH`/`DB_PATH`全局常量完成关键路径，也不得让`SummaryLane`等constructor在strict preflight前调用宽松`loadFromFile`、创建settings或自动migration。兼容导出若暂时保留，只能由已完成bootstrap的context初始化，不能自行fallback。

所有backend和routing相关读写必须统一使用该两阶段模型：先从environment/control source解析data-root pointer，再从canonical effective runtime settings解析业务配置。适用入口包括：

- strict runtime resolver；
- Settings GET/POST；
- worker host/port；
- cache invalidation；
- activation/rollback script；
- diagnostics。

禁止 `SettingsRoutes` 或 `worker-utils` 自己重新拼接 `homedir()/.claude-mem/settings.json` 读取业务值。当前 Pod 已证明这种重复拼接会命中 control settings，而 worker 的 `USER_SETTINGS_PATH` 位于另一个目录。

`CLAUDE_MEM_DATA_DIR` 必须在进程启动前解析。启用前输出经过脱敏的 canonical control root、runtime data root、mount type、settings source、PID root 和 credential root；不能只显示 `~/.claude-mem`。若迁移 data root，rollback set 必须同时包含 bootstrap pointer 与 effective runtime settings，且 data migration 必须作为 executable routing 之外的独立实施单元。

### 6.3 `CLAUDE_CODE_PATH`

保留已有字段，但收紧成明确 schema：

| backend | `CLAUDE_CODE_PATH` | 结果 |
|---|---|---|
| `claude` | 精确空字符串 | 查找 native `claude` / Windows `claude.cmd` |
| `claude` | 合法绝对路径 | canonicalize，并验证常规文件、平台可执行、非目录/FIFO/socket 后使用 |
| `claude` | 不存在、相对、不可执行、非字符串或空白 | `CONFIG_BLOCKED`，不 fallback |
| `claudex` | 精确空字符串 | 查找并验证 `claudex` wrapper |
| `claudex` | 任何其他值或类型 | `CONFIG_BLOCKED`，提示清空 native-only override |
| 非法 backend | 任意 | 先拒绝 backend，不进行 path lookup |

claudex lookup 结果必须转成 canonical absolute path，并在当前 Pod 验证为预期 root-owned wrapper、常规文件、不可 group/world write。禁止把 backend 字段本身拼进 shell 命令。

第一版 `claudex` backend **只支持目标 Linux Pod**：依赖 root UID、POSIX owner/mode、Bash、`/proc`、原子 rename 与当前 wrapper 布局。非 Linux 平台选择 `claudex` 时必须在 lookup 前返回稳定的 `CONFIG_UNSUPPORTED_PLATFORM`；不得省略权限检查或猜测 `claudex.cmd`。native `claude` 的既有 Windows command mapping 保持不变。

### 6.4 provider 与 backend 的合法路由矩阵

下表只描述 **backend preflight 成功** 的稳定状态：

| `CLAUDE_MEM_PROVIDER` | CLI backend | SDK Observer OB | Bypass OB | SUM |
|---|---|---|---|---|
| `claude` | `claude` | Agent SDK → native `claude` | disabled | fresh Agent SDK → native `claude` |
| `claude` | `claudex` | Agent SDK → claudex wrapper | disabled | fresh Agent SDK → claudex wrapper |
| `openai` | `claude` | Agent SDK → native `claude` | OpenAI-compatible competing consumer | fresh Agent SDK → native `claude` |
| `openai` | `claudex` | Agent SDK → claudex wrapper | OpenAI-compatible competing consumer | fresh Agent SDK → claudex wrapper |

“独立”表示 BypassLane 不读取 backend，不表示它在 backend 配置错误时拥有独立 session 生命周期。第一版在 CLI preflight 失败时阻止所有 AI consumer 启动，避免 observation 被部分消费而 Summary 永久阻塞。

### 6.5 model 是独立兼容门

`CLAUDE_MEM_MODEL` 当前由 OB/SUM 传给 SDK，SDK 再生成显式 `--model`。wrapper 的环境默认值不能保证覆盖显式 CLI 参数。

当前 `claude-sonnet-5` 未被已完成探针覆盖；claudex README 只明确记录 `sonnet/opus/haiku` alias 到 Terra/Sol/Luna。因此：

- 不允许 resolver 偷偷改写模型；
- 不允许模型失败后自动 fallback；
- 启用前必须使用**实际 resolved model**跑 SDK smoke；
- 若当前 model 不兼容，必须由用户在“改为跨后端 alias（例如 `sonnet`）”与“新增显式 backend-specific model 设计”之间另行决定；
- 该决定会影响质量、成本和未来回切，不能埋在 executable patch 中。

### 6.6 routing-critical 配置生命周期

backend 不是唯一影响路由一致性的字段。第一版把下表全部纳入同一个 worker-lifetime immutable routing snapshot；环境或文件被运行中修改时只影响下一次完整 restart。

| 配置/派生值 | 生命周期 | 普通 Settings POST | snapshot 内容/理由 |
|---|---|---|---|
| backend、`CLAUDE_CODE_PATH`、canonical executable | worker | 整个请求 HTTP 409 | 决定所有 OB/SUM child 的 executable |
| SDK config profile/root 与 child env policy | worker | 不直接可写 | 决定 CLI state、resume 与凭据边界 |
| provider、Bypass base URL/model/credential | worker | 整个请求 HTTP 409 | private snapshot持实际请求配置；status DTO只投影存在性/来源/指纹 |
| `CLAUDE_MEM_MODEL` | worker | 整个请求 HTTP 409 | 防止同一 turn 的 OB 与 SUM 使用不同模型 |
| `CLAUDE_MEM_OBSERVER_RESUME` | worker | 整个请求 HTTP 409 | 防止同一 worker 新 session 的 anchor 语义漂移 |
| 非 routing UI/显示设置 | 按现有语义 | 可按现有 allowlist 写 | 不得间接改变 executable、provider、model 或 resume |

POST body 只要包含任一 restart-required 字段，必须 all-or-nothing 返回 409 和稳定 `restartRequired=true`，同一请求中的其他字段也不得写入。管理面通过 controlled cutover 在 worker stopped 时原子更新 canonical runtime settings；不把“POST 写成功但当前 lane 不重配”当作支持的热更新。

startup strict resolver对整组routing-critical值生成有provenance的snapshot。`INV-003`的“损坏时不spawn、不claim”特指startup strict preflight；运行中直接损坏文件不会改变既有snapshot。不得让业务代码继续调用宽松`loadFromFile`并在运行中静默fallback default。

行为读取与观测读取严格分离：`RoutingDriftProbe`只在sanitized status请求时使用同一个strict纯解析器，以只读模式重新观察current file/process env并与private snapshot比较；不得调用宽松loader、创建/migrate文件、更新selection/lane、lookup executable、spawn、claim或触发状态转换。输出只允许`in_sync|drifted|unreadable`及脱敏字段名，不输出current/old value、credential片段或可反推secret的hash。业务行为始终使用immutable private snapshot；发现drift只提示operator controlled restart。

---

## 7. Worker-lifetime backend 状态机

### 7.1 状态

| 状态 | 含义 | 是否 claim 队列 |
|---|---|---|
| `UNINITIALIZED` | worker 已创建，但尚未解析 strict settings/backend | 否 |
| `CONFIG_BLOCKED` | bootstrap/runtime parse、safe bind、routing字段、path/profile或executable验证失败；pre-listen失败时可直接非零退出 | 否 |
| `READY` | 完整routing snapshot、child env和executable已验证，startup maintenance已完成，消费者尚未全部启动 | 否 |
| `ARMED` | activation fence内mandatory lanes已初始化但consume/claim与业务intake保持暂停 | 否 |
| `ACTIVE` | fence已清除，OB/Bypass/Summary按合法矩阵运行 | 是 |
| `RUNTIME_BLOCKED` | startup后发现routing/consistency invariant被破坏 | 否；停止全部lane |
| `QUIESCING` | 拒绝新intake，等待/中止在途工作 | 不新增claim |
| `STOPPED` | 旧PID已退出、端口释放 | 否 |

默认规则：只有worker state=`ACTIVE`且双层maintenance gate都不存在才允许业务mutating intake与新claim。`UNINITIALIZED`、`CONFIG_BLOCKED`、`READY`、`ARMED`、`RUNTIME_BLOCKED`、`QUIESCING`和`STOPPED`均拒绝intake/claim。fence owner启动的worker可在gate内完成startup maintenance与lane初始化并进入`ARMED`，但consume loop与HTTP业务intake保持暂停；只有worker自己的`commitActivation`串行临界区能先转`ACTIVE`再移除gate，使外部永远看不到“gate已无但仍ARMED”的窗口。只读diagnostics是否可用取决于safe listener是否已建立。

### 7.2 启动转换

```text
UNINITIALIZED
  ├── strict config / executable validation fail → CONFIG_BLOCKED
  ├── success + matching maintenance fence → READY → initialize paused lanes → ARMED
  │                                            └── commitActivation(nonce, epoch, hash) → ACTIVE
  └── success + no fence → READY → initialize consumers → ACTIVE
```

启动顺序必须固定为：

```text
strict bootstrap pointer + runtime JSON + host/port parse
→ 无法得到安全loopback bind：CONFIG_BLOCKED后非零退出，不listen、不写PID
→ 可安全bind：HTTP liveness-only listen + PID
→ strict routing/executable/profile preflight
→ fail: CONFIG_BLOCKED并立即停止业务初始化
→ success: DB queue maintenance/recovery
→ READY
→ mandatory consumers/lane initialization
→ no fence: ACTIVE；matching fence: ARMED，待commit clear后ACTIVE
```

host/port决定网络暴露面，不能先用宽松default listen再读取strict settings。只有完整JSON可解析、canonical source明确且bind为获批loopback时，才允许建立诊断listener；否则通过脱敏stderr/exit code报告启动阻塞。listener建立后，CLI/routing preflight必须是`WorkerService.initializeBackground`的第一项业务检查，且早于`resetStaleProcessingMessages`、dead-letter/orphan cleanup、fallback replay、`processPendingQueues`、Bypass初始化和Summary启动。否则即使未启动模型subprocess，startup maintenance也可能先改变queue，违背无副作用承诺。

进入 `CONFIG_BLOCKED` 时必须：

- 仅当safe bind preflight成功并建立listener后，`/api/health`才可作为进程liveness返回200，且必须携带sanitized worker state；pre-listen blocked没有HTTP承诺；
- `/api/readiness` 只有 `ACTIVE` 才返回 200；blocked 返回 503 和稳定脱敏 error code；不得复用“HTTP 已 listen”或 `initializationCompleteFlag` 冒充 ready；
- 只开放 read-only core diagnostics；所有可能创建 session、pending row、fallback replay 或触发处理的 `SessionStart`、`UserPromptSubmit`、`PostToolUse`、`Stop` 等 intake endpoint 返回稳定 503，不写 DB；
- 不启动 SDK Observer generator、Bypass consumers 或 Summary consume loop；
- 不执行会改变 pending row 的 startup reset/cleanup/recovery；若只读诊断需要 DB，必须将只读 open 与 maintenance/replay 拆开；
- 不改变 pending status/retry_count，不触发 dead-letter 或 salvage；
- 不设置普通 ready flag；记录稳定 error code、routing source 和非敏感原因；
- 不记录 token、完整环境或 raw stderr。

### 7.3 配置变更转换

整组routing-critical配置在worker lifetime内不可变：

```text
ACTIVE --(operator requests backend change)--> QUIESCING
QUIESCING --(old PID/port fully gone)--> STOPPED
STOPPED --(atomic settings update + target bundle start)--> UNINITIALIZED
```

直接编辑文件时，旧 worker 仍继续使用启动快照；它不会部分切换。新值只有新 worker 读取。

### 7.4 运行时依赖消失

preflight 后 wrapper 被删除、权限改变、gateway/OAuth失效属于 runtime failure，不是配置热切换：

- OB 继续使用既有 watchdog/recovery；
- Summary 继续使用现有有界 retry；
- diagnostics 必须能区分 `CONFIG_BLOCKED` 与 runtime provider failure；
- 正常 runtime failure 仍可能 dead-letter/salvage，因此真实验收必须检查 pending/status，而不能只看 summary 数量。

### 7.5 deployment profile 与 SDK child profile

worker bundle 的 deployment profile 与 SDK child 使用的 Claude config root 是两个不同 provenance 维度，snapshot 和 diagnostics 必须分别记录：

- `deploymentProfileId` 与 bundle workerPath/hash；
- `sdkConfigProfileId`；
- canonical `sdkConfigRoot`；
- config root 来源：closed-profile resolver、wrapper-fixed 或受信 launch env；
- backend/profile mismatch error code。

deployment profile 不隐式决定 SDK profile；backend 才决定 child 的预期 config root：

| deployment profile | backend | SDK config profile/root | 结果 |
|---|---|---|---|
| `native` 或 `claudex` | `claude` | native `/root/.claude` | allowed，但必须显式记录两种 profile ID |
| `native` 或 `claudex` | `claudex` | wrapper-fixed `/root/.claudecpa/claudex` | allowed，但必须显式记录两种 profile ID |
| 任一 | 任一 | child 实际 root 与 backend-derived root 不一致 | `CONFIG_PROFILE_MISMATCH`，blocked |

这保留“plugin deployment 与 CLI backend 是独立轴”，同时消除 ambient launch env。native child 不得偶然继承启动 worker 的另一个 `CLAUDE_CONFIG_DIR`；claudex child 的 wrapper-fixed root 必须与诊断记录一致。未来 `resume=true` 的 mismatch 判据必须同时比较 backend 与 `sdkConfigProfileId`，不能只比较 executable 名称。

---

## 8. Resume、active session 与切换矩阵

`CLAUDE_MEM_OBSERVER_RESUME=false` 时，新 session 使用 `cm-` worker anchor，`SDKAgent.shouldResumeSDKSession` 不会 resume；这是当前默认和目标 cutover 前置条件。

`CLAUDE_MEM_OBSERVER_RESUME=true` 时，raw SDK session ID 与产生它的 Claude config root/backend 有绑定关系，但当前 DB/ActiveSession 不记录 backend provenance。把 native session ID交给强制使用 claudex config root 的 wrapper可能得到 `No conversation found` 或错误恢复。

第一版锁定：

- live activation 的 resolved resume 必须是精确字符串 `false`；
- 有 raw SDK anchor 的 active session 时禁止切换；
- 不在本 feature 中承诺 `resume=true` 跨 backend 迁移；
- 未来若支持，必须为 session 记录 spawn backend/profile，backend 不一致时 force fresh，而不是尝试跨 profile resume。

| 场景 | 预期 |
|---|---|
| resume=false、无 active Observer、无 in-flight Summary | 允许 clean cutover |
| resume=false、已有 Observer 或 Summary subprocess | 先 quiesce/stop，禁止混跑 |
| resume=true、raw SDK ID 仍可能继续 | 禁止切换；需结束旧 session 或另做 provenance 设计 |
| routing settings被运行中编辑 | 旧worker保持snapshot并报告drift；必须restart才生效 |
| 只看到 ProcessRegistry count=0 | 不足以证明 idle；Summary subprocess刻意不注册，需要 lane idle/shutdown 证据 |

---

## 9. claudex 机器协议与安全边界

### 9.1 stdout 契约

对 SDK child：

- stdout 是机器协议专用通道；
- 每个非空 stdout 行必须是 SDK 可接受的 JSON event；
- gateway “started/already running”不得出现在 stdout；
- 禁止用“丢弃第一行”adapter 修补，因为 banner 数量、错误路径和版本都可能变化；
- 正确修复位置是 wrapper 调用 gateway 的边界。

wrapper 中推荐把 routine `start` stdout 丢弃，同时保留退出码和受控 stderr，而不是把 routine banner 改写到 worker stderr：

- 目标语义：`gateway start stdout → /dev/null`；
- gateway 独立 CLI 的 stdout 契约保持不变；
- wrapper 最终 `exec` 和所有 SDK argv 保持不变。

这比原计划的“stdout 全部重定向到 stderr”更窄，避免每次 SDK spawn 都把 routine banner写入 worker debug/stderr tail。

### 9.2 stderr 与敏感信息

当前 gateway 启动失败会把 launcher log tail 写到 stderr，而 `ProcessRegistry` 会记录/缓存 child stderr。故：

- routine 状态不得进入 stderr；
- raw gateway log tail 不得进入 health、SSE、pending row 或普通 worker日志；
- worker 对 child stderr 需要统一长度上限和 token/Bearer/OAuth/proxy credential redaction；
- 原始诊断只保留在 owner-only gateway log；
- 验收只记录事件类型、行数、退出状态和 redaction 结果，不复制完整日志。

### 9.3 child environment

native backend继续使用现有`buildIsolatedEnv()`隔离语义，但按第7.5节显式设置backend-derived SDK config root，不能继承偶然的launch profile。claudex backend在root身份执行Bash wrapper，不应全量继承可注入shell的环境：

- 使用 backend-aware child env builder；
- 保留 gateway 所需 loopback/proxy、HOME、locale、timezone 和基础运行变量；
- 固定为受信系统目录组成的 PATH；
- 删除 `BASH_ENV`、`ENV`、`BASH_FUNC_*`、loader 注入和 `NODE_OPTIONS`；
- 删除 claudex 不需要的上游 API/OAuth key；wrapper自己注入本地 gateway token并从受限文件读取 OAuth；
- 不在日志打印 child env。

wrapper/gateway 的 shebang 应使用实机存在的绝对 Bash 路径；gateway 调用外部工具必须由同一受信 PATH 约束。此项是防误配置加固，不改变模型协议。

### 9.4 原有权限隔离不变

以下选项继续由 `buildHardenedSdkOptions` 统一提供，claudex 分支不得复制或放宽：

- `tools: []`；
- `allowedTools: []`；
- explicit deny-list；
- `permissionMode: dontAsk`；
- deny-all `canUseTool`；
- `mcpServers: {}`；
- `settingSources: []`；
- `strictMcpConfig: true`；
- empty additional directories；
- observer sessions cwd jail；
- abort controller 与现有 spawn wrapper。

wrapper设置 `CLAUDE_CONFIG_DIR` 不等于 Agent SDK会继承该 profile 的 tools/MCP；但它仍影响 CLI 状态/session文件位置，因此 resume 边界仍需处理。

---

## 10. 实施范围与步骤

### 10.1 阶段 0：只做阻塞项决策，不改代码

开始 live activation 前必须由用户明确决定：

1. **Data root**
   - 保留当前overlay root，只做临时进程级smoke；或
   - 另开独立migration实施单元迁移到用户批准的GPFS目录，完整验证DB/settings/log/permissions并先完成自身rollback验收，然后routing activation只消费已稳定的新pointer。
   - data migration不得嵌入routing cutover事务；未决定时可以实现和测试代码，但不能声称“插件已持久恢复”。
2. **Model**
   - 用当前 `claude-sonnet-5` 做 exact-model claudex SDK probe；
   - 若失败，用户另行批准模型 alias/映射方案。
3. **写操作授权**
   - wrapper 外部文件修改；
   - Git branch/commit；
   - profile/cache/settings 变更；
   - worker/plugin 启停分别属于不同授权边界，不自动继承。

### 10.2 阶段 1：wrapper protocol prerequisite

仅在实施被恢复后：

1. 记录 wrapper canonical path、owner/mode、preimage checksum 和精确调用行。
2. 在 wrapper target 所在的 GPFS 目录获取专用 update lock；锁内创建同文件系统、唯一命名的完整 candidate，不原地编辑 live inode。
3. candidate 中把 embedded gateway start 的 routine stdout 丢弃，保留失败退出码和受控 stderr，并按第 9 节收紧 Bash 启动与 PATH/environment 注入面。
4. 对 candidate 做 bytes、语法、owner/mode 与 preimage→candidate diff 校验；lock 内再次检查 active readers。已有 Bash 即使仍持有旧 inode也可完整读完，新的调用只能在 atomic rename 前读旧文件或在 rename 后读完整新文件，不能看到半写状态。
5. 使用同目录 atomic rename promotion；禁止先写 `/tmp` 再跨文件系统移动。rollback 也使用同样的 lock + same-filesystem candidate + atomic rename。
6. 不修改 `/usr/local/bin/claudex` symlink，不复制一份 wrapper 到 Claude-Mem repo；update lock/candidate 在 finally 中清理。
7. 做两次 stream-json 探针：第一次覆盖 gateway start，第二次覆盖 already-running；两次 stdout 都必须是纯 NDJSON。
8. 失败时用记录的 preimage 精确恢复；owner-only rollback material 按第 16 节处理。

### 10.3 阶段 2：runtime backend routing

#### 配置与严格解析

实施前必须用symbol/reference search枚举`DATA_DIR`、`USER_SETTINGS_PATH`、`DB_PATH`、`getWorkerHost/Port`、`loadFromFile`及`WorkerService`/lane constructor的全部caller；任何签名或注入边界变更都按实际callsite matrix更新，不能只改下列已知文件。

修改：

- `src/shared/SettingsDefaultsManager.ts::SettingsDefaults`
- `src/shared/SettingsDefaultsManager.ts::SettingsDefaultsManager.DEFAULTS`
  - 新增 backend，默认 `claude`。
- 新增小型 strict/provenance-aware CLI settings resolver
  - 区分 missing、env、file、default、parse/read error；
  - 返回 typed error code；
  - 纯逻辑支持依赖注入测试。
- `src/services/worker/http/routes/SettingsRoutes.ts`
  - GET/POST 使用 canonical `USER_SETTINGS_PATH`；
  - non-secret routing值 GET可见，但第6.6节全部restart-required字段均不可热改；
  - 不把backend加入普通viewer write allowlist；
  - 任一restart-required字段出现在POST时，整次请求以409/admin-only响应拒绝并零写入，而不是静默丢弃或部分写入。

#### Worker-lifetime selection

worker-owned selection分成两个对象：

1. `PrivateRoutingSelection`：只存在于worker内存，不可JSON serialization、不允许object spread到日志/status，至少包含：
   - backend、provider、model、resume与各字段source；
   - canonical executable；
   - deployment profile ID；
   - SDK config profile ID/root与来源；
   - 实际immutable child env snapshot或受控secret handle；
   - provider=`openai`时实际Bypass endpoint/model/credential；provider=`claude`时不读取、不指纹化不需要的OpenAI secret；
   - 初始化时间/worker epoch和typed resolver state。
2. `RoutingStatusDTO`：由private selection显式投影，只含非敏感executable identity、credential存在性/来源/稳定指纹、profile、model identity与error code，绝不含credential、raw env或可反推token的片段。

Bypass transport只能注入`PrivateRoutingSelection`中的私有config，diagnostics只能取得`RoutingStatusDTO`。每次spawn不得从可变`.env`重新构造child env；若必须延迟取secret，应使用worker-lifetime只读credential handle并锁定其rotation/restart语义。

worker startup分两步构造selection：在`server.listen`前strict解析bootstrap/runtime settings并验证safe loopback host/port；随后在`initializeBackground`最前面、任何queue reset/cleanup/recovery和AI consumer之前完成executable/profile/child-env preflight：

- pre-listen parse失败则非零退出，不绑定端口、不写PID；
- safe listener建立后才可用HTTP返回后续blocked诊断；
- 全部成功才允许DB queue maintenance、recovery与consumer初始化，并在这些步骤真正完成后把readiness置为ACTIVE；
- 失败进入CONFIG_BLOCKED，跳过所有会改变pending row的启动路径；
- 整个worker lifetime不重读任何routing-critical字段。

调整依赖注入：

- `SDKAgent.startSession` 使用 selection，不再每个 generator读取 mutable backend/model/resume；
- `SummaryLane.buildDeps` 使用同一 selection，不再每个 message重读 model；
- `BypassLane` transport通过专用TypeScript接口注入`PrivateRoutingSelection.bypassConfig`中的实际endpoint/model/credential，不接受`RoutingStatusDTO`或sanitized identity，也不自行重读settings/`.env`；health/log/SSE只能接收独立status DTO。Bypass仍不由backend决定，但只在全局preflight成功后启动；
- session anchor 逻辑使用 snapshot 中的 resume；
- `findClaudeExecutable` 可保留兼容 facade，但不得成为每次 spawn 的可变读取点。

#### Summary 配置错误保护

配置错误必须在 claim 前阻断。另加防御层：如果 typed CLI configuration error 仍在 `claimNextSummarize` 之后到达 SummaryLane，必须：

1. 对 exact message ID 做原子 compare-and-set release：仅当 status仍为本 lane刚 claim 的 `processing` 时恢复 `pending`；
2. 保持 `retry_count`、原始创建时间、session/turn identity 和 payload不变，只清除 transient claim/processing metadata；
3. release成功后把worker唯一转换为`RUNTIME_BLOCKED`，拒绝全部mutating intake和新claim，并abort/stop Observer、Bypass、Summary；不得只停Summary或使用含糊的degraded半服务；
4. release失败时报告稳定consistency error并执行同一fatal stop，不得继续claim；
5. 不调用`markFailed`、不dead-letter、不salvage；必须由controlled restart恢复。

第一版可利用Summary全局单消费者和exact-ID/status CAS，无需新增DB schema；测试必须比较release前后的完整业务字段，而不只检查retry count。状态转换固定为：

```text
ACTIVE → exact-ID CAS release → RUNTIME_BLOCKED
       → reject intake/claims → stop all AI lanes → controlled restart required
```

#### Diagnostics

`/api/health`是liveness；`/api/readiness`只有worker state=`ACTIVE`、fence不存在且mandatory lane已运行才返回200。`CONFIG_BLOCKED`/`ARMED`的health可为200，普通readiness必须为503。activation另用owner-only loopback `deployment-readiness(nonce)`验证`ARMED`：nonce匹配、bundle/routing provenance正确、mandatory lane已初始化且claim loop暂停。它不是业务readiness，不能被hooks接受。ACTIVE判定至少要求：

- Summary lane=`ACTIVE`；
- Observer dispatcher/selection ready；
- provider=`claude`时Bypass=`DISABLED_EXPECTED`可视为满足；
- provider=`openai`时Bypass配置验证并完成lane initialization。

本地确定性验证与远端探针必须拆成`validateBypassConfig(privateSnapshot)`和有界`probeProvider(privateConfig)`，不能继续由一个`initialize()`把缺配置与断网混成disabled：

| provider/config | startup结果 | readiness | activation |
|---|---|---|---|
| `claude` | Bypass=`DISABLED_EXPECTED`，不读取OpenAI secret | 可进入ACTIVE | 不probe |
| `openai`且key/base/model/schema任一无效 | `CONFIG_BLOCKED`，maintenance前停止 | 503或pre-listen退出 | 禁止 |
| `openai`配置有效且probe成功 | Bypass=`ACTIVE` | 200 | 可继续 |
| `openai`配置有效但远端probe失败 | Bypass=`NOT_READY`，不改配置 | 503 | live activation失败 |
| ACTIVE后短暂网络失败 | Bypass=`DEGRADED`/circuit breaker | worker保持ACTIVE但status degraded | 运行期告警；不自动改backend/provider |

sanitized status至少包含：

- `cliBackend`、provider、model identity与 resume；
- resolver/worker state和稳定 error code；
- deployment profile ID；
- SDK config profile ID/root/source；
- workerPath；
- bundle commit/hash；
- Summary lane state和 in-flight/claimed count；
- Bypass state和 active request count；
- Observer tracked process count。

不得包含 credentials、完整 env、raw stderr 或敏感 query内容。

#### 明确不改

- prompts 与 XML parser；
- SQLite schema/migrations；
- observation/summary payload schema；
- `buildHardenedSdkOptions` 的安全语义；
- Chroma/search 逻辑；
- Bypass REST transport 与 provider 枚举。

### 10.4 阶段 3：profile-aware deployment and global worker ownership

当前 `sync-to-cache.cjs`、`sync-marketplace.cjs` 与 `restartWorker` 不能直接作为安全 cutover 工具。必须拆成两个职责不能混用的操作：

1. `stageProfileBundle(profileId)`：
   - 接收闭集 profile ID（`native|claudex`），不是任意 filesystem path；
   - profile resolver从 ID导出 canonical root，验证 root/祖先/目标不是危险 symlink、owner正确且不可 group/world write；
   - 只构建 unique staging cache/marketplace/metadata candidate并校验 commit/hash/workerPath；
   - 不覆盖 live target、不改 installed/known metadata、不改 enabled bool、不 stop/start worker。
2. `activateStagedBundle(profileId, expectedHash)`：
   - 在整个quiesce→stop→settings update→promotion→start→provenance/readiness verify→enable hooks事务期间持有同一个Pod-global deployment lock；
   - 取得lock后创建同nonce的双层maintenance gate：Pod-local runtime-state root中的mode 0600 fast fence，以及目标profile managed transaction root中的persistent gate；两者都只含expected profile/hash和sanitized phase，不含secret；
   - 对每个live object做same-filesystem per-object atomic promotion，并用crash-consistent transaction state保证cache、marketplace、installed metadata与known metadata最终一致指向expected hash；
   - 任一步失败都禁止enable hooks，并按rollback state恢复live targets；
   - 不允许worker或hooks长期指向staging临时路径；所有target manifest准备完成后，由activation把durable decision fsync为`COMMIT_DECIDED`，再调用worker owner-only `commitActivation(nonce, expectedWorkerEpoch, expectedHash)`；成功后标记`COMPLETED`。
3. maintenance fence是部署脚本之外的跨进程协议：`ensureWorkerRunning`、`tryStartWorker`、restart入口和所有profile的hook fallback必须先检查Pod-local fence、persistent gate以及target parent中未`COMPLETED`的transaction marker。任一pre-commit gate存在时，普通hook不得自动拉起worker、不得写fallback queue或pending row；以稳定maintenance no-op成功返回给host。activation窗口禁止业务会话，故该窗口事件明确不纳入记忆；只有持有匹配nonce的activation/recovery进程可启动expected live worker。Pod重建导致local fence丢失时，persistent gate或`COMMIT_DECIDED` marker仍必须阻止普通auto-start并触发确定性recovery。
4. `commitActivation(nonce, expectedWorkerEpoch, expectedHash)`是唯一commit执行者。worker在单一串行临界区内验证nonce/epoch/hash/`ARMED`/all-target decision，预备paused claim loops，先把内存state设为`ACTIVE`（gate仍阻止外部intake），再移除persistent gate和local fence并唤醒loops；endpoint成功后activation才把WAL标记`COMPLETED`。这样最后一个gate消失时worker已是ACTIVE。
5. durable state一旦进入`COMMIT_DECIDED`就不再允许普通rollback。若activation或worker在endpoint完成前后崩溃，recovery必须验证全部expected target/settings/profile并证明旧PID/epoch已消失；完全匹配时可在同nonce decision下原子登记一个replacement worker epoch，启动其到ARMED后调用同一commit endpoint roll-forward并标记COMPLETED；不匹配则hard stop人工处理。
6. fence支持必须在backend cutover前作为兼容能力存在于所有可能被旧host调用的hook runner中；activation还必须审计并关闭或证明不存在仍加载不支持fence旧hook的Claude host进程，否则hard stop。
7. `sync-to-cache.cjs`必须明确选定一种契约：默认成为pure stage命令；若保留activate能力，只能通过显式`--activate`调用上述事务，禁止“sync默认隐式restart”。
8. sync、marketplace、bun-runner fallback、activation和restart使用同一个closed-profile resolver。
9. `plugin/hooks/hooks.json`在`CLAUDE_PLUGIN_ROOT`缺失时基于`${CLAUDE_CONFIG_DIR:-$HOME/.claude}`，不能硬编码native cache。
10. 禁止对live target直接半程`rsync --delete`后宣称成功；多个target不是单次原子操作，必须按第16节实现per-object atomic、transaction-level crash-consistent promotion。
11. 部署前必须有可审计的committed source SHA；不部署“metadata仍指向bca99e66、内容却来自未提交工作树”的bundle。
12. restart contract：
   - capture old PID/workerPath；
   - 请求shutdown后等待旧health down或端口释放；
   - promotion完成后从expected live marketplace path启动，不从staging path启动；
   - activation进程携带匹配fence nonce启动expected worker；
   - fence模式等待owner-only ARMED deployment-readiness；普通无fence restart才等待ACTIVE readiness；
   - 断言新PID不同、workerPath正确、bundle hash正确、routing snapshot ready；
   - 失败返回非零，不把旧worker仍健康误判为新worker成功。
13. async CLI main必须await stage/activation/restart并传播非零失败；只在完整事务验证成功后输出activation success。pure stage只能输出staged/verified，不能输出worker success。
14. profile enabled顺序：目标live bundle/worker ready后，最后才启用目标hooks；非目标profile保持disabled，除非未来有单独takeover设计。

### 10.5 阶段 4：测试、构建和独立 review

测试先于实现。不得手改 `plugin/scripts/*.cjs`；统一由 `bun run build` 生成。

新增或扩展：

- executable/backend pure resolver tests；
- strict config provenance tests；
- corrupted JSON/read error/non-object JSON tests；
- flat 与 legacy `{env:{...}}` 只读 normalize、无隐式 rewrite tests；
- `CLAUDE_CODE_PATH` 类型、absolute/canonical/regular/executable tests；
- non-Linux claudex `CONFIG_UNSUPPORTED_PLATFORM` 与 native Windows regression；
- 全组routing-critical worker-lifetime immutable tests与read-only RoutingDriftProbe无副作用/脱敏tests；
- pre-listen strict parse失败不bind/不写PID，safe-listener后invalid routing的mutating intake 503、startup maintenance/consumer不运行、queue不变；
- Summary typed config error原子release claim，完整业务字段不变、全lane转RUNTIME_BLOCKED且不retry/dead-letter/salvage；
- health liveness、fenced ARMED deployment-readiness、claim delta=0与fence-clear ACTIVE readiness tests；
- PrivateRoutingSelection不可序列化/不泄密、RoutingStatusDTO显式投影、provider=claude不读取OpenAI secret；
- Bypass deterministic config矩阵与bounded probe/runtime degraded tests；
- deployment profile / SDK config profile独立provenance tests；
- resume=false切换与 resume=true禁止矩阵；
- backend-aware child env injection tests；
- wrapper fake PATH/BASH_ENV/stdout framing tests；
- SettingsRoutes canonical runtime path tests，包括 `CLAUDE_MEM_DATA_DIR` override；
- hook fallback claudex profile tests；
- profile resolver、pure stage、per-object atomic/crash-consistent promotion、deployment lock/fence与path validation tests；
- 已加载hook命中gate不auto-start、nonce owner可start、non-ACTIVE intake gate contract tests；
- `commitActivation`验证nonce/epoch/hash、ACTIVE-before-gate-removal、首个post-commit intake不丢失、`COMMIT_DECIDED`崩溃roll-forward tests；
- stage不得改live metadata/enable/restart，activate必须从live path启动的contract tests；
- restart old-PID/health-down/new-PID/workerPath/ACTIVE readiness行为测试；
- async CLI必须await并传播stage/activation/restart失败；
- target-local WAL crash recovery、secret snapshot 0600、manifest不含secret、stale transaction cleanup tests；
- existing Summary、security、Bypass 和 settings permissions regression。

Bun 的 `mock.module()` 会污染进程；优先纯函数依赖注入、临时目录和 source-inspection，必要时按文件分进程运行。

实施应拆成独立故障域和独立验收门：① repo外 wrapper协议/原子替换；② worker routing state machine与settings语义；③ profile staging/activation/restart事务。可选 data-root migration单独设计、单独提交和验收，不得与 executable routing同一次 cutover隐式完成。

---

## 11. 配置与切换 callsite matrix

这是 config-gated branch change 的持久 artifact。实施若改变字段或入口，必须先更新本节。

| config/入口 | 读取 routing config？ | 使用 worker snapshot？ | 允许 live change？ | 失败行为 |
|---|---:|---:|---:|---|
| `SettingsDefaultsManager.DEFAULTS` | 定义 defaults | N/A | N/A | backend默认 `claude` |
| bootstrap data-root resolver | 只读 data pointer | 产生 canonical runtime path | 否 | pointer损坏时 blocked |
| strict routing settings resolver | backend/provider/model/resume/path/Bypass identity | 产生 snapshot | 否 | typed CONFIG error |
| `worker-utils` host/port | 从 canonical runtime resolver | 是 | 否 | 不得回读control settings |
| `WorkerService` startup | 是 | 是 | 否 | CONFIG_BLOCKED，maintenance/intake/consumer均不启动 |
| `SDKAgent.startSession` | 否 | 是 | 否 | 不自行 fallback/重读model/resume |
| `SummaryLane.buildDeps` | 否 | 是 | 否 | 不自行重读model；防御错误时release claim |
| `BypassLane` validate/probe/transport | 否 | private snapshot | 否 | 本地缺配置blocked；远端probe失败not ready |
| `ensureWorkerRunning` / hook fallback | 否 | 检查maintenance fence | 否 | fence存在时不auto-start |
| quiesce/start管理控制 | 否 | 验证matching fence nonce | 仅activation | nonce不匹配拒绝 |
| GET `/api/settings` | 返回non-secret effective routing值 | status DTO only | 只读 | 完整secret DTO风险由loopback前置条件约束，是否同批脱敏见第19节 |
| POST `/api/settings` | 检测任一restart-required字段 | N/A | 禁止 | entire request 409，零写入 |
| activation transaction | 写bootstrap pointer/effective settings中获批部分 | N/A | 仅worker stopped且持lock | atomic write + rollback manifest + restart |
| pure profile stage | 不解释业务值 | 不启动worker | 否 | 只产生staging，failure non-zero |
| profile activation/restart | 验证effective snapshot | 验证snapshot | 仅controlled cutover | pre-commit ARMED失败回滚；post-fence ACTIVE失败按runtime incident |

切换矩阵：

| old → new | active Observer | Summary in-flight/backlog | resume | 动作 |
|---|---:|---:|---|---|
| `claude → claudex` | 0 | 0 / 可持久 backlog | false | 允许 controlled restart；backlog只由新 worker处理 |
| `claude → claudex` | >0 | 任意 | false | 禁止直接写设置；先 quiesce/stop |
| `claude → claudex` | 任意 | 任意 | true/raw IDs | 禁止；先结束旧 session或另做 provenance migration |
| `claudex → claude` | 0 | 0 / 可持久 backlog | false | 仅在 native模型/认证通路重新验证后允许 |
| 任意 → 非法 | 任意 | 任意 | 任意 | 不启动新 worker consumer；旧 worker只在显式 stop前维持旧 snapshot |

---

## 12. STRIDE 与 sharp-edge 审查

| 类别 | 适用威胁 | 设计控制 | 残余风险/验收 |
|---|---|---|---|
| Spoofing | ambient PATH 中伪 `claudex`/`bash`/gateway tool | canonical executable、owner/mode检查、固定 PATH、绝对 shebang、closed profile ID | 当前 root operator 本身仍是信任主体；需 fake PATH/BASH_ENV test |
| Tampering | settings、wrapper、plugin cache、marketplace metadata被误写、半promotion或指向symlink | strict settings、profile path validation、wrapper/per-object atomic replace、crash-consistent WAL、bundle hash、deployment lock | wrapper无版本化SSOT；记录checksum与精确patch |
| Repudiation | 未提交bundle、旧hook自动restart或旧worker被误报为成功 | committed SHA、maintenance fence nonce、old/new PID、workerPath、bundle hash、非零失败、审计状态 | 不把版本号单独当provenance |
| Information disclosure | child env、OpenAI key、OAuth、gateway stderr或rollback preimage进入日志/API | non-serializable private selection、explicit status DTO、owner-only same-fault-domain preimage、redaction、loopback API | Settings API完整认证/secret DTO改造是独立hardening；远程绑定前必须完成 |
| Denial of service | 非法backend触发restart/retry、旧hook在cutover自动start、双profile争抢worker | non-ACTIVE拒绝intake、CONFIG_BLOCKED不claim、nonce fence、global lock、reliable restart | runtime provider故障仍走现有有界retry |
| Elevation of privilege | claudex继承 profile tools/MCP或 shell注入环境 | hardened SDK options、empty settings/MCP、cwd jail、child env过滤 | 不能删除 `canUseTool` backstop或改 permission mode |

安全默认：

- backend 缺失 → `claude`，保持升级兼容；
- backend 损坏/冲突 → blocked，不 fallback；
- backend 不开放热写；
- profile 未明确选择 → 现有 native行为，但 live claudex部署必须显式 profile ID；
- worker host 不是 loopback → 本次 activation hard stop。

---

## 13. Liveness 与队列分析

### 13.1 正常路径

- SDK Observer 使用 event-driven message generator 和 response watchdog；本 feature不改消息循环。
- BypassLane 在有效状态下按 observation query claim，并有 timeout/circuit breaker；本 feature不改其 transport。
- SummaryLane idle 时有 2 秒 sleep，retry 间有 2 秒 sleep，不存在本 feature新增的同步 busy loop。

### 13.2 配置错误路径

现状：Summary 先 claim 再解析 executable；任何错误都会 `markFailed`，三次后 dead-letter + salvage。

目标：routing preflight 在任何 queue maintenance、mutating intake和 consumer startup前完成。CONFIG_BLOCKED不启动 Summary loop，因此：

- 不 claim；
- 不 retry；
- 不 salvage；
- 不接收会创建 session/pending row的新 hook intake；
- 不需要依赖 backoff避免 livelock；
- 修复配置并重启后，原 pending row仍可处理。

防御性 typed config error若极少数情况下出现在 claim之后，必须 exact-ID CAS release回 pending并立即停止 lane；不得形成 `claim → release → 同一 loop再次claim` 的自循环。

### 13.3 Shutdown 与切换

- Observer process 在 ProcessRegistry 中可见；shutdown 必须 abort并等待退出，必要时 SIGKILL。
- fresh Summary subprocess刻意不注册到 ProcessRegistry，只靠 registry count=0不能证明 idle。
- cutover需要Summary lane的in-flight状态，或先完整stop worker并确认旧PID/port消失。
- deployment lock只约束部署进程，不能约束已加载hook；maintenance fence必须阻止`ensureWorkerRunning`/`tryStartWorker`在stop→promotion窗口自动拉起旧worker。
- 所有非ACTIVE状态拒绝mutating intake与新claim；QUIESCING control和activation start都用matching fence nonce授权。
- shutdown中断的claimed message必须依靠现有stale-claim self-heal回到可处理状态；切换验收需要验证，而非假定。
- gateway是claudex的共享外部服务，plugin rollback不应擅自停止它；其他claudex session可能仍使用。

### 13.4 Bypass 边界

provider/config 有效时，Bypass 与 backend正交；backend preflight失败时第一版整体阻止 AI consumer，避免出现“部分 observation 已被 bypass消费、Summary 永久 blocked”的半服务状态。

如果未来要求 bypass-only degraded mode，必须单独设计 session lifecycle、Summary backlog和恢复语义，不能从本矩阵自动推导。

---

## 14. Failure matrix

| 失败 | 检测点 | 队列影响 | 自动动作 | operator动作 |
|---|---|---|---|---|
| backend非法/非字符串 | startup strict resolver | 无 | CONFIG_BLOCKED | 修复 effective source并重启 |
| bootstrap/runtime settings损坏、无法解析safe bind | pre-listen strict resolver | 无 | CONFIG_BLOCKED后非零退出，不listen/不写PID/不回退 | 从typed exit与owner-only log修复canonical source |
| routing字段非法但safe bind有效 | post-listen startup preflight | 无 | CONFIG_BLOCKED，health liveness可用/readiness 503 | 修复effective source并restart |
| legacy schema合法 | shared pure parser | 无 | 只读normalize，不在preflight改写 | 如需migration，单独原子执行 |
| data pointer与runtime source分叉 | bootstrap/runtime diagnostics | 无 | CONFIG_BLOCKED | 修复canonical pointer/source；必要时回滚bootstrap settings |
| claudex + native path override | startup resolver | 无 | CONFIG_BLOCKED | 清空 override并重启 |
| 非Linux选择claudex | platform preflight | 无 | `CONFIG_UNSUPPORTED_PLATFORM` | 使用native或目标Linux Pod |
| executable缺失/非文件/不可执行 | startup preflight | 无 | CONFIG_BLOCKED | 修复安装/权限，不fallback |
| stdout含非JSON banner | pre-enable probe或SDK parse | plugin启用前无 | probe失败 | 修复 wrapper framing |
| current model不被gateway接受 | exact-model smoke | plugin启用前无 | smoke失败 | 用户决定model方案 |
| provider=openai但Bypass本地配置不完整 | startup pure validation | 无 | CONFIG_BLOCKED，非disabled | 修复key/base/model/schema并restart |
| provider=openai配置有效但activation probe失败 | bounded provider probe | 无业务intake | NOT_READY，activation失败 | 修复网络/provider后重试 |
| gateway/OAuth runtime失败 | child exit/result | OB/SUM按现有runtime策略 | 有界retry/watchdog | 修复gateway；检查是否出现dead-letter |
| typed config error意外发生在Summary claim后 | Summary defense | CAS恢复pending，业务字段不变 | RUNTIME_BLOCKED，stop全部AI lanes/intake/claims | controlled restart；release失败为consistency incident |
| Summary parse/no_text | SummaryLane | retry，可能dead-letter/salvage | adaptive obs cap + retry | 验收视为失败；不能用salvage冒充成功 |
| restart只收到ACK、旧worker仍活 | restart contract | 若未修会混用旧bundle | 新contract必须等待down/new PID | 失败非零，保持hooks disabled |
| hook缺少 `CLAUDE_PLUGIN_ROOT` | fallback test | 可能执行native旧cache | profile-aware fallback | 修复后再启用 |
| 两个profile并发activation | deployment lock | 可能替换global worker | 第二个activation拒绝 | 明确takeover，不并行 |
| fence期间旧hook尝试auto-start | hook/worker-utils fence check | 不启动、不写fallback queue/pending | maintenance no-op返回host | 查明不支持fence的旧host；必要时hard stop |
| pure stage中途失败 | staging validation | live状态无变化 | 删除不完整candidate | 修复后重新stage |
| activation进程或Pod在多target promotion中途退出 | target-local WAL/transaction scan | fence未清除前无新业务intake | 下次启动先恢复last committed set或hard stop | 不用易失`/tmp`猜测恢复 |
| activation在fence清除前失败 | transaction state | hooks未提交业务；旧worker可能已停 | 恢复live metadata/bundle/settings preimage | 保持hooks disabled，核对provenance |
| live edit routing config | worker snapshot | 旧worker无变化 | diagnostics报告drift，不热重载 | controlled restart |
| resume=true跨backend | cutover precheck | 可能resume失败 | 禁止切换 | 结束旧session或新设计 |
| worker host为`0.0.0.0` | activation precheck | 无 | hard stop | 先完成API认证/TLS设计 |
| data root在overlay | mount precheck | Pod替换可丢历史 | 不自动迁移 | 用户选择GPFS root或接受临时smoke |

---

## 15. Controlled cutover 执行模拟

以下步骤必须按顺序；任何失败都停止，不跳到后续步骤。

### 15.1 Stage（无 live intake）

1. 确认源码已在独立 branch 上测试并有用户批准的 local commit；只暂存本 feature允许文件和本 spec，不触碰既有 docs删除/archive状态。
2. 完成 wrapper两次纯 NDJSON probe。
3. 使用实际 model、实际 child env、同一 hardened options做至少两次 SDK smoke；必须看到 assistant和 success result。
4. 构建 generated bundle并运行完整 tests。
5. 以 claudex profile ID写入 staging cache/marketplace，不改变 enabled bool，不重启worker。
6. 记录 staging bundle commit/hash、expected workerPath与 metadata diff。

### 15.2 Activate transaction：lock and quiesce

1. 获取Pod-global deployment lock、创建带nonce的maintenance fence并重新校验staging expected hash；从此步到hooks enable成功或rollback完成全程持lock+fence。
2. 审计所有可能仍加载Claude-Mem hook的Claude host；不支持fence的旧host必须先关闭，否则hard stop。禁用本次目标profile metadata并验证非目标profile已经disabled；不得假设改metadata会卸载已运行host中的hooks，也不得顺手改写非目标profile。
3. 当前worker若存在，记录old PID、workerPath、routing snapshot和pending计数；通过新增的owner-only loopback control `beginQuiesce(nonce)`使其进入`QUIESCING`。该控制必须验证matching fence nonce，并原子拒绝mutating intake与新claim。
4. 等待或中止active Observer/Bypass/Summary；不能只看Observer registry。fence期间任何hook命中`ensureWorkerRunning`都不得自动restart旧worker。
5. 停止old worker，等待PID消失且端口/health down；只有activation持有者可携nonce启动后续expected worker。
6. 记录activation窗口内pending IDs、retry/status和summary IDs，用于证明切换未消费数据。

### 15.3 Configure

1. 按第 6.2 节两阶段模型重新解析 bootstrap/control source与 canonical effective runtime settings；禁止把 `/root/.claude-mem/settings.json` 一律当业务设置目标。
2. 检查 backend/provider/path/model/resume/data-root/host/port 的环境变量覆盖。环境优先级高于文件；任何不匹配的 env override都必须先移除或显式改正，不能写文件后误以为已生效。
3. routing activation本身不得迁移data root或改bootstrap pointer。若用户另行批准迁移，它必须在本事务开始前作为独立实施单元完成并验证；本步骤只确认pointer与data manifest稳定。否则保持当前pointer并明确只做临时进程级恢复。
4. 在 rollback manifest已落盘后，原子写入整组获批routing-critical值，其中backend=`claudex`。
5. 若目标是禁用 bypass，必须在**同一 effective settings**中确认 provider=`claude`；当前有效值实际为 `openai`，因此这是显式配置变更，不能沿用旧计划假设。
6. 确认 native-only path为空、resume=false、worker host=127.0.0.1，并通过统一 host/port resolver证明实际 listener会读取该值。
7. model按用户已批准的方案配置。
8. 收紧 control/runtime/credential各自目录和文件权限；不复制或输出 credentials。

### 15.4 Promote, start and prove provenance

1. 仍持lock+fence，按target-local write-ahead state逐object原子promotion staging cache、marketplace与installed/known metadata；每个live target必须指向expected hash，transaction-level以crash recovery保证一致，而非声称一次全局rename。
2. 只从 promoted **live** claudex marketplace workerPath启动；不得让 worker或 hooks引用 staging临时路径。
3. 等待owner-only `deployment-readiness(nonce)`的`ARMED`成功；普通`/api/readiness`此时必须仍为503，不能接受单纯`/api/health`200。
4. 断言新PID、expected live workerPath、bundle hash、deployment profile、cliBackend、SDK config profile/root和完整routing snapshot identity。
5. 断言Summary/Observer/Bypass mandatory lane均initialized-but-paused且claim delta为零；provider=`openai`时在private config上做有界connectivity probe。
6. 断言native profile仍disabled。
7. 仍保持fence，最后才启用claudex profile metadata，并以静态解析/无业务副作用probe验证hook fallback命中同一live bundle；普通hook此时仍不得提交业务intake或自动restart。
8. activation先把all-target WAL fsync到`COMMIT_DECIDED`，再调用`commitActivation(nonce, expectedWorkerEpoch, expectedHash)`；worker在串行临界区内验证并先转`ACTIVE`、后移除双层gate、最后唤醒claim loops。endpoint成功后写`COMPLETED`，验证普通`/api/readiness`200并释放lock。进入`COMMIT_DECIDED`前失败可保持hooks disabled并在lock+gate内rollback；进入后只能按第10.4节roll-forward或hard stop。gate消失后允许真实业务intake，此后readiness失败按runtime incident逐ID审计，不能无条件事务回滚。

### 15.5 Business acceptance

在新的受控 claudex host session中使用唯一 marker：

1. UserPromptSubmit 建立 session；
2. 安全工具事件触发 PostToolUse；
3. 等待正常 SDK Observer写入 observation；
4. Stop enqueue summarize；
5. 等待正常 fresh SDK Summary写入；
6. 按 message/session ID核对 pending processed、usage/status、backend provenance；
7. 确认 Bypass claim delta符合 provider预期；目标 provider=claude时应为零；
8. 拒绝 `no_text`、`parse_failed`、dead-letter、restart loop和 `[salvaged]` summary；
9. 清理仅为smoke创建的临时文件/进程，不删除正常DB或历史数据。

---

## 16. Rollback 设计

### 16.1 Rollback 原则

- wrapper stdout卫生修复原则上可保留；若需恢复，使用记录的精确 preimage，不凭记忆编辑。
- 当前 native模型/认证通路已知不可用；失败后的安全 operational rollback 是**禁用hooks并停止global worker**，不是假装设置回 `claude` 就恢复服务。
- 无 DB schema migration，但错误部署仍可能改变 queue/salvage；因此“无 migration”不等于“无数据回滚”。
- native profile/cache不得被 claudex rollback触碰。

### 16.2 部署前临时 rollback set

仅在用户授权实施后创建、验收后删除：

- claudex cache live target与 staging identity；
- claudex marketplace live target；
- installed/known marketplace metadata；
- 两个 profile enabled bool；
- bootstrap/control settings中的 data-root pointer；
- canonical effective runtime settings；
- wrapper preimage/checksum；
- old worker PID/workerPath/version/hash；
- activation窗口内 pending IDs/status/retry和 summary IDs。

多个live target不能被一次rename整体原子切换；部署协议定义为**per-object atomic、transaction-level crash-consistent**：

1. 每个target parent在其自身filesystem内创建owner-only、nonce命名的managed transaction area（目录0700）；用途只限本次promotion的write-ahead state和old live preimage，commit/rollback完成即删除，不成为长期backup目录。
2. promotion前写入、flush并fsync非敏感write-ahead manifest；记录target、old/new hash、phase、mode、owner和nonce，不记录secret值。每个故障域都保留足以发现同一未完成nonce的状态，不能把唯一manifest放在会先消失的filesystem。
3. settings preimage先安全落盘并完成获批runtime settings更新；随后old live directory/file通过same-filesystem rename保留到transaction area，再逐object promotion candidate。每一步完成后fsync parent并更新phase。固定顺序为runtime settings→cache→marketplace→installed metadata→known metadata，与第15节执行模拟一致。
4. effective settings的secret preimage必须在settings所在同一故障域的owner-only area中以0600保存；内容不得进入argv、stdout、hash manifest或审计日志。
5. 新stage/activation以及任何hook auto-start/worker restart前扫描所有managed target parent。普通启动遇到未完成nonce必须拒绝；phase早于`COMMIT_DECIDED`时recovery重建双层gate并恢复last committed set；phase已是`COMMIT_DECIDED`时验证expected live set和旧PID消失，完全匹配则在decision中登记replacement epoch、启动新worker到ARMED并调用同一commit协议roll-forward，不匹配则hard stop人工处理。
6. `commitActivation`成功后各manifest标记`COMPLETED`，随后才删除old live、persistent gate遗留和transaction area。`COMMIT_DECIDED`之后不允许自动rollback；此状态代表durable commit decision，而不是已完成记录。

`/tmp`只允许放可重建的probe输出和非关键临时材料：随机tool-owned子目录、owner-only umask、目录0700、文件0600，且总量远低于Pod 40G红线。工具必须在finally与TERM/INT处理器中清理；不得在config目录留下`.bak/.old` clutter。任何未完成transaction或临时残留都必须在最终结果中报告。

### 16.3 Rollback 顺序

本节只适用于durable phase早于`COMMIT_DECIDED`；到达该phase后必须roll-forward或hard stop，禁止执行本节回滚。

1. 仍持或重新取得deployment lock，先禁用本次目标profile的hook intake并验证非目标profile状态未漂移。
2. 停止global worker并确认PID/port退出。
3. 恢复effective runtime settings的backend/provider/path/model/resume等原值，并核对bootstrap pointer仍与事务前相同。routing activation禁止修改pointer；若此前独立data migration需要回滚，按它自己的manifest恢复control settings和data placement，不能混入本事务猜测处理。
4. 恢复claudex live profile metadata与bundle；不修改未被本次事务触及的native cache/bundle。只恢复本事务实际改变的enabled bool；当前场景目标claudex恢复disabled，native仅验证仍disabled。
5. 对 activation窗口逐 ID核对 queue和 summary：
   - preflight正确时应无配置错误造成的 retry/dead-letter/salvage；
   - 若已有副作用，禁止无条件批量删库，必须按 ID和turn去重语义制定修复。
6. 当前 native不可用时保持 worker stopped、两个profile disabled。
7. 只有在旧 live workerPath、bundle hash、routing snapshot和 ACTIVE readiness都已重新验证时才允许启动旧 worker。
8. 验证 health/readiness目标状态、profile bool、queue计数和临时文件清理，记录transaction rollback complete后释放lock。

### 16.4 未来回切 native

未来原生通路恢复后：

1. 先用 native executable + actual model做 SDK smoke；
2. resume=false且无 active/in-flight时 controlled stop；
3. backend改为`claude`，恢复合法 native `CLAUDE_CODE_PATH`；
4. 从明确 native bundle启动并验证 provenance；
5. 选择要启用的 host profile；不能只改 backend。

---

## 17. 测试与验收清单

### 17.1 Focused tests

实施时根据实际文件名调整，但覆盖面不得减少：

- backend resolver/default/path/platform matrix；
- strict settings/provenance/corruption/legacy schema；
- bootstrap pointer、canonical runtime path、host/port/PID/credential ownership；
- settings canonical path与restart-required API atomic rejection；
- full routing worker-lifetime snapshot、read-only drift probe与deployment/SDK profile provenance；
- pre-listen fail-closed、CONFIG_BLOCKED gate、fenced ARMED deployment-readiness与fence-clear ACTIVE readiness语义；
- Summary claim release、全lane RUNTIME_BLOCKED且no retry/dead-letter/salvage；
- Observer/Summary shared private selection wiring与status DTO不泄密；
- Bypass deterministic config/probe矩阵、valid-state independence与blocked-state整体gate；
- resume matrix；
- hardened options regression；
- spawn arg filtering和stderr redaction；
- wrapper protocol/env hardening；
- hook fallback；
- profile resolver/path ownership；
- pure stage/no-live-side-effect、per-object atomic/crash-consistent promotion、lock/fence/restart/ACTIVE provenance；
- target-local owner-only rollback state、crash recovery与stale cleanup；
- full Bun suite；
- build/generated bundle diff。

### 17.2 Completion evidence

只有同时拿到以下实际输出，才能声称“实现完成”：

1. focused tests全部通过；
2. full tests通过，或对与本 feature无关的 baseline failure有修改前证据和明确隔离；
3. build通过；
4. code reviewer确认 JS/TS/Bash变更；
5. wrapper两种 gateway状态下 stdout纯 NDJSON；
6. exact-model SDK smoke成功；
7. pure stage未改变live状态；per-object promotion crash probe可从target-local WAL恢复；正常promotion后restart产生新PID且live workerPath/hash/routing snapshot正确；
8. maintenance fence阻止旧hook auto-start，matching nonce才能启动；fence内仅ARMED且claim delta=0，清除fence后才进入ACTIVE并使普通readiness为200；
9. 正常 OB marker可检索；
10. 正常 fresh Summary可检索，且不是 salvage；
11. pending row processed，无新增 dead-letter/restart loop；
12. bypass行为与 effective provider一致；
13. deployment profile与SDK config profile/root均符合记录；
14. native profile未被误启用/覆盖；
15. 临时快照、wrapper candidate/lock和smoke进程已清理。

本 spec 当前没有执行上述 tests/build/live acceptance，不能把计划内容写成已通过事实。

---

## 18. Rejected alternatives

| 方案 | 拒绝原因 |
|---|---|
| 把源码中的 `claude -p` 替换成 `claudex -p` | 源码没有该业务调用；会绕过 SDK stream-json/control protocol |
| 直接把 `CLAUDE_CODE_PATH` 永久改成 claudex | 无二态语义，破坏原生兼容，无法表达默认 |
| 把 `claudex` 加进 `CLAUDE_MEM_PROVIDER` | provider控制 REST bypass，混合后会让 Summary语义不清 |
| 为 claudex新增第二套 Summary adapter | wrapper已经兼容同一 SDK协议；重复实现会漂移安全选项和parser |
| 过滤stdout第一行 | banner数量和错误路径不稳定；应修复协议边界 |
| backend值非法时fallback另一后端 | 隐藏配置错误，并可能把请求发到意外认证/计费通路 |
| runtime每次spawn重读backend/model/resume/provider | 造成同一turn/session的OB、SUM、Bypass与anchor语义漂移 |
| 允许routing字段普通POST热写 | lane读取时点不同，写成功不代表当前worker一致生效 |
| per-session backend | 需要DB provenance、resume与队列迁移，超出用户要求 |
| 同时启动两个worker | PID/port/data/DB均共享，无法隔离 |
| 只检查profile enabled bool | 不能证明global worker来源 |
| 只检查version `10.5.2` | 同版本cache可被覆盖；无法证明bundle内容 |
| `restart` ACK后立刻看health 200 | 可能仍是旧worker；必须等down/new PID/path |
| 用salvage summary作为SUM成功证据 | salvage表示fresh Summary已失败且retry耗尽 |
| 在 feature 中自动把 model改成alias | executable routing不应偷偷改变质量/成本 |
| 允许任意绝对 `CLAUDE_CONFIG_DIR` | `rsync --delete`和worker执行路径会扩大到任意root/symlink target |
| 同步脚本继续默认触碰native profile | 当前目标是claudex profile，可能覆盖错误运行面 |
| stage命令默认隐式restart | 会在quiesce/configure前提前切换live worker，破坏事务顺序 |
| 只有deployment lock、没有maintenance fence | 已加载hook不读部署锁，会在health down时自动拉起旧worker |
| 把多个live target称作一次atomic switch | 多个filesystem object不能一次rename；必须per-object atomic + crash-consistent WAL |
| 用`/tmp`作为persistent live target唯一rollback依据 | Pod崩溃时manifest先丢而半promotion target可能保留 |
| 从staging workerPath直接运行 | worker/hooks会依赖临时路径，metadata与bundle可能分叉 |
| 原地编辑共享wrapper | Bash懒读取和并发新调用可能看到位移或半写内容；必须same-filesystem atomic replace |

---

## 19. 尚待用户在未来实施会话决定的事项

这些不是当前会话要回答的交互问题，但在 live activation 前不能跳过：

1. Claude-Mem data root 是否迁移到一个用户批准的 GPFS 持久目录；迁移若获批必须单列实施，不与routing cutover合并；
2. 当前 `claude-sonnet-5` exact-model探针结果，以及失败后的模型策略；
3. activation后的期望provider：保留当前`openai`并启用Bypass，还是显式改为`claude`使Bypass保持disabled；
4. 是否授权修改repo外claudex wrapper/gateway脚本；
5. 是否授权创建feature branch、commit、部署、启用profile和启动global worker；
6. Settings API的完整认证/secret-redaction是否与本feature同批实施，或以“严格loopback”为当前上线前置条件。

默认处理：没有明确授权时，只允许完善/评审本文，不实施任何写操作。

---

## 20. 实施文件清单（预期，最终以代码复核为准）

### Repository source

- `src/shared/SettingsDefaultsManager.ts`
- `src/shared/paths.ts` 或新的 strict routing settings resolver
- `src/shared/worker-utils.ts`（host/port canonical source）
- `src/shared/EnvManager.ts` 或新的 backend-aware child env builder
- `src/services/infrastructure/ProcessManager.ts`（Pod-local PID ownership）
- `src/services/worker/claude-exec.ts`
- `src/services/worker/SDKAgent.ts`
- `src/services/worker/SummaryLane.ts`
- `src/services/sqlite/PendingMessageStore.ts`（exact-ID claim release）
- `src/services/worker-service.ts`
- `src/services/server/Server.ts`及owner-only quiesce/intake control owning module
- `src/services/worker/http/routes/SettingsRoutes.ts`
- worker health/readiness/status、PrivateRoutingSelection/DTO、RoutingDriftProbe与intake/commitActivation gate owning modules
- `plugin/hooks/hooks.json`

### Deployment scripts

- `scripts/sync-to-cache.cjs`
- `scripts/sync-marketplace.cjs`
- `scripts/lib/worker-restart.cjs`
- 新的closed-profile resolver / pure staging / per-object promotion / deployment-lock / maintenance-fence / crash-recovery helper（放入现有`scripts/lib/`，不新增平行顶层目录）

### External prerequisite

- persistent claudex wrapper target
- 如实施 stderr最小化需要，shared gateway manager的 embedded-mode输出边界

### Tests

- resolver/config provenance tests
- worker blocked/readiness tests
- Summary queue preservation tests
- Observer/Summary wiring and resume tests
- settings canonical path tests
- child env/wrapper protocol tests
- profile/restart/hook fallback tests
- existing security/Summary/Bypass/full regressions

### Generated artifacts

- `plugin/scripts/*.cjs` 只由 build生成；不得手改。

---

## 21. 当前状态

- Full 级 spec review：已完成。
- 本文：已扩写为设计、风险、状态机、实施与回滚一体化草稿。
- 源码修改：未执行。
- wrapper/gateway修改：未执行。
- settings/model/data root修改：未执行。
- plugin/cache/profile/worker启停：未执行。
- tests/build/live OB/SUM：未执行。

在第 19 节事项得到未来明确授权前，本文停留在“草稿、不可部署”状态。
