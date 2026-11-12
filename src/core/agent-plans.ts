import { z } from 'zod';
import type { AgentPlan, Session } from './types.js';
import type { Store, StoredEvent } from './store.js';

export const agentPlanSchema = z.object({
  source: z.enum(['codex', 'claude', 'opencode']),
  nativeTurnId: z.string().max(256).optional(),
  explanation: z.string().max(16000).optional(),
  steps: z
    .array(
      z.object({
        id: z.string().max(256).optional(),
        text: z.string().min(1).max(8000),
        status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
      }),
    )
    .max(500),
});
const runSchema = z.object({
  runId: z.string(),
  agent: z.enum(['codex', 'claude', 'opencode']),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  title: z.string(),
  startedAt: z.number(),
});
const snapshotSchema = agentPlanSchema.extend({ runId: z.string() });
export function priorAgentPlan(store: Store, session: Session): AgentPlan | undefined {
  const event = store.latestEvent(session.id, 'agent_plan'),
    reset = store.latestEvent(session.id, 'context_reset');
  if (!event || (reset && event.id < reset.id)) return;
  try {
    const data = JSON.parse(event.text);
    if (!session.nativeId || data.nativeId !== session.nativeId || data.source !== session.agent)
      return;
    return agentPlanSchema.parse(data);
  } catch {
    return;
  }
}
const parse = <T>(schema: z.ZodType<T>, event: StoredEvent | undefined): T | undefined => {
  try {
    return event ? schema.parse(JSON.parse(event.text)) : undefined;
  } catch {
    return undefined;
  }
};
export function agentPlans(
  store: Store,
  session: Session,
  query: { limit: number; before?: number },
) {
  const rows = store.planEvents(session.id, query.limit + 1, query.before);
  const latest = store.latestEvent(session.id, 'agent_run'),
    run = parse(runSchema, latest),
    reset = store.latestEvent(session.id, 'context_reset');
  const currentRun =
    run && (!reset || latest!.id > reset.id)
      ? {
          ...run,
          status:
            run.status === 'running' && !['running', 'waiting'].includes(session.status)
              ? 'interrupted'
              : run.status,
        }
      : undefined;
  const plans = rows.slice(0, query.limit).flatMap((event) => {
    const plan = parse(snapshotSchema, event);
    if (!plan) return [];
    const life = parse(runSchema, store.planRunEvent(session.id, plan.runId));
    const active =
      life?.status === 'running' &&
      currentRun?.runId === plan.runId &&
      ['running', 'waiting'].includes(session.status);
    const status =
      life?.status === 'running' && !active ? 'interrupted' : (life?.status ?? 'unknown');
    return [
      {
        ...plan,
        eventId: event.id,
        at: event.at,
        title: life?.title ?? '原生执行计划',
        runStatus: status,
        current: currentRun?.runId === plan.runId,
        archived: !!reset && event.id < reset.id,
        counts: plan.steps.reduce((v, s) => ({ ...v, [s.status]: v[s.status] + 1 }), {
          pending: 0,
          in_progress: 0,
          completed: 0,
          cancelled: 0,
        }),
      },
    ];
  });
  return {
    currentRun,
    plans,
    ...(rows.length > query.limit ? { nextBefore: rows[query.limit - 1]!.id } : {}),
    note: '步骤状态来自原生 Agent 的待办更新；轮次结束不等于所有步骤完成，也不代表父任务已验收。',
  };
}
export function agentPlansText(store: Store, session: Session): string {
  const data = agentPlans(store, session, { limit: 3 }),
    labels = { pending: '待处理', in_progress: '进行中', completed: '已完成', cancelled: '已取消' };
  return [
    data.currentRun?.status === 'running' && !data.plans.some((p) => p.current)
      ? '当前轮次尚未上报待办。'
      : undefined,
    ...data.plans.map(
      (plan) =>
        `${plan.current ? '最近一轮' : '历史轮次'} · ${plan.title}${plan.archived ? '（重置前）' : ''}\n${plan.explanation ?? ''}\n${plan.steps.map((s, i) => `${i + 1}. [${labels[s.status]}] ${s.text}`).join('\n') || 'Agent 已清空此轮待办。'}`,
    ),
    !data.plans.length ? '尚无已采集的 Agent 待办；Agent 上报执行计划后会自动显示。' : undefined,
    data.note,
  ]
    .filter(Boolean)
    .join('\n\n');
}
