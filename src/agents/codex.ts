import { CodexUsageHistory } from './codex-usage-history.js';
import { codexUsage } from './token-usage.js';
import { TASK_MCP_SERVER } from '../brand.js';
import { codexElicitation, elicitationEnvelope } from './codex-elicitation.js';
import { approvalChoices, approvalAction } from '../core/approval-decisions.js';
import {
  approvalPolicyContext,
  nativeApprovalPolicy,
  selectedApprovalPolicy,
} from '../core/approval-policy.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { RpcProcess, type RpcMessage } from './rpc.js';
import {
  type AgentAdapter,
  type AgentModel,
  type AgentRun,
  type Session,
  type Interaction,
} from '../core/types.js';
import { agentEnvironment } from './environment.js';
import { approvalPresentation } from './approval.js';
import { codexTool } from './tool-events.js';
import { sameWorkspace } from '../core/session-workspace.js';
import { CodexMaintenance } from './codex-maintenance.js';
import { channelInstructions, codexInstructions } from '../core/channel-instructions.js';
import { prepareCodexInstructions } from './codex-instructions.js';

const threadResult = z.object({
  thread: z.object({ id: z.string(), cwd: z.string().optional() }),
  approvalPolicy: z.unknown().optional(),
});
const itemEvent = z.object({
  item: z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
});
const turnEvent = z.object({
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.object({ message: z.string() }).nullable().optional(),
  }),
});
const questions = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      isSecret: z.boolean().optional(),
      isOther: z.boolean().optional(),
      options: z
        .array(z.object({ label: z.string(), description: z.string().optional() }))
        .nullable()
        .optional(),
    }),
  ),
});
const planUpdate = z.object({
  threadId: z.string(),
  turnId: z.string(),
  explanation: z.string().max(16000).nullish(),
  plan: z
    .array(
      z.object({
        step: z.string().min(1).max(8000),
        status: z.enum(['pending', 'inProgress', 'completed']),
      }),
    )
    .max(500),
});
const asyncQuestions = z.object({
  id: z.string().min(1),
  delivery: z.literal('async'),
  questions: z
    .array(z.object({ title: z.string().min(1), options: z.array(z.string().min(1)).nullish() }))
    .min(1),
});

