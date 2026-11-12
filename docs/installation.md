# 安装与第一次使用

本指南从空环境开始，完成安装、网页启动和第一个任务。已经运行服务时，日常操作见 [使用手册](sessions-guide.md)，新增机器人见 [接入向导](onboarding.md)。

## 准备环境

需要 Node.js **22.16 或更高版本**和 npm：

```sh
node --version
npm --version
```

真正执行任务还需要准备所选原生 Agent：Codex/OpenCode 使用其可执行文件，Claude Code 使用 SDK 原生运行时或配置指定命令；登录、Provider、模型额度由原生 Agent 负责。应在运行 tab-ai 的同一系统账号下完成登录。安装 tab-ai 不会自动购买额度、注册模型账号或迁移其他 Agent 的凭证。

当前自动化重点覆盖 macOS/Linux；Windows 没有同等级验收记录。远程服务器不需要桌面，网页可通过 SSH 转发访问。

## 选择安装方式

### 从源码使用

```sh
git clone https://github.com/dujl/tab-ai.git
cd tab-ai
npm ci
npm run build
npm link --ignore-scripts
tab-ai --version
```

也可以解压可信来源的源码 zip，进入包含 package.json 的目录，从 `npm ci` 开始执行。源码方式适合修改代码。以后可以使用 `tab-ai` 命令；不使用 npm link 时，在仓库中将下文的 `tab-ai` 替换为 `npm start --`。构建和启动是分开的，修改源码后需重新构建才影响 dist。

### 使用本地安装包

仓库可以生成 npm tarball；无需把源代码目录作为日常运行目录。由构建者执行：

```sh
npm ci
npm run verify
npm pack --pack-destination /path/to/output
```

当前版本会生成 `tab-ai-0.3.0.tgz`，版本号以 package.json 为准。收到安装包的使用者执行：

```sh
npm install --global /path/to/tab-ai-0.3.0.tgz
tab-ai --version
tab-ai --help
```

不具备全局 npm 目录写权限时，使用个人安装前缀：

```sh
npm install --global --prefix "$HOME/.local" /path/to/tab-ai-0.3.0.tgz
export PATH="$HOME/.local/bin:$PATH"
tab-ai --help
```

PATH 设置只影响当前终端；长期使用可写入自己的 shell 配置。无需为使用 tab-ai 而用 sudo 运行 Agent。首次安装还会下载平台相关的 Agent SDK 二进制，耗时取决于网络；tarball 不是包含全部依赖的离线包。包内提供构建后的 CLI、网页、配置模板和 docs；全局安装文档位于 `$(npm root -g)/tab-ai/docs`，自定义前缀时用 `npm root -g --prefix "$HOME/.local"` 查询。

本仓库说明不代表 tab-ai 已发布到公共 npm registry。没有确认发布来源和版本时，使用上述源码或明确来源的 tarball。

## 先运行只有网页的实例

先进入你希望 Agent 使用的真实工作目录，再初始化：

```sh
cd /path/to/your/project
tab-ai init --local
tab-ai doctor
tab-ai serve
```

`init --local` 创建本机配置，已有文件不会覆盖；它不会执行工作任务。`doctor` 检查本机配置和运行条件，不代表模型额度及每个 IM 租户均已验证。`serve` 在当前终端前台运行；保留该终端，另开终端执行：

```sh
tab-ai dashboard
```

打开输出链接。新实例没有 Bot 时会显示接入向导，也可从界面进入 Tasks 创建本地任务。网页与 IM 都需要服务保持运行；终端 Ctrl+C 会停止这个服务。

默认配置 `~/.tab-ai/config.json`，数据 `~/.tab-ai/data`，HTTP 端口 4317。需要独立实例或不同目录时，在每条命令中使用同一个配置路径：

```sh
tab-ai -c /path/to/isolated/config.json init --local
```

`-c` 只指定配置文件，**不会自动隔离数据目录**。在启动之前，将新配置的 dataDir 改为独立目录、port 改为未使用端口，按 [配置说明](configuration.md) 核对 workspaces。然后分别在两个终端执行：

```sh
tab-ai -c /path/to/isolated/config.json serve
tab-ai -c /path/to/isolated/config.json dashboard
```

不要为了开发占用正式实例的数据目录。

## 完成第一个任务

1. 在 Tasks 新建任务，填写目标、Agent 和服务器上实际存在的工作目录。例如“阅读当前仓库，列出三个关键模块与入口文件”。
2. 打开节点，在对话中发送工作请求。首次执行后可看到原生 Session ID；没有启动前显示尚未启动是正常的。
3. 遇到审批或问题，在网页处理，或在该任务当前 IM 入口处理。允许审批表示授权工具请求，不等于任务已验收完成。
4. 查看执行记录和 Agent 待办；原生不支持或尚未上报的能力不伪造数据。
5. 完成后查看交付报告；需要分工时从当前节点建立子任务，子节点继承直接父级目录，拥有独立上下文。

网页和当前 IM 可以接力，但不会同时开启两个原生执行轮。不要把原生 Session ID 当作框架任务/管理 ID。更完整流程见 [双入口](dual-entry-tasks.md) 与 [任务编排](task-orchestration.md)。

## 接入聊天机器人

在网页侧栏选择“接入机器人”，或使用：

```sh
tab-ai setup
```

按平台授权和配对。已有服务时向导复用同一实例；未启动服务时可按终端向导完成后再 serve。飞书/企微/钉钉/微信的输入、卡片和附件能力不同，以 [通道说明](wechat-wecom.md) 和 [首次接入](onboarding.md) 为准。

接入后，在与 Bot 的聊天中发送 `/tab menu` 查看本会话，群内默认可能需要 @。飞书群无需 @ 的 auto 模式还取决于平台消息权限。全局 `/tab admin` 仅 Manager Bot 的授权单聊提供，不应在群中寻找全局会话列表。

## 停止、升级与卸载

日常停止当前 Agent 轮次使用网页按钮或 `/tab stop`；退出服务使用前台 Ctrl+C 或自己配置的服务管理器。关闭 Session 和停止服务是不同操作。

升级前等待活动任务、审批与维护结束，并备份配置、数据目录和必要的原生历史。源码更新后重新安装依赖、验证、构建；包安装方式重新安装明确版本的 tarball。随后使用原配置启动，不重建数据库或自动重跑历史任务。详见 [维护](operations.md)。

npm 包可用 `npm uninstall --global tab-ai` 卸载；自定义前缀需带同一 --prefix。卸载程序不会自动删除 ~/.tab-ai、工作产物或原生 Agent 历史，是否保留由使用者决定。

## 遇到问题

先运行 `tab-ai doctor`，再对照 [故障排查](troubleshooting.md)。网页访问链接含本实例管理令牌，提交问题前请删去 token、凭证、原始聊天和个人路径。
