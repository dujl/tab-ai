import { z } from 'zod';
import { agentPlanSchema } from '../core/agent-plans.js';
import type { AgentPlan } from '../core/types.js';
const task = z.object({
  id: z.string().min(1).max(256),
  subject: z.string().min(1).max(8000),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export class ClaudePlans {
  private calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private tasks = new Map<string, AgentPlan['steps'][number]>();
  constructor(prior?: AgentPlan) {
    if (prior?.source === 'claude')
      for (const step of prior.steps) if (step.id) this.tasks.set(step.id, step);
  }
  use(id: string, name: string, input: unknown): boolean {
    if (
      !['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(name) ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input)
    )
      return false;
    this.calls.set(id, { name, input: input as Record<string, unknown> });
    if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value!);
    return true;
  }
  result(id: string, failed: boolean, output: unknown): AgentPlan | undefined {
    const call = this.calls.get(id);
    this.calls.delete(id);
    if (!call || failed) return;
    const data = output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
    if (call.name === 'TodoWrite') {
      if (!Array.isArray(call.input.todos)) return;
      const plan = agentPlanSchema.safeParse({
        source: 'claude',
        steps: call.input.todos.map((t) =>
          t && typeof t === 'object'
            ? {
                text: (t as Record<string, unknown>).content,
                status: (t as Record<string, unknown>).status,
              }
            : t,
        ),
      });
      if (!plan.success) return;
      this.tasks.clear();
      return plan.data;
    }
    if (call.name === 'TaskList') {
      const list = z.array(task).max(500).safeParse(data.tasks);
      if (!list.success) return;
      this.tasks.clear();
      for (const t of list.data)
        this.tasks.set(t.id, { id: t.id, text: t.subject, status: t.status });
    } else if (call.name === 'TaskCreate') {
      const created = task.omit({ status: true }).safeParse(data.task);
      if (!created.success) return;
      this.tasks.set(created.data.id, {
        id: created.data.id,
        text: created.data.subject,
        status: 'pending',
      });
    } else if (call.name === 'TaskGet') {
      const got = task.safeParse(data.task);
      if (!got.success) return;
      this.tasks.set(got.data.id, {
        id: got.data.id,
        text: got.data.subject,
        status: got.data.status,
      });
    } else {
      if (
        data.success !== true ||
        typeof data.taskId !== 'string' ||
        data.taskId !== call.input.taskId
      )
        return;
      const current = this.tasks.get(data.taskId);
      if (!current) return;
      if (call.input.status === 'deleted') this.tasks.delete(data.taskId);
      else {
        const next = task.safeParse({
          id: current.id,
          subject: call.input.subject ?? current.text,
          status: call.input.status ?? current.status,
        });
        if (!next.success) return;
        this.tasks.set(data.taskId, {
          id: next.data.id,
          text: next.data.subject,
          status: next.data.status,
        });
      }
    }
    if (this.tasks.size > 500) return;
    return { source: 'claude', steps: [...this.tasks.values()] };
  }
}
