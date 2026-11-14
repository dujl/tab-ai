# Agent 原生待办与执行计划

Dashboard 的「Agent 待办」展示当前 Session 内原生 Agent 的执行步骤；「任务结构」仍负责框架的父子任务关系。原生待办不创建子 Session，不参与父任务验收，也不直接触发工具执行。

## 按能力展示

- Codex：接入 `turn/plan/updated`，校验当前 thread 和 turn 后接收计划快照。
- Claude Code：根据原生初始化消息中的实际工具列表判断能力。支持 `TaskCreate`、`TaskUpdate`、`TaskGet`、`TaskList` 和 `TodoWrite`；只在原生工具成功后应用状态。部分模型默认没有这些工具，因此入口隐藏，不强行开启工具或修改模型权限。工具实际出现时也可确认能力。
- OpenCode：接入当前原生 session 的 `todo.updated`，同时处理成功完成的 `todowrite` 工具调用，包括清空列表；其他原生子 agent 和会话的列表不会覆盖当前 Session。
- 未实现待办适配的后端隐藏入口。支持但尚未生成列表的会话显示明确的空状态。

Claude 的运行时能力绑定 Session、原生会话和模型。模型变更、上下文重置后，旧能力快照失效，等待再次确认。新模型未提供待办工具时不把普通工具调用或文字回复转换成虚构的待办。

## 状态与历史

界面支持全部、进行中、待处理、已完成、已取消筛选，显示各轮最近的计划快照及完成数量，按需加载更早计划。加载历史后仍刷新当前轮进度。所有文本以纯文本渲染。

轮次完成不自动把剩余步骤改成已完成；失败、中断或服务重启也保留原生上报的步骤状态，界面将未结算的进行中步骤标为「上次进行中」。同一 Session 重置上下文后，原有计划标为重置前历史。

各轮快照与生命周期写入 SQLite 的 `events`：

- `agent_run`：框架轮次 ID、Agent、标题、开始时间和轮次状态；轮次 ID 与工具执行记录一致。
- `agent_plan`：原生来源、步骤、解释、可选原生 turn ID、框架轮次 ID 和原生会话引用。
- `agent_capabilities`：当前原生会话及模型上报的待办能力。

重复快照去重；查询按轮次合并到最后一次快照，不依赖最近 200 条普通对话事件。重启后继续查看历史。Claude 的已确认任务 ID 可用于恢复下一轮观察状态，但不会注入用户提示词。普通会话历史及原生 Agent 上下文保持原状。

待办来自已采集的原生事件；未保存的事件不会从对话文本中补建。Agent 没有生成计划时不会根据最终回复猜测计划或完成率。

## 入口

网页：选中会话 → Agent 待办。聊天：`/tab todos`，或本会话的工具与请求菜单。两种入口查询同一份状态；不支持时隐藏菜单，手动命令返回能力说明。

API 参见 [API 文档](api.md)。原生协议参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude 跟踪待办](https://code.claude.com/docs/en/agent-sdk/todo-tracking)、[OpenCode Server](https://docs.opencode.ai/docs/server/)。

验证覆盖与步骤见 [验收](acceptance.md)。
