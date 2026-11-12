# tab-ai 命名

Every task evolves. Any agent runs it (Codex, OpenCode, Claude Code…); any bot drives it (Feishu, WeCom, DingTalk, WeChat…).

**TAB = Task · Agent · Bot**。Agent 和 Bot 是两个独立的能力维度；每个任务可拆成子任务，每个节点有独立的 Agent session，由 Web 与当前 IM 入口共同推进。slogan 中列举的平台是产品定位；各平台的具体能力仍以连接器和权限说明为准。

## 统一入口

- 主命令 `tab-ai`，配置 `~/.tab-ai/config.json`，数据目录 `~/.tab-ai/data`，示例 `tab-ai.config.example.json`。
- 环境变量与向导生成的凭证引用使用 `TAB_AI_` 前缀。
- 任务 MCP 服务名 `tab_ai_tasks`，对 Agent 暴露 `task_create` / `task_report` / `task_review` 等工具。
- 新建机器人默认名称 `tab-ai-botN`。
- `/tab` 是与品牌对应的聊天管理命令前缀，例如 `/tab menu`、`/tab status`、`/tab new`。菜单、卡片、配对指令和帮助统一使用 `/tab`。命令参数和普通聊天原文不改写。

工程目录、Session ID、原生 Agent ID 与 SQLite 表结构互相独立：移动工程目录需要同步更新配置 `workspaces` 与已有会话的 `workspace`，仅改名不会重建任务树。服务只在无执行、审批、维护和终端接管时重启，继续使用同一数据目录。