export class CodexAdapter implements AgentAdapter {
  private usageHistory = new CodexUsageHistory();
  historicalUsage(session: Session) {
    return this.usageHistory.read(session);
  }
  readonly supportsPlans = true;
  readonly supportsWorkspaceSwitch = true;
  private maintenance: CodexMaintenance;
  private warm = new Map<
    string,
    {
      rpc: RpcProcess;
      threadId: string;
      fingerprint: string;
      approvalContext?: Interaction['approvalContext'];
      discard: (reason: string) => void;
    }
  >();
  private running = new Set<string>();
  private fingerprint(session: Session) {
    return JSON.stringify([
      session.nativeId,
      session.workspace,
      session.settings,
      session.approvalPolicy,
      codexInstructions(session),
    ]);
  }
  async release(id: string, reason = '本会话临时授权运行实例已清除') {
    const worker = this.warm.get(id);
    this.warm.delete(id);
    if (worker) {
      try {
        worker.discard(reason);
      } finally {
        this.maintenance.detach(id, worker.rpc);
        await worker.rpc.close();
      }
    }
  }
  async close() {
    await Promise.all([...this.warm.keys()].map((id) => this.release(id)));
  }
  private live = new Map<string, { rpc: RpcProcess; threadId: string; turnId?: string }>();
  constructor(
    private command = 'codex',
    private secretKeys: string[] = [],
    private maxIdleWorkers = 8,
  ) {
    this.maintenance = new CodexMaintenance(command, secretKeys);
  }
  async compact(session: Session, signal: AbortSignal) {
    await this.release(session.id);
    return this.maintenance.compact(session, signal);
  }
  loops(session: Session, signal: AbortSignal) {
    return this.maintenance.loops(session, signal);
  }
  stopLoop(session: Session, id: string, signal: AbortSignal) {
    return this.maintenance.stopLoop(session, id, signal);
  }
  async steer(session: Session, text: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const live = this.live.get(session.id);
    if (!live?.turnId || live.threadId !== session.nativeId) return false;
    // An expected turn ID prevents input from landing in an unrelated turn.
    const expectedTurnId = live.turnId;
    const result = z.object({ turnId: z.string() }).parse(
      await live.rpc.request('turn/steer', {
        threadId: live.threadId,
        expectedTurnId,
        input: [{ type: 'text', text, text_elements: [] }],
      }),
    );
    if (result.turnId !== expectedTurnId) throw new Error('原生回答未确认提交到预期轮次');
    return true;
  }
  resumeCommand(session: Session): string[] {
    if (channelInstructions(session) && session.codexDeveloperInstructions === undefined)
      throw new Error(
        '此历史会话尚未加载原生指令快照；请先在 tab-ai 完成一轮任务，再交回终端，以保留原生指令和通道背景。',
      );
    const policy = nativeApprovalPolicy(session);
    return [
      ...(session.nativeId ? [this.command, 'resume', session.nativeId] : [this.command]),
      '--cd',
      session.workspace,
      ...(policy ? ['-c', `approval_policy=${JSON.stringify(policy)}`] : []),
      ...(session.settings ? ['--model', session.settings.model] : []),
      ...(codexInstructions(session)
        ? ['-c', `developer_instructions=${JSON.stringify(codexInstructions(session))}`]
        : []),
      ...(session.settings?.effort
        ? ['-c', `model_reasoning_effort=${JSON.stringify(session.settings.effort)}`]
        : []),
    ];
  }
  async models(session: Session, signal: AbortSignal): Promise<AgentModel[]> {
    signal.throwIfAborted();
    const rpc = new RpcProcess(
      this.command,
      ['app-server'],
      session.workspace,
      agentEnvironment(this.secretKeys),
    );
    const abort = () => {
      void rpc.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    const page = z.object({
      data: z.array(
        z.object({
          model: z.string(),
          displayName: z.string(),
          hidden: z.boolean().optional(),
          defaultReasoningEffort: z.string().optional(),
          supportedReasoningEfforts: z.array(
            z.object({ reasoningEffort: z.string(), description: z.string() }),
          ),
        }),
      ),
      nextCursor: z.string().nullable().optional(),
    });
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'tab-ai-settings', version: '0.3.0' },
      });
      rpc.write({ method: 'initialized' });
      const models: AgentModel[] = [],
        seen = new Set<string>();
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const result = page.parse(
          await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }),
        );
        models.push(
          ...result.data
            .filter((m) => !m.hidden)
            .map((m) => ({
              id: m.model,
              label: m.displayName,
              defaultEffort: m.defaultReasoningEffort,
              efforts: m.supportedReasoningEfforts.map((e) => ({
                id: e.reasoningEffort,
                label: e.description,
              })),
            })),
        );
        cursor = result.nextCursor ?? undefined;
        if (cursor && (seen.has(cursor) || models.length > 500))
          throw new Error('模型列表分页异常');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return models;
    } finally {
      signal.removeEventListener('abort', abort);
      await rpc.close();
    }
  }
  async run({ session, text, hooks, signal, taskBridge }: AgentRun): Promise<void> {
    signal.throwIfAborted();
    if (this.running.has(session.id)) throw Error('此 Codex 会话已有执行轮次');
    this.running.add(session.id);
    if (
      this.warm.has(session.id) &&
      this.warm.get(session.id)!.fingerprint !== this.fingerprint(session)
    )
      await this.release(session.id);
    const prior = this.warm.get(session.id);
    this.warm.delete(session.id);
    let approvalContext =
      prior?.approvalContext ?? approvalPolicyContext('codex', selectedApprovalPolicy(session));
    const rpc =
      prior?.rpc ??
      new RpcProcess(
        this.command,
        ['app-server'],
        session.workspace,
        agentEnvironment(this.secretKeys),
      );
    let keep = !!prior,
      completed = false;
    let taskClient: Client | undefined;
    const taskNames = new Set<string>();
    let turnId: string | undefined;
    const seenQuestions = new Set<string>();
    const pendingElicitations = new Map<string | number, AbortController>();
    const cancelElicitations = () => {
      for (const controller of pendingElicitations.values())
        controller.abort(new Error('原生请求已结束'));
      pendingElicitations.clear();
    };
    let resolveDone!: () => void, rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Register a handler immediately: the server may complete before turn/start responds.
    void done.catch(() => {});
    rpc.onFailure = rejectDone;
    const abort = () => {
      if (turnId && session.nativeId)
        void rpc.request('turn/interrupt', { threadId: session.nativeId, turnId }).catch(() => {});
      rejectDone(new Error('任务已中断'));
      void rpc.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    rpc.onMessage = (message) => {
      if (message.id !== undefined && message.method) {
        if (
          message.method === 'mcpServer/elicitation/request' &&
          pendingElicitations.has(message.id)
        )
          return;
        const controller =
          message.method === 'mcpServer/elicitation/request' ? new AbortController() : undefined;
        if (controller) pendingElicitations.set(message.id, controller);
        void this.answer(
          rpc,
          message,
          hooks,
          controller ? AbortSignal.any([signal, controller.signal]) : signal,
          session.workspace,
          taskClient,
          taskNames,
          session.nativeId,
          () => {
            keep = true;
          },
          approvalContext,
        )
          .catch((error) => {
            if (!controller?.signal.aborted || signal.aborted) rejectDone(error);
          })
          .finally(() => {
            if (controller && pendingElicitations.get(message.id!) === controller)
              pendingElicitations.delete(message.id!);
          });
        return;
      }
      try {
        const context = message.params as { threadId?: string; turnId?: string } | undefined;
        if (context?.threadId && session.nativeId && context.threadId !== session.nativeId) return;
        if (context?.turnId && turnId && context.turnId !== turnId) return;
        if (message.method === 'serverRequest/resolved') {
          const p = message.params as { threadId?: string; requestId?: string | number };
          if (p?.threadId === session.nativeId && p.requestId !== undefined)
            pendingElicitations.get(p.requestId)?.abort(new Error('原生请求已结束'));
        } else if (message.method === 'thread/tokenUsage/updated') {
          const value = codexUsage(message.params, session.nativeId);
          if (value) hooks.usage?.(value);
        } else if (message.method === 'turn/plan/updated') {
          const value = planUpdate.safeParse(message.params);
          if (
            value.success &&
            value.data.threadId === session.nativeId &&
            value.data.turnId === turnId
          )
            hooks.plan?.({
              source: 'codex',
              nativeTurnId: value.data.turnId,
              ...(value.data.explanation ? { explanation: value.data.explanation } : {}),
              steps: value.data.plan.map((s) => ({
                text: s.step,
                status: s.status === 'inProgress' ? 'in_progress' : s.status,
              })),
            });
        } else if (message.method === 'item/completed') {
          const { item } = itemEvent.parse(message.params);
          if (item.type === 'agentMessage') {
            const question = asyncQuestions.safeParse(item);
            if (question.success && hooks.askAsync) {
              if (!seenQuestions.has(question.data.id)) {
                seenQuestions.add(question.data.id);
                hooks.askAsync({
                  kind: 'question',
                  title: 'Codex 需要你补充信息',
                  detail: '',
                  questions: question.data.questions.map((q, i) => ({
                    id: String(i + 1),
                    question: q.title,
                    options: q.options ?? undefined,
                    allowOther: true,
                    multiSelect: false,
                  })),
                });
              }
            } else if (item.text) hooks.text(item.text);
          }
          const tool = codexTool(item, true);
          if (tool) hooks.tool?.(tool);
        } else if (message.method === 'item/started') {
          const parsed = itemEvent.safeParse(message.params);
          if (parsed.success) {
            const tool = codexTool(parsed.data.item, false);
            if (tool && hooks.tool) hooks.tool(tool);
            else if (!['reasoning', 'userMessage', 'agentMessage'].includes(parsed.data.item.type))
              hooks.activity(parsed.data.item.type);
          }
        } else if (message.method === 'turn/started') {
          turnId = turnEvent.parse(message.params).turn.id;
          const live = this.live.get(session.id);
          if (live) live.turnId = turnId;
        } else if (message.method === 'turn/completed') {
          const { turn } = turnEvent.parse(message.params);
          cancelElicitations();
          const live = this.live.get(session.id);
          if (live) live.turnId = undefined;
          if (turn.status === 'completed') resolveDone();
          else
            rejectDone(
              new Error(
                turn.error?.message || `任务${turn.status === 'interrupted' ? '已中断' : '失败'}`,
              ),
            );
        }
      } catch (error) {
        rejectDone(error instanceof Error ? error : new Error(String(error)));
      }
    };
    try {
      if (!prior)
        await rpc.request('initialize', {
          clientInfo: { name: 'tab-ai', title: 'tab-ai', version: '0.3.0' },
          capabilities: { experimentalApi: true },
        });
      if (!prior) rpc.write({ method: 'initialized' });
      let dynamicTools: object[] | undefined;
      if (taskBridge) {
        taskClient = new Client({ name: 'tab-ai-codex-task-tools', version: '0.3.0' });
        await taskClient.connect(
          new StreamableHTTPClientTransport(new URL(taskBridge.url), {
            requestInit: { headers: { Authorization: `Bearer ${taskBridge.token}` } },
          }),
        );
        const listed = await taskClient.listTools();
        dynamicTools = listed.tools.map((tool) => {
          taskNames.add(tool.name);
          return {
            type: 'function',
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
          };
        });
      }
      // Only explicit per-session choices override native model defaults.
      if (!prior) await prepareCodexInstructions(session, rpc);
      const result = prior
        ? { thread: { id: prior.threadId, cwd: session.workspace }, approvalPolicy: undefined }
        : threadResult.parse(
            await rpc.request(session.nativeId ? 'thread/resume' : 'thread/start', {
              ...(session.nativeId ? { threadId: session.nativeId } : {}),
              cwd: session.workspace,
              ...(!session.nativeId && dynamicTools ? { dynamicTools } : {}),
              ...(session.nativeId && taskBridge && session.codexTaskTools !== 'dynamic'
                ? {
                    config: {
                      [`mcp_servers.${TASK_MCP_SERVER}`]: {
                        url: taskBridge.url,
                        http_headers: { Authorization: `Bearer ${taskBridge.token}` },
                        enabled: true,
                      },
                    },
                  }
                : {}),
              ...(nativeApprovalPolicy(session)
                ? { approvalPolicy: nativeApprovalPolicy(session) }
                : {}),
              ...(session.settings ? { model: session.settings.model } : {}),
              ...(codexInstructions(session)
                ? { developerInstructions: codexInstructions(session) }
                : {}),
            }),
          );
      if (result.approvalPolicy !== undefined)
        approvalContext = approvalPolicyContext('codex', result.approvalPolicy, true);
      if (
        (session.nativeId && result.thread.id !== session.nativeId) ||
        (result.thread.cwd !== undefined && !sameWorkspace(result.thread.cwd, session.workspace))
      )
        throw new Error('Codex 原生会话或工作目录与请求不匹配；未创建替代上下文。');
      if (taskBridge && !session.codexTaskTools)
        session.codexTaskTools = session.nativeId ? 'mcp' : 'dynamic';
      session.nativeId = result.thread.id;
      this.live.set(session.id, { rpc, threadId: result.thread.id });
      this.maintenance.attach(session.id, rpc);
      hooks.nativeId(result.thread.id);
      signal.throwIfAborted();
      await rpc.request('turn/start', {
        threadId: result.thread.id,
        cwd: session.workspace,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(session.settings
          ? {
              model: session.settings.model,
              ...(session.settings.effort ? { effort: session.settings.effort } : {}),
            }
          : {}),
      });
      await done;
      completed = true;
    } finally {
      cancelElicitations();
      if (this.live.get(session.id)?.rpc === rpc) this.live.delete(session.id);
      this.maintenance.detach(session.id, rpc);
      signal.removeEventListener('abort', abort);
      await taskClient?.close().catch(() => {});
      this.running.delete(session.id);
      if (completed && keep && !signal.aborted) {
        while (this.warm.size >= this.maxIdleWorkers && this.warm.size)
          await this.release(
            this.warm.keys().next().value!,
            '本会话原生授权缓存因空闲实例回收而失效；历史保留，下次需要时重新审批',
          );
        this.warm.set(session.id, {
          rpc,
          threadId: session.nativeId!,
          fingerprint: this.fingerprint(session),
          approvalContext,
          discard: (reason) => hooks.activity(reason),
        });
        this.maintenance.attach(session.id, rpc);
        rpc.onFailure = () => {
          void this.release(session.id);
        };
        // Idle workers have no authority to start untracked turns or tools.
        rpc.onMessage = (message) => {
          if ((message.id !== undefined && message.method) || message.method === 'turn/started')
            void this.release(session.id);
        };
      } else await rpc.close();
    }
  }
  private async answer(
    rpc: RpcProcess,
    message: RpcMessage,
    hooks: AgentRun['hooks'],
    signal: AbortSignal,
    workspace: string,
    taskClient?: Client,
    taskNames?: Set<string>,
    threadId?: string,
    onSessionApproval?: () => void,
    approvalContext?: Interaction['approvalContext'],
  ): Promise<void> {
    const method = message.method!;
    let result: unknown;
    if (method === 'item/tool/call' && taskClient) {
      const params = z
        .object({
          threadId: z.string(),
          callId: z.string(),
          tool: z.string(),
          namespace: z.string().nullable().optional(),
          arguments: z.record(z.string(), z.unknown()),
        })
        .parse(message.params);
      if (params.threadId !== threadId || params.namespace || !taskNames?.has(params.tool))
        throw new Error('任务工具不属于当前会话');
      hooks.tool?.({
        id: params.callId,
        name: params.tool,
        status: 'running',
        input: JSON.stringify(params.arguments),
      });
      const output = await taskClient.callTool({ name: params.tool, arguments: params.arguments });
      const content = Array.isArray(output.content)
        ? output.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => ({ type: 'inputText', text: String(c.text) }))
        : [];
      result = { contentItems: content, success: !output.isError };
      hooks.tool?.({
        id: params.callId,
        name: params.tool,
        status: output.isError ? 'failed' : 'completed',
        output: content.map((c) => c.text).join('\n'),
      });
    } else if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      const params = z
        .object({
          threadId: z.string().optional(),
          turnId: z.string().optional(),
          availableDecisions: z.array(z.unknown()).nullish(),
        })
        .passthrough()
        .parse(message.params);
      if (params.threadId && params.threadId !== threadId)
        throw Error('审批请求不属于当前原生会话');
      const nativeActions = {
        allow: 'accept',
        session: 'acceptForSession',
        deny: 'decline',
        cancel: 'cancel',
      };
      const choices = approvalChoices(true, true).filter(
        (c) =>
          !params.availableDecisions || params.availableDecisions.includes(nativeActions[c.id]),
      );
      const active = [...this.live.values()].find((v) => v.rpc === rpc);
      if (params.turnId && (!active?.turnId || params.turnId !== active.turnId))
        throw Error('审批请求不属于当前原生轮次');
      const request = {
        kind: 'approval' as const,
        title: method.includes('commandExecution') ? 'Codex 请求执行命令' : 'Codex 请求修改文件',
        ...approvalPresentation(
          message.params,
          workspace,
          true,
          method.includes('commandExecution'),
        ),
        approvalOptions: choices,
        approvalContext,
      };
      const answer = await hooks.ask(request, signal),
        action = approvalAction(answer);
      if (!choices.some((c) => c.id === action)) throw Error('原生请求不支持此审批范围');
      if (action === 'session') onSessionApproval?.();
      result = {
        decision: {
          allow: 'accept',
          session: 'acceptForSession',
          deny: 'decline',
          cancel: 'cancel',
        }[action],
      };
    } else if (method === 'mcpServer/elicitation/request') {
      const parsed = elicitationEnvelope.safeParse(message.params),
        active = [...this.live.values()].find((v) => v.rpc === rpc);
      if (
        !parsed.success ||
        parsed.data.threadId !== threadId ||
        (parsed.data.turnId && parsed.data.turnId !== active?.turnId)
      ) {
        rpc.write({
          id: message.id,
          error: {
            code: -32602,
            message: 'MCP request does not belong to the active thread or turn',
          },
        });
        return;
      }
      result = await codexElicitation(parsed.data, hooks, signal);
    } else if (method === 'item/tool/requestUserInput') {
      const parsed = questions.parse(message.params);
      if (parsed.questions.some((q) => q.isSecret)) {
        rpc.write({
          id: message.id,
          error: {
            code: -32602,
            message: 'Secret input is not supported over chat. Use the native terminal.',
          },
        });
        throw new Error('Agent 请求敏感输入，请在原生终端中继续。');
      }
      const answer = await hooks.ask(
        {
          kind: 'question',
          title: 'Codex 需要你的回答',
          detail: '',
          questions: parsed.questions.map((q) => ({
            id: q.id,
            question: q.question,
            options: q.options?.map((o) => o.label),
            descriptions: q.options?.map((o) => o.description ?? ''),
            multiSelect: false,
            allowOther: q.isOther ?? true,
          })),
        },
        signal,
      );
      result = {
        answers:
          'answers' in answer
            ? Object.fromEntries(
                Object.entries(answer.answers).map(([key, values]) => [key, { answers: values }]),
              )
            : {},
      };
    } else {
      // Fail closed for newer protocol requests instead of silently authorizing them.
      rpc.write({
        id: message.id,
        error: { code: -32601, message: `Unsupported native request: ${method}` },
      });
      throw new Error(`需要原生终端处理的请求: ${method}`);
    }
    signal.throwIfAborted();
    rpc.write({ id: message.id, result });
  }
}
