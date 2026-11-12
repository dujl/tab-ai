# 开发与贡献

tab-ai 把任务组织、原生 Agent 执行和 Bot 通道分开。修改前阅读 [设计原则](docs/design-principles.md) 与 [架构](docs/architecture.md)；用户安装和日常操作见 [安装指南](docs/installation.md) 与 [使用手册](docs/sessions-guide.md)。

## 建立开发环境

需要 Node.js 22.16+ 和 npm。从源码仓库工作：

```sh
git clone https://github.com/dujl/tab-ai.git
cd tab-ai
npm ci
npm run verify
```

`npm run verify` 顺序执行格式、文档、严格类型、完整测试、构建及安装包文档检查。修改依赖时同步提交 package-lock.json。对现有运行实例开发时，使用独立 checkout 和数据目录，不在服务使用的 node_modules 上执行 npm ci。

只查看界面不要求 Agent 登录；真正执行工作时需要所选 Agent 可执行文件和相应原生登录。开发实例可以单独初始化：

```sh
TAB_AI_DEV_DIR="$(mktemp -d)"
node dist/cli.js -c "$TAB_AI_DEV_DIR/config.json" init --local

```

**在启动之前**，将这个配置的 dataDir 改为临时目录内的绝对路径，port 改为未被使用的端口。`-c` 只选择配置文件；init 生成的 dataDir 仍默认为 ~/.tab-ai/data，不会自动隔离。修改后执行：

```sh
node dist/cli.js -c "$TAB_AI_DEV_DIR/config.json" serve
```

另一个终端使用同一个配置路径运行 `node dist/cli.js -c /path/to/config.json dashboard`。开发默认也使用 4317 端口；已有服务占用时先修改开发配置的 port，不要停止别人的任务。通过 `npm run dev -- -c /path/to/config.json serve` 可直接运行 TypeScript。

## 代码与文档位置

| 范围       | 入口与责任                                           |
| ---------- | ---------------------------------------------------- |
| 原生执行   | src/agents：协议适配、真实能力、用量与原生历史       |
| 任务和会话 | src/core：Task/Session、调度、审批、报告、数据与管理 |
| 通道       | src/channels：路由、附件、卡片与回调                 |
| 网页       | src/web：受认证 API 和静态 Dashboard                 |
| 接入       | src/setup、src/cli.ts：初始化、配置与机器人向导      |
| 自动验证   | test、scripts：隔离回归、文档检查与原子构建          |
| 产品说明   | docs：用法、架构、实现边界与验收                     |

产物 dist 由构建生成，不手工编辑。配置示例只放占位符；实际数据、凭证和原生历史留在仓库外。

## 修改与验证

1. 保持 Task 的目标状态和 Session 的执行状态独立；关闭或空闲不能替代交付验收。
2. 管理操作沿框架控制入口执行，保留当前会话归属、权限、版本及幂等检查。
3. 原生能力按 Agent 实际支持展示；不能拿协议受理回执当完成，也不能通过重跑副作用恢复未知结果。
4. 对有风险的状态和协议变更补充可观察的回归；低影响文案和样式无需编写复刻实现的测试。
5. 同步相关用法、API、配置与限制，再运行 `npm run verify`。测试分类、覆盖率和原生联调见 [测试指南](docs/testing.md)。

提交通常说明问题、最终行为和验证结果。公开问题或日志中使用合成 Session/聊天 ID，删除用户内容、原生输出、登录链接和凭证。漏洞私下报告流程见 [安全说明](SECURITY.md)。
