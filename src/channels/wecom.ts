import { WecomMedia } from './wecom-media.js';
import { WecomHistory } from './wecom-history.js';
import { WSClient } from '@wecom/aibot-node-sdk';
import { type ChannelConfig, secret } from '../config.js';
import {
  type Answer,
  type Channel,
  type Incoming,
  type Interaction,
  type InteractionDelivery,
  type Session,
} from '../core/types.js';
import { ApprovalDetailsDelivery } from './approval-details.js';
import { CardRegistry, cardBody } from './cards.js';
import { wecomCard, wecomCardAction } from './wecom-cards.js';
import { normalizeWecom } from './normalize.js';
import { channelError, splitText } from './common.js';
import { ManagementCards, wecomManagementCard, wecomManagementAction } from './management-cards.js';
import type { ManagementHandler, ManagementView } from '../core/types.js';
import { managementText } from '../core/management-view.js';
import { createHash } from 'node:crypto';

// Keep transport diagnostics useful without logging frames, credentials or URLs.
export function wecomDiagnostic(message: unknown): string {
  const value = typeof message === 'string' ? message : '';
  const rules: [RegExp, string][] = [
    [/Received disconnected_event|Server disconnected/, 'replaced-connection'],
    [/Authentication failed|auth failure/, 'authentication'],
    [/Heartbeat|heartbeat|consecutive pings/, 'heartbeat'],
    [/Reply ack timeout/, 'reply-timeout'],
    [/Reply ack error/, 'reply-rejected'],
    [/WebSocket connection closed/, 'connection-closed'],
    [/WebSocket error|Failed to create WebSocket/, 'connection-error'],
    [/invalid message format|unknown frame|Failed to parse/, 'invalid-frame'],
    [/Failed to send|Reply queue/, 'send-failed'],
  ];
  const reason = rules.find(([pattern]) => pattern.test(value))?.[1] ?? 'other';
  const code = /errcode=(-?\d+)/.exec(value)?.[1];
  return `${reason}${code ? ` code=${code}` : ''}`;
}

