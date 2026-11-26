import { z } from 'zod';
import { TASK_MCP_SERVER } from '../brand.js';
import { approvalAction, approvalChoices } from '../core/approval-decisions.js';
import {
  approvalPolicyContext,
  selectedApprovalPolicy,
  nativeApprovalPolicy,
} from '../core/approval-policy.js';
import { agentPlanSchema } from '../core/agent-plans.js';
import { agentInstructions } from '../core/channel-instructions.js';
import { type AgentAdapter, type AgentModel, type AgentRun, type Session } from '../core/types.js';
import { approvalPresentation } from './approval.js';
import { agentEnvironment } from './environment.js';
import { RpcProcess, type RpcMessage } from './rpc.js';
import { ScopedGrants } from './scoped-grants.js';
import { agyContextUsage, agyUsage } from './token-usage.js';
import { acpTool } from './tool-events.js';
import { AgyDiagnostics, agyFailure } from './agy-diagnostics.js';

const selectOptionValue = z
  .object({
    value: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullish(),
  })
  .passthrough();
const selectOptionGroup = z
  .object({
    group: z.string().optional(),
    name: z.string().optional(),
    options: z.array(selectOptionValue),
  })
  .passthrough();
const configOptionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    category: z.string().nullish(),
    type: z.string().optional(),
    currentValue: z.unknown().optional(),
    options: z.array(z.union([selectOptionValue, selectOptionGroup])).optional(),
  })
  .passthrough();
type ConfigOption = z.infer<typeof configOptionSchema>;

