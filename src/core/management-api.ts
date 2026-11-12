import { z } from 'zod';
import {
  groupIdSchema,
  groupModeSchema,
  type GroupMode,
  type GroupPermission,
} from './group-mode.js';
import type { Incoming } from './types.js';

const target = z.object({ botId: z.string().min(1).max(200), chatId: groupIdSchema }).strict();
export const managementRequestSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('group_mode.get'), parameters: target }).strict(),
  z
    .object({
      intent: z.literal('group_mode.set'),
      parameters: target.extend({ mode: groupModeSchema }).strict(),
    })
    .strict(),
]);
export type ManagementRequest = z.infer<typeof managementRequestSchema>;
// Constructed by the authenticated transport, never from model output / HTTP JSON.
export type ManagementActor =
  { kind: 'local' } | { kind: 'chat'; source: 'slash' | 'natural'; message: Incoming };
export type ManagementPolicy = (
  actor: ManagementActor,
  request: ManagementRequest,
) => void | Promise<void>;
export interface ManagementResult {
  intent: ManagementRequest['intent'];
  id: string;
  chatId: string;
  mode: GroupMode;
  previousMode: GroupMode;
  changed: boolean;
  permission?: GroupPermission;
}
interface Handlers {
  authorize: ManagementPolicy;
  get: (botId: string, chatId: string) => GroupMode;
  set: (botId: string, chatId: string, mode: GroupMode) => void;
}

// All entry points use the same validation, policy and dispatch. Additional policy
// can restrict existing access; it never replaces the mandatory authorization.
export async function executeManagementApi(
  input: unknown,
  actor: ManagementActor,
  handlers: Handlers,
  policy?: ManagementPolicy,
): Promise<ManagementResult> {
  const request = managementRequestSchema.parse(input);
  await handlers.authorize(actor, request);
  await policy?.(actor, request);
  await handlers.authorize(actor, request); // Permission may have changed while policy awaited.
  const { botId, chatId } = request.parameters;
  const previousMode = handlers.get(botId, chatId);
  const mode = request.intent === 'group_mode.set' ? request.parameters.mode : previousMode;
  if (request.intent === 'group_mode.set') handlers.set(botId, chatId, mode);
  return {
    intent: request.intent,
    id: botId,
    chatId,
    mode,
    previousMode,
    changed: mode !== previousMode,
  };
}

// Classifier parameters deliberately contain no target IDs or caller privileges.
export const managementIntentSchema = z
  .object({
    intent: z.enum(['group_mode.get', 'group_mode.set', 'group_mode.clarify']),
    parameters: z.object({ mode: groupModeSchema.nullable() }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.intent === 'group_mode.set') !== (value.parameters.mode !== null))
      ctx.addIssue({ code: 'custom', message: 'Only group_mode.set requires a mode' });
  });
export type ManagementIntent = z.infer<typeof managementIntentSchema>;
export const managementIntentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'parameters'],
  properties: {
    intent: { type: 'string', enum: ['group_mode.get', 'group_mode.set', 'group_mode.clarify'] },
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { type: ['string', 'null'], enum: ['mention', 'context', 'auto', null] },
      },
    },
  },
};

// Whole-message fast paths only. Quotes, compound requests and explanations go to
// semantic classification rather than triggering a substring-based mutation.
export function recognizeManagement(text: string): ManagementIntent | undefined {
  const value = text
    .trim()
    .replace(/[。！!？?]$/, '')
    .trim();
  if (/^(?:这个群|本群)(?:现在|当前)?(?:是什么模式|的(?:行为|回复|接收)模式是什么)$/.test(value))
    return { intent: 'group_mode.get', parameters: { mode: null } };
  const explicit =
    /^(?:请)?(?:把)?(?:这个群|本群)(?:的(?:行为|回复|接收)模式)?(?:设置为|设为|切换为|改成|改为)\s*(mention|context|auto)$/i.exec(
      value,
    );
  if (explicit)
    return {
      intent: 'group_mode.set',
      parameters: { mode: explicit[1]!.toLowerCase() as GroupMode },
    };
  const phrases: Record<string, GroupMode> = {
    '这个群以后只有 @你 才处理，平时不用收集聊天': 'mention',
    '这个群以后只有@你才处理，平时不用收集聊天': 'mention',
    '平时先收集群聊，@你时结合前面的讨论回答': 'context',
    '这个群不用@你，收到消息就处理': 'auto',
    '这个群不用 @你，收到消息就处理': 'auto',
  };
  if (Object.hasOwn(phrases, value))
    return { intent: 'group_mode.set', parameters: { mode: phrases[value]! } };
  if (/^(?:请)?(?:你)?(?:以后)?(?:不要自动回复|别自动回复了|安静一点)$/.test(value))
    return { intent: 'group_mode.clarify', parameters: { mode: null } };
  return undefined;
}
