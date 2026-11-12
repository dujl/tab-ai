import { reportDraftSchema } from './report-model.js';
import { z } from 'zod';
import type { AgentKind, Route } from './types.js';
export type TaskState =
  | 'provisioning'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'review'
  | 'completed'
  | 'blocked'
  | 'paused'
  | 'cancelled';
export const taskStateNames: Record<TaskState, string> = {
  provisioning: '创建中',
  queued: '排队中',
  running: '执行中',
  waiting: '等待结果 / 补充',
  review: '待父任务验收',
  completed: '已完成',
  blocked: '需处理',
  paused: '已暂停',
  cancelled: '已取消',
};
export const taskResultSchema = z
  .object({
    summary: z.string().min(1).max(12000),
    artifacts: z.array(z.string().max(2000)).max(30),
    checks: z.array(z.string().max(1000)).max(30),
    issues: z.array(z.string().max(1000)).max(30),
    handoff: reportDraftSchema.optional(),
  })
  .strict();
export type TaskResult = z.infer<typeof taskResultSchema>;
export interface TaskRecord {
  id: string;
  rootId: string;
  parentId?: string;
  sessionId?: string;
  route: Route;
  // Navigation provenance for a root task, never a task acceptance parent.
  sourceSessionId?: string;
  deferred?: boolean;
  // Existing session adopted in place; its navigation key and native history stay stable.
  originSession?: boolean;
  // A durable task record can retain interactive execution until explicitly orchestrated.
  executionMode?: 'interactive';
  instructions?: string;
  progress?: { summary: string; at: number };
  key: string;
  title: string;
  objective: string;
  criteria: string;
  context: string;
  agent: AgentKind;
  workspace: string;
  sourceWorkspace?: string;
  dependencies: string[];
  state: TaskState;
  revision: number;
  result?: TaskResult;
  link?: string;
  waitingForUser?: boolean;
  error?: string;
  autoTurns: number;
  createdAt: number;
  updatedAt: number;
}
export interface TaskJob {
  id: string;
  taskId: string;
  key: string;
  text: string;
  state: 'pending' | 'running' | 'done' | 'interrupted' | 'cancelled';
  at: number;
  inputReports?: { taskId: string; reportId: string; version: number; taskRevision: number }[];
}
export interface TaskBoard {
  current: TaskRecord;
  root: TaskRecord;
  tasks: TaskRecord[];
}
export const childTaskSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .describe('Stable idempotency key; reuse when retrying the same creation.'),
    title: z.string().min(1).max(60),
    objective: z.string().max(16000),
    criteria: z.string().min(1).max(4000),
    context: z.string().max(16000).default(''),
    agent: z.enum(['codex', 'claude', 'opencode']).optional(),
    instructions: z.string().max(16000).optional(),
    workspaceMode: z
      .literal('shared')
      .default('shared')
      .describe(
        'New children inherit the direct parent workspace. No automatic worktree or filesystem isolation.',
      ),
    dependencies: z.array(z.string().uuid()).max(12).default([]),
    start: z.boolean().default(true).describe('false 只建立子任务，等待用户后续输入再执行。'),
  })
  .strict();
export type ChildTaskInput = z.infer<typeof childTaskSchema>;
export const rootTaskSchema = z
  .object({
    sourceSessionId: z.string().uuid(),
    key: z.string().min(1).max(200),
    title: z.string().min(1).max(60),
    objective: z.string().min(1).max(16000),
    criteria: z.string().max(4000).default('按用户目标完成并给出可核验的结果'),
    agent: z.enum(['codex', 'claude', 'opencode']).optional(),
    workspace: z.string().min(1).max(4096).optional(),
  })
  .strict();
