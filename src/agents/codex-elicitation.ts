import { z } from 'zod';
import type { AgentHooks, Interaction } from '../core/types.js';
import { approvalChoices } from '../core/approval-decisions.js';
import { InteractionTimeoutError } from '../core/interactions.js';
import {
  elicitationQuestions,
  elicitationContent,
  safeElicitationUrl,
} from '../core/mcp-elicitation.js';
export const elicitationEnvelope = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().nullable().optional(),
    serverName: z.string().min(1).max(200),
    mode: z.string().max(80),
  })
  .passthrough();
const cancelled = () => ({ action: 'cancel', content: null, _meta: null });
export async function codexElicitation(
  params: z.infer<typeof elicitationEnvelope>,
  hooks: AgentHooks,
  signal: AbortSignal,
) {
  const server = params.serverName;
  hooks.activity(`MCP 交互：${server} · ${params.mode}`);
  const unsupported = (reason: string) => {
    hooks.text(
      `MCP 服务「${server}」的本次交互无法在聊天中处理：${reason}。已取消该请求，未自动批准；Agent 可继续其他工作。`,
    );
    return cancelled();
  };
  if (!['form', 'openai/form', 'openaiForm', 'url'].includes(params.mode))
    return unsupported('需要原生身份验证或暂不支持的交互方式');
  if (typeof params.message !== 'string' || params.message.length > 12000)
    return unsupported('请求说明缺失或过长');
  const url = params.mode === 'url' ? safeElicitationUrl(params.url) : undefined;
  if (params.mode === 'url' && !url) return unsupported('授权地址不符合 HTTP／HTTPS 链接要求');
  let questions: NonNullable<Interaction['questions']> = [];
  if (params.mode !== 'url') {
    try {
      questions = elicitationQuestions(params.requestedSchema);
    } catch {
      return unsupported('表单包含敏感字段、复杂结构或暂不支持的约束，请使用原生客户端处理该项');
    }
  }
  const elicitation: NonNullable<Interaction['elicitation']> = {
    serverName: server,
    mode: params.mode === 'url' ? 'url' : 'form',
    ...(url ? { url } : {}),
  };
  const detail = `MCP 服务：${server}\n${params.message}${url ? `\n授权地址：${url}\n请自行完成网页流程后确认继续；打开链接不会自动批准。` : ''}`;
  try {
    if (!questions.length) {
      const answer = await hooks.ask(
        {
          kind: 'approval',
          title: `MCP ${url ? '外部授权确认' : '操作确认'} · ${server}`,
          detail,
          elicitation,
          approvalSummary: {
            operation: params.message,
            facts: [
              { label: 'MCP 服务', value: server },
              { label: '交互方式', value: url ? '外部网页流程' : '本次确认' },
            ],
            caution: url
              ? '先打开授权页面完成流程，再确认继续；本次确认不代表网页授权必然成功。'
              : '仅处理本次请求，不产生跨会话或永久授权。',
          },
          approvalOptions: approvalChoices(false, true).map((o) =>
            url && o.id === 'allow' ? { ...o, label: '已完成，继续' } : o,
          ),
        },
        signal,
      );
      if (!('allow' in answer)) return cancelled();
      return {
        action: answer.allow ? 'accept' : answer.cancel ? 'cancel' : 'decline',
        content: answer.allow && !url ? {} : null,
        _meta: null,
      };
    }
    const answer = await hooks.ask(
      { kind: 'question', title: `MCP 需要你的输入 · ${server}`, detail, questions, elicitation },
      signal,
    );
    if (!('answers' in answer)) return cancelled();
    if (answer.action === 'decline' || answer.action === 'cancel')
      return { action: answer.action, content: null, _meta: null };
    return {
      action: 'accept',
      content: elicitationContent(questions, answer.answers),
      _meta: null,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof InteractionTimeoutError) {
      hooks.activity(`MCP 交互等待超时，已取消该项：${server}`);
      return cancelled();
    }
    throw error;
  }
}
