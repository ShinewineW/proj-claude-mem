# README Translator

> **创建日期**: 2026-04-12
> **更新日期**: 2026-06-06
> **状态**: 维护（已接入 `package.json` 的 `translate:*` 脚本；非高频运行）
> **范围**: 用 Claude Agent SDK 把 `README.md` 翻译成多语言
> **适用环境**: Bun（仓库内运行）；需 Claude Code 已登录 或 `ANTHROPIC_API_KEY`

---

## 1. 概述

一个用 Claude Agent SDK 翻译 Markdown 文档的小工具，**vendored 在本仓库内**（不是从 npm 安装的外部包）。在 proj-claude-mem 里，它的产物用于生成 README 的多语言版本到 `docs/i18n/`。

> ⚠️ 下文的 `npm install readme-translator` 是上游作为**独立 npm 包**发布时的说法；在本仓库中应通过 `bun scripts/translate-readme/cli.ts` 运行。**许可证按本仓库整体的 AGPL-3.0 判定**（不适用独立包的 MIT 声明）。
>
> 截至 2026-06-06，`docs/i18n/` 尚未生成/提交，即翻译尚未实际跑出产物。

## 2. 文件清单

- `cli.ts`
  - 性质：CLI 入口
  - 作用：解析命令行参数（语言、`-o/-p/-m/--max-budget/-v/--list-languages` 等），调用 `index.ts` 的 `translateReadme()`。
  - 主 caller / 入口：`bun scripts/translate-readme/cli.ts`；`package.json` 的 `translate-readme` / `translate:tier1..4` / `translate:all` 脚本。

- `index.ts`
  - 性质：库（公共 API）
  - 作用：导出 `translateReadme(options)`、`SUPPORTED_LANGUAGES`、以及 `TranslationOptions` / `TranslationResult` / `TranslationJobResult` 类型。
  - 主 caller / 入口：`cli.ts`、以及任何 `import { translateReadme } from "./index"` 的脚本。

- `examples.ts`
  - 性质：示例
  - 作用：编程式调用 `translateReadme()` 的用法示例。

- `README.md`
  - 性质：doc — 本工具的 API 参考与仓库内用法。

## 3. 在本仓库中如何使用

```bash
# 直接跑 CLI（仓库内的真实入口）
bun scripts/translate-readme/cli.ts -v -o docs/i18n README.md zh ja fr

# 列出支持的语言码
bun scripts/translate-readme/cli.ts --list-languages

# 经 npm 脚本分层翻译（输出到 docs/i18n/）
bun run translate-readme        # = cli.ts -v -o docs/i18n README.md
bun run translate:tier1         # zh zh-tw ja pt-br ko es de fr
bun run translate:tier2 / tier3 / tier4
bun run translate:all           # 四层并行
```

### CLI 选项

| 选项 | 说明 |
|--------|-------------|
| `-o, --output <dir>` | 输出目录（默认与源文件同目录） |
| `-p, --pattern <pat>` | 输出文件名模式（默认 `README.{lang}.md`） |
| `--no-preserve-code` | 连代码块也翻译（不推荐） |
| `-m, --model <model>` | Claude 模型（默认 `sonnet`） |
| `--max-budget <usd>` | 最大预算（USD） |
| `--use-existing` | 用已存在的翻译文件作参考 |
| `-v, --verbose` | 详细进度 |
| `--list-languages` | 列出所有语言码 |

### 编程式 API

```typescript
import { translateReadme } from "./index";

const result = await translateReadme({
  source: "./README.md",
  languages: ["zh", "ja", "fr"],
  outputDir: "./docs/i18n",
  maxBudgetUsd: 5.0,
  verbose: true,
});
console.log(`Translated ${result.successful} files, $${result.totalCostUsd.toFixed(4)}`);
```

`TranslationOptions` 字段：`source`、`languages`、`outputDir?`、`pattern?`（默认 `README.{lang}.md`）、`preserveCode?`（默认 `true`）、`model?`（默认 `sonnet`）、`maxBudgetUsd?`、`useExisting?`、`verbose?`。

支持的语言码以代码为准——用 `--list-languages` 或读 `index.ts` 的 `SUPPORTED_LANGUAGES`（`package.json` 的 `translate:tier1..4` 划分了优先级分层）。

## 4. 关键约束 / 已知坑

- **认证**：本机有 Claude Code 已登录即可（无需 API key）；CI 环境需 `ANTHROPIC_API_KEY`（或 Bedrock / Vertex 凭证）。
- **预算**：用 `--max-budget` / `maxBudgetUsd` 防止跑量超支。
- **保留代码块**：默认 `preserveCode: true`，避免破坏代码示例。
- 自动翻译非完美，关键文档建议人工复核。

## 5. Cross-Ref

- 根 [`README.md`](../../README.md) — 翻译的源文档。
- [`scripts/CLAUDE.md`](../CLAUDE.md) — scripts/ 目录总导航。
