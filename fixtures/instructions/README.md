# instructions-fixture

`dsh-instructions-policy` 的可选手工验收夹具。它只用来观察插件是否按策略改变模型看到的指令，
不属于插件运行时，也不会随 npm 包安装。

## 快速开始

1. 从 Release 下载 `instructions-fixture.zip` 和同页的 `.sha256`，校验后解压：

   ```powershell
   # 校验（Windows PowerShell），应输出 True
   $expected = (Get-Content .\instructions-fixture.zip.sha256) -split '\s+' | Select-Object -First 1
   $actual = (Get-FileHash .\instructions-fixture.zip -Algorithm SHA256).Hash.ToLower()
   $actual -eq $expected.ToLower()
   # 解压（不要删掉解压目录里的 .git）
   Expand-Archive .\instructions-fixture.zip -DestinationPath .
   ```

   ```sh
   # 校验并解压（macOS / Linux）
   shasum -a 256 -c instructions-fixture.zip.sha256   # macOS
   sha256sum -c instructions-fixture.zip.sha256       # Linux
   unzip instructions-fixture.zip
   ```

2. 打开 `dsh web`，新建任务（不要用历史会话），工作区选 `instructions-fixture/sub`
   （Windows 用 `instructions-fixture\sub`）。
3. 按 [VERIFY.md](VERIFY.md) 的 A–F 场景操作。
4. 想在命令行客观核对时，在任务工作区运行：

   ```sh
   node ../verify-state.mjs --expect A
   ```

   把 `A` 换成当前场景字母。脚本只读会话日志，不修改任何文件。

## 文件与标记

| 文件 | 标记 | 用途 |
|---|---|---|
| `AGENTS.md` | `ROOT_MARKER_111` | 项目根指令 |
| `CLAUDE.md` | `CLAUDE_MARKER_555` | 项目根第二候选 |
| `CUSTOM_ROOT.md` | `CUSTOM_MARKER_444` | 自定义根文件 |
| `sub/AGENTS.md` | `SUB_MARKER_222` | 工作区所在目录 |
| `sub/CLAUDE.md` | 同 `SUB_MARKER_222` | 与 `sub/AGENTS.md` 同内容，验证去重 |
| `sub/deep/AGENTS.md` | `DEEP_MARKER_333` | 读取 `deep/note.txt` 后追加 |
| `sub/advanced/local/AGENTS.md` | `LOCAL_AGENTS_MARKER_666` | 高级：本地候选 |
| `sub/advanced/local/AGENTS.local.md` | `LOCAL_OVERLAY_MARKER_667` | 高级：本地覆盖 |
| `sub/advanced/escape/AGENTS.md` | `ESCAPE_MARKER_777` | 高级：`</system-reminder>` 转义 |

`.git/HEAD` 只是项目根标记，不是可用 Git 仓库；不要删除。夹具不会创建、备份或删除
`~/.dsh`、`~/.agents` 下的用户级指令文件；用户级开关由维护者自测，安装者可跳过。

## 说明

- 夹具只含占位标记，不含真实项目规则。
- 插件的自动化测试在项目仓库的 `tests/` 里，不依赖本目录。
