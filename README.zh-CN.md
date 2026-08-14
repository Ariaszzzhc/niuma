# Niuma Agent

[English](README.md) | [简体中文](README.zh-CN.md)

Niuma Agent 是一个运行在终端里的 AI 编码 agent。它能读写代码、执行 shell
命令、搜索文件，并根据执行反馈自主规划和调整下一步动作。整个系统由同一个事件溯源（event-sourced）内核驱动：每个会话都是磁盘上的一份
append-only JSONL journal，没有需要运行或迁移的数据库。

_名字由来：牛马（niúmǎ），中文互联网自嘲用语，指任劳任怨替人干活的那位——现在轮到
AI 了。_

同一个二进制提供三种界面：全屏交互式 TUI、一次性提示模式，以及一个 HTTP+SSE
服务器。

niuma 使用 TypeScript 编写，运行在 [Deno](https://deno.com) 上，TUI
的热路径由一个小型 Rust 库承担。

## 当前状态

早期开发阶段。v0.1.0 是第一个打 tag
的版本。版本之间的行为和接口可能发生不兼容变更，不提供迁移路径。

## 安装

预编译二进制覆盖 Linux（x86_64）、macOS（Apple Silicon）和 Windows（x86_64）。

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/Ariaszzzhc/niuma/main/scripts/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/Ariaszzzhc/niuma/main/scripts/install.ps1 | iex
```

安装器会从 [GitHub Releases](https://github.com/Ariaszzzhc/niuma/releases)
下载对应平台的压缩包，对照该版本的 `SHA256SUMS` 校验，然后安装到
`~/.niuma/bin`。可以用 `NIUMA_INSTALL` 修改安装根目录，用版本参数（或
`NIUMA_VERSION`）锁定版本。也可以直接从 releases 页面下载压缩包。

### 从源码构建

需要 Deno 2.x 和 Rust 工具链：

```sh
git clone https://github.com/Ariaszzzhc/niuma.git
cd niuma
deno task build   # 编译 native 库 + deno compile -> dist/niuma
```

## 快速上手

```sh
niuma auth login kimi     # OAuth 设备流程；或者：niuma auth login openai
cd your-project
niuma                     # 交互式 TUI
```

一次性模式，适合脚本和快速提问：

```sh
niuma -p "解释一下这个仓库的主要模块"
```

配置文件位于 `~/.niuma/config.toml`，项目级覆盖放在
`<项目>/.niuma/config.toml`。模型以 `provider/model-id` 形式引用，通过 `--model`
参数或 `config.toml` 顶层的 `model` 键指定。

## 功能

- **交互式 TUI。** 流式输出、markdown 渲染、内联审批和斜杠命令补全。
- **内置工具。** bash、文件读写/编辑、glob、grep、补丁、子代理和计划跟踪。
- **登录即用。** 支持 Kimi 和 ChatGPT 账号的 OAuth 设备流程，也可以直接粘贴 API
  key。自定义 OpenAI/Anthropic 兼容服务通过 `config.toml` 里的 `[provider.*]`
  表声明。
- **可恢复的会话。** `/resume` 继续之前的会话；上下文快满时用 `/compact`
  折叠历史。
- **Agent skills。** 把 `SKILL.md` 放进 `~/.niuma/skills/` 或
  `.niuma/skills/`，模型会按需加载；也可以直接用 `/name args` 调用。
- **自定义斜杠命令。** 在 `~/.niuma/commands/` 或 `.niuma/commands/` 中放置
  markdown 提示词模板，支持 `$ARGUMENTS` / `$1..$N` 占位符。
- **MCP 支持。** 在 `mcp.json` 中配置的 MCP server 会以 niuma 工具的形式出现。
- **HTTP+SSE 服务器。** `niuma serve` 把同一个 agent
  内核暴露出来，便于开发自定义客户端和调试。

## 参与开发

```sh
deno task check   # 类型检查
deno task test    # 完整测试套件（无网络依赖）
deno task cli     # 从源码运行 CLI
```

架构概览、包地图和仓库约定见 [AGENTS.md](AGENTS.md)。

## 证书

[MIT](LICENSE) © Ariaszzzhc
