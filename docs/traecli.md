# TRAE CLI 接入

TRAE CLI 是独立的 Agent，配置标识为 `traecli`。tab-ai 通过原生
`traecli app-server` 连接，保留 TRAE CLI 的登录、模型配置、项目指令和原生
Session；可以从网页或当前 IM 入口继续同一任务。

## 选择包含对接的构建

公共 npm 的 `tab-ai@0.3.0` 尚未包含 TRAE CLI Agent；需要使用包含此对接的源码分支或它生成的本地 tarball。当前源码的版本号同样可能为 0.3.0，确认功能时应同时检查安装来源、实际启动入口和 `doctor` 中是否有 `traecli` 项。安装方法见 [安装指南](installation.md#选择安装方式)。

修改 checkout 中的代码不会更新另一个目录里的全局 npm 包。以下步骤直接使用 `node dist/cli.js`，明确启动本源码的构建；需要使用 `tab-ai` 命令时，可安装对应 tarball，或在源码目录执行 `npm link --ignore-scripts`。

## 准备原生运行时

先按 TRAE CLI 的安装说明准备支持 app-server 的版本，在运行 tab-ai 的同一
系统账号下检查命令并完成原生登录：

```sh
traecli --version
traecli app-server --help
traecli login
```

已经登录时无需重复登录。tab-ai 不代理账号登录或模型额度。实际可执行文件名
为 `traex` 时，可以将 `agents.traecli.command` 配置为 `traex` 或其绝对路径；
Agent 标识仍为 `traecli`。

## 配置与运行说明

从源码运行时先安装依赖和构建：

```sh
cd /path/to/tab-ai
npm ci
npm run build
node dist/cli.js -c /path/to/config.json init --local
```

将生成配置中的 `defaultAgent` 改为 `traecli`。以下是仅使用网页的配置示例，
目录需替换为本机真实路径；独立实例使用自己的 dataDir 和未被占用的端口：

```json
{
  "dataDir": "/path/to/tab-ai-data",
  "port": 4317,
  "defaultAgent": "traecli",
  "topicRouterAgent": "traecli",
  "defaultWorkspace": "default",
  "workspaces": { "default": "/path/to/your/project" },
  "agents": { "traecli": { "command": "traecli" } },
  "channels": []
}
```

`topicRouterAgent` 选择独立受限的意图识别和报告生成后端。默认执行者为
TRAE CLI 时，可直接使用 TRAE CLI 完成这些工作。

启动前检查配置和命令：

```sh
node dist/cli.js -c /path/to/config.json doctor
node dist/cli.js -c /path/to/config.json serve
```

`serve` 必须保持运行，Bot 消息才会进入 Agent。`doctor` 检查配置和命令，`init --local` 初始化配置，二者都不启动持续接收服务。

另开终端获取网页地址：

```sh
node dist/cli.js -c /path/to/config.json dashboard
```

在 Tasks 新建任务时选择 **TRAE CLI**，发送明确目标，在对话、审批与执行、
Agent 待办中查看结果。接入 Bot 后，聊天可以使用 `/tab new traecli`；
`traexcli`、`traex` 和 `TRAE CLI` 名称会解析为同一种 Agent。配置文件使用
规范标识 `traecli`。Bot 接入步骤见 [接入向导](onboarding.md)。

接入完成后先在该 Bot 的已授权私聊中发送 `/tab status`，确认服务能够接收并回复管理命令，再发送一个简单工作请求。群聊按当前模式决定是否需要 @；无响应时按 [故障排查](troubleshooting.md#bot-消息没有反应) 逐层定位。

## 会话、模型与权限

每个任务保存自己的 TRAE CLI 原生 ID。下一轮和服务重启后按该 ID 恢复，
网页与当前 IM 继续同一上下文。`tab-ai native <管理ID>` 可交接到原生终端；
管理 ID 和原生 ID 的用途不同，参见 [会话控制](session-management.md)。

默认模型沿用原生配置，在当前 Session 的模型/思考面板可以选择原生目录
提供的模型和强度。审批默认采用 `on-request`；选择 `native` 则沿用原生
权限配置。单次允许、会话范围、框架自动允许和原生自动审查的范围与撤销
方式见 [会话审批](session-approvals.md)。选择某种审批策略不修改原生沙箱。

工具、计划和 Token 统计来自原生事件；没有上报的值显示未知。原生压缩
需要完成信号才显示完成，停止当前轮保留历史。原生扩展和循环能力取决于
安装版本及已接入的协议，未适配功能在原生入口管理。

## 原生目录与排查

TRAE CLI 的共享配置默认在 `~/.trae/traecli.toml`，私有会话目录默认在
`~/.trae/cli`。`TRAE_HOME` 修改共享根，`TRAECLI_HOME` 修改私有运行目录；
只修改私有目录不会迁移共享主配置。tab-ai 的数据目录和 TRAE CLI 原生
历史目录分别管理。Codex 会话继续使用自己的原生目录。

对接失败时先核对运行服务账号的 `PATH`、配置中的 command、原生版本、
登录和上述目录；`doctor` 的可执行文件检查不等于模型调用已经成功。
原生恢复失败会保留失败信息，不建立替代上下文。框架保留原生指令并附加
通道背景，不公开原生私有配置和凭据。验证方法见 [测试指南](testing.md)。
