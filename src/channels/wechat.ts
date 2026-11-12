import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { type ChannelConfig, secret } from '../config.js';
import { type Channel, type Incoming, type Session } from '../core/types.js';
import { atomicJson } from '../setup/storage.js';
import { channelError, splitText } from './common.js';
import { WechatApi, WechatApiError } from './wechat-api.js';
import type { ManagementView } from '../core/types.js';
import { managementText } from '../core/management-view.js';

const quotedMessage = z.object({
  svr_id: z.union([z.string(), z.number().int().safe()]).transform(String).optional(),
  message_item: z.object({ msg_id: z.string().optional() }).optional(),
});
const wireMessage = z.object({
  message_id: z.union([z.string().min(1), z.number().int().safe()]).transform(String),
  from_user_id: z.string().min(1),
  to_user_id: z.string().optional(),
  message_type: z.number(),
  message_state: z.number().optional(),
  group_id: z.string().optional(),
  context_token: z.string().optional(),
  item_list: z
    .array(
      z.object({
        type: z.number(),
        ref_msg: quotedMessage.optional(),
        text_item: z.object({ text: z.string() }).optional(),
      }),
    )
    .default([]),
});
const savedState = z.object({
  cursor: z.string(),
  contexts: z.record(z.string(), z.string()),
  routes: z.record(z.string(), z.string()).default({}),
});
export function normalizeWechat(raw: unknown, account: string): Incoming | undefined {
  const parsed = wireMessage.safeParse(raw);
  if (!parsed.success) return;
  const m = parsed.data;
  if (
    m.message_type !== 1 ||
    (m.message_state !== undefined && m.message_state !== 2) ||
    m.group_id
  )
    return;
  const text = m.item_list
    .filter((i) => i.type === 1)
    .map((i) => i.text_item?.text ?? '')
    .join('\n');
  return {
    id: m.message_id,
    text,
    direct: true,
    route: {
      platform: 'wechat',
      account,
      conversation: m.from_user_id,
      thread: '',
      sender: m.from_user_id,
    },
  };
}
export class WechatChannel implements Channel {
  readonly platform = 'wechat' as const;
  readonly id: string;
  private api: WechatApi;
  private controller?: AbortController;
  private polling?: Promise<void>;
  private state = {
    cursor: '',
    contexts: {} as Record<string, string>,
    routes: {} as Record<string, string>,
  };
  private file: string;
  private botId: string;
  constructor(
    private config: Extract<ChannelConfig, { type: 'wechat' }>,
    resolveSecret = secret,
    dataDir = '.tab-ai',
    request: typeof fetch = fetch,
  ) {
    this.id = config.id;
    this.botId = resolveSecret(config.botIdEnv);
    this.api = new WechatApi(config.baseUrl, resolveSecret(config.tokenEnv), request);
    this.file = join(
      dataDir,
      'wechat',
      `${createHash('sha256')
        .update(this.id + '\0' + this.botId)
        .digest('hex')}.json`,
    );
    if (existsSync(this.file))
      this.state = savedState.parse(JSON.parse(readFileSync(this.file, 'utf8')));
  }
  async start(onMessage: (message: Incoming) => Promise<void>): Promise<void> {
    if (this.controller) throw new Error('微信连接已启动');
    const controller = new AbortController();
    this.controller = controller;
    // Retry only the read-only connection check, never a message send.
    try {
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        try {
          await this.api.call(
            'getconfig',
            { ilink_user_id: this.config.allowedUsers[0] ?? '' },
            controller.signal,
            10_000,
          );
          break;
        } catch (error) {
          const retryable =
            error instanceof WechatApiError &&
            (error.code === undefined ||
              error.code === 429 ||
              (error.code >= 500 && error.code < 600));
          if (controller.signal.aborted || !retryable || attempt >= 2) throw error;
          await delay(500 * (attempt + 1), undefined, { signal: controller.signal });
        }
      }
      controller.signal.throwIfAborted();
      this.polling = this.poll(onMessage, controller.signal);
    } catch (error) {
      if (this.controller === controller) this.controller = undefined;
      throw error;
    }
  }
  private async poll(
    receive: (message: Incoming) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const result = z
          .object({
            msgs: z.array(z.unknown()).default([]),
            get_updates_buf: z.string().optional(),
          })
          .parse(await this.api.call('getupdates', { get_updates_buf: this.state.cursor }, signal));
        for (const raw of result.msgs) {
          if (signal.aborted) return;
          const parsed = wireMessage.safeParse(raw),
            message = normalizeWechat(raw, this.id);
          if (!parsed.success || !message) continue;
          if (parsed.data.to_user_id && parsed.data.to_user_id !== this.botId) continue;
          if (!this.config.allowedUsers.includes(message.route.sender)) continue;
          const refs = parsed.data.item_list.flatMap((item) =>
            item.ref_msg ? [item.ref_msg] : [],
          );
          if (refs.length) {
            const threads = refs.map((ref) => {
              const id = ref.svr_id || ref.message_item?.msg_id;
              return id ? this.state.routes[JSON.stringify([message.route.sender, id])] : undefined;
            });
            if (threads.some((thread) => thread === undefined) || new Set(threads).size !== 1)
              message.unresolvedQuote = true;
            else message.route.thread = threads[0]!;
          }
          if (parsed.data.context_token) {
            this.state.contexts[message.route.sender] = parsed.data.context_token;
            atomicJson(this.file, this.state);
          }
          if (!message.text.trim()) {
            await this.send(
              message,
              '当前微信接入支持文字消息；请用文字描述任务。图片、语音与文件暂不转发给 Agent。',
            );
            continue;
          }
          // Manager durably deduplicates IDs before dispatch. Do not advance the cursor until accepted.
          await receive(message);
        }
        if (result.get_updates_buf) this.state.cursor = result.get_updates_buf;
        atomicJson(this.file, this.state);
        failures = 0;
        await delay(200, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        channelError(this.id);
        if (error instanceof WechatApiError && error.code === -14) {
          console.error(`[${this.id}] 微信登录已失效，请在接入向导重新扫码。`);
          return;
        }
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), undefined, {
          signal,
        }).catch(() => {});
      }
    }
  }
  private remember(sender: string, messageId: string, thread: string): void {
    this.state.routes[JSON.stringify([sender, messageId])] = thread;
    const keys = Object.keys(this.state.routes);
    for (const key of keys.slice(0, Math.max(0, keys.length - 10000)))
      delete this.state.routes[key];
    atomicJson(this.file, this.state);
  }
  recordSessionMessage(message: Incoming, session: Session): void {
    if (
      message.route.account !== this.id ||
      session.route.account !== this.id ||
      message.route.sender !== session.route.sender
    )
      throw new Error('微信会话不匹配');
    this.remember(message.route.sender, message.id, session.route.thread);
  }
  async send(message: Incoming, text: string): Promise<void> {
    if (
      message.route.account !== this.id ||
      message.route.platform !== 'wechat' ||
      message.route.conversation !== message.route.sender ||
      !this.config.allowedUsers.includes(message.route.sender)
    )
      throw new Error('微信消息路由不匹配');
    const context = this.state.contexts[message.route.sender];
    if (!context) throw new Error('缺少微信回复凭证，请先给机器人发送一条消息。');
    const heading = /^【[^\n]{1,180}】\n/.exec(text)?.[0] ?? '';
    const body = heading ? text.slice(heading.length) : text;
    for (const chunk of splitText(body, 3000 - Buffer.byteLength(heading))) {
      const part = heading + chunk;
      const result = await this.api.call(
        'sendmessage',
        {
          msg: {
            from_user_id: '',
            to_user_id: message.route.sender,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: context,
            item_list: [{ type: 1, text_item: { text: part } }],
          },
        },
        this.controller?.signal ?? AbortSignal.timeout(15_000),
        15_000,
      );
      const sent = z
        .object({
          message_id: z.union([z.string(), z.number().int().safe()]).transform(String).optional(),
        })
        .parse(result);
      if (sent.message_id && message.sessionAnchor)
        this.remember(message.route.sender, sent.message_id, message.route.thread);
    }
  }
  async sendManagement(message: Incoming, view: ManagementView): Promise<void> {
    const heading = /^【[^\n]{1,180}】\n/.exec(view.text)?.[0] ?? '';
    await this.send(
      message,
      heading +
        managementText({ ...view, text: heading ? view.text.slice(heading.length) : view.text }),
    );
  }
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.polling;
    this.controller = undefined;
  }
}
