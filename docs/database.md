# 数据模型与持久化

配置 `dataDir` 下的 `state.sqlite` 是框架状态库，使用 SQLite WAL。默认目录 `~/.tab-ai/data`，目录 0700、数据库文件 0600。原生 Agent 的完整上下文仍由其自身存储，框架保存原生 ID 和公开事件，不另造一份原生会话数据库。

## 表与职责

| 表                      | 职责                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `sessions`              | Session ID、nativeId、目录、Agent、状态、设置与关系，主体为 JSON              |
| `bindings`              | Route → 当前 Session；归档节点不因路由相同覆盖当前选择                        |
| `events`                | 递增 ID、Session、类型、正文、毫秒时间；公开输入/输出、工具、审批、报告索引等 |
| `receipts`              | 平台消息去重回执                                                              |
| `session_cards`         | 飞书持久会话卡片身份、状态和版本                                              |
| `group_messages`        | 已接收群参考，按聊天与权限限定使用                                            |
| `group_context_cursors` | Session 已消费群参考的位置                                                    |
| `task_records`          | Task ID、root/parent、创建 key、目标、依赖、状态、revision 和结果             |
| `task_jobs`             | 持久待执行输入、去重 key、状态及所用报告版本                                  |
| `topic_updates`         | 关联话题报告的逐级回传队列                                                    |
| `session_reports`       | 会话版本报告、Task revision、触发来源、状态、授权 scope 与正文                |
| `schema_migrations`     | 已应用的数据登记版本与备份信息                                                |

表名和建表细节以 `core/store.ts`、`core/report-store.ts`、`core/task-migration.ts` 为准。JSON 主体便于适配不同原生协议；查询所需身份、父级、状态和时间使用列或表达式索引，不把所有字段拆成独立关系表。

## 关系与状态

Task 的 sessionId 指向独立 Session；成功建立后一个 Session 对应一个任务节点。创建中的 Task 可以暂时没有 Session。只交互记录不进入自动调度，启用编排后仍保留 Session/nativeId。

Task.parentId 是验收层级，Session.parentSessionId 是对话关联；根任务的 sourceSessionId 只是入口来源，不能据此跨级验收。Route 由 platform/account/conversation/thread/sender 构成，不能仅凭名称或短 ID 越权定位。

Task 目标完成、Session 空闲/关闭、报告就绪、审批允许是不同状态。报告记录提供方或执行 Agent 的依据，不能代替实际验收。

## 事务与恢复

Session 写入及对应任务同步、任务结果/队列变化使用同一 SQLite 事务；嵌套操作采用 savepoint。单节点变动同步相关祖先与必要子树，避免每次扫描整个图。迁移持有与服务相同的目录锁，先备份，再在写事务内核对快照，没有变化才整体提交。

`Store` 构造会执行恢复：活动 Session 和工作队列改为中断/待核对，不自动重做已可能生效的操作；报告生成队列可在原版本上恢复。线上只读检查用 API 或 `DatabaseSync` 的 readOnly 模式，不额外实例化 Store。

活的审批 Promise 和授权实例在内存中；事件保存审计，重启不将旧批准恢复为有效请求。凭证、Dashboard token、附件、向导草稿和平台轮询/引用恢复文件位于数据目录文件中，备份需一并保护。详见 [运行维护](operations.md)。

## 原生 Token 统计

`events.type=usage` 保存归一化 JSON、原生会话 ID 和事件时间，作为历史记录；`sessions.data.tokenUsage` 保存当前原生会话的最新快照（nativeId、at、value）。同一次原生累计快照按覆盖处理，不相加；缓存读取包含在输入中、reasoning 包含在输出中，避免重复统计。不同 Agent 的累计范围通过 totalScope 区分；缺失不当作零。

`events.type=compaction` 可附本次操作 tokens.nativeId/before/after；`sessions.data.lastCompactionTokens` 保存最近已确认压缩的对比，`contextUsageInvalidated` 标识压缩后或中止后旧占用已失效。读取时校验当前 Agent/nativeId；重置不继承这些快照。使用现有 JSON 存储，无需重建表或迁移历史会话；旧 usage 事件没有可靠原生 ID 时不自动推定为当前统计；Codex 可按 nativeId 只读补查原生历史，作为展示覆盖层，不回填会话或改变更新时间，确实缺失时才等待新上报。
