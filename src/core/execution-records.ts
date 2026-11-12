import { currentUsage, usageInformation } from './token-usage.js';
import type { Store } from './store.js';
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
    const request = data as Interaction,
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
