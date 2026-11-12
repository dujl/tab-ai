import { openCodeUsage } from './token-usage.js';
import { TASK_MCP_SERVER } from '../brand.js';
import { ScopedGrants } from './scoped-grants.js';
import { approvalChoices, approvalAction } from '../core/approval-decisions.js';
import { agentInstructions } from '../core/channel-instructions.js';
import { z } from 'zod';
import { type AgentAdapter, type AgentModel, type AgentRun, type Session } from '../core/types.js';
import { agentEnvironment } from './environment.js';
import { OpenCodeServer, consumeEvents } from './opencode-server.js';
import { agentPlanSchema } from '../core/agent-plans.js';
import { approvalPresentation } from './approval.js';
import { openCodeTool } from './tool-events.js';
import { sameWorkspace } from '../core/session-workspace.js';

type Server = Pick<OpenCodeServer, 'request' | 'fetch' | 'close'>;
type ServerFactory = (cwd: string, signal: AbortSignal) => Promise<Server>;
const nativeSession = z.object({
  id: z.string().startsWith('ses'),
  directory: z.string(),
  parentID: z.string().optional(),
});
const permission = z.object({
  id: z.string(),
  sessionID: z.string(),
  permission: z.string(),
  patterns: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const question = z.object({
  id: z.string(),
  sessionID: z.string(),
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string() })),
      multiple: z.boolean().optional(),
      custom: z.boolean().optional(),
    }),
  ),
});
const eventSchema = z.object({ type: z.string(), properties: z.record(z.string(), z.unknown()) });
const responseSchema = z.object({
  info: z.object({
    sessionID: z.string(),
    tokens: z.unknown().optional(),
    error: z
      .object({
        name: z.string(),
        data: z.object({ message: z.string().optional() }).passthrough().optional(),
      })
      .optional(),
  }),
  parts: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      ignored: z.boolean().optional(),
      synthetic: z.boolean().optional(),
    }),
  ),
});
const providerSchema = z.object({
  connected: z.array(z.string()),
  all: z.array(
    z.object({
      id: z.string(),
      models: z.record(
        z.string(),
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          variants: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    }),
  ),
});

export class OpenCodeAdapter implements AgentAdapter {
  readonly supportsPlans = true;
  private grants = new ScopedGrants();
  async release(id: string) {
    this.grants.clear(id);
  }
  async close() {
    this.grants.close();
  }
  readonly supportsWorkspaceSwitch = true;
  constructor(
    private command = 'opencode',
    private secretKeys: string[] = [],
    private serverFactory?: ServerFactory,
  ) {}
  async compact(session: Session, signal: AbortSignal): Promise<{ compacted: boolean }> {
    signal.throwIfAborted();
    if (!session.nativeId) throw new Error('此会话尚无原生历史。');
    const server = await this.server(session.workspace, signal),
      id = encodeURIComponent(session.nativeId);
    let owned = false,
      complete = false;
    const messagesSchema = z.array(
      z.object({
        info: z
          .object({
            id: z.string(),
            sessionID: z.string(),
            role: z.string(),
            parentID: z.string().optional(),
            summary: z.unknown().optional(),
            providerID: z.string().optional(),
            modelID: z.string().optional(),
            error: z.unknown().optional(),
            time: z.object({ completed: z.number().optional() }).passthrough().optional(),
          })
          .passthrough(),
        parts: z.array(z.object({ type: z.string() }).passthrough()),
      }),
    );
    const read = async () => {
      const messages = messagesSchema.parse(
        await server.request(`/session/${id}/message?limit=20`, signal),
      );
      if (messages.some((m) => m.info.sessionID !== session.nativeId))
        throw new Error('压缩历史属于其他原生会话。');
      return messages;
    };
    try {
      const path = z.object({ directory: z.string() }).parse(await server.request('/path', signal));
      if (!sameWorkspace(path.directory, session.workspace))
        throw new Error('实际工作目录不匹配。');
      const loaded = nativeSession.parse(await server.request(`/session/${id}`, signal));
      if (loaded.id !== session.nativeId) throw new Error('原生会话不匹配，未创建替代会话。');
      owned = true;
      const before = await read(),
        ids = new Set(before.map((m) => m.info.id)),
        last = [...before]
          .reverse()
          .find((m) => m.info.role === 'assistant' && m.info.providerID && m.info.modelID);
      const slash = session.settings?.model.indexOf('/') ?? -1;
      const model = session.settings
        ? {
            providerID: session.settings.model.slice(0, slash),
            modelID: session.settings.model.slice(slash + 1),
          }
        : last
          ? { providerID: last.info.providerID!, modelID: last.info.modelID! }
          : undefined;
      if (!model || !model.providerID || !model.modelID || (session.settings && slash < 1))
        throw new Error('无法确定此原生会话的模型；请先完成一轮任务或选择模型。');
      if ((await server.request(`/session/${id}/summarize`, signal, model)) !== true)
        throw new Error('OpenCode 未确认受理压缩请求。');
      const after = await read(),
        parents = new Set(
          after
            .filter(
              (m) =>
                !ids.has(m.info.id) &&
                m.info.role === 'user' &&
                m.parts.some((p) => p.type === 'compaction'),
            )
            .map((m) => m.info.id),
        );
      const summary = after.find(
        (m) =>
          !ids.has(m.info.id) &&
          m.info.role === 'assistant' &&
          m.info.summary === true &&
          parents.has(m.info.parentID ?? ''),
      );
      if (!summary || summary.info.error || !summary.info.time?.completed)
        throw new Error('未收到本次原生压缩的完整摘要；未报告成功，也未自动重试。');
      complete = true;
      return { compacted: true };
    } finally {
      if (owned && !complete)
        await server.request(`/session/${id}/abort`, AbortSignal.timeout(3000), {}).catch(() => {});
      await server.close();
    }
  }
  private server(
    cwd: string,
    signal: AbortSignal,
    bridge?: AgentRun['taskBridge'],
  ): Promise<Server> {
    const env = agentEnvironment(this.secretKeys);
    if (bridge) {
      const configured = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...configured,
        permission: {
          ...(typeof configured.permission === 'object'
            ? configured.permission
            : configured.permission
              ? { '*': configured.permission }
              : {}),
          [`${TASK_MCP_SERVER}_*`]: 'allow',
        },
        mcp: {
          ...configured.mcp,
          [TASK_MCP_SERVER]: {
            type: 'remote',
            url: bridge.url,
            headers: { Authorization: `Bearer ${bridge.token}` },
            oauth: false,
            enabled: true,
          },
        },
      });
    }
    return this.serverFactory
      ? this.serverFactory(cwd, signal)
      : OpenCodeServer.start(this.command, cwd, env, signal);
  }
  resumeCommand(session: Session): string[] {
    return [
      this.command,
      ...(session.nativeId ? ['--session', session.nativeId] : []),
      ...(session.settings ? ['--model', session.settings.model] : []),
    ];
  }
  async models(session: Session, signal: AbortSignal): Promise<AgentModel[]> {
    const server = await this.server(session.workspace, signal);
    try {
      const catalog = providerSchema.parse(await server.request('/provider', signal));
      return catalog.all
        .filter((p) => catalog.connected.includes(p.id))
        .flatMap((provider) =>
          Object.values(provider.models)
            .filter((model) => model.status !== 'deprecated')
            .map((model) => ({
              id: `${provider.id}/${model.id}`,
              label: `${model.name} (${provider.id})`,
              efforts: Object.keys(model.variants ?? {}).map((id) => ({ id, label: id })),
            })),
        );
    } finally {
      await server.close();
    }
  }
  async run({ session, text, signal, hooks, taskBridge }: AgentRun): Promise<void> {
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal]);
    const server = await this.server(session.workspace, combined, taskBridge);
    let nativeId: string | undefined, stream: Promise<void> | undefined;
    const jobs = new Set<Promise<void>>(),
      seen = new Set<string>(),
      children = new Set<string>();
    let complete = false;
    const owns = async (id: string): Promise<boolean> => {
      if (id === nativeId || children.has(id)) return true;
      const visited: string[] = [];
      while (id && visited.length < 16 && !visited.includes(id)) {
        visited.push(id);
        const data = nativeSession.parse(
          await server.request(`/session/${encodeURIComponent(id)}`, combined),
        );
        if (!data.parentID) return false;
        if (data.parentID === nativeId || children.has(data.parentID)) {
          visited.forEach((child) => children.add(child));
          return true;
        }
        id = data.parentID;
      }
      return false;
    };
    const interact = async (type: string, properties: Record<string, unknown>) => {
      if (type === 'permission.asked') {
        const request = permission.parse(properties);
        if (!(await owns(request.sessionID))) return;
        // Native `always` can persist at project scope in some versions. Keep
        // the exact requested range only in this tab-ai session instead.
        const range = { permission: request.permission, patterns: [...request.patterns].sort() };
        let action: 'allow' | 'session' | 'deny' | 'cancel';
        if (this.grants.has(session, range)) {
          action = 'allow';
          hooks.activity('复用本会话内授权：' + request.permission + '（相同请求范围）');
        } else {
          const answer = await hooks.ask(
            {
              kind: 'approval',
              title: `OpenCode：${request.permission}`,
              ...approvalPresentation(
                {
                  ...(request.metadata ?? {}),
                  permission: request.permission,
                  patterns: request.patterns,
                },
                session.workspace,
                false,
                false,
                request.permission,
              ),
              approvalOptions: approvalChoices(true),
            },
            combined,
          );
          action = approvalAction(answer);
          if (action === 'cancel') throw Error('此原生请求不支持取消选项');
          if (action === 'session') this.grants.add(session, range);
        }
        combined.throwIfAborted();
        await server.request(`/permission/${encodeURIComponent(request.id)}/reply`, combined, {
          reply: action === 'allow' || action === 'session' ? 'once' : 'reject',
        });
      } else {
        const request = question.parse(properties);
        if (!(await owns(request.sessionID))) return;
        const answer = await hooks.ask(
          {
            kind: 'question',
            title: 'OpenCode 需要你的选择',
            detail: '',
            questions: request.questions.map((q, i) => ({
              id: String(i + 1),
              question: q.question,
              options: q.options.map((o) => o.label),
              descriptions: q.options.map((o) => o.description),
              multiSelect: q.multiple ?? false,
              allowOther: q.custom ?? true,
            })),
          },
          combined,
        );
        combined.throwIfAborted();
        if (!('answers' in answer)) throw new Error('OpenCode 问题未收到有效答案');
        await server.request(`/question/${encodeURIComponent(request.id)}/reply`, combined, {
          answers: request.questions.map((_, i) => answer.answers[String(i + 1)] ?? []),
        });
      }
    };
    try {
      const path = z
        .object({ directory: z.string() })
        .parse(await server.request('/path', combined));
      if (!sameWorkspace(path.directory, session.workspace))
        throw new Error('OpenCode 实际工作目录与请求不匹配；未启动任务。');
      const loaded = nativeSession.parse(
        await server.request(
          session.nativeId ? `/session/${encodeURIComponent(session.nativeId)}` : '/session',
          combined,
          session.nativeId ? undefined : {},
        ),
      );
      // directory is creation metadata. The native server runs this turn in the
      // requested /path directory while retaining the existing transcript ID.
      if (session.nativeId && loaded.id !== session.nativeId)
        throw new Error('OpenCode 原生会话与请求不匹配；未创建替代会话。');
      nativeId = loaded.id;
      hooks.nativeId(nativeId);
      // Subscribe before submitting. A broken event channel must stop the turn, not leave an invisible approval waiting.
      const response = await server.fetch('/event', combined);
      stream = consumeEvents(response, (value) => {
        const event = eventSchema.parse(value);
        if (event.type === 'todo.updated') {
          if (event.properties.sessionID !== nativeId || !Array.isArray(event.properties.todos))
            return;
          const plan = agentPlanSchema.safeParse({
            source: 'opencode',
            steps: event.properties.todos.map((t) =>
              t && typeof t === 'object'
                ? {
                    id: (t as Record<string, unknown>).id,
                    text: (t as Record<string, unknown>).content,
                    status: (t as Record<string, unknown>).status,
                  }
                : t,
            ),
          });
          if (plan.success) hooks.plan?.(plan.data);
          return;
        }
        if (event.type === 'message.part.updated') {
          const tool = openCodeTool(event.properties.part);
          if (tool) {
            if (
              tool.sessionId === nativeId &&
              tool.event.name === 'todowrite' &&
              tool.event.status === 'completed'
            ) {
              const part = event.properties.part as { state?: { input?: { todos?: unknown[] } } };
              if (Array.isArray(part.state?.input?.todos)) {
                const plan = agentPlanSchema.safeParse({
                  source: 'opencode',
                  steps: part.state.input.todos.map((t) =>
                    t && typeof t === 'object'
                      ? {
                          id: (t as Record<string, unknown>).id,
                          text: (t as Record<string, unknown>).content,
                          status: (t as Record<string, unknown>).status,
                        }
                      : t,
                  ),
                });
                if (plan.success) hooks.plan?.(plan.data);
              }
            }
            const job = owns(tool.sessionId)
              .then((allowed) => {
                if (allowed) hooks.tool?.(tool.event);
              })
              .catch((error) => {
                controller.abort(error);
              })
              .finally(() => jobs.delete(job));
            jobs.add(job);
          }
          return;
        }
        if (event.type !== 'permission.asked' && event.type !== 'question.asked') return;
        const key = `${event.type}:${String(event.properties.id)}`;
        if (seen.has(key)) return;
        seen.add(key);
        const job = interact(event.type, event.properties)
          .catch((error) => {
            controller.abort(error);
          })
          .finally(() => jobs.delete(job));
        jobs.add(job);
      }).catch((error) => {
        if (!complete) controller.abort(error);
      });
      const settings = session.settings;
      const slash = settings?.model.indexOf('/') ?? -1;
      if (settings && (slash < 1 || slash === settings.model.length - 1))
        throw new Error('OpenCode 模型应使用 provider/model 格式。');
      const result = responseSchema.parse(
        await server.request(`/session/${encodeURIComponent(nativeId)}/message`, combined, {
          parts: [{ type: 'text', text }],
          ...(agentInstructions(session) ? { system: agentInstructions(session) } : {}),
          ...(settings
            ? {
                model: {
                  providerID: settings.model.slice(0, slash),
                  modelID: settings.model.slice(slash + 1),
                },
              }
            : {}),
          ...(settings?.effort ? { variant: settings.effort } : {}),
        }),
      );
      combined.throwIfAborted();
      if (result.info.sessionID !== nativeId) throw new Error('OpenCode 返回了其他会话的结果');
      if (result.info.error)
        throw new Error(`OpenCode：${result.info.error.data?.message ?? result.info.error.name}`);
      const usage = openCodeUsage(result.info);
      if (usage) hooks.usage?.(usage);
      for (const part of result.parts)
        if (part.type === 'text' && part.text && !part.ignored && !part.synthetic)
          hooks.text(part.text);
      complete = true;
    } finally {
      controller.abort(new Error('OpenCode 本轮已结束'));
      if (nativeId && !complete)
        await server
          .request(`/session/${encodeURIComponent(nativeId)}/abort`, AbortSignal.timeout(3000), {})
          .catch(() => {});
      await server.close();
      await stream;
      await Promise.allSettled(jobs);
    }
  }
}
