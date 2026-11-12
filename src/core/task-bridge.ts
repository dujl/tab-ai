import { z } from 'zod';
import { childTaskSchema, taskResultSchema } from './task-model.js';
import type { Tasks } from './tasks.js';
import { topicReportSchema } from './topic-control.js';
import { capabilityBridge } from './capability-bridge.js';

export async function taskBridge(
  tasks: Tasks,
  sessionId: string,
  signal: AbortSignal,
  ensure?: () => void,
  topicReport?: (input: unknown) => unknown,
  authorize?: () => void,
) {
  return capabilityBridge(
    'tab-ai-tasks',
    (mcp, invoke) => {
      const call = <T>(fn: () => T | Promise<T>) =>
        invoke(() => {
          authorize?.();
          return fn();
        });
      const ready = () => {
        ensure?.();
      };
      if (topicReport)
        mcp.registerTool(
          'topic_report',
          {
            description:
              '保存原话题的阶段进度或最终报告；启用任务编排后改用 task_progress / task_report。',
            inputSchema: topicReportSchema.shape,
          },
          (input) => call(() => topicReport(input)),
        );
      mcp.registerTool(
        'task_report_read',
        {
          description: '读取本任务、下级或已声明依赖的版本化交付报告，包括规格、验证和经验。',
          inputSchema: { reportId: z.string().uuid() },
        },
        (input) => call(() => tasks.readReport(sessionId, input.reportId)),
      );
      mcp.registerTool(
        'task_experience',
        {
          description: '查找同一授权聊天范围内的可复用经验，返回来源报告与适用边界。',
          inputSchema: { query: z.string().max(200) },
        },
        (input) => call(() => tasks.experiences(sessionId, input.query)),
      );
      mcp.registerTool(
        'task_progress',
        {
          description: '保存阶段进展，不结项、不唤醒父任务。整个目标完成才使用 task_report。',
          inputSchema: { summary: z.string().min(1).max(12000) },
        },
        (input) =>
          call(() => {
            ready();
            return tasks.progress(sessionId, input.summary);
          }),
      );
      mcp.registerTool(
        'task_list',
        {
          description:
            '查看自己的任务及直接子任务的状态、结果版本和验收条件。不要循环轮询；结果会由后端主动送达。',
          inputSchema: {},
        },
        () =>
          call(() => {
            ready();
            return tasks.listForSession(sessionId);
          }),
      );
      mcp.registerTool(
        'task_create',
        {
          description:
            '创建独立子任务、话题与原生 Agent session，后端自动调度。默认继承当前父任务工作目录，只传必要资料，不复制对话历史。用稳定 key 避免重复创建。等待子任务时结束本轮，勿 sleep 或轮询。',
          inputSchema: childTaskSchema.shape,
        },
        (input) =>
          call(() => {
            ready();
            return tasks.createChild(sessionId, input);
          }),
      );
      mcp.registerTool(
        'task_report',
        {
          description:
            '提交当前任务的结构化成果；普通回复不表示完成。主任务必须先验收子任务。子任务成果会送回父任务等待验收。',
          inputSchema: taskResultSchema.shape,
        },
        (input) =>
          call(() => {
            ready();
            return tasks.report(sessionId, input);
          }),
      );
      mcp.registerTool(
        'task_review',
        {
          description:
            '验收自己的直接子任务的指定版本。核验产物后 accept=true；需要返工时 accept=false 且提供具体 feedback。',
          inputSchema: {
            taskId: z.string().uuid(),
            revision: z.number().int().min(1),
            accept: z.boolean(),
            feedback: z.string().max(8000),
          },
        },
        (input) =>
          call(() => {
            ready();
            return tasks.review(
              sessionId,
              input.taskId,
              input.revision,
              input.accept,
              input.feedback,
            );
          }),
      );
      mcp.registerTool(
        'task_cancel',
        {
          description: '取消自己的一个直接子任务及其后代；只有不再需要此工作时使用。',
          inputSchema: { taskId: z.string().uuid() },
        },
        (input) =>
          call(() => {
            ready();
            const list = tasks.listForSession(sessionId);
            if (!list.slice(1).some((t) => t.id === input.taskId))
              throw new Error('只能取消直接子任务');
            tasks.cancel(input.taskId);
            return { cancelled: true };
          }),
      );
    },
    signal,
  );
}
