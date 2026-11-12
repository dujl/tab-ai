# 文档导航

文档按当前仓库行为组织。功能用法、实现约束与验证方法分别维护，不以历史讨论代替已实现能力。

| 主题           | 文档                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产品概念与入口 | [命名](branding.md)、[设计原则](design-principles.md)                                                                                                                   |
| 安装与接入     | [从源码或包开始](installation.md)、[配置](configuration.md)、[首次接入](onboarding.md)、[微信与企微](wechat-wecom.md)                                                   |
| 任务与协作     | [任务编排](task-orchestration.md)、[Web/IM 双入口](dual-entry-tasks.md)、[交付与经验](session-reports.md)                                                               |
| 界面           | [Dashboard](dashboard.md)、[任务结构](unified-tasks-and-structure.md)、[树形投影](session-tree-design.md)                                                               |
| 会话与管理     | [使用手册](sessions-guide.md)、[会话控制](session-management.md)、[跨通道菜单](management-cards.md)                                                                     |
| Bot 与群聊     | [角色、授权与群模式](bot-management.md)                                                                                                                                 |
| 执行与交互     | [审批策略](session-approvals.md)、[审批/提问适配](chat-interactions.md)、[MCP 表单](mcp-elicitation.md)、[执行记录](execution-records.md)、[Agent 待办](agent-plans.md) |
| 开发           | [架构](architecture.md)、[数据库](database.md)、[API](api.md)、[实现评审](implementation-review.md)、[贡献](../CONTRIBUTING.md)、[测试](testing.md)                     |
| 运行与验证     | [运维](operations.md)、[验收](acceptance.md)、[排错](troubleshooting.md)、[安全](../SECURITY.md)                                                                        |

## 核心概念

- Task 是统一工作单元，可以拆分多层子任务；没有下级也属于任务。
- Session 保存该节点的原生上下文、目录、设置与执行状态。Task 的目标状态与 Session 的运行状态独立。
- Agent 决定由哪种原生运行时执行，Bot 决定当前聊天入口；Dashboard 与该 IM 共用同一个 Session。
- 新子任务继承直接父级目录，可显式选择已接入 Agent。已有子节点不会跟随父级改目录；不自动建立 worktree 或共享完整聊天。

只交互节点与编排节点是内部执行能力差异，界面不提供“普通/任务”分类。旧数据可用 `tab-ai migrate-tasks` 预览、停服后 `--apply` 原地回填；不恢复或重跑历史任务。

完整安装包包含本目录及根目录的贡献与安全说明；使用时结合 package.json 版本核对相应能力。
