# CONTEXT — 领域术语表（glossary）

> 本文件只放项目专属领域术语,一词一两句,opinionated。不放实现细节、spec 或随手笔记。

## Transport

一次记忆处理请求走的线路 + 代码路径,是 `CLAUDE_MEM_PROVIDER` 的取值,**闭集只有两个**:`claude`(主 Agent SDK 通道)、`openai`(任意 OpenAI 兼容 `/chat/completions`,唯一旁路)。新增 OpenAI 兼容服务**不新增 transport**,只是换 `openai` 这条路的 base URL。

- _Avoid_: 用 "provider" 指代码路径(provider 是身份,transport 是线路);把具体厂商名(deepseek/opencode)当成 transport——它们都归 `openai`;`gemini`、`opencode`、`openrouter`(均为已移除的旧 transport,不再是闭集成员)。

## Bypass provider

非 Claude 的旁路 lane(唯一 transport 为 `openai`),用直连 REST 处理 observation,与主 Claude SDK 通道**竞争消费**同一队列。其**身份一律从配置的 `baseUrl` host 自动派生**(如 `api.deepseek.com`),没有独立的显示名字段——用户连哪个 host 就是哪个,避免自定义 endpoint 命名乱套。

- _Avoid_: `fallback`(它是竞争消费者,不是兜底);为它单设 `displayName` / 厂商枚举 / 预置 catalog(均已否决)。
