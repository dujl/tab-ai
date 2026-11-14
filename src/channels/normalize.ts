import type { GroupMode } from '../core/group-mode.js';
import { z } from 'zod';
import { type Incoming, type AttachmentRef } from '../core/types.js';

const larkEvent = z.object({
  sender: z.object({ sender_id: z.object({ open_id: z.string() }), sender_type: z.string() }),
  message: z.object({
    message_id: z.string(),
    chat_id: z.string(),
    chat_type: z.string(),
    message_type: z.string(),
    content: z.string(),
    root_id: z.string().optional(),
    thread_id: z.string().optional(),
    mentions: z
      .array(z.object({ key: z.string(), id: z.object({ open_id: z.string().optional() }) }))
      .optional(),
  }),
});
export function normalizeLark(
  raw: unknown,
  account: string,
  botOpenId: string,
  groupModes: Record<string, GroupMode> = {},
): Incoming | undefined {
  const parsed = larkEvent.safeParse(raw);
  if (!parsed.success) return;
  const { sender, message } = parsed.data;
  if (sender.sender_type !== 'user') return;
  const mentions = message.mentions?.filter((m) => m.id.open_id === botOpenId) ?? [];
  let content: Record<string, unknown>;
  try {
    content = z.record(z.string(), z.unknown()).parse(JSON.parse(message.content));
  } catch {
    return;
  }
  let text = '';
  const attachments: AttachmentRef[] = [];
  const resource = (key: unknown, name: unknown, type: 'file' | 'image') => {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(key)) return;
    if (!attachments.some((a) => a.key === key))
      attachments.push({
        key,
        name: typeof name === 'string' ? name : type === 'image' ? 'image' : 'attachment',
        type,
      });
  };
  if (message.message_type === 'text' && typeof content.text === 'string') text = content.text;
  else if (message.message_type === 'image') resource(content.image_key, 'image', 'image');
  else if (['file', 'audio', 'media'].includes(message.message_type))
    resource(content.file_key, content.file_name, 'file');
  else if (message.message_type === 'post') {
    const post = (
      Array.isArray(content.content)
        ? content
        : (content.zh_cn ?? content.en_us ?? Object.values(content)[0])
    ) as Record<string, unknown> | undefined;
    if (!post || !Array.isArray(post.content)) return;
    const lines: string[] = typeof post.title === 'string' && post.title ? [post.title] : [];
    for (const row of post.content) {
      if (!Array.isArray(row)) continue;
      let line = '';
      for (const item of row) {
        if (!item || typeof item !== 'object') continue;
        if (item.tag === 'text') line += typeof item.text === 'string' ? item.text : '';
        if (item.tag === 'a') line += typeof item.href === 'string' ? item.href : '';
        if (item.tag === 'at' && item.user_id !== botOpenId)
          line += typeof item.user_name === 'string' ? item.user_name : '';
        if (item.tag === 'img') resource(item.image_key, 'image', 'image');
        if (item.tag === 'media') resource(item.file_key, item.file_name, 'file');
      }
      lines.push(line);
    }
    text = lines.join('\n');
  } else return;
  if (message.message_type !== 'text' && !text.trim() && !attachments.length) return;
  // File messages cannot carry @mentions. Only accept unaddressed group files
  // inside a topic that Manager verifies already belongs to this sender.
  const fullGroup =
    message.chat_type !== 'p2p' &&
    ['context', 'auto'].includes(groupModes[message.chat_id] ?? 'mention');
  const requiresExistingSession =
    message.chat_type !== 'p2p' && mentions.length === 0 && !fullGroup;
  if (requiresExistingSession && (!message.thread_id || !attachments.length || text.trim())) return;
  // Only remove the platform's addressing token. Never rewrite arbitrary user text.
  for (const mention of mentions) {
    if (text.startsWith(mention.key)) text = text.slice(mention.key.length).replace(/^ /, '');
  }
  // Top-level chat shares one route. Only existing topics carry a root; an
  // explicit new-topic command promotes its own message to a root in Manager.
  // root_id alone also appears on ordinary quoted replies. Only thread_id
  // identifies a platform topic; quoting in the main chat must keep its context.
  const root = message.thread_id ? message.root_id || message.message_id : '';
  return {
    id: message.message_id,
    text,
    ...(message.chat_type !== 'p2p' ? { groupMessage: { mentioned: mentions.length > 0 } } : {}),
    direct: message.chat_type === 'p2p',
    ...(attachments.length ? { attachments } : {}),
    ...(requiresExistingSession ? { requiresExistingSession: true } : {}),
    ...(root ? { replyTo: root } : {}),
    route: {
      platform: 'lark',
      account,
      conversation: message.chat_id,
      thread: root,
      sender: sender.sender_id.open_id,
    },
  };
}

