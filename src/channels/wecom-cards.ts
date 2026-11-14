import { approvalOptions } from '../core/approval-decisions.js';
import { z } from 'zod';
import { type TemplateCard } from '@wecom/aibot-node-sdk';
import {
  type CardPrompt,
  type CardRegistry,
  cardHint,
  approvalReference,
  approvalPreview,
} from './cards.js';

export function wecomCard(prompt: CardPrompt): TemplateCard {
  const common = {
    task_id: prompt.id,
    main_title: {
      title: prompt.request.title,
      desc: prompt.question
        ? `第 ${prompt.index + 1}/${prompt.count} 题 · ${prompt.question.multiSelect ? '多选' : '单选'}`
        : '仅允许本次操作',
    },
    sub_title_text: cardHint,
  };
  if (!prompt.question) {
    const directoryLabels = ['本次执行目录', '会话默认目录', '工作目录'];
    const directories = (prompt.request.approvalSections ?? [])
      .filter((s) => directoryLabels.includes(s.label))
      .slice(0, 2)
      .map((s) => ({
        keyname:
          s.label === '本次执行目录'
            ? '执行目录'
            : s.label === '会话默认目录'
              ? '会话目录'
              : '目录',
        value:
          Array.from(s.value).slice(0, 110).join('') +
          (Array.from(s.value).length > 110 ? '…（详情）' : ''),
      }));
    const factLimit = Math.min(
      2,
      6 - directories.length - (prompt.request.approvalContext ? 1 : 0) - 2,
    );
    return {
      task_id: prompt.id,
      source: { desc: 'tab-ai 系统' },
      card_type: prompt.status ? 'text_notice' : 'button_interaction',
      main_title: {
        title: prompt.status ?? prompt.request.title.replace('请求执行命令', '· 执行确认'),
        desc: '程序摘要 · 按所选范围授权 · 仅此会话',
      },
      sub_title_text: approvalPreview(prompt, 96),
      horizontal_content_list: [
        ...directories,
        ...(prompt.request.approvalSummary?.facts
          .filter((f) => !directoryLabels.includes(f.label))
          .slice(0, factLimit)
          .map((f) => ({
            keyname: f.label,
            value:
              Array.from(f.value).slice(0, 110).join('') +
              (Array.from(f.value).length > 110 ? '…（详情）' : ''),
          })) ?? []),
        ...(prompt.request.approvalContext
          ? [{ keyname: '策略', value: prompt.request.approvalContext.label }]
          : []),
        {
          keyname: '授权范围',
          value: approvalOptions(prompt.request).some((o) => o.id === 'session')
            ? '允许本次；或本会话内按原生范围复用，并非所有工具。'
            : '本次未提供会话内授权，不能扩大为允许所有。',
        },
        { keyname: '审批', value: approvalReference(prompt) },
      ],
      ...(!prompt.status
        ? {
            button_list: [
              ...approvalOptions(prompt.request).map((o) => ({
                text: o.label,
                key: o.id,
                style:
                  o.id === 'allow' || o.id === 'session'
                    ? (1 as const)
                    : o.id === 'deny'
                      ? (2 as const)
                      : (3 as const),
              })),
              { text: '查看原文', key: 'details', style: 3 as const },
            ],
          }
        : {}),
    };
  }
  if (prompt.status)
    return {
      ...common,
      card_type: 'text_notice',
      main_title: { title: prompt.status, desc: '可在原会话继续查看任务进度。' },
    };
  return {
    ...common,
    card_type: 'vote_interaction',
    main_title: {
      title: prompt.question.question,
      desc: `${common.main_title.desc}；全部问题提交后继续。`,
    },
    checkbox: {
      question_key: 'answer',
      mode: prompt.question.multiSelect ? 1 : 0,
      option_list: (prompt.question.options ?? []).map((text, index) => ({
        id: String(index),
        text,
        is_checked: false,
      })),
    },
    submit_button: { text: '提交回答', key: 'submit' },
  };
}
const detail = z.object({
  task_id: z.string().uuid(),
  event_key: z.enum(['allow', 'session', 'deny', 'cancel', 'submit', 'details']),
  selected_items: z
    .object({
      selected_item: z.array(
        z.object({
          question_key: z.string(),
          option_ids: z.object({ option_id: z.array(z.string()) }),
        }),
      ),
    })
    .optional(),
});
const event = z.object({
  from: z.object({ userid: z.string().min(1) }),
  chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']).optional(),
  event: z
    .object({ eventtype: z.literal('template_card_event'), template_card_event: detail.optional() })
    .passthrough(),
});
export function wecomCardAction(registry: CardRegistry, raw: unknown) {
  const parsed = event.safeParse(raw);
  if (!parsed.success) return;
  const body = parsed.data,
    action = detail.safeParse(body.event.template_card_event ?? body.event);
  if (!action.success || (body.chattype === 'group' && !body.chatid)) return;
  const selection = action.data.selected_items?.selected_item ?? [];
  if (selection.length > 1 || selection.some((item) => item.question_key !== 'answer')) return;
  const result = registry.submit(
    action.data.task_id,
    { sender: body.from.userid, conversation: body.chatid ?? body.from.userid },
    { action: action.data.event_key, selection: selection[0]?.option_ids.option_id ?? [] },
  );
  return {
    ...result,
    sender: body.from.userid,
    conversation: body.chatid ?? body.from.userid,
    action: action.data.event_key,
    taskId: action.data.task_id,
  };
}
