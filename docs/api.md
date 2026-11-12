# 本机 API

API 与 Dashboard 使用同一服务，默认 `http://127.0.0.1:4317`。请求携带 `Authorization: Bearer <dataDir/token>`；JSON 写入携带 `Content-Type: application/json`。服务校验 Host、Origin 和令牌，请求体最多 300 KB。

令牌代表本机所有者的全局管理能力，不是聊天用户登录。未认证返回 401，非法 Host/Origin 返回 403；资源缺失通常 404，校验或状态拒绝返回 400，未知路径 404。具体返回以端点为准。创建与副作用请求结果未知时先查询，不盲目重试。

## 统一任务入口

| 方法与路径                           | 行为                                          |
| ------------------------------------ | --------------------------------------------- |
| `GET /api/task-nodes`                | 返回统一目录 `{tasks}`，不启动模型或迁移      |
| `POST /api/task-nodes`               | 新建产品根任务，返回 201 目录节点             |
| `POST /api/task-nodes/:key/children` | 在指定目录节点下创建编排子任务，返回 201 节点 |

统一创建参数：

```json
{
  "key": "research-v1",
  "title": "研究任务",
  "objective": "明确目标，可在等待输入时为空",
  "criteria": "可核验的交付标准",
  "agent": "codex",
  "workspace": "default",
  "start": false
}
```

`key` 为 1–64 位字母、数字、下划线或短横线，重试同一创建使用同一个 key。title 必填、最长 60；objective 最长 8000、默认空；criteria 最长 4000、有默认值。agent、workspace 可选；workspace 接受已配置别名或已存在的绝对/`~/` 路径。

根节点可选 `sourceSessionId`；省略时为仅网页任务，提供时沿用该会话的 IM 来源，不复制历史。子节点 `:key` 为 `session:<UUID>` 或 `task:<UUID>`，固定父级，不能更换来源；workspace 未填或必须与直接父级一致，不能用创建参数悄悄迁移父级。

`start` 默认 false，仅建立、等待输入；true 需要明确目标。延迟任务首次收到要求时登记缺失目标并开始，不因下级结果提前唤醒。

## 调度模型接口