const dingEvent = z.object({
  msgId: z.string().min(1),
  msgtype: z.string(),
  conversationId: z.string().min(1),
  conversationType: z.enum(['1', '2']),
  senderStaffId: z.string().optional(),
  senderId: z.string().min(1),
  text: z.object({ content: z.string() }).optional(),
  isInAtList: z.boolean().optional(),
});
export function normalizeDingTalk(raw: unknown, account: string): Incoming | undefined {
  const parsed = dingEvent.safeParse(raw);
  if (!parsed.success) return;
  const data = parsed.data;
  if (data.msgtype !== 'text' || !data.text) return;
  if (data.conversationType === '2' && data.isInAtList !== true) return;
  return {
    id: data.msgId,
    text: data.text.content,
    direct: data.conversationType === '1',
    route: {
      platform: 'dingtalk',
      account,
      conversation: data.conversationId,
      thread: '',
      sender: data.senderStaffId || data.senderId,
    },
  };
}

const wecomResource = z.object({
  url: z.url(),
  aeskey: z.string().optional(),
  filename: z.string().optional(),
  file_name: z.string().optional(),
});
const wecomPart = z.object({
  msgtype: z.string(),
  text: z.object({ content: z.string() }).optional(),
  image: wecomResource.optional(),
  file: wecomResource.optional(),
});
const wecomBody = wecomPart.extend({
  mixed: z.object({ msg_item: z.array(wecomPart) }).optional(),
});
const wecomEvent = wecomBody.extend({
  msgid: z.string(),
  chattype: z.enum(['single', 'group']),
  chatid: z.string().optional(),
  from: z.object({ userid: z.string() }),
  quote: wecomBody.optional(),
});
export function normalizeWecom(
  raw: unknown,
  account: string,
  resource?: (
    route: Incoming['route'],
    value: { url: string; aeskey?: string; filename?: string },
    type: 'file' | 'image',
  ) => AttachmentRef,
): Incoming | undefined {
  const parsed = wecomEvent.safeParse(raw);
  if (!parsed.success) return;
  const data = parsed.data;
  if (data.chattype === 'group' && !data.chatid) return;
  const route: Incoming['route'] = {
    platform: 'wecom',
    account,
    conversation: data.chattype === 'group' ? data.chatid! : data.from.userid,
    thread: '',
    sender: data.from.userid,
  };
  const attachments: AttachmentRef[] = [];
  const add = (part: z.infer<typeof wecomPart>) => {
    const value =
      part.msgtype === 'image' ? part.image : part.msgtype === 'file' ? part.file : undefined;
    if (!value || !resource) return;
    const ref = resource(
      route,
      { url: value.url, aeskey: value.aeskey, filename: value.filename || value.file_name },
      part.msgtype === 'image' ? 'image' : 'file',
    );
    if (!attachments.some((a) => a.key === ref.key)) attachments.push(ref);
  };
  const collect = (body: z.infer<typeof wecomBody>) => {
    if (body.msgtype === 'mixed') for (const part of body.mixed?.msg_item || []) add(part);
    else add(body);
  };
  collect(data);
  if (data.quote) collect(data.quote); // Quoted media is data; quoted text is never a command.
  let text =
    data.msgtype === 'text'
      ? data.text?.content || ''
      : data.msgtype === 'mixed'
        ? (data.mixed?.msg_item || [])
            .filter((p) => p.msgtype === 'text')
            .map((p) => p.text?.content || '')
            .join('\n')
        : '';
  // Group callbacks are addressed to this connected bot. Recognize an anchored
  // management command after the leading address; preserve all ordinary prose.
  if (data.chattype === 'group')
    text = /^@[^\s@/]+[\s\u00a0]*(\/tab(?:\s|$)[\s\S]*)$/.exec(text)?.[1] ?? text;
  if (!text.trim() && !attachments.length) return;
  return {
    id: data.msgid,
    text,
    direct: data.chattype === 'single',
    route,
    ...(attachments.length ? { attachments } : {}),
    ...(data.chattype === 'group' && !text.trim() ? { requiresExistingSession: true } : {}),
  };
}
