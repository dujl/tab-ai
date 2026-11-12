import type { Interaction } from './types.js';
import { approvalOptions } from './approval-decisions.js';

export function approvalGuidance(request: Interaction): string {
  const options = approvalOptions(request);
  return [
    request.approvalContext
      ? `审批策略：${request.approvalContext.label}\n${request.approvalContext.description}`
      : undefined,
    ...options.map((o) => (o.description ? `${o.label}：${o.description}` : undefined)),
    !options.some((o) => o.id === 'session')
      ? '本次未提供会话内授权，不能扩大为“允许所有”。'
      : undefined,
    '本轮结束后可用 /tab approval 调整本会话审批策略。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function approvalSummaryText(request: Interaction): string {
  const summary = request.approvalSummary;
  return [
    summary?.operation ?? '原生工具请求；请查看完整请求核对操作内容。',
    ...(summary?.facts.map((f) => `${f.label}：${f.value}`) ?? []),
    summary?.caution,
    approvalGuidance(request),
  ]
    .filter(Boolean)
    .join('\n');
}