| 方法与路径                     | 参数 / 结果                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/tasks`               | `{tasks: TaskRecord[]}`                                                                                           |
| `POST /api/tasks`              | sourceSessionId、key、title、非空 objective；可选 criteria、agent、workspace。返回 201 TaskRecord，创建后立即执行 |
| `POST /api/tasks/:id/children` | 子任务 schema，返回 201 TaskRecord                                                                                |
| `POST /api/tasks/:id/message`  | `{text,key}`；对编排节点同 key 去重排队，对交互节点执行会话输入                                                   |
| `POST /api/tasks/:id/pause`    | 暂停节点调度并阻止后代领取队列                                                                                    |
| `POST /api/tasks/:id/resume`   | 校验祖先与会话状态后恢复                                                                                          |
| `POST /api/tasks/:id/cancel`   | 取消节点及后代，保留历史，生成取消报告                                                                            |

生命周期写入返回 200 `{task}`。只交互节点不提供调度暂停/恢复/取消，使用本会话控制；新增调度子任务会按需启用编排。

子任务参数：key（同上）、title、objective（最长 16000）、非空 criteria（最长 4000）；可选 context（最长 16000）、instructions、agent、dependencies、workspaceMode、start。workspaceMode 仅为 shared，表示继承直接父级目录，没有自动 worktree；dependencies 最多 12 个已创建同级任务 UUID。start 在此底层接口默认 true，与统一网页创建入口的默认值不同。关闭、暂停和验收不是同一操作。

成果提交、进展与验收通过当前有效原生轮的受限任务工具完成，详见 [任务编排](task-orchestration.md)。

## 状态与能力

`GET /api/state` 返回 sessions、tasks、taskNodes、interactions、channels、workspaces、默认配置、agentCatalog、sessionCapabilities、sessionReportStates 和能力标记。

- `sessions` 保存执行与原生上下文；`tasks` 保存目标与调度状态。
- `taskNodes` 以稳定 key/parentKey 投影一个产品目录；lastUserAt 取真实用户事件，不取后台工具更新时间。
- `channels[].connection` 为 starting/ready/error，表示启动状态，不是持续健康检测；不返回凭证。
- `sessionCapabilities[id].plans` 决定原生待办入口，不能只看 Agent 名称。
- `sessionReportStates` 只含报告更新时间索引，正文单独分页读取。

状态支持 ETag / If-None-Match，未变化返回 304。服务端仍构造状态投影，不承诺服务端零计算或流式推送。

## 会话控制

以下路径均以 `/api/sessions/:id` 为前缀；不存在 Session 返回 404。

| 子路径                     | 方法 / 参数                               | 行为                                                                   |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `/events`                  | GET                                       | 最近 200 个公开框架事件，无分页                                        |
| `/messages`                | POST `{text}`                             | 本节点工作输入；编排节点排队                                           |
| `/begin`                   | POST                                      | 开始已保存的初始化任务                                                 |
| `/stop`、`/close`、`/open` | POST                                      | 停止本轮、关闭、打开                                                   |
| `/settings`                | GET / POST `{settings,revision}`          | 原生模型能力与本会话设置，乐观版本校验                                 |
| `/replace-workspace`       | POST `{workspace}`                        | 当前绑定的空闲节点原地改目录，返回 201 Session；已有历史要求适配器支持 |
| `/reset`                   | GET / POST `{revision}`                   | 查询能否重置或确认重置；任务节点保持身份，交互节点接续关系并归档原记录 |
| `/detach`、`/attach`       | POST                                      | 原生终端交接；detach 返回 command/cwd                                  |
| `/maintenance`             | GET                                       | 压缩能力、占用、revision、可选 lastCompaction                          |
| `/compact`                 | POST `{revision}`                         | 受理原生压缩，返回 202；需查询实际结果                                 |
| `/loops`                   | GET                                       | 已接入的持续项与 revision                                              |
| `/loop-stop`               | POST `{loopId,revision}`                  | 停止精确来源并等待确认                                                 |
| `/im-entry`                | GET / POST `{revision,confirmedUnknown?}` | 补建原 Bot/聊天的飞书入口；unknown 须明确确认，不是通道迁移            |

工作、下载、维护、排队输入、终端占用及绑定变化分别校验，不允许旧面板覆盖新状态。只影响选中节点，已有子节点目录不随之修改。

`POST /api/sessions` 是内部上下文创建接口，参数 agent、workspace（必须为已配置别名）、可选 instructions，返回 201 Session。`POST /api/sessions/:id/children` 创建只交互子节点，参数 key、title、可选 objective/agent/workspace/instructions；不复制历史或自动执行目标，父级已启用编排时委托 Task 服务创建等待输入的子任务，仍需验收，不能指定与直接父级不同的目录。产品新建统一使用 `/api/task-nodes`。

## 审批与提问

`POST /api/sessions/:id/answer` 接受 `{id,answer}`。审批答案为 `{allow:boolean,scope?:"once"|"session",cancel?:boolean}`，只允许请求实际提供的决定；问题答案为 `{answers:{问题ID:[答案]}}`。MCP 表单可附 action 为 accept/decline/cancel，拒绝或取消时答案为空，按原 schema 还原类型。无效答案不结算原请求。

`GET /api/sessions/:id/approval-policy` 返回 mode/defaulted/modes/revision/canRevoke；POST `{mode,revision,revoke?}` 保存本会话策略或撤销临时授权。Codex 未覆盖时默认 on-request，native 是明确选择；不修改沙箱或共享原生配置。运行、待审批、终端占用或版本过时拒绝。详见 [审批策略](session-approvals.md)、[MCP 交互](mcp-elicitation.md)。

## 记录、待办与交付

| 路径                             | 查询 / 参数                                                          | 返回                                                    |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/sessions/:id/records`  | kind=approvals/tools，limit=1–50（默认30），before=事件ID，q 最长200 | items、nextBefore；不受对话200条限制                    |
| `GET /api/sessions/:id/todos`    | limit=1–50（默认10），before=事件ID                                  | supported、currentRun、plans、nextBefore、note          |
| `GET /api/sessions/:id/reports`  | before=会话内版本                                                    | reports，每页20份、版本倒序                             |
| `POST /api/sessions/:id/reports` | 可选 UUID key                                                        | 202 与持久报告请求，同 Session/key 幂等                 |
| `GET /api/experiences`           | 可选 sessionId、q                                                    | 对应范围的经验与来源；本机管理员省略 sessionId 可查全局 |

工具按 runId/toolId 合并最后快照，审批按真实终态展示；缺失结果不猜测成功。原生待办按当前能力显示，轮次结束不自动完成剩余步骤。报告生成不启动工作任务或改变验收状态。详见 [执行记录](execution-records.md)、[待办](agent-plans.md)、[交付报告](session-reports.md)。

## Bot 与接入向导

`POST /api/channels/:botId/role` 为 `{manager}`；`/details` 为 `{displayName,defaultWorkspace}`；`/group-mode` 为 `{chatId,mode}`，只支持飞书群。这些写入要求配置持久化服务存在。`POST /api/management` 接收 group_mode.get/set 的结构化请求，本机授权仍由入口构造。

`GET /api/setup` 查询说明、当前流程和草稿；`POST /api/setup/start` 开始；`GET /api/setup/:id` 查询；对应 POST `/verify`、`/confirm`、`/cancel` 完成验证、确认或取消。平台字段以 `setup/service.ts` 的 setupInput 为准，建议使用网页或 CLI 向导，避免重复创建结果不确定的远端应用。

会话 `maintenance` 与 `records` 查询附带 `tokenInformation`，提供与聊天信息区一致的上下文、消耗及口径详情；`maintenance.lastCompaction.tokens` 可包含本次压缩前后计数。`records.usage` 仅在已采集或原生历史补读的快照与当前 Agent/nativeId 匹配时返回，不复用重置前的事件作为当前用量；只读补查不改变管理 revision 和会话更新时间。缺失计数不返回伪造的零或压缩率。
