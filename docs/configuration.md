# 安装、配置与升级

完整的源码/安装包选择、首次任务和独立实例步骤见 [安装指南](installation.md)。本页侧重配置字段与生效范围。

## 1. 安装和启动

需要 Node.js 22.16+，以及你准备使用的原生 Agent 运行时和登录状态。tab-ai 自己不提供模型额度或模型账户登录代理。

```bash
cd /path/to/tab-ai
npm ci
npm run build
npm link --ignore-scripts
tab-ai init
tab-ai doctor
tab-ai serve
```

`init` 会创建配置并进入机器人接入向导。只初始化本机配置：`tab-ai init --local`。`serve` 在前台运行，适合放在服务管理器中；不要求显示器，也不依赖 tmux。

在另一个终端执行：

```bash
tab-ai dashboard
```

复制输出的本地链接打开工作台。未执行 `npm link` 时，将 `tab-ai` 替换为 `npm start --`。进入接入向导使用 `tab-ai dashboard --setup`。

## 2. 配置文件选择

不指定 `-c` 时使用 `~/.tab-ai/config.json`；首次运行 `tab-ai init` 或 `tab-ai serve` 会在该目录创建配置。已有配置不会被覆盖。可以显式指定：

```bash
tab-ai -c /path/to/config.json serve
```

默认数据目录为 `~/.tab-ai/data`，与从哪个工作目录启动无关。显式 `dataDir` 始终优先，可写绝对路径、`~/` 或相对配置文件目录的路径。

配置中的相对路径以配置文件所在目录为基准。工作目录必须已存在且为目录。不要把凭证写进工作任务或公开示例文件。

## 3. 核心配置

```json
{
  "dataDir": "data",
  "port": 4317,
  "defaultAgent": "codex",
  "topicRouterAgent": "codex",
  "defaultWorkspace": "default",
  "workspaces": { "default": "/Users/me/workspace/project" },
  "maxConcurrentRuns": 4,
  "turnTimeoutMs": 1800000,
  "interactionTimeoutMs": 600000,
  "agents": {
    "codex": { "command": "codex" },
    "claude": {},
    "opencode": { "command": "opencode" }
  },
  "channels": []
}
```

| 字段                   | 含义与影响                                                     |
| ---------------------- | -------------------------------------------------------------- |
| `dataDir`              | SQLite、访问令牌、渠道凭证、附件和向导草稿所在地               |
| `port`                 | 本机 HTTP 端口；默认监听 `127.0.0.1`，局域网需显式配置         |
| `defaultAgent`         | 新会话未指定时使用 codex、claude 或 opencode；不替换旧会话后端 |
| `topicRouterAgent`     | 独立意图识别后端，仅 codex/claude；不复用工作 session          |
| `defaultWorkspace`     | `workspaces` 中的默认别名                                      |
| `workspaces`           | 目录别名映射；会话也可显式使用本机存在的绝对目录               |
| `defaultInstructions`  | 可选的默认附加指令；普通会话未配置时沿用原生指令               |
| `maxConcurrentRuns`    | 1～32；普通会话和任务调度共用并发容量，默认 4                  |
| `turnTimeoutMs`        | 单轮最长时间，默认 30 分钟                                     |
| `interactionTimeoutMs` | 原生问题/审批等待时间，默认 10 分钟；超时不自动批准            |
| `agents.*.command`     | 原生可执行文件路径；Claude 未指定时可使用 SDK 自带运行时       |

渠道字段参见[配置示例](../tab-ai.config.example.json)。向导生成的配置通常无需手写。企微 channel 可选 `contextGroups` 指定允许用官方 CLI 补读近期群消息的白名单；省略时关闭，需要同一机器人独立授权，详见[企微群聊补读](wechat-wecom.md#企微群聊近期消息补读可选)。

## 4. 模型与登录

先在运行服务的同一系统用户下登录 Codex、Claude Code 或 OpenCode。保留原生 HOME 和原生配置；tab-ai 不把一种 Agent 的认证转换成另一种。

模型默认从原生配置读取。要只修改一个 session，在飞书会话卡片或 Dashboard 的“模型 / 思考”面板读取该 Agent 提供的列表并保存。原生配置、项目指令和模型覆盖的详细行为见[会话手册](sessions-guide.md)。

`.env.example` 只是模板，程序不自动读取 `.env`。可在启动服务的环境中导出对应变量；向导也可以把凭证保存到数据目录内受文件权限保护的 `credentials.json`。

## 5. 配置与数据位置

配置在 `~/.tab-ai/config.json`，数据在 `~/.tab-ai/data`（SQLite、访问令牌、渠道凭证、附件、向导草稿）。目录权限 0700、文件 0600；`-c` 可指向其他配置文件。

- 聊天管理命令统一使用 `/tab`；子命令及权限边界见会话使用手册。
- 机器人在平台上的应用名与历史聊天内容不会因本地改名被远程改写；新建机器人使用 `tab-ai-botN`。
- Dashboard 的 BOT 显示名称是本机标签，不等于平台应用名。

已启动的原生 session 仍依赖原来的工作目录。移动工程目录时需要同步更新配置的 `workspaces` 与已有会话的 `workspace`，并确认原生 Agent 仍能恢复对应 thread；只改配置不会自动迁移原生历史的 cwd。

## Dashboard 局域网地址

可选 `dashboardLanHost` 为本机的私有 IPv4 地址，例如 `192.168.1.10`。配置后服务允许该 Host / Origin 与本机地址，仍要求访问令牌；未配置时继续只监听本机。`tab-ai dashboard` 输出配置的局域网登录链接。本机 CLI 仍通过回环地址工作，不将 bearer 写入配置或网页静态文件。

品牌约定见 [tab-ai 命名](branding.md)。
