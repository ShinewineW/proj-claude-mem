# CONTEXT — 领域术语表（glossary）

> 本文件只放项目专属领域术语,一词一两句,opinionated。不放实现细节、spec 或随手笔记。

## Engram

本插件的 canonical 产品名(2026-06-09 定)。取神经科学义:记忆在介质上留下的物理印痕——恰是本系统所做:把每次会话的 observation 压缩、刻存为可被唤回的记忆痕迹。

- **Tagline**(承载 per-project 语义,命名目标1 由此兜住):`Engram — per-project memory for Claude Code`
- **派生命名**(待 Q2 定):plugin key、marketplace namespace、npm 包名、cache 路径均从此名派生。
- _Avoid_: `claude-mem`(上游品牌,本 fork 不再以此自称)、`repo-memory` / `project-memory`(功能直白但通用、易撞名,已否决)、`codex`(本工作区 Codex CLI 占用,撞名)。

## Transport

一次记忆处理请求走的线路 + 代码路径,是 `CLAUDE_MEM_PROVIDER` 的取值,**闭集只有两个**:`claude`(主 Agent SDK 通道)、`openai`(任意 OpenAI 兼容 `/chat/completions`,唯一旁路)。新增 OpenAI 兼容服务**不新增 transport**,只是换 `openai` 这条路的 base URL。

- _Avoid_: 用 "provider" 指代码路径(provider 是身份,transport 是线路);把具体厂商名(deepseek/opencode)当成 transport——它们都归 `openai`;`gemini`、`opencode`、`openrouter`(均为已移除的旧 transport,不再是闭集成员)。

## Bypass provider

非 Claude 的旁路 lane(`gemini` 或 `openai` transport),用直连 REST 处理 observation,与主 Claude SDK 通道**竞争消费**同一队列。其**身份一律从配置的 `baseUrl` host 自动派生**(如 `api.deepseek.com`),没有独立的显示名字段——用户连哪个 host 就是哪个,避免自定义 endpoint 命名乱套。

- _Avoid_: `fallback`(它是竞争消费者,不是兜底);为它单设 `displayName` / 厂商枚举 / 预置 catalog(均已否决)。
