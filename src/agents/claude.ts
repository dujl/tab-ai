import { claudeUsage } from './token-usage.js';
import { TASK_MCP_SERVER } from '../brand.js';
import { ScopedGrants } from './scoped-grants.js';
import { approvalChoices, approvalAction } from '../core/approval-decisions.js';
import {
  query,
  type Options,
  type SDKMessage,
  type ModelInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ClaudePlans } from './claude-plans.js';
import { approvalPresentation } from './approval.js';
import { toolText } from './tool-events.js';
import {
  type AgentAdapter,
  type AgentModel,
  type AgentRun,
  type Session,
  type AgentUsage,
  type CompactionResult,
} from '../core/types.js';
import { agentEnvironment } from './environment.js';
import { agentInstructions } from '../core/channel-instructions.js';

const questionInput = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      multiSelect: z.boolean().optional(),
      options: z
        .array(z.object({ label: z.string(), description: z.string().optional() }))
        .optional(),
    }),
  ),
});

export function nativeClaudeOptions(
  cwd: string,
  command?: string,
  secretKeys: string[] = [],
): Options {
  return {
    cwd,
    ...(command ? { pathToClaudeCodeExecutable: command } : {}),
    // SDK defaults differ from the CLI; explicitly select the unmodified native preset.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    env: agentEnvironment(secretKeys),
  };
}
export type ClaudeQuery = (
  input: Parameters<typeof query>[0],
) => AsyncIterable<SDKMessage> & { close(): void; supportedModels?(): Promise<ModelInfo[]> };
export class ClaudeAdapter implements AgentAdapter {
  readonly supportsPlans = true;
  readonly requiresPlanDiscovery = true;
  private grants = new ScopedGrants();
  async release(id: string) {
    this.grants.clear(id);
  }
  async close() {
    this.grants.close();
  }
  constructor(
    private command?: string,
    private secretKeys: string[] = [],
    private queryRuntime: ClaudeQuery = query,
  ) {}
  async compact(session: Session, signal: AbortSignal): Promise<CompactionResult> {
    signal.throwIfAborted();
    if (!session.nativeId) throw new Error('此会话尚无原生历史。');
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let usage: AgentUsage | undefined, contextBefore: number | undefined;
    let compacted = false,
      resultText = '',
      completed = false;
    const conversation = this.queryRuntime({
      prompt: '/compact',
      options: {
        ...nativeClaudeOptions(session.workspace, this.command, this.secretKeys),
        resume: session.nativeId,
        ...(agentInstructions(session)
          ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: agentInstructions(session),
              },
            }
          : {}),
        ...(session.settings ? { model: session.settings.model } : {}),
        abortController: controller,
        maxTurns: 1,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        canUseTool: async () => ({
          behavior: 'deny' as const,
          message: '会话压缩期间不执行工作工具。',
        }),
      },
    });
    try {
      for await (const message of conversation) {
        signal.throwIfAborted();
        if (
          (message.type === 'system' &&
            (message.subtype === 'init' || message.subtype === 'compact_boundary')) ||
          message.type === 'result'
        ) {
          if (message.session_id !== session.nativeId)
            throw new Error('Claude 恢复了不同的原生会话；未替换当前上下文。');
        }
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
          compacted = true;
          const metadata = z
            .object({
              pre_tokens: z.number().int().nonnegative(),
              post_tokens: z.number().int().nonnegative().optional(),
            })
            .safeParse(message.compact_metadata);
          if (metadata.success) {
            contextBefore = metadata.data.pre_tokens;
            if (metadata.data.post_tokens !== undefined)
              usage = {
                source: 'claude',
                contextTokens: metadata.data.post_tokens,
                contextKind: 'native',
              };
          }
        }
        if (message.type === 'result') {
          if (message.is_error || message.subtype !== 'success')
            throw new Error('Claude 原生压缩失败，请检查原生登录、额度及会话状态。');
          completed = true;
          resultText = message.result;
          const reported = claudeUsage(message);
          if (reported) usage = { ...usage, ...reported };
        }
      }
      signal.throwIfAborted();
      if (!completed) throw new Error('未收到 Claude 压缩结果。');
      return {
        compacted,
        ...(usage ? { usage } : {}),
        ...(contextBefore === undefined ? {} : { contextBefore }),
        ...(!compacted ? { detail: resultText || '原生会话没有足够内容可压缩。' } : {}),
      };
    } finally {
      signal.removeEventListener('abort', abort);
      controller.abort();
      conversation.close();
    }
  }
  resumeCommand(session: Session): string[] {
    return [
      ...(session.nativeId
        ? [this.command ?? 'claude', '--resume', session.nativeId]
        : [this.command ?? 'claude']),
      ...(session.settings ? ['--model', session.settings.model] : []),
      ...(session.approvalPolicy ? ['--permission-mode', session.approvalPolicy] : []),
      ...(agentInstructions(session)
        ? ['--append-system-prompt', agentInstructions(session)!]
        : []),
      ...(session.settings?.effort ? ['--effort', session.settings.effort] : []),
    ];
  }
  async models(session: Session, signal: AbortSignal): Promise<AgentModel[]> {
    signal.throwIfAborted();
    const controller = new AbortController();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* noMessages(): AsyncGenerator<never> {
      await waiting;
    }
    const conversation = this.queryRuntime({
      prompt: noMessages(),
      options: {
        ...nativeClaudeOptions(session.workspace, this.command, this.secretKeys),
        abortController: controller,
        persistSession: false,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settings: { disableAllHooks: true },
      },
    });
    let rejectAbort!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      controller.abort();
      release();
      rejectAbort(new Error('模型查询已取消'));
      conversation.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (!conversation.supportedModels) throw new Error('Claude SDK 不支持模型能力查询');
      const models = await Promise.race([conversation.supportedModels(), cancelled]);
      return models.map((m) => ({
        id: m.value,
        label: m.displayName,
        efforts: m.supportsEffort
          ? (m.supportedEffortLevels ?? []).map((id) => ({ id, label: id }))
          : [],
      }));
    } finally {
      signal.removeEventListener('abort', abort);
      controller.abort();
      release();
      conversation.close();
    }
  }
  async run({ session, text, hooks, signal, taskBridge, priorPlan }: AgentRun): Promise<void> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const grantedRules = this.grants.values(session).flatMap((value) =>
      (
        value as {
          updates: Extract<
            import('@anthropic-ai/claude-agent-sdk').PermissionUpdate,
            { type: 'addRules' }
          >[];
        }
      ).updates.flatMap((p) =>
        p.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)),
      ),
    );
    let emitted = false,
      completed = false,
      capturedNativeId = false;
    const toolNames = new Map<string, string>();
    const plans = new ClaudePlans(priorPlan);
    const conversation = this.queryRuntime({
      prompt: text,
      options: {
        ...nativeClaudeOptions(session.workspace, this.command, this.secretKeys),
        ...(agentInstructions(session)
          ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: agentInstructions(session),
              },
            }
          : {}),
        ...(session.nativeId ? { resume: session.nativeId } : {}),
        ...(session.settings
          ? {
              model: session.settings.model,
              ...(session.settings.effort
                ? {
                    effort: z
                      .enum(['low', 'medium', 'high', 'xhigh', 'max'])
                      .parse(session.settings.effort),
                  }
                : {}),
            }
          : {}),
        abortController: controller,
        ...(taskBridge
          ? {
              mcpServers: {
                [TASK_MCP_SERVER]: {
                  type: 'http' as const,
                  url: taskBridge.url,
                  headers: { Authorization: `Bearer ${taskBridge.token}` },
                },
              },
            }
          : {}),
        ...(session.approvalPolicy
          ? {
              permissionMode: z
                .enum(['default', 'acceptEdits', 'dontAsk'])
                .parse(session.approvalPolicy),
            }
          : {}),
        ...(grantedRules.length ? { allowedTools: [...new Set(grantedRules)] } : {}),
        canUseTool: async (tool, input, options) => {
          if (
            taskBridge &&
            /^mcp__tab_ai_tasks__(?:task_(list|create|report|review|cancel|progress|report_read|experience)|topic_report)$/.test(
              tool,
            )
          )
            return { behavior: 'allow', updatedInput: input };
          if (tool === 'AskUserQuestion') {
            const parsed = questionInput.parse(input);
            const answer = await hooks.ask(
              {
                kind: 'question',
                title: 'Claude Code 需要你的回答',
                detail: '',
                questions: parsed.questions.map((q, index) => ({
                  id: String(index + 1),
                  question: q.question,
                  options: q.options?.map((o) => o.label),
                  descriptions: q.options?.map((o) => o.description ?? ''),
                  multiSelect: q.multiSelect ?? false,
                  allowOther: true,
                })),
              },
              AbortSignal.any([signal, options.signal]),
            );
            if (!('answers' in answer))
              return { behavior: 'deny', message: 'User did not answer.' };
            return {
              behavior: 'allow',
              updatedInput: {
                ...input,
                answers: Object.fromEntries(
                  parsed.questions.map((q, index) => [
                    q.question,
                    (answer.answers[String(index + 1)] ?? []).join(', '),
                  ]),
                ),
              },
            };
          }
          // Only native allow-rule proposals are eligible; no mode/config changes.
          const suggestions = options.suggestions ?? [];
          const updates =
            suggestions.length &&
            suggestions.every(
              (p) => p.type === 'addRules' && p.behavior === 'allow' && p.rules.length,
            )
              ? suggestions
                  .filter(
                    (p): p is Extract<typeof p, { type: 'addRules' }> => p.type === 'addRules',
                  )
                  .map((p) => ({ ...p, destination: 'session' as const }))
              : [];
          const proposal = { tool, updates },
            signalForTool = AbortSignal.any([signal, options.signal]);
          signalForTool.throwIfAborted();
          // Native rules are reapplied through SDK options on later turns. Any
          // callback that still arrives must be shown again (e.g. enforced ask).
          const presentation = approvalPresentation(
            { ...input, ...(updates.length ? { sessionPermissionRules: updates } : {}) },
            session.workspace,
            false,
            tool === 'Bash',
            tool,
          );
          const answer = await hooks.ask(
            {
              kind: 'approval',
              title: `Claude Code 请求使用 ${tool}`,
              ...presentation,
              approvalOptions: approvalChoices(updates.length > 0, true),
            },
            signalForTool,
          );
          signalForTool.throwIfAborted();
          const action = approvalAction(answer);
          if (action === 'session' && !updates.length)
            throw Error('此请求没有可用于本会话授权的原生规则');
          if (action === 'session') this.grants.add(session, proposal);
          return action === 'allow' || action === 'session'
            ? {
                behavior: 'allow',
                updatedInput: input,
                ...(action === 'session' ? { updatedPermissions: updates } : {}),
                decisionClassification: action === 'session' ? 'user_permanent' : 'user_temporary',
              }
            : {
                behavior: 'deny',
                message: 'The user denied this tool request.',
                ...(action === 'cancel' ? { interrupt: true } : {}),
                decisionClassification: 'user_reject',
              };
        },
      },
    });
    try {
      for await (const message of conversation) {
        signal.throwIfAborted();
        if (
          !capturedNativeId &&
          ((message.type === 'system' && message.subtype === 'init') || message.type === 'result')
        ) {
          hooks.nativeId(message.session_id);
          capturedNativeId = true;
        }
        if (
          message.type === 'system' &&
          message.subtype === 'init' &&
          message.session_id === session.nativeId &&
          Array.isArray(message.tools)
        )
          hooks.capabilities?.({
            plans: message.tools.some((name) =>
              ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(name),
            ),
          });
        if (message.session_id === session.nativeId) {
          const usage = claudeUsage(message);
          if (usage) hooks.usage?.(usage);
        }
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text) {
              hooks.text(block.text);
              emitted = true;
            } else if (block.type === 'tool_use') {
              toolNames.set(block.id, block.name);
              const input = block.input as Record<string, unknown> | undefined;
              if (
                !message.parent_tool_use_id &&
                message.session_id === session.nativeId &&
                plans.use(block.id, block.name, input)
              )
                hooks.capabilities?.({ plans: true });
              if (hooks.tool)
                hooks.tool({
                  id: block.id,
                  name: block.name,
                  status: 'running',
                  input: toolText(input?.command ?? block.input),
                });
              else hooks.activity(block.name);
            }
          }
        } else if (message.type === 'user' && Array.isArray(message.message.content)) {
          for (const block of message.message.content)
            if (block.type === 'tool_result' && toolNames.has(block.tool_use_id)) {
              const output =
                typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .filter((b) => b.type === 'text')
                        .map((b) => ('text' in b ? b.text : ''))
                        .join('\n')
                    : '';
              hooks.tool?.({
                id: block.tool_use_id,
                name: toolNames.get(block.tool_use_id)!,
                status: block.is_error ? 'failed' : 'completed',
                output,
              });
              const count = message.message.content.filter((b) => b.type === 'tool_result').length;
              let structured = count === 1 ? message.tool_use_result : undefined;
              if (structured === undefined)
                try {
                  structured = JSON.parse(output);
                } catch {}
              const plan = plans.result(block.tool_use_id, !!block.is_error, structured);
              if (plan) hooks.plan?.(plan);
            }
        } else if (message.type === 'result') {
          if (message.subtype !== 'success') throw new Error(message.errors.join('\n'));
          if (message.is_error) throw new Error(message.result);
          if (!emitted && message.result) hooks.text(message.result);
          completed = true;
        }
      }
      if (!completed) throw new Error('Claude Code 连接关闭，未收到本轮完成事件。');
    } finally {
      signal.removeEventListener('abort', abort);
      conversation.close();
    }
  }
}
