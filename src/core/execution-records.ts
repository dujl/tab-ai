import { currentUsage, usageInformation } from './token-usage.js';
import type { Store, StoredEvent } from './store.js';
import type { Interaction, ToolActivity, Session } from './types.js';
export interface RecordQuery {
  kind: 'approvals' | 'tools';
  before?: number;
  limit: number;
  q: string;
}
export function executionRecords(
  store: Store,
  sessionId: string,
  query: RecordQuery,
  pending: Interaction[],
  usageSession?: Session,
) {
  const rows = store.recordEvents(sessionId, query),
    more = rows.length > query.limit,
    page = rows.slice(0, query.limit);
  const items = page.map((event) => {
    const data = JSON.parse(event.text);
    if (query.kind === 'tools') {
      const tool = data as ToolActivity & { runId: string };
      return {
        ...tool,
        eventId: event.id,
        kind: 'tool' as const,
        at: event.at,
        status:
          tool.status === 'completed' && tool.exitCode !== undefined && tool.exitCode !== 0
            ? ('failed' as const)
            : tool.status,
      };
    }
    return interactionRecord(store, sessionId, event, pending);
  });
  const session = usageSession?.id === sessionId ? usageSession : store.get(sessionId);
  const usage = session ? currentUsage(session) : undefined;
  return {
    items,
    nextBefore: more ? page.at(-1)?.id : undefined,
    kind: query.kind,
    ...(usage ? { usage } : {}),
    ...(session ? { tokenInformation: usageInformation(session) } : {}),
  };
}

function interactionRecord(
  store: Store,
  sessionId: string,
  event: StoredEvent,
  pending: Interaction[],
) {
  const request = JSON.parse(event.text) as Interaction,
    history = store.interactionHistory(sessionId, request.id),
    decision = history.filter((e) => e.type === 'decision').at(-1),
    closed = history.filter((e) => e.type === 'interaction_closed').at(-1),
    timeout = history.filter((e) => e.type === 'interaction_timeout').at(-1);
  const answer = decision ? JSON.parse(decision.text).answer : undefined;
  const status = closed
    ? JSON.parse(closed.text).status
    : decision
      ? answer?.allow === true
        ? 'allowed'
        : answer?.allow === false
          ? 'denied'
          : 'answered'
      : timeout
        ? 'timed_out'
        : pending.some((p) => p.id === request.id)
          ? 'pending'
          : 'ended_unknown';
  return {
    eventId: event.id,
    kind: 'approval' as const,
    at: event.at,
    request,
    status,
    answer,
    settledAt: (closed ?? decision ?? timeout)?.at,
  };
}

export function inspectInteraction(
  store: Store,
  sessionId: string,
  id: string,
  pending: Interaction[],
) {
  const event = store.interactionEvent(sessionId, id);
  if (!event) return;
  const request = JSON.parse(event.text) as Partial<Interaction>;
  if (
    request.sessionId !== sessionId ||
    !['approval', 'question'].includes(request.kind ?? '') ||
    typeof request.title !== 'string' ||
    typeof request.detail !== 'string'
  )
    return;
  return interactionRecord(store, sessionId, event, pending);
}

export function interactionDetailsText(record: ReturnType<typeof interactionRecord>): string {
  const { request, status, answer } = record;
  const labels: Record<string, string> = {
    pending: '等待处理',
    allowed: '已允许',
    denied: '已拒绝',
    answered: '已回答',
    timed_out: '已超时，未批准',
    cancelled: '已取消',
    ended_unknown: '已结束，结果未记录',
  };
  const scope =
    request.kind === 'approval' && status === 'allowed'
      ? `\n授权范围：${answer?.scope === 'session' ? '本会话内（以原生 Agent 实际授权范围为准）' : '仅本次'}`
      : '';
  return `${request.title}\n请求 ID：${request.id}\n所属会话：${request.sessionId}\n状态：${labels[status] ?? '状态未确认'}${scope}\n创建时间：${new Date(record.at).toISOString()}${record.settledAt !== undefined ? `\n处理时间：${new Date(record.settledAt).toISOString()}` : ''}\n\n完整请求\n${request.detail}\n\n仅查看详情，不提交或重新执行审批。${status === 'allowed' ? '审批通过不代表工具已经执行成功，历史范围也不代表临时授权仍有效。' : ''}`;
}
