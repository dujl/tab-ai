# 功能与限制

tab-ai 将任务、原生 Agent 和即时通讯入口组合为单机工作服务。本页汇总功能、实现入口及适用边界；操作步骤见 [文档导航](index.md)。

## 核心能力

| 功能                         | 行为                                                                     | 实现入口                                          |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| 任务、执行者与聊天入口       | Tasks、Agents、Bots 分别管理工作、原生执行者与聊天入口，总览汇总运行状态 | `web/public/dashboard.js`、`core/task-catalog.ts` |
| 多层任务树                   | 独立 Task/Session，可逐层拆分；同级依赖与直接父级验收                    | `core/tasks.ts`、`core/task-model.ts`             |
| 每节点独立 Agent             | Codex、Claude Code、OpenCode；不复制原生上下文                           | `agents/`、`core/types.ts`                        |
| 同一任务由网页和当前 IM 推进 | 两入口使用同一 Session/nativeId，编排输入持久排队，不并发写同一节点      | `core/manager.ts`、`web/server.ts`                |
| 深树易于查看                 | 左侧待处理/最近/范围筛选，主区分层导航、大纲与分支聚焦                   | `web/public/task-structure.js`、`dashboard.js`    |
| 会话设置与全局管理分离       | `/tab menu` 仅当前会话；`/tab admin` 仅 Manager Bot 已授权单聊           | `core/management-view.ts`、`manager.ts`           |
| 主会话能感知下级             | 注入本分支索引、目标和已提交摘要；不要求全局 Manager                     | `core/tasks.ts`、`topics.ts`                      |
| 阶段进度不提前结项           | progress 不结项；最终成果经直接父级验收；新工作使祖先已有结论失效        | `core/tasks.ts`、`topic-control.ts`               |
| 目录继承与上下文保留         | 新节点继承直接父级；已有历史仅对已声明支持的后端开放原地切换             | `core/session-workspace.ts`、`manager.ts`         |
| 结束后形成可接续报告         | 关闭、取消和成果提交生成版本报告，含规格/验证/遗留与经验来源             | `core/session-reports.ts`、`report-store.ts`      |
| 下游依赖明确交付             | 验收通过且对应报告就绪才调度，TaskJob 固定报告版本                       | `core/tasks.ts`                                   |
| 原生审批能力透出             | 每 Session 策略、实际可用的单次/会话范围决定与审计；不跨会话授权         | `core/approval-policy.ts`、`agents/`              |
| 多渠道管理交互               | 飞书/企微卡片，钉钉菜单和可选模板，微信文字；超时与终态明确              | `channels/`、`core/interactions.ts`               |
| 按 Agent 能力显示待办        | Codex/OpenCode 事件，Claude 按实际工具发现；不虚构步骤                   | `core/agent-plans.ts`、`agents/claude-plans.ts`   |
| 统一品牌与命令               | `tab-ai` CLI、`/tab` 聊天命令及 `tab_ai_tasks` 原生工具                  | `brand.ts`、`cli.ts`、`core/manager.ts`           |

Session 保存任务的原生上下文。只交互节点登记为 TaskRecord 后仍等待用户输入；编排调度由任务能力控制。

## 适用边界

- 树有容量边界：编排树最多 32 节点、每节点 12 个直接下级、根下 8 层；交互关联树最多 100 个后代。
- 同一 Session 同时只有一个工作/维护轮；不同任务共享目录时，框架不自动隔离文件或解决冲突。
- Dashboard token 是本机全局管理能力，没有多用户 RBAC；聊天授权按 Bot、聊天和用户隔离。群内不同发送者不会共用一个原生线程。
- 飞书群模式需要平台消息权限；企微群消息按需补读，不提供未 @ 消息的通用实时订阅；个人微信仅支持文字私聊。
- Claude 已有历史的跨目录恢复尚未声明支持；原生循环枚举/停止仅接入框架调度与 Codex goal。其他未适配交互仍需原生入口。
- 报告受公开历史预算限制，引用与结构校验不等于事实审计。总结失败保留明确标注的事实摘要；经验不是全局自动记忆或向量检索库。
- 不实现跨 IM Session 迁移、自动故障切换、跨 Agent 无损上下文迁移。
- 状态条件查询减少网络传输，仍存在服务端全量状态投影；当前按单机有限规模设计，没有分布式调度和事件推送保证。

## 使用与验证

安装和日常操作见 [使用手册](sessions-guide.md)，权限范围见 [Bot 与群聊](bot-management.md)，运行边界见 [安全说明](../SECURITY.md)。平台权限、原生登录及客户端交互需按 [验收流程](acceptance.md) 分别验证。
