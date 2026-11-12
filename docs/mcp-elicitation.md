# MCP 交互请求

Codex app-server 的 `mcpServer/elicitation/request` 是 MCP 服务请求用户确认、填写表单或处理外部网页流程的原生协议。tab-ai 将它接入同一会话的交互系统，不再将这类正常请求统一视为未知协议并主动结束本轮。

## 支持的入口与行为

- 空表单确认：展示本次允许、拒绝、取消。只回复该条请求，不设置 session 或永久授权。
- 普通表单：展示布尔、字符串、数字／整数、单选和多选；按原 schema 校验必填、范围、长度、数量与 email／uri／date／date-time 格式，再返回原生类型。可选字段留空时省略，不自动选择默认值。飞书多字段按现有多题卡片逐项提交，最后一项完成后合并回传；无效字段可以修改重试。
- URL 流程：展示 HTTP／HTTPS 授权入口，用户自行完成后确认继续，也可拒绝或取消。打开链接不等于提交同意；不会自动打开浏览器或将外部授权视为必然成功。
- 飞书和 Dashboard 使用卡片／表单；企微可用原有卡片处理简单确认，结构化表单与链接流程回退为完整文字命令。钉钉的现有模板回退为文字交互，避免展示缺少必要动作的控件。

表单拒绝与取消：`/tab answer <请求ID> decline` 或 `cancel`。确认类仍使用 `/tab approve <请求ID> allow|deny|cancel`。网页表单可提交 `{answers:{...},action:"decline"|"cancel"}`，拒绝或取消时 `answers` 必须为空；普通非 MCP 提问不接受这些额外动作。

## 原生结果与生命周期

返回 `{action:"accept"|"decline"|"cancel",content:对象或null,_meta:null}`。同一条原生请求最多回复一次；MCP 的 `threadId` 和非空 `turnId` 必须匹配当前会话与原生轮次。nullable turnId 按协议允许。异会话、异轮次不展示交互、不授权。

超时向原工具返回 cancel，框架不因此主动终止整轮；原生 Agent 后续如何处理工具取消结果由其自身决定。用户停止、关闭会话、原生 `serverRequest/resolved` 或轮次结束会撤销待处理卡片，防止迟到回答再次发送。卡片终态使用既有跨入口同步和重试机制。

## 明确边界

目前只接受可完整校验的扁平对象表单，最多 20 个字段，每个选项列表最多 50 项。支持 enum／oneOf 单选与 enum／anyOf 多选；不支持嵌套对象、任意 JSON、正则 pattern 等未实现约束。复杂结构、敏感输入和 `openai/userVerification` 等原生身份验证请求会说明原因并返回 cancel，提示使用原生客户端处理该项。不会把身份挑战或密码表单转成普通聊天输入，也不会吞掉整个任务。

`openai/form`／旧 `openaiForm` 若收到，也只处理上述可完整校验的子集；初始化不额外声明支持扩展表单，以免向服务端承诺未实现的 UI 能力。审批元数据不用于隐式创建 session／全局持久授权。

## 实现与排查

- `src/agents/codex-elicitation.ts`：请求转换与原生结果；`src/agents/codex.ts`：原生作用域、结束通知和生命周期。
- `src/core/mcp-elicitation.ts`：schema 子集解析、输入校验及原生类型还原。
- `src/core/interactions.ts`、`src/core/manager.ts`：统一验证、文字动作、超时与审计。
- `src/channels/cards.ts`、`lark-cards.ts` 和 `src/web/public/app.js`：原聊天卡片、网页表单与终态。

事件记录保留 MCP 服务名、交互模式、已展示的请求及用户明确提交的回答。暂不支持的身份验证不会把原生 challenge 写入事件或聊天。排查时优先查看 `activity` 中的服务／模式、`interaction`、`decision`、`interaction_closed` 和卡片同步事件。

参考：[Codex app-server MCP 交互](https://learn.chatgpt.com/docs/app-server#mcp-server-elicitation-requests)。
