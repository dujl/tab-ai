import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { Session } from './types.js';

export function taskReportFingerprint(store: Store, session: Session): string {
  const task = session.taskId ? store.taskRecord(session.taskId) : undefined;
  return createHash('sha256')
    .update(
      JSON.stringify({
        stage: session.currentStageId,
        revision: session.executionRevision ?? 0,
        nativeId: session.nativeId,
        agent: session.agent,
        settings: session.settings,
        workspace: session.workspace,
        instructions: session.instructions,
        title: session.title,
        routeKey: session.routeKey,
        goal: task?.objective ?? session.topicObjective,
        criteria: task?.criteria ?? session.topicCriteria,
        taskRevision: task?.revision,
        taskState: task?.state,
        result: task?.result,
        evidence: store.relayEvidenceId(session.id),
      }),
    )
    .digest('hex');
}
