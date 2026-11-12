import { usageInformation } from './token-usage.js';
import { sessionIdentity } from './session-identity.js';
import { agentNames, type Session, type SessionInformation } from './types.js';
import { approvalModes, selectedApprovalPolicy } from './approval-policy.js';
import { sessionName } from './session-title.js';
export function sessionInformation(session: Session): SessionInformation {
  const usage = usageInformation(session);
  const mode = selectedApprovalPolicy(session);
  const effort = session.settings?.effort;
  const effortNames: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
  };
  const shortPolicies: Record<string, string> = {
    native: '原生配置',
    'on-request': '按需审批',
    untrusted: '审慎审批',
    never: '不询问·未授权拒绝',
    default: '原生默认',
    acceptEdits: '自动允许编辑',
    dontAsk: '不询问·未授权拒绝',
  };
  const effortText = effort
    ? effortNames[effort]
      ? `${effortNames[effort]}（${effort}）`
      : effort
    : undefined;
  const statuses = {
    idle: '空闲 · 可继续对话',
    running: '执行中',
    waiting: '等待审批或回答',
    interrupted: '已中断',
    error: '发生错误',
    detached: '原生终端占用',
    closed: '已关闭',
  };
  return {
    name: sessionName(session),
    status: session.operation === 'compact' ? '正在压缩会话' : statuses[session.status],
    fields: [
      { label: '上下文占用', value: usage.context },
      { label: 'Token 消耗', value: usage.total },
      { label: 'Agent', value: agentNames[session.agent] },
      {
        label: '思考深度',
        shortValue: effortText ?? '原生默认（未上报）',
        value:
          effortText ??
          (session.settings ? '未显式设置；以原生能力为准' : '沿用原生，实际值未上报'),
      },
      {
        label: '模型',
        shortValue: session.settings?.model ?? '原生默认（未上报）',
        value: session.settings?.model
          ? `${session.settings.model}（已保存配置）`
          : '沿用原生，实际值未上报',
      },
      { label: '工作目录', value: session.workspace },
      {
        label: '审批策略',
        shortValue: shortPolicies[mode] ?? mode,
        value:
          (approvalModes(session.agent).find((m) => m.id === mode)?.label ?? mode) +
          (session.approvalPolicy === undefined ? '（默认）' : '（显式设置）'),
      },
    ],
    details: [
      ...usage.details,
      { label: '原生会话与终端', value: sessionIdentity(session) },
      { label: '任务 ID', value: session.taskId ?? '尚未关联' },
      { label: '父会话', value: session.parentSessionId ?? session.topicParentId ?? '无（顶层）' },
      {
        label: '来源',
        value: `${session.route.platform} · ${session.channelContext?.conversationType ?? (session.route.thread ? '话题' : '聊天')}`,
      },
      {
        label: '附加指令',
        value: session.instructions
          ? `已设置（${session.instructions.length} 字符），可通过附加指令入口查看`
          : '未设置',
      },
    ],
  };
}
