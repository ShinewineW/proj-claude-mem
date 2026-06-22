## 背景

这个项目已经不再是一个临时 fork。它现在有自己的产品方向：

- per-project SQLite 数据库隔离
- per-project opt-in 白名单机制
- 对上游修复的选择性移植
- 和上游 `claude-mem` 不完全一致的 worker / runtime / 部署策略

继续沿用原插件身份会造成混乱。当前仍然残留这些旧身份：

- 插件 key：`claude-mem@thedotmack`
- marketplace namespace：`thedotmack`
- cache 路径：`~/.claude/plugins/cache/thedotmack/claude-mem/<version>`
- runtime package version：当前为 `10.5.2`
- 多处 docs、skills、hooks、sync scripts 仍然使用 `claude-mem`
- 根目录 `.claude-plugin/plugin.json` 版本还停在 `10.4.1`，已经和构建后的插件 metadata 不一致

本次目标是让这个项目成为一个真正独立的插件：拥有自己的名字、身份、版本线和分发模式。

## 主要目标

0. 第一条铁律：修订后的版本，应当能无缝兼容之前保存的数据库，向量库等数据，不能导致数据损毁，无法读取的情况。修订后的版本，应当能无缝兼容之前保存的数据库，向量库等数据，不能导致数据损毁，无法读取的情况。修订后的版本，应当能无缝兼容之前保存的数据库，向量库等数据，不能导致数据损毁，无法读取的情况。

1. 插件身份脱离 `claude-mem`。

   公开插件名、Claude Code plugin key、package name、marketplace metadata、cache path、文档和用户可见文字，都不应继续把本 fork 表现成 `claude-mem`。

2. 引入独立的 marketplace namespace。

   不再使用 `thedotmack` 作为本 fork 的 marketplace namespace。新的 namespace 需要足够稳定，能同时支持本地 Mac 安装、受控 pod 安装，以及未来公开插件市场发现。

3. 建立独立的 fork 版本线。

   `/api/version`、plugin manifests、生成的 `plugin/package.json`、install marker、marketplace metadata、cache 目录都应使用本 fork 自己的 semver 版本。除非本 fork 真的变成上游完整 `13.4.0` 等价版本，否则不应直接使用上游 `13.4.0` 作为 runtime version。

4. 不再把 GitHub 当作用户侧分发入口。

   GitHub 可以继续作为开发源码仓库和 provenance 记录来源，但用户安装路径应转向插件市场。公开 marketplace 安装优先考虑 npm package source，而不是 GitHub source。

5. 保留现有记忆数据。

   每个项目的 `<repo>/.claude/mem.db` 不应因为插件改名而迁移、重命名或删除。这个名字是可以保留的

6. 防止旧插件和新插件同时运行。

   迁移时必须禁用或干净地覆盖 `claude-mem@thedotmack`，再启用新插件 key，避免两个 hook 或两个 worker 同时处理同一批 session。也就是说这里意味着，修改完成后，需要完全卸载目前的版本，然后重新从新的渠道安装完全独立的版本来进行测试。

8. 保持 runtime health / version 检查有效。

   build-and-sync 后，worker `/api/version`、已安装插件 metadata、`installed_plugins.json`、cache `package.json`、marketplace plugin metadata 应保持一致。现有 version mismatch auto-restart 机制仍应可用。即这里意味着全新插件的版本控制应当还是有用的。

9. 更新所有本地安装和同步工具。

   `sync-to-cache.cjs`、`sync-marketplace.cjs`、smart install helpers、hook fallback path、marketplace 注册、known marketplace 注册、enabled plugin 注册，都必须使用新身份。

10. 更新用户可见的 skills 和文档(注意这里是这个仓库的所有文档)。

    Slash-skill 文档、README、CLAUDE.md、plugin README、安装/卸载说明、排障文本、marketplace 描述，都应使用新的插件身份。同时保留对原上游项目的 provenance 说明。

## 分发目标

1. 公开插件市场用户不需要从 GitHub 安装。

2. marketplace metadata 优先采用 npm package source。GitHub repo 只作为开发源码和 provenance 来源，而不是主要安装通道。

3. npm package 内容需要包含 Claude Code 插件运行所需的 built `plugin/` payload，包括：

   - hooks
   - skills
   - scripts
   - MCP metadata
   - UI bundle
   - runtime package metadata

4. 保留本地 Mac 开发路径。

   `npm run build-and-sync` 仍应作为本地测试、插件 cache 同步、受控 pod 部署准备的可用命令。

## 兼容目标

1. 保持 per-project `.claude/mem.db` 可读，且不移动。

2. 第一阶段身份迁移中，现有 settings 和 credentials 应继续可用。

3. 对旧安装条目给出明确处理：

   - `installed_plugins.json`
   - `known_marketplaces.json`
   - `settings.json` 的 `enabledPlugins`
   - 旧 cache 目录
   - 旧 marketplace 目录

4. 避免误删用户数据。

   只有在新插件已经安装、启用、重启并通过 health check 后，才可以清理旧插件安装 payload。数据目录不属于本次清理范围。

## 命名目标

1. 新名字应体现 per-project memory，而不是沿用原上游品牌。

2. 新名字不应暗示这是官方上游 `claude-mem`。

3. 新名字应尽量短、可搜索、适合公开插件市场发布。

4. 候选名：

   - `project-memory`
   - `repo-memory`
   - `context-vault`
   - `memscope`
   - `work-memory`

## 非目标

1. 不宣称本 fork 是 upstream `claude-mem@13.4.0`。

2. 不改写历史 provenance。文档需要继续说明本项目派生自 upstream `claude-mem`，并且已经选择性 backport 到当前审计水位。

3. 本阶段不迁移 per-project memory databases。

4. 除非后续任务明确改变受控网络策略，否则不允许受控 pod 访问 GitHub、npm 或公开 marketplace。

5. 增加公开 marketplace 分发后，也不移除本地开发/部署 workflow。

## 验收标准

1. 本地 fresh build 后，注册的是新 plugin key，而不是 `claude-mem@thedotmack`。

2. 生成的 cache path 使用新的 namespace、新插件名和新版本。

3. build-and-sync 后：

   - `installed_plugins.json`
   - `known_marketplaces.json`
   - `settings.json`

   都指向新身份。

4. 旧 plugin key 被禁用或从 active registration 中移除，避免重复 hook。

5. `/api/version` 返回新的 fork version。

6. 本地 build-and-sync 后，worker health 和 readiness 检查通过。

7. 同一份 source 可以通过 Mac 投递到受控 pod，并在 pod 上 rebuild / restart；pod 不访问 GitHub。

8. 插件仍然读写同一批 per-project `.claude/mem.db`。

9. docs 和 skills 不再指导用户安装或检查 `claude-mem@thedotmack`。

10. marketplace metadata 已准备好走 npm-backed public distribution path。
