# 会话指令状态验收说明

这个文件用来验收 `dsh-instructions-policy` 是否按预期改变了会话里的 AGENTS.md 内容。
**测试会话的 AI 不需要、也不应该阅读插件源码。**

## 前提

- 新建一个任务（不要用历史会话），工作区选 `instructions-fixture/sub`。
- 本文提示词中的相对路径都以该工作区为基准；换机器或换目录时不需要改路径。
- 推荐流程：先定策略（chip 或 `/instructions`），再发下面这段提示词。
- 确认插件和 DSH 版本：`dsh --version`，以及 profile 里 `dsh-instructions-policy` 的版本。
- 不要同时挂其他会加载工作区指令的插件；一个会话只测一套 loader。

### 用户级指令（只检查，不修改）

A–D/F 场景假设用户级指令不存在。先检查，不要用本夹具去创建、备份或删除它们：

```powershell
Test-Path $HOME\.dsh\AGENTS.md
Test-Path $HOME\.agents\AGENTS.md
```

```sh
ls ~/.dsh/AGENTS.md ~/.agents/AGENTS.md 2>/dev/null
```

若存在，A–D/F 都会多出一段 `GLOBAL_MARKER_999`，`--expect` 的可见集合会因此不匹配；
可以接受这个差异并跳过自动断言，或只在 E 场景使用它。
**E 场景仅用于维护者本地验证，安装者可跳过**；本夹具不提供创建/备份/删除用户级文件的命令，
也不要求安装者准备它。

### 标记对照

| 文件 | 标记 |
|---|---|
| `AGENTS.md` | `ROOT_MARKER_111` |
| `CLAUDE.md` | `CLAUDE_MARKER_555` |
| `CUSTOM_ROOT.md` | `CUSTOM_MARKER_444` |
| `sub/AGENTS.md` | `SUB_MARKER_222` |
| `sub/CLAUDE.md` | 同 `SUB_MARKER_222`（去重用例，正常不应单独出现） |
| `sub/deep/AGENTS.md` | `DEEP_MARKER_333` |
| `sub/advanced/local/AGENTS.md` | `LOCAL_AGENTS_MARKER_666` |
| `sub/advanced/local/AGENTS.local.md` | `LOCAL_OVERLAY_MARKER_667` |
| `sub/advanced/escape/AGENTS.md` | `ESCAPE_MARKER_777` |

## 给测试会话 AI 的提示词（整段复制）

```text
本场景：<A/B/C/D/E/F 之一>

你在验收 DSH 的“工作区指令策略”。不要阅读 dsh-instructions-policy 的插件源码，不要修改任何文件，也不要提前结束本轮；读完文件后继续下一步。

路径约定：第 2、3 步的相对路径都以本任务工作区（instructions-fixture/sub）为基准。如果工具不接受相对路径，先用 pwd / Get-Location 取得工作区绝对路径再拼接，不要猜测。

1) 先不要调用文件工具。把你当前上下文里所有以 <system-reminder> 开头、含 “Instructions from:” 或 “Additional instructions from:” 的段落，按出现顺序原样摘出：路径，以及该段落正文里的标记（ROOT_MARKER_111 等）。没有就写“无”。

2) 读取本任务工作区（instructions-fixture/sub）下的相对路径：deep/note.txt
   读完后继续本轮（不要结束回答），再按第 1 步的格式列出**新增**的段落。

3) 在任务工作区运行：node ../verify-state.mjs --expect <A/B/C/D/E/F 之一>
   （把尖括号换成实际场景字母）把 baseline、visible instruction files、not on current surface、last batch markers 原样贴出，并原样引用 baseline 里的 "policy" 对象。

4) 输出表格：
| 标记 | 本场景期望 | 第 1 步可见 | 第 2 步新增 | 日志 visible | 结论 |
最后给一行结论 JSON：
{"scenario":"A","baseline_policy":{...},"active":["..."],"after_touch":["..."],"pass":true}

规则：可见性只依据你实际看到的 <system-reminder>，不要推测；结论只写“通过”或“不通过”，不通过时一句话说明差异。
```

## 期望矩阵

场景在第一步之前确定（chip 或 `/instructions`），然后按同一场景验收。
“第一轮 baseline”指发第一条消息后、尚未读取 `deep/note.txt` 时可见的文件。