const initializeResult = z
  .object({
    protocolVersion: z.number().optional(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        load_session: z.boolean().optional(),
        sessionCapabilities: z
          .object({
            resume: z.unknown().optional(),
            load: z.unknown().optional(),
            close: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
        session_capabilities: z
          .object({
            resume: z.unknown().optional(),
            load: z.unknown().optional(),
            close: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
        _meta: z
          .object({
            antigravity: z
              .object({
                systemPrompt: z
                  .object({
                    append: z.boolean().optional(),
                  })
                  .passthrough()
                  .optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const sessionResponseSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    configOptions: z.array(configOptionSchema).optional(),
    models: z
      .object({
        currentModelId: z.string().optional(),
        availableModels: z
          .array(
            z
              .object({
                modelId: z.string().min(1),
                name: z.string().min(1),
                description: z.string().nullish(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    modes: z
      .object({
        currentModeId: z.string().optional(),
        availableModes: z
          .array(
            z
              .object({
                id: z.string().min(1),
                name: z.string().min(1),
                description: z.string().nullish(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const setConfigOptionResponse = z
  .object({
    configOptions: z.array(configOptionSchema).optional(),
  })
  .passthrough();

const permissionOptionSchema = z
  .object({
    optionId: z.string().min(1),
    name: z.string().optional(),
    kind: z.string().optional(),
  })
  .passthrough();

const permissionRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    toolCall: z
      .object({
        toolCallId: z.string().optional(),
        title: z.string().nullish(),
        kind: z.string().nullish(),
        status: z.string().nullish(),
        rawInput: z.unknown().optional(),
        locations: z
          .array(z.object({ path: z.string(), line: z.number().optional() }).passthrough())
          .optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    options: z.array(permissionOptionSchema),
  })
  .passthrough();

const promptResponseSchema = z
  .object({
    stopReason: z.string().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

const TASK_TOOL_PATTERN = new RegExp(
  `^(?:Run\\s+)?(?:mcp_{1,2})?${TASK_MCP_SERVER}(?:_{1,2}|\\/|:|\\.)(?:task_(?:list|create|report|review|cancel|progress|report_read|experience)|topic_report)$`,
);

function flattenSelectOptions(
  option?: ConfigOption,
): { value: string; name: string; description?: string | null }[] {
  if (!option?.options) return [];
  const result: { value: string; name: string; description?: string | null }[] = [];
  for (const item of option.options) {
    if ('options' in item && Array.isArray(item.options)) result.push(...item.options);
    else if (typeof item.value === 'string' && typeof item.name === 'string')
      result.push({
        value: item.value,
        name: item.name,
        description: typeof item.description === 'string' ? item.description : null,
      });
  }
  return result;
}

function findConfigOption(
  options: ConfigOption[] | undefined,
  categories: string[],
  ids: string[],
): ConfigOption | undefined {
  if (!options) return undefined;
  return (
    options.find((opt) => opt.category && categories.includes(opt.category)) ??
    options.find((opt) => ids.includes(opt.id))
  );
}

function extractModels(result: z.infer<typeof sessionResponseSchema>): AgentModel[] {
  const effortOption = findConfigOption(
    result.configOptions,
    ['thought_level'],
    ['thought_level', 'effort', 'reasoning_effort'],
  );
  const efforts = flattenSelectOptions(effortOption).map((opt) => ({
    id: opt.value,
    label: opt.description ? `${opt.name} (${opt.description})` : opt.name,
  }));
  const defaultEffort =
    typeof effortOption?.currentValue === 'string' &&
    efforts.some((e) => e.id === effortOption.currentValue)
      ? effortOption.currentValue
      : undefined;

  const modelOption = findConfigOption(result.configOptions, ['model'], ['model']);
  const fromConfig = flattenSelectOptions(modelOption);
  if (fromConfig.length) {
    const availableIds = new Set(
      (result.models?.availableModels ?? []).map((model) => model.modelId),
    );
    return fromConfig.map((opt) => {
      let modelEfforts = efforts;
      if (availableIds.size && efforts.length) {
        const matched = efforts.filter((effort) => availableIds.has(`${opt.value}-${effort.id}`));
        if (matched.length) modelEfforts = matched;
        else if (availableIds.has(opt.value)) modelEfforts = [];
      }
      const modelDefaultEffort =
        defaultEffort && modelEfforts.some((e) => e.id === defaultEffort)
          ? defaultEffort
          : undefined;
      return {
        id: opt.value,
        label: opt.name,
        efforts: modelEfforts,
        ...(modelDefaultEffort ? { defaultEffort: modelDefaultEffort } : {}),
      };
    });
  }
  if (result.models?.availableModels?.length) {
    return result.models.availableModels.map((model) => ({
      id: model.modelId,
      label: model.name,
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
    }));
  }
  return [];
}

function contentText(content: unknown): string {
  if (!content) return '';
  if (Array.isArray(content)) return content.map((block) => contentText(block)).join('');
  if (typeof content === 'object') {
    const block = content as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

function requireAvailableModel(
  loaded: z.infer<typeof sessionResponseSchema>,
  options: ConfigOption[] | undefined,
  selected?: string,
) {
  const modelOption = findConfigOption(options, ['model'], ['model']);
  // Older ACP versions may omit model discovery entirely. If discovery is
  // advertised, an empty catalogue is not evidence of a usable native default.
  if (modelOption?.options === undefined && loaded.models?.availableModels === undefined) return;
  const catalogue = extractModels({ ...loaded, configOptions: options });
  if (!catalogue.length || loaded.models?.availableModels?.length === 0)
    throw new Error('Antigravity CLI 未加载可用模型目录；本轮未发送。请刷新模型列表后重试。');
  const current =
    selected ??
    (typeof modelOption?.currentValue === 'string'
      ? modelOption.currentValue
      : loaded.models?.currentModelId);
  if (current && !catalogue.some((model) => model.id === current))
    throw new Error(
      'Antigravity CLI 当前模型不在可用模型目录中；本轮未发送。请在本会话模型设置中重新选择模型。',
    );
}

function isTaskBridgeTool(toolCall: z.infer<typeof permissionRequestSchema>['toolCall']): boolean {
  if (!toolCall) return false;
  const metaName =
    typeof toolCall._meta?.toolName === 'string'
      ? toolCall._meta.toolName
      : typeof toolCall._meta?.name === 'string'
        ? toolCall._meta.name
        : undefined;
  if (metaName && TASK_TOOL_PATTERN.test(metaName)) return true;
  if (typeof toolCall.title === 'string' && TASK_TOOL_PATTERN.test(toolCall.title.trim()))
    return true;
  return false;
}

function permissionPayload(
  toolCall: z.infer<typeof permissionRequestSchema>['toolCall'],
): Record<string, unknown> {
  const rawInput: Record<string, unknown> =
    toolCall?.rawInput && typeof toolCall.rawInput === 'object' && !Array.isArray(toolCall.rawInput)
      ? { ...(toolCall.rawInput as Record<string, unknown>) }
      : toolCall?.rawInput !== undefined
        ? { input: toolCall.rawInput }
        : {};
  const command =
    typeof rawInput.command === 'string'
      ? rawInput.command
      : typeof rawInput.CommandLine === 'string'
        ? rawInput.CommandLine
        : undefined;
  const cwd =
    typeof rawInput.cwd === 'string'
      ? rawInput.cwd
      : typeof rawInput.Cwd === 'string'
        ? rawInput.Cwd
        : undefined;
  const filePath =
    typeof rawInput.file_path === 'string'
      ? rawInput.file_path
      : typeof rawInput.path === 'string'
        ? rawInput.path
        : typeof rawInput.Path === 'string'
          ? rawInput.Path
          : toolCall?.locations?.length === 1
            ? toolCall.locations[0]!.path
            : undefined;
  const summary =
    typeof rawInput.description === 'string' && rawInput.description.trim()
      ? rawInput.description
      : typeof rawInput.toolSummary === 'string' && rawInput.toolSummary.trim()
        ? rawInput.toolSummary
        : toolCall?.title && toolCall.title !== command
          ? toolCall.title
          : undefined;
  delete rawInput.CommandLine;
  delete rawInput.Cwd;
  delete rawInput.Path;
  delete rawInput.path;
  delete rawInput.toolSummary;
  delete rawInput.WaitMsBeforeAsync;
  delete rawInput.NotificationTimeoutSeconds;
  delete rawInput.IsDaemon;
  return {
    ...rawInput,
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(filePath !== undefined ? { file_path: filePath } : {}),
    ...(summary !== undefined ? { description: summary } : {}),
    ...(toolCall?.kind && toolCall.kind !== 'other' && !(toolCall.kind === 'execute' && command)
      ? { permission: toolCall.kind }
      : {}),
    ...(toolCall?.locations && toolCall.locations.length > 1
      ? { locations: toolCall.locations.map((loc) => loc.path) }
      : {}),
  };
}

export class AgyAdapter implements AgentAdapter {
  readonly supportsPlans = true;
  private grants = new ScopedGrants();
  constructor(
    private command = 'agy',
    private secretKeys: string[] = [],
    private inputAcceptanceTimeoutMs = 90_000,
  ) {}
  async release(id: string) {
    this.grants.clear(id);
  }
  async close() {
    this.grants.close();
  }
  resumeCommand(session: Session): string[] {
    return [
      this.command,
      ...(session.nativeId ? ['--resume', session.nativeId] : []),
      ...(session.settings ? ['--model', session.settings.model] : []),
      ...(session.settings?.effort ? ['--effort', session.settings.effort] : []),
      ...(session.approvalPolicy &&
      ['accept-edits', 'auto', 'plan'].includes(session.approvalPolicy)
        ? ['--mode', session.approvalPolicy]
        : []),
    ];
  }
  private startRpc(cwd: string) {
    const diagnostics = new AgyDiagnostics();
    const rpc = new RpcProcess(
      this.command,
      ['acp', '--log-file', diagnostics.file],
      cwd,
      agentEnvironment(this.secretKeys),
      { jsonrpc: '2.0' },
    );
    return { rpc, diagnostics };
  }
  private async initialize(rpc: RpcProcess, clientName: string) {
    const raw = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: clientName, title: 'tab-ai', version: '0.3.0' },
    });
    const parsed = initializeResult.parse(raw);
    const caps = parsed.agentCapabilities;
    const sessionCaps = caps?.sessionCapabilities ?? caps?.session_capabilities;
    return {
      supportsResume: !!sessionCaps?.resume,
      supportsLoad: !!(caps?.loadSession ?? caps?.load_session ?? sessionCaps?.load),
      supportsClose: !!sessionCaps?.close,
      systemPromptAppend: caps?._meta?.antigravity?.systemPrompt?.append,
    };
  }
  async models(session: Session, signal: AbortSignal): Promise<AgentModel[]> {
    signal.throwIfAborted();
    const { rpc, diagnostics } = this.startRpc(session.workspace);
    const abort = () => {
      void rpc.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    let createdSessionId: string | undefined;
    let supportsClose = false;
    try {
      const caps = await this.initialize(rpc, 'tab-ai-settings');
      supportsClose = caps.supportsClose;
      signal.throwIfAborted();
      const created = sessionResponseSchema.parse(
        await rpc.request('session/new', { cwd: session.workspace, mcpServers: [] }),
      );
      createdSessionId = created.sessionId;
      signal.throwIfAborted();
      const catalog = extractModels(created);
      if (!catalog.length)
        throw new Error(diagnostics.failure()?.message ?? 'Antigravity CLI 未返回可用模型列表。');
      return catalog;
    } catch (error) {
      const diagnostic = diagnostics.failure();
      const failure = diagnostic?.terminal
        ? diagnostic
        : (agyFailure(error instanceof Error ? error.message : '') ?? diagnostic);
      if (failure) throw new Error(failure.message);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (supportsClose && createdSessionId && !signal.aborted)
        await rpc.request('session/close', { sessionId: createdSessionId }, 2000).catch(() => {});
      await rpc.close();
      diagnostics.close();
    }
  }
  async run({ session, text, hooks, signal, taskBridge }: AgentRun): Promise<void> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const { rpc, diagnostics } = this.startRpc(session.workspace);
    const jobs = new Set<Promise<void>>();
    const tools = new Map<string, { name: string; input?: string }>();
    let activeSessionId: string | undefined;
    let acceptingUpdates = false;
    let pendingText = '';
    let lastContext: { contextTokens?: number; modelContextWindow?: number } | undefined;
    let supportsClose = false;
    let completed = false;

    const flushText = () => {
      if (!pendingText) return;
      const chunk = pendingText;
      pendingText = '';
      hooks.text(chunk);
    };

    const approvalContext = approvalPolicyContext('agy', selectedApprovalPolicy(session));
    let inputAccepted = false;
    let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
    let diagnosticTimer: ReturnType<typeof setInterval> | undefined;
    const acceptInput = (evidence: string) => {
      if (inputAccepted || !acceptingUpdates || !activeSessionId) return;
      inputAccepted = true;
      clearTimeout(acceptanceTimer);
      hooks.inputAccepted?.({ nativeId: activeSessionId, evidence });
    };

    const handlePermission = async (message: RpcMessage) => {
      const parsed = permissionRequestSchema.safeParse(message.params);
      if (!parsed.success || !activeSessionId || parsed.data.sessionId !== activeSessionId) {
        rpc.write({
          id: message.id,
          error: {
            code: -32602,
            message: 'Permission request does not belong to the active session.',
          },
        });
        return;
      }
      flushText();
      acceptInput('ACP permission request');
      const { toolCall, options } = parsed.data;
      const allowOnce = options.find((o) => o.kind === 'allow_once');
      // Persistent native decisions may outlive this logical Session. Never
      // present them as one-time or session-local permission.
      const allowOption = allowOnce;
      const rejectOption = options.find((o) => o.kind === 'reject_once');

      if (taskBridge && allowOption && isTaskBridgeTool(toolCall)) {
        rpc.write({
          id: message.id,
          result: { outcome: { outcome: 'selected', optionId: allowOption.optionId } },
        });
        return;
      }

      const range = {
        kind: toolCall?.kind ?? '',
        title: toolCall?.title ?? '',
        rawInput: toolCall?.rawInput ?? null,
        locations: toolCall?.locations ?? null,
      };
      if (allowOption && this.grants.has(session, range)) {
        hooks.activity(
          `复用本会话内授权：${toolCall?.title || toolCall?.kind || '工具'}（相同请求范围）`,
        );
        rpc.write({
          id: message.id,
          result: { outcome: { outcome: 'selected', optionId: allowOption.optionId } },
        });
        return;
      }

      const choices = approvalChoices(!!allowOption, true)
        .filter((choice) => {
          if (choice.id === 'allow' || choice.id === 'session') return !!allowOption;
          if (choice.id === 'deny') return !!rejectOption;
          return choice.id === 'cancel';
        })
        .map((choice) =>
          choice.id === 'session'
            ? {
                ...choice,
                label: '允许本会话重复此操作',
                description:
                  '仅复用工具类型、标题、完整参数和文件位置均相同的请求；命令或脚本变化仍需确认。不跨会话，关闭、重启或清除授权后失效。',
              }
            : choice,
        );
      const payload = permissionPayload(toolCall);
      const toolLabel = toolCall?.title || toolCall?.kind || '工具操作';
      const presentation = approvalPresentation(
        payload,
        session.workspace,
        false,
        toolCall?.kind === 'execute',
        toolLabel,
      );
      if (!allowOnce && options.some((o) => o.kind === 'allow_always'))
        presentation.detail +=
          '\n原生仅提供持久允许，不能作为本次或本会话授权；可取消后在原生终端检查权限。';
      let answer;
      try {
        answer = await hooks.ask(
          {
            kind: 'approval',
            title: `Antigravity CLI 请求：${toolLabel}`,
            ...presentation,
            approvalOptions: choices,
            approvalContext,
            ...(allowOnce && ['execute', 'edit'].includes(toolCall?.kind ?? '')
              ? { approvalAutomation: 'agy-command-file' as const }
              : {}),
          },
          combined,
        );
      } catch (error) {
        try {
          rpc.write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        } catch {
          /* Process already closed. */
        }
        throw error;
      }
      combined.throwIfAborted();
      const action = approvalAction(answer);
      if (action === 'auto' || !choices.some((c) => c.id === action))
        throw new Error('原生请求不支持此审批范围');
      if (action === 'session') this.grants.add(session, range);
      if (action === 'allow' || action === 'session') {
        rpc.write({
          id: message.id,
          result: { outcome: { outcome: 'selected', optionId: allowOption!.optionId } },
        });
      } else if (action === 'deny') {
        rpc.write({
          id: message.id,
          result: { outcome: { outcome: 'selected', optionId: rejectOption!.optionId } },
        });
      } else {
        rpc.write({
          id: message.id,
          result: { outcome: { outcome: 'cancelled' } },
        });
      }
    };

    const handleNotification = (message: RpcMessage) => {
      if (!acceptingUpdates || message.method !== 'session/update') return;
      const params = message.params as
        { sessionId?: string; update?: Record<string, unknown> } | undefined;
      if (!params || params.sessionId !== activeSessionId || !params.update) return;
      const update = params.update;
      const kind = update.sessionUpdate;
      if (
        ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(
          String(kind),
        )
      )
        acceptInput('ACP prompt event');
      if (kind === 'agent_message_chunk') {
        const piece = contentText(update.content);
        if (piece) pendingText += piece;
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        if (kind === 'tool_call') flushText();
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        const prior = id ? tools.get(id) : undefined;
        const tool = acpTool(update, prior);
        if (tool) {
          tools.set(tool.id, { name: tool.name, input: tool.input });
          if (hooks.tool) hooks.tool(tool);
          else if (kind === 'tool_call') hooks.activity(tool.name);
        }
      } else if (kind === 'plan' && Array.isArray(update.entries)) {
        const steps = update.entries
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
          .map((entry) => ({
            text: typeof entry.content === 'string' ? entry.content : '',
            status:
              entry.status === 'in_progress' ||
              entry.status === 'completed' ||
              entry.status === 'pending' ||
              entry.status === 'cancelled'
                ? entry.status
                : 'pending',
          }))
          .filter((step) => step.text.length > 0);
        const parsed = agentPlanSchema.safeParse({ source: 'agy', steps });
        if (parsed.success) hooks.plan?.(parsed.data);
      } else if (kind === 'usage_update') {
        const usage = agyContextUsage(update);
        if (usage) {
          lastContext = {
            contextTokens: usage.contextTokens,
            modelContextWindow: usage.modelContextWindow,
          };
          hooks.usage?.(usage);
        }
      }
    };

    rpc.onMessage = (message) => {
      if (message.id !== undefined && message.method) {
        if (message.method === 'session/request_permission' && acceptingUpdates) {
          const job = handlePermission(message)
            .catch((error) => {
              controller.abort(error);
              void rpc.close();
            })
            .finally(() => jobs.delete(job));
          jobs.add(job);
          return;
        }
        // Fail closed on any client request we did not advertise support for.
        try {
          rpc.write({
            id: message.id,
            error: { code: -32601, message: `Unsupported native request: ${message.method}` },
          });
        } catch {
          /* Ignore write error if already closing. */
        }
        controller.abort(new Error(`需要原生终端处理的请求: ${message.method}`));
        void rpc.close();
        return;
      }
      handleNotification(message);
    };

    const abort = () => {
      if (activeSessionId && acceptingUpdates) {
        try {
          rpc.write({ method: 'session/cancel', params: { sessionId: activeSessionId } });
        } catch {
          /* Process may already be closed. */
        }
      }
      void rpc.close();
    };
    combined.addEventListener('abort', abort, { once: true });

    try {
      const caps = await this.initialize(rpc, 'tab-ai');
      supportsClose = caps.supportsClose;
      combined.throwIfAborted();

      const instructions = agentInstructions(session);
      if (instructions && caps.systemPromptAppend === false)
        throw new Error('当前 Antigravity CLI ACP 版本不支持附加系统提示词。');

      const mcpServers = taskBridge
        ? [
            {
              type: 'http',
              name: TASK_MCP_SERVER,
              url: taskBridge.url,
              headers: [{ name: 'Authorization', value: `Bearer ${taskBridge.token}` }],
            },
          ]
        : [];
      const meta = instructions
        ? { _meta: { antigravity: { systemPrompt: { append: instructions } } } }
        : {};

      let loaded: z.infer<typeof sessionResponseSchema>;
      if (session.nativeId) {
        if (caps.supportsResume) {
          loaded = sessionResponseSchema.parse(
            await rpc.request('session/resume', {
              sessionId: session.nativeId,
              cwd: session.workspace,
              mcpServers,
              ...meta,
            }),
          );
        } else if (caps.supportsLoad) {
          loaded = sessionResponseSchema.parse(
            await rpc.request('session/load', {
              sessionId: session.nativeId,
              cwd: session.workspace,
              mcpServers,
              ...meta,
            }),
          );
        } else {
          throw new Error('当前 Antigravity CLI 不支持恢复既有原生会话；未创建替代上下文。');
        }
        if (loaded.sessionId && loaded.sessionId !== session.nativeId)
          throw new Error('Antigravity CLI 原生会话与请求不匹配；未创建替代上下文。');
        activeSessionId = session.nativeId;
      } else {
        loaded = sessionResponseSchema.parse(
          await rpc.request('session/new', {
            cwd: session.workspace,
            mcpServers,
            ...meta,
          }),
        );
        if (!loaded.sessionId) throw new Error('Antigravity CLI 未返回有效的原生会话 ID。');
        activeSessionId = loaded.sessionId;
      }

      session.nativeId = activeSessionId;
      hooks.nativeId(activeSessionId);
      combined.throwIfAborted();

      let currentConfigOptions = loaded.configOptions;
      requireAvailableModel(loaded, currentConfigOptions, session.settings?.model);
      const policy = nativeApprovalPolicy(session);
      if (policy) {
        const modeOption = findConfigOption(currentConfigOptions, ['mode'], ['mode']);
        if (modeOption) {
          const updated = setConfigOptionResponse.parse(
            await rpc.request('session/set_config_option', {
              sessionId: activeSessionId,
              configId: modeOption.id,
              value: policy,
            }),
          );
          if (updated.configOptions) currentConfigOptions = updated.configOptions;
        } else {
          await rpc.request('session/set_mode', {
            sessionId: activeSessionId,
            modeId: policy,
          });
        }
      }

      if (session.settings?.model) {
        const modelOption = findConfigOption(currentConfigOptions, ['model'], ['model']);
        if (modelOption) {
          const updated = setConfigOptionResponse.parse(
            await rpc.request('session/set_config_option', {
              sessionId: activeSessionId,
              configId: modelOption.id,
              value: session.settings.model,
            }),
          );
          if (updated.configOptions) currentConfigOptions = updated.configOptions;
        } else {
          await rpc.request('session/set_model', {
            sessionId: activeSessionId,
            modelId: session.settings.model,
          });
        }
      }

      if (session.settings?.effort) {
        const effortOption = findConfigOption(
          currentConfigOptions,
          ['thought_level'],
          ['thought_level', 'effort', 'reasoning_effort'],
        );
        if (!effortOption) throw new Error('Antigravity CLI 当前会话未提供可设置的思考深度选项。');
        const updated = setConfigOptionResponse.parse(
          await rpc.request('session/set_config_option', {
            sessionId: activeSessionId,
            configId: effortOption.id,
            value: session.settings.effort,
          }),
        );
        if (updated.configOptions) currentConfigOptions = updated.configOptions;
      }

      combined.throwIfAborted();
      requireAvailableModel(loaded, currentConfigOptions, session.settings?.model);
      hooks.input?.({
        text,
        nativeId: activeSessionId,
        instructions,
        instructionMode: 'agy-append',
      });

      diagnostics.beginPrompt();
      acceptingUpdates = true;
      diagnosticTimer = setInterval(() => {
        const failure = diagnostics.failure();
        if (failure?.terminal)
          controller.abort(new Error(failure.message + '本轮执行失败，未自动重试。'));
      }, 250);
      acceptanceTimer = setTimeout(() => {
        const failure = diagnostics.failure();
        controller.abort(
          new Error(
            `${failure?.message ?? `Antigravity CLI 在 ${Math.round(this.inputAcceptanceTimeoutMs / 1000)} 秒内未确认处理本轮输入；原生未返回明确原因，请检查模型、登录和网络。`}输入结果未确认，不自动重试。`,
          ),
        );
      }, this.inputAcceptanceTimeoutMs);
      const result = promptResponseSchema.parse(
        await rpc.request(
          'session/prompt',
          {
            sessionId: activeSessionId,
            prompt: [{ type: 'text', text }],
          },
          0,
        ),
      );
      // Some ACP versions send a warning as agent text and still return
      // end_turn. Native executor failures must not become successful runs.
      const nativeFailure = diagnostics.failure();
      if (nativeFailure?.terminal) throw new Error(nativeFailure.message);
      acceptInput('ACP prompt response');
      acceptingUpdates = false;
      combined.throwIfAborted();
      flushText();

      if (result.usage) {
        const usage = agyUsage(result.usage, lastContext);
        if (usage) hooks.usage?.(usage);
      }

      if (result.stopReason === 'cancelled') throw new Error('任务已中断');
      if (result.stopReason && result.stopReason !== 'end_turn') {
        const reasons: Record<string, string> = {
          refusal: 'Antigravity CLI 拒绝了本次请求',
          max_tokens: 'Antigravity CLI 达到输出长度上限，本轮未完整结束',
          max_turn_requests: 'Antigravity CLI 达到单轮最大工具调用次数上限',
        };
        throw new Error(
          reasons[result.stopReason] ?? `Antigravity CLI 异常结束（${result.stopReason}）`,
        );
      }
      completed = true;
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) throw controller.signal.reason;
      if (signal.aborted) throw new Error('任务已中断');
      const diagnostic = diagnostics.failure();
      const failure = diagnostic?.terminal
        ? diagnostic
        : (agyFailure(error instanceof Error ? error.message : '') ?? diagnostic);
      if (failure) throw new Error(failure.message);
      throw error;
    } finally {
      clearTimeout(acceptanceTimer);
      clearInterval(diagnosticTimer);
      acceptingUpdates = false;
      combined.removeEventListener('abort', abort);
      if (!completed && !controller.signal.aborted) controller.abort(new Error('本轮已结束'));
      await Promise.allSettled(jobs);
      if (supportsClose && activeSessionId && completed && !signal.aborted)
        await rpc.request('session/close', { sessionId: activeSessionId }, 2000).catch(() => {});
      await rpc.close();
      diagnostics.close();
    }
  }
}
