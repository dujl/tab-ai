import { managementView, sessionHomeButtons } from '../core/management-view.js';
import { normalizeCardCallback } from './lark-menu-layout.js';
import { updateLarkCard } from './lark-card-update.js';
import { randomUUID } from 'node:crypto';
import { deliverManagement } from './lark-management-delivery.js';
import QRCode from 'qrcode';
import { checkLarkGroupPermission, permissionRequest } from './lark-group-permission.js';
import * as Lark from '@larksuiteoapi/node-sdk';
import { setTimeout as delay } from 'node:timers/promises';
import { type ChannelConfig, secret } from '../config.js';
import {
  type Answer,
  type Channel,
  type Incoming,
  type Interaction,
  type InteractionDelivery,
  type Session,
  type SessionCardClick,
  type SessionCardView,
} from '../core/types.js';
import { downloadAttachments } from './attachments.js';
import { larkResourceError } from './lark-errors.js';
import { larkClosedCard } from './lark-system-card.js';
import { larkToolCard } from './lark-tool-card.js';
import type { ToolRunView } from '../core/types.js';
import { larkSessionAction, larkSessionCard } from './lark-session-card.js';
import { ApprovalDetailsDelivery } from './approval-details.js';
import { CardRegistry, cardBody } from './cards.js';
import { larkCard, larkCardAction } from './lark-cards.js';
import { normalizeLark } from './normalize.js';
import { channelError, splitText } from './common.js';
import {
  ManagementCards,
  larkManagementCard,
  larkManagementAction,
  managementChunks,
} from './management-cards.js';
import type { ManagementHandler, ManagementView } from '../core/types.js';