| 场景 | 策略 | 第一轮 baseline | 读 `deep/note.txt` 后 | 不应出现 |
|---|---|---|---|---|
| A 默认 | root 默认，global 开，nested 开 | ROOT (111) + CLAUDE (555) + SUB (222) | 追加 DEEP (333) | — |
| B 根关闭 | root off | SUB (222) | 追加 DEEP (333) | ROOT、CLAUDE |
| C 自定义根 | 用 `/instructions root custom CUSTOM_ROOT.md` 选 custom（不要用文件选择器，否则 `policy.file` 是绝对路径或附件引用） | CUSTOM (444) + SUB (222) | 追加 DEEP (333) | ROOT、CLAUDE |
| D 不遍历 | root 默认，nested off | ROOT (111) + CLAUDE (555) + SUB (222) | 不变（无 DEEP） | DEEP |
| E 用户级关（仅维护者） | global off | 与 A 相同，但没有用户级段 | 追加 DEEP (333) | `GLOBAL_MARKER_999` |
| F 首轮前预选 | 新任务界面先选 root off，再发第一条消息 | SUB (222) | 追加 DEEP (333) | ROOT、CLAUDE |

> `sub/AGENTS.md` 属于 baseline（工作区就是 `sub`），不是 nested；nested 开关只影响更深的目录（如 `sub/deep`）。
>
> `--expect` 按“读完 `deep/note.txt` 之后”的最终状态断言。F 与 B 的最终状态相同，
> 区别在“第一条消息前预选”，靠 chip 的“任务开始时应用”人工确认。

## 高级场景（G–I，可选）

| 场景 | 操作 | 期望 |
|---|---|---|
| G 去重 | 任意核心场景 | `visible` 不出现 `sub/CLAUDE.md`（它与 `sub/AGENTS.md` 同内容） |
| H 本地候选 | 在任务工作区读取 `advanced/local/note.txt` | `visible` 增加 `sub/advanced/local/AGENTS.md` 与 `AGENTS.local.md`，标记 666 / 667 |
| I 转义 | 在任务工作区读取 `advanced/escape/note.txt` | 最后一批出现 `ESCAPE_MARKER_777`，且原文的 `</system-reminder>` 显示为转义形式，frame 不提前结束 |

H/I 是在核心场景之后追加的 nested 批次。可以用：

```sh
node ../verify-state.mjs --json
```

查看 `visible`、`lastMarkers` 和 `lastText`；`lastText` 里应能看到 `ESCAPE_MARKER_777`，
且不会出现未转义的 frame 结束标签。

## 客观核对脚本

`verify-state.mjs` 会找当前工作区对应的最新会话 JSONL，按 `surfaceOp` 重放模型当前可见的
surface，再折叠 `agent-instructions` 消息的 changes，输出：

- `session` / `cwd`：读的是哪个会话
- `baseline`：最近一个可见 baseline 的 identity，里面带 `policy`（root/file/global）
- `visible instruction files`：当前仍可见的指令文件
- `not on current surface`：日志里出现过、但已被 compaction 等操作移出 surface 的文件
- `removed`：被明确移除过的路径
- `last batch markers`：最后一条指令消息里出现的标记

脚本支持：

```text
node ../verify-state.mjs                     # 当前工作区最新会话
node ../verify-state.mjs --expect A          # 断言场景 A（不匹配 exit 2）
node ../verify-state.mjs --json              # 机器可读结果
node ../verify-state.mjs --list              # 列出最近会话及其 cwd
node ../verify-state.mjs --session <file>    # 指定会话文件
node ../verify-state.mjs --any               # 忽略 cwd，取最新会话
```

`--expect` 对 A–F 检查 `policy`（root/file/global）、`visible` 文件集合和禁止标记。
它不修改任何东西，也不读取插件源码。会话日志位置遵循 `DSH_HOME`，未设置时用 `~/.dsh`。

## 常见偏差

- **历史会话**永远显示旧状态：策略只对创建之后的新任务生效。
- **上下文里看不到标记，但日志 visible 有**：说明消息被压缩或预算截断，换新任务重测。
- **日志 visible 为空、上下文却有旧标记**：你读的是旧会话文件；用 `--list` 确认 cwd 和修改时间。
- **chip 显示“会话未连接”**：blank 会话还没物化，属于暂存路径，第一条消息发出后再看。
- **`--expect` 报 missing `sub/deep/AGENTS.md`**：第 2 步没读 `deep/note.txt`，或 nested 已关闭。
- **A 场景多了 `GLOBAL_MARKER_999`**：用户级文件存在；本夹具不会删它，接受差异或改用 E 场景。
