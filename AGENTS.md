# dsh-instructions-policy

> **当前阶段：开发/测试**（用户未声明切换前，自由改动，不必请示；修问题从全局考虑，不必只做小修补）

## 目标

独立的 DSH 插件，给 DeepSeek Harness 的工作区指令（`AGENTS.md` / `CLAUDE.md` 等文件）加一层会话级策略：根文件可换、用户级可关、子目录遍历可关，且不复制任何预设文件。

- 用户文档：[README.md](README.md)；设计取舍：[DESIGN.md](DESIGN.md)
- 上游DSH官方源码参考：`.tmp/deepseek-harness/`

## 硬约束

- **零运行时依赖**：`tsc` 产出 `lib/`（提交进仓库，link/GitHub 安装免构建），`client.js` 手写；不引入打包器。
- **不复制预设**：只在导入缝替换，官方预设照常升级。
- **客户端模块格式固定**：`window.__ModuleLoader__.load({ id, factory })`；无 JSX / CSS Modules，样式只用 `@deepseek-ai/dsh-client-ui-primitives` 和 `--dsw-*` token。
- **改 `client.js` 必须 bump `package.json` version**，再重启 `dsh web` + 浏览器硬刷新——客户端模块按版本缓存，三者缺一不可。
- **模型可见 ⟺ 会话日志**：策略只回放 `command/run` + `command/done`；禁止私有 `plugin:` 事件。
- **客户端状态来自投影**：chip 的策略、锁定、最近命令结果、项目根、已加载文件全部来自 host 的 `instructionsPolicy` 投影。
- **跨插件不 import 值**：复用能力走 Cordis 服务（`fileUpload`、`remote.*`、`attachments`、只读的 `configEditor`）和 slot。
- **失败语义**：配置错误在 apply 时 fail loud；运行期 `compose` 异常 warn + 跳过本次注入；导入/读取校验失败返回明确错误。

## 关键文件
- `src/index.ts` — host 行：导入缝、官方模块捕获、facade、自检
- `src/loader.ts` — 命令、pre-step、tools/result、compose、附件导入
- `src/policy.ts` — 从命令事件回放策略
- `src/discovery.ts` — 项目根、目录链、候选读取、附件读取
- `src/render.ts` — 官方 renderer 优先 + 内置回退；预算/截断/移除
- `src/state.ts` — 可见指令的日志折叠（增量 + compaction 重建）
- `src/projection.ts` — `instructionsPolicy` 投影（chip 唯一状态源）
- `src/i18n.ts` — `/instructions` 结果的 zh/en 文案 + `auto` 语言解析
- `client.js` — chip、策略菜单、文件浏览器、本机上传
- `cordis.patch.yml` — host 行 + 默认配置

## 根文件语义
`root` 指**项目根**（`.git` 所在目录），不是 cwd；baseline 始终是"项目根 → cwd"整条链，`off` 只跳过链顶端。

## 已知坑点

1. **`loader.internal` 会被别人整体赋值**：必须用访问器，赋值时重新包一层；捕获官方模块必须走原始 import。
2. **可见状态只能从日志折叠**：不要另存 `loaded` 账本，compaction 后私有账本会让模型丢了指令却不补发；游标遇 `replaceGeneration` 变化必须清零重扫。
3. **只有真正渲染进文本的才算"已加载"**：`changes` 只能用 renderer 返回的 `included` / `changes` / `removed`；`includedBytes === 0` 也算没加载；`/instructions show` 同样走渲染结果（nested 从可见日志补）。
4. **首步空 entering batch 是 no-step turn**：`step === 1` 且 `messages` 为空时不要注入 baseline，否则会把不发生的 turn 变成一次模型请求；只有 `step > 1` 才补 compose。
5. **nested 预算丢弃 / compaction 恢复与官方 loader 一致**：只记录实际渲染的条目，不提前记账、不自动重试；只有 nested 从关到开时用 `knownDirs` 重查已触碰目录。
6. **任何策略变更都必须能从命令参数回放**：附件引用要编码进 `attach` 的 args，name token 带 `uri:` 前缀（命令按空白切分）。新增命令先问"只有 args 能不能重建"。
7. **host command 必须声明 `input.hint`**：否则 DSH 当作 bare command，参数进不了 composer；改命令语法时同步 hint。
8. **命令写入走 `remote.commands.execute`**：它返回 `CommandExecution`（含 `commandId` 和 `result.kind/text`）；`Session.command` 只返回 `matched`，会丢 host 错误；无 sessionId 时保留 pending intent。
9. **投影注册在 host 行**：`src/index.ts` 的 inject 必须含 `sessionProjections`；改 state 字段或 fold 语义时 bump `stateVersion`；schema 用窄适配器，运行时只调 `parse`。
10. **移动仓库目录后要重指 profile 链接**：`node_modules` 里的链接和 `package.json` 的 `link:` 都是绝对路径，只改一处会让 host 半还能跑、Web 半静默消失。
11. **DSH 按行整行替换 `config`，不做深合并**：在 profile 里覆盖本行时要重述所有需要的字段（`maxBytes`、完整的 `policy`）。

## 命令

```sh
npm run build      # tsc + 复制 client.js
npm run typecheck
npm test           # 进程内 node:test；不要用 node --test tests（会 spawn，沙箱报 EPERM）
```

## 验收

- 提交前至少 `npm run build && npm test`；PR 由 `.github/workflows/ci.yml` 跑 build、`lib/` 新鲜度检查和测试。新增行为补对应测试。
- 四层测试：`policy.test.mjs`（加载器全链路）、`projection.test.mjs`（投影 fold/缓存/预设默认值）、`client.test.mjs`（vm + 假 React 渲染 chip）、`contract.test.mjs`（对本机安装的 DSH 跑真实契约，找不到自动 skip）。
- 用户的手工验收在本地 `instructions-fixture` 目录（根目录和 `sub` 都会跑）。

## 执行规则

1. 用户用疑问句时先回答，不要直接动手。
2. 小步提交，build/test 通过再提交。
3. 行为边界以本 DSH 源码为例；能复用运行版本能力（renderer、fileUpload、attachments）就不重写。
