import { agentUsageSchema, currentUsage } from './token-usage.js';
import { readCompaction } from './maintenance-diagnostics.js';
import type { Store } from './store.js';
import type { AgentAdapter, AgentKind, Session } from './types.js';

// Presentation overlay only: reading statistics never changes session recency,
// management revisions, bindings, history or task state.
export class SessionUsage {
  constructor(
    private store: Store,
    private agents: Record<AgentKind, AgentAdapter>,
  ) {}
  enrich(session: Session): Session {
    let historical;
    try {
      historical = this.agents[session.agent].historicalUsage?.(session);
    } catch {
      return session;
    }
    if (
      !historical ||
      historical.nativeId !== session.nativeId ||
      !Number.isFinite(historical.at) ||
      historical.at < 0 ||
      historical.at > 8640000000000000
    )
      return session;
    const parsed = agentUsageSchema.safeParse(historical.value);
    if (!parsed.success || parsed.data.source !== session.agent) return session;
    const stored = currentUsage(session);
    if (stored && session.tokenUsage!.at >= Math.max(historical.at, historical.compactedAt ?? 0))
      return session;
    const value = { ...stored, ...parsed.data };
    if (historical.contextInvalidated) delete value.contextTokens;
    const next = { ...session, tokenUsage: { ...historical, value } };
    if (historical.contextInvalidated || session.operation === 'compact')
      next.contextUsageInvalidated = true;
    else if (parsed.data.contextTokens !== undefined) {
      const operation = readCompaction(this.store.latestEvent(session.id, 'compaction')?.text);
      if (
        !session.contextUsageInvalidated ||
        (operation &&
          (historical.at >= operation.updatedAt ||
            (historical.compactedAt ?? 0) >= operation.startedAt))
      )
        delete next.contextUsageInvalidated;
    }
    return next;
  }
}
