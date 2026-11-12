# 测试指南

本页说明维护者怎样复现检查，以及结果能够证明什么。用户安装见 [安装指南](installation.md)，真实环境交付标准见 [验收](acceptance.md)。

## 标准命令

```sh
npm ci
npm run verify
```

| 命令                       | 检查范围                                         |
| -------------------------- | ------------------------------------------------ |
| npm run format:check       | 源码、测试、脚本、Markdown、配置及网页格式       |
| npm run docs:check         | 根目录与 docs 的本地链接、锚点和文档所列数据库表 |
| npm run check              | 严格 TypeScript 与未使用符号                     |
| npm test                   | 全部 test/*.test.ts，最多四个测试文件并行        |
| npm run test:coverage      | 同一套测试，加 Node 原生覆盖率统计               |
| npm run build              | 从源码生成完整 dist，原子替换构建目录            |
| npm run docs:check:package | 基于包清单检查完整文档及本地链接目标             |
| npm pack --dry-run         | 核对待发布包中实际包含的文件                     |

并行上限用于限制子进程、HTTP 服务和临时 SQLite 的资源竞争；不改变产品的 Agent 并发配置，也不放宽功能超时断言。不要在正在运行服务所依赖的 node_modules 中重新安装依赖。

## 运行相关回归

```sh
npx tsx --test --test-concurrency=4 test/native-usage-history.test.ts test/token-usage.test.ts
npx tsx --test --test-concurrency=4 test/session-menu.test.ts test/session-controls.test.ts
npx tsx --test --test-concurrency=4 test/tasks.test.ts test/dual-entry.test.ts
```

测试使用临时目录、独立数据库、Fake Agent/Channel、协议替身或 loopback HTTP，不需要真实模型额度或聊天机器人凭证。测试创建的原生记录均为合成数据，不应把测试 dataDir 换成正式实例。

## 测试领域

| 领域               | 代表文件                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- |
| 任务树、依赖及接续 | tasks、task-workspace、task-migration、session-hierarchy、session-reports             |
| Web/IM 与 API      | dual-entry、server、management-api、dashboard-tree                                    |
| 模型、目录与上下文 | agents、opencode、session-settings、workspace-switch、session-maintenance             |
| 审批与问答         | scoped-approvals、mcp-elicitation、interaction-timeout-feedback、lark-async-questions |
| 管理卡片           | session-menu、session-controls、management-cards、lark-card-update                    |
| Token 统计         | token-usage、native-usage-history；包括旧会话、压缩、身份及采样时效                   |
| 通道与附件         | channels、wechat、wecom-*、attachments、recent-attachment-context                     |
| 存储与安全边界     | store、setup、group-permission、bot-roles、admin-dm-scope                             |

表中文件名均位于 test，后缀为 .test.ts；完整测试清单以实际目录为准。覆盖率仅统计本轮被加载且匹配 src/** 的文件，未加载的网页脚本不会进入分母；报告中的总比例不等于整个工程所有源文件的覆盖率。它也不表示真实 Provider 或 IM 租户全部验收，不以追求比例代替协议和状态断言。

## 持续集成

[CI 配置](../.github/workflows/ci.yml) 对 push、pull request 和手动运行执行安装、完整 verify（含安装包文档检查），目标为 Linux/macOS、Node 22.16.0/24。工作流仅有仓库读取权限，第三方 Action 固定到提交 SHA；不提供真实 Bot/模型密钥，不自动部署或发布 npm 包。

本地验证不等于 GitHub 工作流已经成功；首次推送后应检查各矩阵任务。工作流命令参考 [GitHub 的 Node.js 构建测试指南](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)。

## 原生与界面联调

有条件时另外运行新建隔离 Session 的原生协议探测、真实平台按钮回调，以及桌面/390px 界面验收。原生 Token 历史可以只读验证，不需要为了获取用量重放任务或调用模型。截图来自本地 Card JSON 预览时应注明，不能当作飞书客户端验收记录。

失败时保留测试名称、Node/系统版本、提交 ID 和脱敏错误。先判断断言回归、资源竞争还是外部登录/网络问题；修复后运行相关测试及完整 verify，不通过反复重试或任意加长超时掩盖故障。
