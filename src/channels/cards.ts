import {
  approvalAnswer,
  approvalDecisionText,
  approvalOptions,
  type ApprovalAction,
} from '../core/approval-decisions.js';
import { randomUUID } from 'node:crypto';
import { type Answer, type Incoming, type Interaction, type Question } from '../core/types.js';
import { validateValues } from '../core/interactions.js';
import { approvalSummaryText } from '../core/approvals.js';
import { splitText } from './common.js';

export interface CardPrompt {
  id: string;
  request: Interaction;
  question?: Question;
  index: number;
  count: number;
  status?: string;
  messageId?: string;
}
export interface CardActor {
  sender: string;
  conversation: string;
  messageId?: string;
}
export interface CardInput {
  action: ApprovalAction | 'submit' | 'details';
  selection?: string[];
  text?: string;
}
interface Batch {
  message: Incoming;
  cards: CardPrompt[];
  values: Record<string, string[]>;
  answer: (sender: string, answer: Answer) => void;
}
export interface CardResult {
  ok: boolean;
  message: string;
  prompt?: CardPrompt;
  details?: { message: Incoming; prompt: CardPrompt };
}

// Only platform-authenticated callbacks reach this registry. Card values carry opaque
// IDs / option indices, never executable commands or an arbitrary answer supplied by a button.
export class CardRegistry {
  private entries = new Map<string, { batch: Batch; prompt: CardPrompt }>();
  open(message: Incoming, request: Interaction, answer: Batch['answer']) {
    const questions = request.kind === 'approval' ? [undefined] : (request.questions ?? []);
    const cards = questions.map(
      (question, index) =>
        ({ id: randomUUID(), request, question, index, count: questions.length }) as CardPrompt,
    );
    const batch: Batch = {
      message,
      cards,
      values: Object.create(null) as Record<string, string[]>,
      answer,
    };
    for (const prompt of cards) this.entries.set(prompt.id, { batch, prompt });
    return {
      cards,
      close: (status: string) => {
        for (const card of cards) {
          card.status = status;
          this.entries.delete(card.id);
        }
      },
    };
  }
  submit(id: string, actor: CardActor, input: CardInput): CardResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, message: '此卡片已结束或服务已重启。请查看当前任务状态。' };
    const { batch, prompt } = entry,
      owner = batch.message.route;
    if (
      actor.sender !== owner.sender ||
      actor.conversation !== owner.conversation ||
      (prompt.messageId && actor.messageId !== prompt.messageId)
    )
      return { ok: false, message: '只有原会话中的任务发起人可以操作此卡片。' };
    if (
      prompt.status ||
      (prompt.request.expiresAt !== undefined && Date.now() >= prompt.request.expiresAt)
    )
      return { ok: false, message: '此卡片已提交或已过期。' };
    try {
      if (input.action === 'details') {
        if (prompt.request.kind !== 'approval') throw new Error('此卡片不是工具审批。');
        return {
          ok: true,
          message: '已请求完整详情，审批仍待处理。',
          prompt,
          details: { message: batch.message, prompt },
        };
      }
      if (prompt.request.kind === 'approval') {
        if (!approvalOptions(prompt.request).some((o) => o.id === input.action))
          throw new Error('此请求不支持所选审批范围');
        const answer = approvalAnswer(input.action as ApprovalAction);
        batch.answer(actor.sender, answer);
        prompt.status = approvalDecisionText(answer);
      } else {
        if (prompt.request.elicitation && (input.action === 'deny' || input.action === 'cancel')) {
          batch.answer(actor.sender, {
            answers: {},
            action: input.action === 'deny' ? 'decline' : 'cancel',
          });
          prompt.status = input.action === 'deny' ? '已拒绝本次请求' : '已取消本次请求';
          return { ok: true, message: prompt.status, prompt };
        }
        if (input.action !== 'submit' || !prompt.question) throw new Error('请提交问题答案。');
        const question = prompt.question;
        const selection = input.selection ?? [];
        const values = selection.map((value) => {
          if (!/^(0|[1-9]\d*)$/.test(value) || !question.options?.[Number(value)])
            throw new Error('选项无效，请重新选择。');
          return question.options[Number(value)]!;
        });
        if (input.text?.trim()) {
          if (selection.length) throw new Error('请选择选项或填写自定义答案，不要同时提交。');
          values.push(input.text);
        }
        validateValues(question, values);
        const next = { ...batch.values, [question.id]: values };
        if (batch.cards.every((card) => card.question && Object.hasOwn(next, card.question.id)))
          batch.answer(actor.sender, { answers: next });
        batch.values = next;
        prompt.status = `已提交（${Object.keys(next).length}/${batch.cards.length}）`;
      }
      return { ok: true, message: prompt.status, prompt };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '提交失败，请使用文字命令。',
      };
    }
  }
}

export const cardHint = '按钮不可用或需自定义回答时，发送 /tab pending 获取文字答题方式。';
export function cardBody(prompt: CardPrompt): string {
  const q = prompt.question;
  return q
    ? [
        ...(prompt.request.elicitation ? [prompt.request.detail] : []),
        q.question,
        ...(q.options ?? []).map(
          (option, i) =>
            `${i + 1}. ${option}${q.descriptions?.[i] ? ' — ' + q.descriptions[i] : ''}`,
        ),
      ].join('\n')
    : prompt.request.detail;
}

export const approvalReference = (prompt: CardPrompt): string => prompt.request.id.slice(0, 8);
export function approvalPreview(prompt: CardPrompt, length = 85): string {
  const value = prompt.request.approvalSummary?.operation ?? '原生工具请求 · 查看完整请求后审批';
  const chars = Array.from(value);
  return chars.slice(0, length).join('') + (chars.length > length ? '…' : '');
}
export function approvalDetailParts(prompt: CardPrompt, maxBytes = 2400): string[] {
  const parts = splitText(cardBody(prompt), maxBytes);
  return parts.map(
    (part, index) =>
      `tab-ai · 审批 ${approvalReference(prompt)} · 详情 ${index + 1}/${parts.length}\n${part}`,
  );
}

export function approvalCardText(prompt: CardPrompt): string {
  return approvalSummaryText(prompt.request);
}
