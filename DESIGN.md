# 设计说明

> 记录已落地的架构决定与取舍；改这些决定前先读这里。

## 总览

- **替换点**：Loader 的模块导入缝，不改任何预设。
- **模型可见状态**：全部从会话日志折叠，没有私有账本。
- **chip 状态**：host 的 `instructionsPolicy` session projection。

## 挂载：为什么走导入缝

上游把 `agent-instructions` 的 host 行设为 `disabled`，由每个预设在自己的 `config.plugins` 里各挂一份。改预设意味着复制整份 `config.plugins`，DSH 一升级就漂移。

- 只包 `ctx.loader.internal.import`：命中 `@deepseek-ai/dsh-agent-instructions` 就换成 `lib/loader.js`，其余原样转发。
- host 行 `config` 是策略默认值的稳定住处；被替换行的 `config` 与之合并（普通字段预设行优先，`policy` 按字段合并）。
- 代价：`loader.internal` 不是文档化 API。用访问器防止整体赋值，双层自检（apply 扫预设行、首步看是否命中）；没命中就 warn 并退回官方行为。
- `engines.dsh` 只拦大版本：本项目依赖官方机制实现，官方没有大改前，次要升级放行比拦在门外更划算。

## 策略模型

| 字段 | 作用域 | 生效方式 |
|---|---|---|
| `root` / `file` / `global` | 会话开始 | 进 `baselineIdentity`；变化时整段重渲染 |
| `nested` | 会话中 | 不进 identity；只影响下一次 reconcile 的增删 |

- 策略不是自定义事件，而是回放已声明的 `command/run` + `command/done`：resume、fork、compaction 共用一条路径，日志里不出现私有事件。
- 出现 `turn/start` 或 `step/start` 后 root/file/global 锁定；nested 始终可切，下一步生效。
- `nested: false` 时对已加载的子目录 scope 发 `Instructions removed:`；重新打开时用 `knownDirs` 重查已触碰目录。
- 目录发现只跟随 `read` / `write` / `edit` 的 `file_path`；shell 的 `cd` 或列目录不算触碰（与官方一致）。

## 每步对账

- 可见状态 = `surface.nodes` 中 `agent-instructions` 消息的折叠结果；identity 一致不重发，不一致整段重渲染并补 `remove`。
- `surface.replaceGeneration` 变化（compaction）→ 折叠清零重扫；没有该字段时退化为“已折叠序列仍是 surface 前缀”的判定。
- compaction 后 baseline 下一步补发；nested 与官方一致，要等目录再次被触碰。
- 首步空 entering batch 是 no-step turn：不注入 baseline，避免把不发生的 turn 变成一次请求；`step > 1` 的空 batch 才补 compose。
- 每条消息的 `source` 带 `policy` 快照，作为对账依据。

## Web 端

- 状态在 host：`instructionsPolicy` 投影 fold 命令结果、锁定、指令消息（含项目根、已加载文件与 policy 快照）和成功的 compaction。
- 初始 policy 按 `header.agentPreset` 查 `loader.entries()` 里预设行的 instruction config，找不到回退 host 行。
- chip 只读投影（`useProjection`）；命令走 `remote.commands.execute`——`Session.command` 只返回 `matched`，会吞 host 错误。无 `sessionId` 时保留 pending intent，错误可从投影 `lastCommand` 恢复。
- 投影 schema 只实现 `parse`，零依赖用窄适配器；`contract.test.mjs` 对真实 registry 验证。
- UI：chip 在 `conversation.input.left`；自定义根可用工作区浏览器或本机文件，导入的附件不复制进工作区。

## 手工验收夹具与 Release asset

- 夹具源提交在 `fixtures/instructions/`，候选文件用 `*.template` 后缀：**该目录内**不能出现真名 `AGENTS.md` / `CLAUDE.md`，否则开发会话的 nested discovery 会注入测试标记；父级 `fixtures/AGENTS.md` 是刻意的目录说明，不进入 stage。
- 运行副本由 `scripts/fixture.mjs` 生成到 `.tmp/instructions-fixture`，并写入 `.git/HEAD`。Git 不能提交 `.git`；没有它，项目根会向上落到插件仓库，baseline 会读错。
- 同一 stage 产物在 CI 打成 `instructions-fixture.zip`，作为 GitHub Release asset 发布；`package.json.files` 白名单不含 `fixtures/`、`dist/`，npm 包不受影响。
- 夹具只读会话日志；不创建、不备份、不修改用户级 `AGENTS.md`（用户级测试涉及重要文件，仅由维护者自行本地测试）。

## 已否决的方案

- **项目级插件**：DSH 没有按目录加载组合的机制；项目目录只贡献内容。
- **自定义 `instructions-policy/selected` 会话事件**：会往日志里塞私有事件；改用已声明的命令生命周期。
- **包装 `ctx.fs`**：路径寻址、拿不到 session，还要重写整个 provider。
- **客户端折叠事件窗口 + 乐观 `draft`**：窗口会被分页/compaction 裁剪，命令又拿不到 handler 错误，chip 会长期显示 host 没接受的策略。
- **事后改写上游消息**：上游按 payload 对账，改写会导致每步重注入。
- **fork 全量上游**：约 2100 行，升级即漂移；本实现只重写发现与状态层。

## 兼容性

- `source.kind` 固定 `agent-instructions`；`changes` 为 `{ action, scope, path, digest? }`，另带 `policy` 快照；resume 和卡片依赖它。
- `changes` 只记录真正进入文本的文件；预算丢弃的条目不记账，等下次触碰。
- `baselineIdentity` 含 cwd、markers、候选名、策略三字段、两个预算；不含 nested。
- 指令内容里的 `</system-reminder>` 一律转义，仓库文本不能截断插件自己的 frame。
- 内置回退按整条消息算 `maxBytes`；官方 renderer 可用时完全以它为准（两链各一份，合并帧最多 2×）。
- 回退的降级顺序：先试整批 → 逐份丢最宽泛（`omitted`）→ 截断最具体 → 放弃；baseline 与 nested 共用。
- 配置覆盖是**整行替换**，不做深合并。
- `root` 指项目根；`off` 只跳过顶端；相对自定义路径先 cwd 后项目根；同路径只渲染一次。
- 导入的根文件是附件引用，发现阶段从附件库读，不落盘、不需要写权限。

## 运行时硬化

- `loader.internal` 访问器；compose 异常隔离 + 同 session 串行；`maxBytes: 0` 禁用；自定义根越界拒绝并给出项目根提示。
