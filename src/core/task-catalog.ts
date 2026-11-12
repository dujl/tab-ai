import type { Session, Route, AgentKind } from './types.js';
import type { TaskResult } from './task-model.js';
import type { TopicReport } from './topic-control.js';
interface TaskCatalogEntry {
  key: string;
  id: string;
  sessionId?: string;
  taskId?: string;
  parentKey?: string;
  title: string;
  objective: string;
  criteria: string;
  goalState: string;
  executionState: string;
  agent: AgentKind;
  route: Route;
  workspace: string;
  updatedAt: number;
  lastUserAt?: number;
  report?: TaskResult | TopicReport;
  capabilities: { scheduled: boolean; canCreateChild: boolean; canQueueInput: boolean };
}
import type { TaskRecord } from './task-model.js';
import { sessionParentId, sameSessionScope } from './session-hierarchy.js';

// One product-level task catalog, without mutating/resuming native contexts.
// Scheduler records and historical conversations remain their durable sources.
export function taskCatalog(
  sessions: Session[],
  tasks: TaskRecord[],
  firstTask: (id: string) => string | undefined = () => undefined,
  lastUserAt: (id: string) => number | undefined = () => undefined,
) {
  const bySession = new Map(tasks.filter((t) => t.sessionId).map((t) => [t.sessionId!, t]));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const taskKey = (t: TaskRecord) => (t.originSession ? `session:${t.sessionId}` : `task:${t.id}`);
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const keyFor = (id: string) =>
    bySession.has(id) ? taskKey(bySession.get(id)!) : `session:${id}`;
  const entries: TaskCatalogEntry[] = tasks.map((t) => {
    const s = t.sessionId ? byId.get(t.sessionId) : undefined,
      source = t.sourceSessionId ? byId.get(t.sourceSessionId) : undefined;
    return {
      key: taskKey(t),
      id: t.id,
      sessionId: s?.id,
      taskId: t.id,
      parentKey: t.parentId
        ? byTask.has(t.parentId)
          ? taskKey(byTask.get(t.parentId)!)
          : `task:${t.parentId}`
        : source && !source.taskId && sameSessionScope(source, { route: t.route } as Session)
          ? keyFor(source.id)
          : undefined,
      title: t.title,
      objective: t.objective,
      criteria: t.criteria,
      goalState:
        t.executionMode === 'interactive'
          ? ['completed', 'paused', 'cancelled'].includes(t.state)
            ? t.state
            : t.objective.trim()
              ? 'active'
              : 'needs_goal'
          : !t.objective.trim() && ['waiting', 'queued', 'provisioning'].includes(t.state)
            ? 'needs_goal'
            : t.state,
      executionState: s?.operation === 'compact' ? 'compacting' : (s?.status ?? 'provisioning'),
      agent: t.agent,
      route: t.route,
      workspace: t.workspace,
      updatedAt: Math.max(t.updatedAt, s?.updatedAt ?? 0),
      lastUserAt: s ? lastUserAt(s.id) : undefined,
      report:
        t.result ??
        (t.progress
          ? { summary: t.progress.summary, artifacts: [], checks: [], issues: [] }
          : undefined),
      capabilities: {
        scheduled: t.executionMode !== 'interactive',
        canCreateChild: !!s && t.state !== 'cancelled',
        canQueueInput: t.executionMode !== 'interactive',
      },
    };
  });
  for (const s of sessions) {
    if (bySession.has(s.id)) continue;
    const id = sessionParentId(s),
      parent = id ? byId.get(id) : undefined;
    const objective = s.topicObjective?.trim() || firstTask(s.id)?.trim() || '';
    const title = /^【(?:tab-ai|GenesisBot) (?:话题交付摘要|话题阶段汇报)/.test(s.title ?? '')
      ? '群主任务'
      : s.title || `${s.agent} 任务`;
    entries.push({
      key: `session:${s.id}`,
      id: s.id,
      sessionId: s.id,
      taskId: undefined,
      parentKey: parent && sameSessionScope(s, parent) ? keyFor(parent.id) : undefined,
      title,
      objective,
      criteria: s.topicCriteria ?? '',
      goalState: s.topicCompleted ? 'completed' : objective ? 'active' : 'needs_goal',
      executionState: s.operation === 'compact' ? 'compacting' : s.status,
      agent: s.agent,
      route: s.route,
      workspace: s.workspace,
      updatedAt: s.updatedAt,
      lastUserAt: lastUserAt(s.id),
      report: s.topicReport?.result,
      capabilities: { scheduled: false, canCreateChild: !s.taskId, canQueueInput: false },
    });
  }
  return entries;
}
