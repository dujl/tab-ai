# Antigravity CLI (`agy`) 接入

Antigravity CLI 是独立的 Agent，配置标识为 `agy`。tab-ai 通过原生
`agy acp`（Agent Client Protocol stdio JSON-RPC 2.0）连接，保留 Antigravity CLI
的登录、模型与思考深度配置、项目规则和原生会话；可以从网页或当前 IM 入口继续同一任务。

## 准备原生运行时

先安装支持 `acp` 子命令与 `--print --output-format json` 的 Antigravity CLI，在运行
tab-ai 的同一系统账号下检查命令并完成原生登录：

```sh
agy --version
agy acp --help
```

已经登录时无需重复登录。tab-ai 不代理账号登录或模型额度。如果可执行文件不在默认
`PATH` 中，可以将 `agents.agy.command` 配置为绝对路径；Agent 标识仍为 `agy`。

## 配置与运行说明

从源码运行时先安装依赖和构建：

```sh
cd /path/to/tab-ai
npm ci
npm run build
node dist/cli.js -c /path/to/config.json init --local
```

将生成配置中的 `defaultAgent` 改为 `agy`。以下是仅使用网页的配置示例，目录需替换为
本机真实路径；独立实例使用自己的 `dataDir` 和未被占用的端口：

```json
{
  "dataDir": "/path/to/tab-ai-data",
  "port": 4317,
  "defaultAgent": "agy",
  "topicRouterAgent": "agy",
  "defaultWorkspace": "default",
  "workspaces": { "default": "/path/to/your/project" },
  "agents": { "agy": { "command": "agy" } },
  "channels": []
}
```

`topicRouterAgent` 选择独立受限的意图识别和报告生成后端。默认执行者为 Antigravity CLI
时，可直接通过 `agy --print --output-format json --json-schema ... --disable-slash-commands --sandbox`
完成这些工作。

启动前检查配置和命令：

```sh
node dist/cli.js -c /path/to/config.json doctor
node dist/cli.js -c /path/to/config.json serve
```

另开终端获取网页地址：

```sh
node dist/cli.js -c /path/to/config.json dashboard
```

在 Tasks 新建任务时选择 **Antigravity CLI**，发送明确目标，在对话、审批与执行、
Agent 待办中查看结果。接入 Bot 后，聊天可以使用 `/tab new agy`；`agycli`、`agy cli`、
`antigravity`、`antigravity-cli` 和 `Antigravity CLI` 会解析为同一种 Agent。配置文件
使用规范标识 `agy`。Bot 接入步骤见 [接入向导](onboarding.md)。

## 会话、模型与权限

每个任务保存自己的 Antigravity CLI 原生会话 ID。下一轮和服务重启后优先通过 ACP
`session/resume` 恢复（不支持时回退到 `session/load` 并抑制历史重放通知），网页与当前
IM 继续同一上下文。未设置通道背景和附加指令的会话可使用 `tab-ai native <管理ID>` 交接
到原生终端（`agy --resume <原生ID>`）；包含通道背景或附加指令的会话通过 ACP
`_meta.antigravity.systemPrompt.append` 注入，原生终端无等价参数，应在 tab-ai 中继续。

默认模型沿用原生配置，在当前 Session 的模型/思考面板读取 ACP 返回的 `configOptions`
（或 `models.availableModels`）并应用到会话。审批策略支持 `native`、`default`、
`accept-edits`、`auto` 和 `plan`，范围说明见 [会话审批](session-approvals.md)。单次请求
通过 ACP `session/request_permission` 透出；选择“本会话允许”时仅在当前 tab-ai Session
内存记录精确请求范围并回传原生单次允许，不修改全局配置，不跨会话共享。

工具记录、执行计划（ACP `plan`）和 Token 统计（ACP `usage_update` 与 `session/prompt`
用量）均来自原生事件；没有上报的值显示未知。任务编排通过会话专属 HTTP MCP 服务器
`tab_ai_tasks` 注入到 `session/new` / `session/resume` / `session/load` 的 `mcpServers`。

## 排查

对接失败时先核对运行服务账号的 `PATH`、配置中的 `agents.agy.command`、原生版本与登录
状态；`doctor` 的可执行文件检查不等于模型调用已经成功。原生恢复失败会保留失败信息，
不建立替代上下文。验证方法见 [测试指南](testing.md)。
