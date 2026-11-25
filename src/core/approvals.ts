import type { Interaction } from './types.js';
import { approvalOptions } from './approval-decisions.js';

export function approvalGuidance(request: Interaction): string {
  const options = approvalOptions(request);
  const hasSession = options.some((o) => o.id === 'session');
  const hasAuto = options.some((o) => o.id === 'auto');
  const scopeNote = hasSession
    ? `仅本次只批准当前操作；本会话内允许仅复用相同授权范围，不是允许所有工具、不跨会话${hasAuto ? '；本会话自动允许仅覆盖本会话命令与文件审批' : ''}。`
    : `本次未提供会话内授权，不能扩大为“允许所有”${hasAuto ? '；本会话自动允许仅覆盖本会话命令与文件审批' : ''}。`;
  return [
    request.approvalContext
      ? `审批策略：${request.approvalContext.label}（本轮后可用 /tab approval 调整）`
      : '本轮结束后可用 /tab approval 调整本会话审批策略。',
    scopeNote,
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
