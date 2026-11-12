import { z } from 'zod';
import {
  type CardPrompt,
  type CardRegistry,
  type CardResult,
  cardBody,
  cardHint,
  approvalCardText,
} from './cards.js';

// Contract for a tenant-owned DingTalk Card Platform template. No public demo
// template is silently trusted to render permissions or answer choices.
export function dingCardData(prompt: CardPrompt): Record<string, string> {
  const q = prompt.question;
  return {
    title: prompt.request.title,
    body: q ? cardBody(prompt) : approvalCardText(prompt),
    kind: q ? 'question' : 'approval',
    options: JSON.stringify(
      q?.options?.map((label, index) => ({ text: label, value: String(index) })) ?? [],
    ),
    multiSelect: String(q?.multiSelect ?? false),
    allowOther: String(!q?.options?.length || q.allowOther !== false),
    status: prompt.status ?? '待处理',
    hint: q ? cardHint : `完整原文：/tab inspect ${prompt.request.id}。仅允许本次，超时不批准。`,
    detailAction: 'details',
    progress: `${prompt.index + 1}/${prompt.count}`,
  };
}
const callback = z.object({
  outTrackId: z.string().uuid(),
  userId: z.string().min(1),
  userIdType: z.number().optional(),
  spaceId: z.string().min(1),
  spaceType: z.enum(['IM_GROUP', 'IM_ROBOT']),
  content: z.string().max(100_000),
});
const content = z.object({
  cardPrivateData: z.object({
    params: z.object({
      action: z.enum(['allow', 'deny', 'submit', 'details']),
      selection: z.union([z.string(), z.array(z.string())]).nullish(),
      text: z.string().nullish(),
    }),
  }),
});
export function dingCardAction(
  registry: CardRegistry,
  raw: unknown,
  targets: Map<string, { conversation: string; spaceId: string; spaceType: string }>,
): Record<string, unknown> & { details?: CardResult['details'] } {
  const data = callback.safeParse(raw);
  if (!data.success || (data.data.userIdType !== undefined && data.data.userIdType !== 1))
    return {};
  const value = data.data,
    target = targets.get(value.outTrackId);
  if (!target || target.spaceId !== value.spaceId || target.spaceType !== value.spaceType)
    return {};
  let parsed: ReturnType<typeof content.safeParse>;
  try {
    parsed = content.safeParse(JSON.parse(value.content));
  } catch {
    return {};
  }
  if (!parsed.success) return {};
  const params = parsed.data.cardPrivateData.params,
    selected = params.selection;
  const result = registry.submit(
    value.outTrackId,
    { sender: value.userId, conversation: target.conversation },
    {
      action: params.action,
      selection: typeof selected === 'string' ? (selected ? [selected] : []) : (selected ?? []),
      text: params.text ?? undefined,
    },
  );
  // On errors do not overwrite the owner's shared card. Private feedback is
  // shown only to the operator by the template's feedback variable.
  return result.ok && result.prompt
    ? {
        ...(result.details ? { details: result.details } : {}),
        cardData: { cardParamMap: dingCardData(result.prompt) },
        cardUpdateOptions: { updateCardDataByKey: true },
      }
    : {
        userPrivateData: { cardParamMap: { feedback: result.message } },
        cardUpdateOptions: { updatePrivateDataByKey: true },
      };
}
