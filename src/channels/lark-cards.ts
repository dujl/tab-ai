import { safeElicitationUrl } from '../core/mcp-elicitation.js';
import { approvalOptions } from '../core/approval-decisions.js';
import { z } from 'zod';
import {
  cardBody,
  cardHint,
  approvalReference,
  approvalCardText,
  type CardPrompt,
  type CardRegistry,
} from './cards.js';
import { interactionAppearance } from './lark-card-status.js';

const plain = (content: string) => ({ tag: 'plain_text', content });
export function larkCard(prompt: CardPrompt) {
  const appearance = interactionAppearance(prompt);
  const elements: object[] = [
    { tag: 'div', text: plain(prompt.question ? cardBody(prompt) : approvalCardText(prompt)) },
  ];
  const elicitationUrl = prompt.request.elicitation?.url;
  if (!prompt.status && safeElicitationUrl(elicitationUrl))
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: plain('打开授权页面 ↗'), type: 'default', url: elicitationUrl },
      ],
    });
  if (prompt.status) elements.push({ tag: 'div', text: plain(prompt.status) });
  else if (!prompt.question)
    elements.push({
      tag: 'action',
      actions: [
        ...approvalOptions(prompt.request).map((o) => ({
          tag: 'button',
          text: plain(o.label),
          type:
            o.id === 'allow' || o.id === 'session'
              ? 'primary'
              : o.id === 'deny'
                ? 'danger'
                : 'default',
          value: { id: prompt.id, action: o.id },
        })),
        { tag: 'button', text: plain('查看完整请求'), value: { id: prompt.id, action: 'details' } },
      ],
    });
  else {
    const q = prompt.question,
      fields: object[] = [];
    if (q.options?.length)
      fields.push({
        tag: q.multiSelect ? 'multi_select_static' : 'select_static',
        name: 'selection',
        placeholder: plain(q.multiSelect ? '请选择，可多选' : '请选择一项'),
        options: q.options.map((label, i) => ({ text: plain(label), value: String(i) })),
      });
    if (!q.options?.length || q.allowOther !== false)
      fields.push({
        tag: 'input',
        name: 'other',
        placeholder: plain(q.options?.length ? '或填写自定义答案（与选项二选一）' : '请输入回答'),
      });
    fields.push({
      tag: 'button',
      name: 'submit',
      text: plain('提交回答'),
      type: 'primary',
      action_type: 'form_submit',
      value: { id: prompt.id, action: 'submit' },
    });
    elements.push({ tag: 'form', name: 'answer', elements: fields });
    if (prompt.request.elicitation)
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: plain('拒绝本次请求'),
            type: 'danger',
            value: { id: prompt.id, action: 'deny' },
          },
          {
            tag: 'button',
            text: plain('取消本次请求'),
            value: { id: prompt.id, action: 'cancel' },
          },
        ],
      });
  }
  const questionHint =
    prompt.request.mode === 'async'
      ? `Agent 会继续分析；提交后将回答送回原会话。本轮结束后仍可在有效期内回答。${prompt.count === 1 ? '也可直接回复完整选项或序号。' : `第 ${prompt.index + 1}/${prompt.count} 题，全部提交后发送。`}未选择不会自动代答。`
      : prompt.count > 1
        ? `第 ${prompt.index + 1}/${prompt.count} 题，全部提交后继续。`
        : '超时不会自动批准。';
  elements.push({
    tag: 'note',
    elements: [
      plain(
        prompt.question
          ? `${cardHint}\n仅任务发起人可操作；${questionHint}`
          : `tab-ai 审批 · ${approvalReference(prompt)}\n授权范围以所选选项为准，仅此会话；超时不批准。摘要由程序提取，不是完整影响分析。完整原文：/tab inspect ${prompt.request.id}`,
      ),
    ],
  });
  if (prompt.status?.includes('已允许'))
    elements.push({
      tag: 'note',
      elements: [
        plain('此卡片仅表示审批已允许，不代表工具已执行成功；实际结果请查看工具执行卡片。'),
      ],
    });
  return {
    config: { wide_screen_mode: true, update_multi: true, enable_forward: false },
    header: {
      title: plain(
        prompt.status?.includes('已超时')
          ? prompt.status
          : `${appearance.label} · ${prompt.request.title}`,
      ),
      template: appearance.color,
    },
    elements,
  };
}
const actionSchema = z.object({
  operator: z.object({ open_id: z.string().min(1) }),
  context: z.object({ open_message_id: z.string().min(1), open_chat_id: z.string().min(1) }),
  action: z.object({
    value: z.object({
      id: z.string().uuid(),
      action: z.enum(['allow', 'session', 'deny', 'cancel', 'submit', 'details']),
    }),
    form_value: z
      .object({
        selection: z.union([z.string(), z.array(z.string())]).nullish(),
        other: z.string().nullish(),
      })
      .optional(),
  }),
});
export function larkCardAction(registry: CardRegistry, raw: unknown) {
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success)
    return { toast: { type: 'error', content: '无法识别卡片操作，请发送 /tab pending。' } };
  const { operator, context, action } = parsed.data;
  const selected = action.form_value?.selection;
  const result = registry.submit(
    action.value.id,
    {
      sender: operator.open_id,
      conversation: context.open_chat_id,
      messageId: context.open_message_id,
    },
    {
      action: action.value.action,
      selection: typeof selected === 'string' ? [selected] : (selected ?? []),
      text: action.form_value?.other ?? undefined,
    },
  );
  return {
    toast: { type: result.ok ? 'success' : 'error', content: result.message },
    ...(result.details ? { details: result.details } : {}),
    ...(result.prompt ? { card: { type: 'raw', data: larkCard(result.prompt) } } : {}),
  };
}