export class LarkChannel implements Channel {
  readonly platform = 'lark' as const;
  readonly id: string;
  private client: Lark.Client;
  private socket: Lark.WSClient;
  private appId: string;
  private cards = new CardRegistry();
  private managementCards = new ManagementCards();
  private managedSessionMessages = new Set<string>();
  onManagementAction(
    handler: ManagementHandler,
    authorize?: (message: Incoming, scope?: ManagementView['scope']) => boolean,
  ): void {
    this.managementCards.handler = handler;
    this.managementCards.authorize = authorize;
    this.managementCards.details = (message, text) => this.send(message, text);
  }
  async sendManagement(message: Incoming, view: ManagementView): Promise<void> {
    const previous = message.managementOrigin
      ? this.managementCards.get(message.managementOrigin)
      : undefined;
    const reusable =
      previous?.messageId &&
      previous.message.route.sender === message.route.sender &&
      previous.message.route.conversation === message.route.conversation &&
      previous.message.route.thread === message.route.thread &&
      previous.expires > Date.now()
        ? previous
        : undefined;
    const card = this.managementCards.open(message, view),
      parts = managementChunks(view);
    let qrKey: string | undefined;
    if (view.authorization?.status !== 'ready' && view.authorization?.url) {
      try {
        const png = await QRCode.toBuffer(view.authorization.url, { width: 320, margin: 2 });
        const result = await permissionRequest(
          this.client.im.image.create({ data: { image_type: 'message', image: png } }),
        );
        qrKey = result?.image_key;
      } catch {
        /* The clickable permission link remains usable if image upload is unavailable. */
      }
    }
    try {
      for (const [index, part] of parts.entries()) {
        if (index === 0 && reusable?.messageId) {
          await updateLarkCard(() =>
            this.client.im.message.patch({
              path: { message_id: reusable.messageId! },
              data: { content: JSON.stringify(larkManagementCard(card, part, true, qrKey)) },
            }),
          );
          card.messageId = reusable.messageId;
          this.managedSessionMessages.add(reusable.messageId);
          if (this.managedSessionMessages.size > 200)
            this.managedSessionMessages.delete(this.managedSessionMessages.values().next().value!);
          this.managementCards.remove(reusable.id);
          continue;
        }
        const data = {
            msg_type: 'interactive',
            content: JSON.stringify(
              larkManagementCard(card, part, index === 0, index === 0 ? qrKey : undefined),
            ),
            uuid: randomUUID(),
          },
          root = this.replyTarget(message);
        const result = await deliverManagement(() =>
          root
            ? this.client.im.message.reply({
                path: { message_id: root },
                data: { ...data, reply_in_thread: true },
              })
            : this.client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { ...data, receive_id: message.route.conversation },
              }),
        );
        if (index === 0) card.messageId = result.data!.message_id;
      }
      // Long-running management operations reuse this server-side context for
      // their accepted and final notifications, replacing the same message.
      if (reusable || (view.action === 'compact' && view.tone === 'orange'))
        message.managementOrigin = card.id;
    } catch (error) {
      this.managementCards.remove(card.id);
      throw error;
    }
  }
  async sendManagementFallback(message: Incoming, text: string): Promise<void> {
    const root = this.replyTarget(message);
    for (const part of splitText(text, 12_000)) {
      const data = {
        msg_type: 'text',
        content: JSON.stringify({ text: part }),
        uuid: randomUUID(),
      };
      await deliverManagement(() =>
        root
          ? this.client.im.message.reply({
              path: { message_id: root },
              data: { ...data, reply_in_thread: true },
            })
          : this.client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: { ...data, receive_id: message.route.conversation },
            }),
      );
    }
  }
  async checkGroupPermission(chatId: string) {
    return checkLarkGroupPermission(this.appId, this.config.domain, () =>
      permissionRequest(
        this.client.im.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            page_size: 1,
            sort_type: 'ByCreateTimeDesc',
          },
        }),
      ),
    );
  }
  private connecting?: AbortController;
  private approvalDetails: ApprovalDetailsDelivery;
  private sessionAction?: (click: SessionCardClick) => SessionCardView;
  onSessionAction(handler: (click: SessionCardClick) => SessionCardView): void {
    this.sessionAction = handler;
  }
  async createTopic(message: Incoming, title = '待命会话'): Promise<Incoming> {
    // Own the root so its preview is the task title and can later be renamed.
    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: message.route.conversation,
        msg_type: 'text',
        content: JSON.stringify({ text: title.replace(/</g, '＜').replace(/>/g, '＞') }),
        uuid: message.id,
      },
    });
    if (result.code !== 0 || !result.data?.message_id)
      throw new Error('新话题根消息投递失败或结果未知；未自动重试。');
    const root = result.data.message_id;
    return {
      ...message,
      replyTo: root,
      ownedTopicRoot: root,
      route: { ...message.route, thread: root },
    };
  }
  async topicLink(session: Session): Promise<string | undefined> {
    const result = await this.client.im.message.get({ path: { message_id: session.route.thread } });
    if (result.code !== 0) return undefined;
    const item = result.data?.items?.find((item) => item.message_id === session.route.thread);
    const thread = item?.thread_id;
    if (!thread) return undefined;
    const url = new URL(
      `https://${this.config.domain === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn'}/client/thread/open`,
    );
    url.searchParams.set('openchatid', session.route.conversation);
    url.searchParams.set('openthreadid', thread);
    url.searchParams.set('open_chat_id', session.route.conversation);
    url.searchParams.set('open_thread_id', thread);
    url.searchParams.set('thread_position', '-1');
    return url.toString();
  }
  async renameTopic(session: Session, title: string): Promise<void> {
    if (!session.ownedTopicRoot || session.ownedTopicRoot !== session.route.thread)
      throw new Error('此话题入口不是本机器人创建的可编辑消息。');
    const result = await this.client.im.message.update({
      path: { message_id: session.ownedTopicRoot },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: title.replace(/</g, '＜').replace(/>/g, '＞') }),
      },
    });
    if (result.code !== 0) throw new Error('话题入口标题更新失败或结果未知。');
  }
  private sessionCard(view: SessionCardView) {
    if (view.instructionsEditable || view.card.view !== 'status')
      return { body: larkSessionCard(view), menu: undefined };
    const message: Incoming = {
      id: randomUUID(),
      text: '/tab menu',
      route: view.session.route,
      direct: view.session.channelContext?.conversationType === 'direct',
      ...(view.session.channelContext?.conversationType === 'group'
        ? { groupMessage: { mentioned: true } }
        : {}),
    };
    const menu = this.managementCards.open(
      message,
      managementView(
        'menu',
        '常用操作；重置需再次确认。',
        view.session,
        sessionHomeButtons(view.session, true, view.pendingCount ?? 0),
        false,
      ),
    );
    menu.messageId = view.card.messageId;
    return { body: larkManagementCard(menu), menu };
  }
  async sendSessionCard(view: SessionCardView): Promise<string> {
    const root = this.replyTarget({ id: '', text: '', route: view.session.route });
    const rendered = this.sessionCard(view);
    const data = {
      msg_type: 'interactive',
      content: JSON.stringify(rendered.body),
      uuid: view.card.id,
    };
    const result = root
      ? await this.client.im.message.reply({
          path: { message_id: root },
          data: { ...data, reply_in_thread: true },
        })
      : await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { ...data, receive_id: view.session.route.conversation },
        });
    if (result.code !== 0 || !result.data?.message_id)
      throw new Error('会话卡片投递失败或结果未知');
    if (rendered.menu) rendered.menu.messageId = result.data.message_id;
    return result.data.message_id;
  }
  async sendSessionClosed(
    session: Session,
    notice: { id: string; at: number; recovery: string },
  ): Promise<void> {
    const root = this.replyTarget({ id: '', text: '', route: session.route });
    const data = {
      msg_type: 'interactive',
      content: JSON.stringify(larkClosedCard(session, notice)),
      uuid: notice.id,
    };
    const result = root
      ? await this.client.im.message.reply({
          path: { message_id: root },
          data: { ...data, reply_in_thread: true },
        })
      : await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { ...data, receive_id: session.route.conversation },
        });
    if (result.code !== 0 || !result.data?.message_id)
      throw new Error('关闭通知投递失败或结果未知');
  }
  async updateSessionCard(view: SessionCardView): Promise<void> {
    if (!view.card.messageId) throw new Error('会话卡片不存在');
    // A manually opened panel owns its message until the user refreshes it.
    // Background lifecycle/model-catalog refreshes must not overwrite unsaved form input.
    if (this.managedSessionMessages.has(view.card.messageId)) return;
    const result = await this.client.im.message.patch({
      path: { message_id: view.card.messageId },
      data: { content: JSON.stringify(this.sessionCard(view).body) },
    });
    if (result.code !== 0) throw new Error('会话卡片更新失败');
  }
  async sendToolProgress(message: Incoming, view: ToolRunView): Promise<string> {
    const root = this.replyTarget(message),
      data = {
        msg_type: 'interactive',
        content: JSON.stringify(larkToolCard(view)),
        uuid: view.id,
      };
    const result = root
      ? await this.client.im.message.reply({
          path: { message_id: root },
          data: { ...data, reply_in_thread: true },
        })
      : await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { ...data, receive_id: message.route.conversation },
        });
    if (result.code !== 0 || !result.data?.message_id)
      throw new Error('工具进度卡片投递失败或结果未知');
    return result.data.message_id;
  }
  async updateToolProgress(messageId: string, view: ToolRunView): Promise<void> {
    const result = await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(larkToolCard(view)) },
    });
    if (result.code !== 0) throw new Error('工具进度更新失败');
  }
  private replyTarget(message: Incoming): string | undefined {
    if (message.replyTo) return message.replyTo;
    if (message.route.thread.startsWith('om_')) return message.route.thread;
    if (message.route.thread) throw new Error('无法确定原话题根消息，未发送到聊天顶层。');
    return undefined;
  }
  constructor(
    private config: Extract<ChannelConfig, { type: 'lark' }>,
    resolveSecret = secret,
    private dataDir = '.tab-ai',
  ) {
    this.id = config.id;
    this.approvalDetails = new ApprovalDetailsDelivery(this.id, (message, text) =>
      this.send(message, text),
    );
    // SDK's fatal=0 falls back to its default logger in some versions. Never
    // allow Axios errors (containing credential headers) into service logs.
    const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
    const options = {
      appId: resolveSecret(config.appIdEnv),
      appSecret: resolveSecret(config.appSecretEnv),
      domain: config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.fatal,
      logger,
    };
    this.appId = options.appId;
    this.client = new Lark.Client(options);
    this.socket = new Lark.WSClient(options);
  }
  async downloadAttachments(message: Incoming, session: Session) {
    return downloadAttachments(this.dataDir, message, session, async (ref, signal) => {
      try {
        return await new Promise<import('node:stream').Readable>((resolve, reject) => {
          const abort = () => reject(new DOMException('附件下载超时', 'TimeoutError'));
          signal.addEventListener('abort', abort, { once: true });
          this.client.im.messageResource
            .get({
              path: { message_id: message.id, file_key: ref.key },
              params: { type: ref.type },
            })
            .then((result) => {
              const stream = result.getReadableStream();
              if (signal.aborted) stream.destroy();
              else resolve(stream);
            })
            .catch(reject)
            .finally(() => signal.removeEventListener('abort', abort));
        });
      } catch (error) {
        throw await larkResourceError(error, '飞书附件下载', this.appId);
      }
    });
  }
  async recentAttachments(session: Session): Promise<Incoming[]> {
    try {
      let containerType = 'chat',
        containerId = session.route.conversation;
      if (session.route.thread) {
        // Chat history lists thread roots only. Resolve the platform thread ID
        // from our stable root-message route before fetching topic replies.
        const root = await this.client.im.message.get({
          path: { message_id: session.route.thread },
        });
        if (root.code !== 0) throw root;
        const item = root.data?.items?.find((item) => item.message_id === session.route.thread);
        if (!item?.thread_id) throw new Error('Topic is unavailable');
        containerType = 'thread';
        containerId = item.thread_id;
      }
      const items = [];
      let pageToken: string | undefined;
      // Feishu permits at most 50 messages per page, not 100.
      for (let page = 0; page < 2; page++) {
        const result = await this.client.im.message.list({
          params: {
            container_id_type: containerType,
            container_id: containerId,
            page_size: 50,
            sort_type: 'ByCreateTimeDesc',
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
        if (result.code !== 0) throw result;
        items.push(...(result.data?.items ?? []));
        if (!result.data?.has_more || !result.data.page_token) break;
        pageToken = result.data.page_token;
      }
      return items
        .flatMap((item) => {
          if (
            item.sender?.id !== session.route.sender ||
            item.deleted ||
            !['file', 'image', 'audio', 'media', 'post'].includes(item.msg_type ?? '')
          )
            return [];
          const root = item.thread_id ? item.root_id || item.message_id : '';
          if (root !== session.route.thread) return [];
          // These are already constrained to this session's sender and route.
          const message = normalizeLark(
            {
              sender: { sender_type: 'user', sender_id: { open_id: item.sender.id } },
              message: {
                message_id: item.message_id,
                chat_id: session.route.conversation,
                chat_type: 'p2p',
                message_type: item.msg_type,
                content: item.body?.content,
                root_id: item.root_id,
                thread_id: item.thread_id,
              },
            },
            this.id,
            this.config.botOpenId,
          );
          // Recover files only. Never replay old user text or execute old tasks.
          return message?.attachments?.length ? [{ ...message, text: '' }] : [];
        })
        .reverse();
    } catch (error) {
      throw await larkResourceError(error, '飞书历史附件读取', this.appId);
    }
  }
  async start(onMessage: (message: Incoming) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.connecting = controller;
    try {
      await this.socket.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (raw) => {
            try {
              const message = normalizeLark(
                raw,
                this.id,
                this.config.botOpenId,
                this.config.groupModes,
              );
              if (message) await onMessage(message);
            } catch {
              channelError(this.id);
            }
          },
          'card.action.trigger': async (raw: unknown) => {
            raw = normalizeCardCallback(raw);
            const kind = (raw as { action?: { value?: { kind?: unknown } } })?.action?.value?.kind;
            if (kind === 'management') {
              const result = larkManagementAction(this.managementCards, raw);
              if (result.run) void result.run().catch(() => channelError(this.id));
              return { toast: { type: result.ok ? 'success' : 'error', content: result.message } };
            }
            if (kind === 'session') return larkSessionAction(raw, this.sessionAction);
            const { details, ...response } = larkCardAction(this.cards, raw);
            if (details && !this.approvalDetails.enqueue(details))
              return {
                toast: {
                  type: 'error',
                  content: '详情投递队列繁忙，审批未提交。请使用 /tab inspect。',
                },
              };
            return response;
          },
        }),
      });
      // SDK start() schedules connection work; its resolved promise is not readiness.
      const deadline = Date.now() + 20_000;
      while (this.socket.getConnectionStatus().state !== 'connected') {
        if (Date.now() >= deadline || this.socket.getConnectionStatus().state === 'failed')
          throw new Error('Not connected');
        await delay(100, undefined, { signal: controller.signal });
      }
    } catch {
      this.socket.close();
      throw new Error(
        '飞书长连接未建立，请检查网络、应用发布状态，以及事件与回调是否配置为长连接。',
      );
    } finally {
      if (this.connecting === controller) this.connecting = undefined;
    }
  }
  async sendInteraction(
    message: Incoming,
    request: Interaction,
    answer: (sender: string, answer: Answer) => void,
  ): Promise<InteractionDelivery | undefined> {
    const batch = this.cards.open(message, request, answer);
    if (
      !batch.cards.length ||
      batch.cards.length > 10 ||
      batch.cards.some(
        (p) => (p.question && cardBody(p).length > 6000) || (p.question?.options?.length ?? 0) > 50,
      )
    ) {
      batch.close('改用文字回答');
      return;
    }
    const close = async (status: string) => {
      batch.close(status);
      const results = await Promise.allSettled(
        batch.cards
          .filter((p) => p.messageId)
          .map(async (p) => {
            const content = JSON.stringify(larkCard(p));
            await updateLarkCard(() =>
              this.client.im.message.patch({
                path: { message_id: p.messageId! },
                data: { content },
              }),
            );
          }),
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    };
    try {
      const replyTo = this.replyTarget(message);
      for (const prompt of batch.cards) {
        const data = { msg_type: 'interactive', content: JSON.stringify(larkCard(prompt)) };
        const result = replyTo
          ? await this.client.im.message.reply({
              path: { message_id: replyTo },
              data: { ...data, reply_in_thread: true },
            })
          : await this.client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: { ...data, receive_id: message.route.conversation },
            });
        if (result.code !== 0 || !result.data?.message_id) throw new Error('卡片投递失败');
        prompt.messageId = result.data.message_id;
      }
      return { close };
    } catch {
      await close('卡片未完成投递，请使用文字命令').catch(() => {});
      throw new Error('飞书卡片投递失败或结果未知');
    }
  }
  async send(message: Incoming, text: string): Promise<void> {
    const replyTo = this.replyTarget(message);
    for (const part of splitText(text, 12_000)) {
      const data = { msg_type: 'text', content: JSON.stringify({ text: part }) };
      const response = replyTo
        ? await this.client.im.message.reply({
            path: { message_id: replyTo },
            data: { ...data, reply_in_thread: true },
          })
        : await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { ...data, receive_id: message.route.conversation },
          });
      if (response.code !== 0) throw new Error('Lark rejected the message');
    }
  }
  async stop(): Promise<void> {
    this.approvalDetails.stop();
    this.connecting?.abort();
    this.socket.close();
  }
}
