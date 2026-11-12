import type { Answer, Interaction } from './types.js';
export type ApprovalAction = 'allow' | 'session' | 'deny' | 'cancel';
export const approvalChoices = (
  session = false,
  cancel = false,
): NonNullable<Interaction['approvalOptions']> => [
  { id: 'allow', label: '允许本次', description: '只批准当前请求；后续请求仍由原生权限规则判断。' },
  ...(session
    ? [
        {
          id: 'session' as const,
          label: '本会话内允许',
          description:
            '仅按当前原生请求的授权范围复用，不是允许所有工具，不共享给其他会话；关闭、重启或原生实例回收后失效。',
        },
      ]
    : []),
  { id: 'deny', label: '拒绝', description: '不批准当前操作。' },
  ...(cancel
    ? [
        {
          id: 'cancel' as const,
          label: '取消当前请求',
          description: '取消本次原生请求，不授予权限。',
        },
      ]
    : []),
];
export function approvalOptions(request: Pick<Interaction, 'approvalOptions'>) {
  return request.approvalOptions ?? approvalChoices();
}
export function approvalAnswer(action: ApprovalAction): Answer {
  return action === 'allow'
    ? { allow: true }
    : action === 'session'
      ? { allow: true, scope: 'session' }
      : action === 'cancel'
        ? { allow: false, cancel: true }
        : { allow: false };
}
export function approvalAction(answer: Answer): ApprovalAction {
  if (!('allow' in answer)) throw Error('此请求需要审批决定');
  return answer.allow
    ? answer.scope === 'session'
      ? 'session'
      : 'allow'
    : answer.cancel
      ? 'cancel'
      : 'deny';
}
export function approvalDecisionText(answer: Answer) {
  const action = approvalAction(answer);
  return {
    allow: '已允许本次操作',
    session: '已允许本会话内的原生授权范围',
    deny: '已拒绝本次操作',
    cancel: '已取消当前请求，未批准',
  }[action];
}
