import { channelIdentity, channelInstructions } from './channel-instructions.js';
import { sessionName } from './session-title.js';
import { agentNames, type Session, type ManagementView } from './types.js';
import { topicRoleInstructions } from './topic-control.js';

export function instructionsOverview(session: Session): NonNullable<ManagementView['overview']> {
  const identity = channelIdentity(session);
  return {
    summary:
      '原生指令 + 通道背景 + 会话附加指令共同生效。\n仅查看，不启动任务；完整标识与提示词见下方「查看全文」。',
    facts: [
      { label: '来源平台', value: `${identity.platform} · ${identity.conversationType}` },
      { label: '机器人', value: session.channelContext?.botName || session.route.account },
      { label: '关联会话', value: `${session.id.slice(0, 8)} · ${session.title || '尚无任务'}` },
      { label: 'Agent', value: agentNames[session.agent] },
      { label: '默认文档', value: identity.documentDefault },
      {
        label: '附加指令',
        value: session.instructions
          ? `已设置 · ${Array.from(session.instructions).length} 字符`
          : '未设置（通道背景仍生效）',
      },
    ],
    detailLabel: '查看全文',
  };
}

export function instructionsText(session: Session): string {
  const identity = channelIdentity(session);
  return [
    '【会话关联信息】',
    `来源平台：${identity.platform} · ${identity.conversationType}`,
    `机器人名称：${session.channelContext?.botName || '未设置名称'}`,
    `机器人账号：${session.route.account}`,
    `会话名称：${sessionName(session)}`,
    `会话 ID：${session.id}`,
    `聊天 ID：${session.route.conversation}`,
    `会话分支：${session.route.thread || '主会话，无独立分支'}`,
    `Agent：${agentNames[session.agent]}`,
    `默认文档：${identity.documentDefault}（用户明确指定其他平台时优先）`,
    '',
    '【有效提示词组成】',
    '1. Agent 原生指令及项目规则：由原生后端加载并保留；此处不公开原生私有配置。',
    '2. 通道背景：',
    channelInstructions(session) || '本地会话未附加聊天通道背景。',
    ...(topicRoleInstructions(session) ? ['', topicRoleInstructions(session)!] : []),
    '',
    '3. 本会话附加指令（原文，首次任务开始后固定）：',
    session.instructions ?? '未设置用户附加指令，通道背景仍正常生效。',
    '',
    '以上内容共同生效。任务开始后修改角色请新建会话；此查询不调用 Agent，不重置上下文。',
  ].join('\n');
}