export class WecomChannel implements Channel {
  readonly platform = 'wecom' as const;
  readonly id: string;
  private client: WSClient;
  private cards = new CardRegistry();
  private managementCards = new ManagementCards();
  onManagementAction(
    handler: ManagementHandler,
    authorize?: (message: Incoming, scope?: ManagementView['scope']) => boolean,
  ): void {
    this.managementCards.handler = handler;
    this.managementCards.authorize = authorize;
    this.managementCards.details = (message, text) => this.sendManagementText(message, text);
  }
  private async sendManagementText(message: Incoming, text: string): Promise<void> {
    for (const part of splitText(text, 1100)) {
      const fence = '`'.repeat(
        Math.max(3, ...[...part.matchAll(/`+/g)].map((m) => m[0].length + 1)),
      );
      const result = await this.client.sendMessage(message.route.conversation, {
        msgtype: 'markdown',
        markdown: { content: `${fence}\n${part}\n${fence}` },
      });
      if (result.errcode) throw new Error('管理文字菜单投递失败');
    }
  }
  async sendManagement(message: Incoming, view: ManagementView): Promise<void> {
    const card = this.managementCards.open(message, view);
    try {
      const result = await this.client.sendMessage(message.route.conversation, {
        msgtype: 'template_card',
        template_card: wecomManagementCard(card),
      });
      if (result.errcode) {
        this.managementCards.remove(card.id);
        await this.sendManagementText(message, managementText(view));
      }
    } catch (error) {
      this.managementCards.remove(card.id);
      throw error;
    }
  }
  private history: WecomHistory;
  private media: WecomMedia;
  private approvalDetails: ApprovalDetailsDelivery;
  private interactionQueue = new Map<string, Promise<unknown>>();
  constructor(
    config: Extract<ChannelConfig, { type: 'wecom' }>,
    resolveSecret = secret,
    dataDir = '.tab-ai',
  ) {
    this.id = config.id;
    this.approvalDetails = new ApprovalDetailsDelivery(
      this.id,
      async (message, part) => {
        const fence = '`'.repeat(
          Math.max(3, ...[...part.matchAll(/`+/g)].map((m) => m[0].length + 1)),
        );
        const sent = await this.client.sendMessage(message.route.conversation, {
          msgtype: 'markdown',
          markdown: { content: `${fence}\n${part}\n${fence}` },
        });
        if (sent.errcode) throw new Error('企业微信审批详情投递失败');
      },
      900,
    );
    this.media = new WecomMedia(dataDir, resolveSecret(config.botIdEnv));
    this.history = new WecomHistory(resolveSecret(config.botIdEnv), config.contextGroups || []);
    const diagnostic = (message: unknown) =>
      console.warn(
        `[${this.id}] ${new Date().toISOString()} transport ${wecomDiagnostic(message)}`,
      );
    this.client = new WSClient({
      botId: resolveSecret(config.botIdEnv),
      secret: resolveSecret(config.secretEnv),
      logger: { debug() {}, info() {}, warn: diagnostic, error: diagnostic },
    });
  }
  async start(onMessage: (message: Incoming) => Promise<void>): Promise<void> {
    for (const event of ['message.text', 'message.image', 'message.file', 'message.mixed'] as const)
      this.client.on(event, (frame) => {
        const message = normalizeWecom(frame.body, this.id, (route, value, type) =>
          this.media.register(route, value, type),
        );
        if (message) void onMessage(message).catch(() => channelError(this.id));
      });
    this.client.on('event.template_card_event', (frame) => {
      void (async () => {
        console.info(`[${this.id}] ${new Date().toISOString()} card-callback received`);
        const management = wecomManagementAction(this.managementCards, frame.body);
        if (management) {
          if (management.ok && management.card)
            await this.client.updateTemplateCard(frame, wecomManagementCard(management.card), [
              management.sender,
            ]);
          if (management.run) await management.run();
          return;
        }
        const result = wecomCardAction(this.cards, frame.body);
        if (!result) {
          console.warn(`[${this.id}] card-callback unrecognized; no approval submitted`);
          return;
        }
        const hash = (value: string) =>
          createHash('sha256').update(value).digest('hex').slice(0, 12);
        const reason = result.ok
          ? 'accepted'
          : /已结束|重启|过期/.test(result.message)
            ? 'ended-or-expired'
            : /只有|无权/.test(result.message)
              ? 'source-or-permission'
              : 'validation';
        console.info(
          `[${this.id}] ${new Date().toISOString()} card-callback ${JSON.stringify({ card: result.taskId, action: result.action, accepted: result.ok, reason, sender: hash(result.sender), chat: hash(result.conversation), request: result.prompt?.request.id })}`,
        );
        if (result?.ok && result.prompt) {
          // Acknowledge the callback before sending potentially many detail chunks.
          try {
            const ack = await this.client.updateTemplateCard(frame, wecomCard(result.prompt), [
              result.sender,
            ]);
            if (ack.errcode) throw Error('Card update rejected');
          } catch {
            console.warn(
              `[${this.id}] card-callback display-update-failed card=${result.taskId}; decision is unchanged`,
            );
            if (!result.details)
              await this.client.sendMessage(result.conversation, {
                msgtype: 'markdown',
                markdown: {
                  content: `${result.message}。卡片状态未能更新，可在原会话发送 /tab status 查看执行状态。`,
                },
              });
          }
          if (result.details && !this.approvalDetails.enqueue(result.details))
            throw new Error('审批详情队列繁忙；审批未提交');
        } else if (!result.ok) {
          const notice = `本次点击未生效：${result.message}\n请在当前会话发送 /tab pending 查看仍有效的请求；已过期的请求需要重新发起任务。`;
          try {
            const ack = await this.client.updateTemplateCard(
              frame,
              {
                card_type: 'text_notice',
                task_id: result.taskId,
                main_title: { title: '本次点击未生效', desc: result.message },
              },
              [result.sender],
            );
            if (ack.errcode) throw Error('Card update rejected');
          } catch {
            console.warn(`[${this.id}] rejected-card display-update-failed card=${result.taskId}`);
          }
          const sent = await this.client.sendMessage(result.conversation, {
            msgtype: 'markdown',
            markdown: { content: notice },
          });
          if (sent.errcode) throw Error('Callback notice rejected');
        }
      })().catch(() => channelError(this.id));
    });
    this.client.on('error', () => channelError(this.id));
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.client.off('authenticated', ready);
        this.client.off('error', failed);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        this.client.disconnect();
        reject(new Error('企业微信认证失败，请检查 Bot ID、Secret、长连接模式和网络。'));
      };
      const timer = setTimeout(failed, 20_000);
      this.client.once('authenticated', ready);
      this.client.once('error', failed);
      this.client.connect();
    });
  }
  downloadAttachments(message: Incoming, session: Session) {
    return this.media.download(message, session);
  }
  referencedAttachments(message: Incoming, signal: AbortSignal) {
    return this.history.attachments(message, signal);
  }
  recentAttachments(session: Session) {
    return this.history.attachments({ id: `sync-${Date.now()}`, route: session.route, text: '' });
  }
  groupReferences(message: Incoming, signal: AbortSignal) {
    return this.history.read(message, signal);
  }
  async send(message: Incoming, text: string): Promise<void> {
    for (const part of splitText(text)) {
      const result = await this.client.sendMessage(message.route.conversation, {
        msgtype: 'markdown',
        markdown: { content: part },
      });
      if (result.errcode) throw new Error('WeCom rejected the message');
    }
  }
  async sendInteraction(
    message: Incoming,
    request: Interaction,
    answer: (sender: string, answer: Answer) => void,
  ): Promise<InteractionDelivery | undefined> {
    if (request.elicitation && (request.kind === 'question' || request.elicitation.mode === 'url'))
      return; // Preserve complete form/link/decline semantics via text commands.
    return this.queueInteraction(message.route.conversation, () =>
      this.deliverInteraction(message, request, answer),
    );
  }
  private async queueInteraction<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.interactionQueue.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(run);
    this.interactionQueue.set(key, job);
    try {
      return await job;
    } finally {
      if (this.interactionQueue.get(key) === job) this.interactionQueue.delete(key);
    }
  }
  private async deliverInteraction(
    message: Incoming,
    request: Interaction,
    answer: (sender: string, answer: Answer) => void,
  ): Promise<InteractionDelivery | undefined> {
    if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) return;
    // Template cards have no general text input. Keep the entire interaction in
    // text mode if one question cannot be represented, avoiding half-filled batches.
    if (
      request.kind === 'question' &&
      request.questions?.some(
        (q) =>
          !q.options?.length ||
          q.options.length > 20 ||
          q.question.length > 128 ||
          q.options.some((o) => o.length > 128),
      )
    )
      return;
    const batch = this.cards.open(message, request, answer);
    if (
      !batch.cards.length ||
      batch.cards.length > 10 ||
      batch.cards.some((p) => p.question && cardBody(p).length > 1000)
    ) {
      batch.close('改用文字回答');
      return;
    }
    try {
      for (const prompt of batch.cards) {
        // Vote templates cannot show option descriptions. Preserve their full
        // meaning in a companion message rather than silently dropping them.
        if (prompt.question?.descriptions?.some(Boolean))
          await this.send(message, cardBody(prompt));
        const result = await this.client.sendMessage(message.route.conversation, {
          msgtype: 'template_card',
          template_card: wecomCard(prompt),
        });
        if (result.errcode) throw new Error('企业微信卡片投递失败');
        if (!prompt.question)
          console.info(
            `[${this.id}] ${new Date().toISOString()} approval-card accepted layout=summary-with-details request=${request.id} card=${prompt.id} expires=${request.expiresAt}`,
          );
      }
      // WeCom only permits replacement in response to a callback, not arbitrary
      // proactive edits. Server-side invalidation is immediate on every close.
      return {
        close: async (status) => {
          batch.close(status);
        },
      };
    } catch {
      batch.close('投递未完成');
      throw new Error('企业微信卡片投递失败或结果未知');
    }
  }
  async stop(): Promise<void> {
    this.approvalDetails.stop();
    this.client.disconnect();
  }
}
