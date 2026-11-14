import { DWClient, TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '../setup/storage.js';
import { type ChannelConfig, secret } from '../config.js';
import {
  type Answer,
  type Channel,
  type Incoming,
  type Interaction,
  type InteractionDelivery,
} from '../core/types.js';
import { ApprovalDetailsDelivery } from './approval-details.js';
import { CardRegistry, cardBody } from './cards.js';
import { dingCardAction, dingCardData } from './dingtalk-cards.js';
import { DingTalkApi } from './dingtalk-api.js';
import { normalizeDingTalk } from './normalize.js';
import { channelError, splitText } from './common.js';
import type { ManagementView } from '../core/types.js';
import { managementText } from '../core/management-view.js';
import { approvalOptions } from '../core/approval-decisions.js';
import { dingManagementMarkdown, dingMarkdownParts, hasDingMarkdown } from './dingtalk-markdown.js';

export function checkedWebhook(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing DingTalk session webhook');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'oapi.dingtalk.com' ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/robot/')
  )
    throw new Error('Invalid DingTalk session webhook');
  return url.href;
}
const recipientSchema = z.object({
  spaceId: z.string().min(1),
  spaceType: z.enum(['IM_GROUP', 'IM_ROBOT']),
  robotCode: z.string().min(1),
  expires: z.number().finite(),
});
export class DingTalkChannel implements Channel {
  readonly platform = 'dingtalk' as const;
  readonly id: string;
  private client: DWClient;
  private cards = new CardRegistry();
  private cardTargets = new Map<
    string,
    { conversation: string; spaceId: string; spaceType: string }
  >();
  private cardRecipients = new Map<string, z.infer<typeof recipientSchema>>();
  private approvalDetails: ApprovalDetailsDelivery;
  private api: DingTalkApi;
  private stopping = new AbortController();
  private recipientFile?: string;
  // Short-lived signed callbacks stay in memory, never in transcripts or model input.
  private replies = new Map<string, { url: string; expires: number }>();
  constructor(
    private config: Extract<ChannelConfig, { type: 'dingtalk' }>,
    resolveSecret = secret,
    dataDir?: string,
  ) {
    this.id = config.id;
    this.approvalDetails = new ApprovalDetailsDelivery(this.id, (message, text) =>
      this.send(message, text),
    );
    const clientId = resolveSecret(config.clientIdEnv),
      clientSecret = resolveSecret(config.clientSecretEnv);
    this.api = new DingTalkApi(clientId, clientSecret);
    if (dataDir) {
      const key = createHash('sha256')
        .update(JSON.stringify([this.id, clientId]))
        .digest('hex');
      this.recipientFile = join(dataDir, 'dingtalk-recipients', `${key}.json`);
      try {
        if (existsSync(this.recipientFile)) {
          const entries = z
            .array(z.tuple([z.string(), recipientSchema]))
            .max(2000)
            .parse(JSON.parse(readFileSync(this.recipientFile, 'utf8')));
          for (const [key, recipient] of entries)
            if (recipient.expires > Date.now()) this.cardRecipients.set(key, recipient);
        }
      } catch {
        channelError(this.id);
      }
    }
    this.client = new DWClient({
      clientId,
      clientSecret,
      debug: false,
      keepAlive: true,
    });
    // Subscribe only to callbacks we handle, with an array owned by this bot.
    // The SDK's default subscriptions array is shared between instances.
    this.client.config.subscriptions = [];
  }
  async start(onMessage: (message: Incoming) => Promise<void>): Promise<void> {
    this.client.registerCallbackListener(TOPIC_ROBOT, (event) => {
      try {
        const raw = JSON.parse(event.data) as Record<string, unknown>;
        const message = normalizeDingTalk(raw, this.id);
        if (message) {
          if (
            typeof raw.robotCode === 'string' &&
            raw.robotCode &&
            (raw.conversationType === '2' ||
              (typeof raw.senderStaffId === 'string' && raw.senderStaffId))
          ) {
            this.cardRecipients.set(
              JSON.stringify([message.route.conversation, message.route.sender]),
              {
                spaceId:
                  raw.conversationType === '2'
                    ? message.route.conversation
                    : String(raw.senderStaffId),
                spaceType: raw.conversationType === '2' ? 'IM_GROUP' : 'IM_ROBOT',
                robotCode: raw.robotCode,
                expires: Date.now() + 30 * 86400_000,
              },
            );
            for (const [key, recipient] of this.cardRecipients)
              if (recipient.expires <= Date.now()) this.cardRecipients.delete(key);
            while (this.cardRecipients.size > 2000)
              this.cardRecipients.delete(this.cardRecipients.keys().next().value!);
            // Recovery requires a non-secret proactive target. Never persist a
            // signed sessionWebhook or raw provider payload in this cache.
            try {
              if (this.recipientFile) atomicJson(this.recipientFile, [...this.cardRecipients]);
            } catch {
              channelError(this.id);
            }
          }
          for (const [key, value] of this.replies)
            if (value.expires <= Date.now()) this.replies.delete(key);
          if (raw.sessionWebhook !== undefined) {
            try {
              const url = checkedWebhook(raw.sessionWebhook),
                expires =
                  raw.sessionWebhookExpiredTime === undefined
                    ? Date.now() + 55 * 60_000
                    : raw.sessionWebhookExpiredTime;
              if (
                typeof expires === 'number' &&
                Number.isFinite(expires) &&
                expires > Date.now() &&
                expires >= (this.replies.get(message.route.conversation)?.expires ?? 0)
              )
                this.replies.set(message.route.conversation, { url, expires });
            } catch {
              // Invalid/missing reply capabilities must not discard valid text.
              channelError(this.id);
            }
          }
          // Manager persists receipt and source before its first await. Robot
          // CALLBACKs are fire-and-forget; ACK does not guarantee redelivery.
          void onMessage(message).catch(() => channelError(this.id));
        }
      } catch {
        channelError(this.id);
      }
      this.acknowledge(event.headers.messageId, { status: 'SUCCESS' });
    });
    this.client.registerCallbackListener(TOPIC_CARD, (event) => {
      let result: object = {};
      try {
        const { details, ...response } = dingCardAction(
          this.cards,
          JSON.parse(event.data),
          this.cardTargets,
        );
        result = response;
        if (details && !this.approvalDetails.enqueue(details))
          result = {
            userPrivateData: {
              cardParamMap: { feedback: '详情投递队列繁忙，审批未提交。请使用 /tab inspect。' },
            },
            cardUpdateOptions: { updatePrivateDataByKey: true },
          };
      } catch {
        channelError(this.id);
      }
      this.acknowledge(event.headers.messageId, result);
    });
    try {
      await this.client.connect();
      if (!this.client.connected) throw new Error('not connected');
    } catch {
      this.client.disconnect();
      throw new Error('钉钉连接失败，请检查凭证、Stream 模式、应用发布状态和网络。');
    }
  }
  private acknowledge(messageId: string, result: object): void {
    try {
      this.client.socketCallBackResponse(messageId, result);
    } catch {
      channelError(this.id);
    }
  }
  private async cardApi(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const value = await this.api.request(
      method,
      `/v1.0/card/instances${path}`,
      body,
      this.budget(),
    );
    if (value.success !== true) throw new Error('钉钉卡片请求未确认成功');
    return value;
  }
  async sendInteraction(
    message: Incoming,
    request: Interaction,
    answer: (sender: string, answer: Answer) => void,
  ): Promise<InteractionDelivery | undefined> {
    if (request.elicitation) return; // Preserve complete form/link/decline semantics via text commands.
    // The tenant template has allow/deny buttons only. Preserve every native
    // choice through the text renderer when that template cannot represent it.
    if (request.kind === 'approval') {
      const choices = approvalOptions(request);
      if (
        choices.length !== 2 ||
        !choices.some((o) => o.id === 'allow') ||
        !choices.some((o) => o.id === 'deny')
      )
        return;
    }
    const recipient = this.cardRecipients.get(
      JSON.stringify([message.route.conversation, message.route.sender]),
    );
    if (!this.config.cardTemplateId || !recipient || recipient.expires <= Date.now()) return;
    const batch = this.cards.open(message, request, answer),
      sent = new Set<string>();
    if (
      !batch.cards.length ||
      batch.cards.length > 10 ||
      batch.cards.some(
        (p) => (p.question && cardBody(p).length > 6000) || (p.question?.options?.length ?? 0) > 20,
      )
    ) {
      batch.close('改用文字回答');
      return;
    }
    const close = async (status: string) => {
      batch.close(status);
      for (const prompt of batch.cards) this.cardTargets.delete(prompt.id);
      const results = await Promise.allSettled(
        batch.cards
          .filter((p) => sent.has(p.id))
          .map((p) =>
            this.cardApi('PUT', '', {
              outTrackId: p.id,
              cardData: { cardParamMap: dingCardData(p) },
              cardUpdateOptions: { updateCardDataByKey: true },
            }),
          ),
      );
      if (results.some((r) => r.status === 'rejected')) throw new Error('钉钉卡片状态更新失败');
    };
    try {
      for (const prompt of batch.cards) {
        this.cardTargets.set(prompt.id, { ...recipient, conversation: message.route.conversation });
        const result = await this.cardApi('POST', '/createAndDeliver', {
          cardTemplateId: this.config.cardTemplateId,
          outTrackId: prompt.id,
          callbackType: 'STREAM',
          userIdType: 1,
          cardData: { cardParamMap: dingCardData(prompt) },
          openSpaceId: `dtv1.card//${recipient.spaceType}.${recipient.spaceId}`,
          ...(recipient.spaceType === 'IM_GROUP'
            ? {
                imGroupOpenSpaceModel: { supportForward: false },
                imGroupOpenDeliverModel: { robotCode: recipient.robotCode },
              }
            : {
                imRobotOpenSpaceModel: { supportForward: false },
                imRobotOpenDeliverModel: { robotCode: recipient.robotCode, spaceType: 'IM_ROBOT' },
              }),
        });
        const deliveries = (
          result.result as { deliverResults?: { success?: boolean }[] } | undefined
        )?.deliverResults;
        if (!deliveries?.length || deliveries.some((d) => d.success !== true))
          throw new Error('钉钉卡片未确认投放成功');
        sent.add(prompt.id);
      }
      return { close };
    } catch {
      await close('投递未完成，请使用文字命令').catch(() => {});
      throw new Error('钉钉卡片投递失败或结果未知');
    }
  }
  private budget(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      this.stopping.signal,
      AbortSignal.timeout(15_000),
      ...(signal ? [signal] : []),
    ]);
  }
  async send(message: Incoming, text: string, signal?: AbortSignal): Promise<void> {
    signal = this.budget(signal);
    if (hasDingMarkdown(text)) {
      await this.sendMarkdown(message, text, 'tab-ai 回复', text, signal);
      return;
    }
    await this.sendText(message, text, signal);
  }
  private async sendText(message: Incoming, text: string, signal: AbortSignal): Promise<void> {
    for (const part of splitText(text))
      await this.deliver(message, 'text', { content: part }, signal);
  }
  private async sendMarkdown(
    message: Incoming,
    text: string,
    title: string,
    fallback: string,
    signal: AbortSignal,
  ): Promise<void> {
    const parts = dingMarkdownParts(text);
    for (const [index, part] of parts.entries()) {
      if (part.format === 'text') {
        await this.sendText(message, part.plain, signal);
        continue;
      }
      const accepted = await this.deliver(
        message,
        'markdown',
        { title, text: part.markdown },
        signal,
      );
      if (!accepted) {
        // A single management message can use its complete plain renderer.
        // Multipart delivery falls back only for this rejected part.
        await this.sendText(
          message,
          parts.length === 1 && index === 0 ? fallback : part.plain,
          signal,
        );
      }
    }
  }
  private async deliver(
    message: Incoming,
    type: 'text' | 'markdown',
    content: Record<string, string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (message.route.platform !== this.platform || message.route.account !== this.id)
      throw new Error('钉钉消息路由不属于当前机器人');
    const reply = this.replies.get(message.route.conversation);
    if (reply && reply.expires > Date.now()) {
      let result: { errcode?: number };
      try {
        const response = await fetch(reply.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: type, [type]: content }),
          signal,
          redirect: 'error',
        });
        if (!response.ok) throw new Error('delivery failed');
        result = (await response.json()) as { errcode?: number };
        signal.throwIfAborted();
      } catch {
        throw new Error('钉钉消息投递失败或结果未知');
      }
      if (result?.errcode === 0) return true;
      // A definitive webhook rejection permits the existing Markdown-to-text
      // fallback. Network errors and malformed responses must never replay.
      if (type === 'markdown' && typeof result?.errcode === 'number') return false;
      throw new Error('钉钉拒绝消息');
    }
    const recipient = this.cardRecipients.get(
      JSON.stringify([message.route.conversation, message.route.sender]),
    );
    if (!recipient || recipient.expires <= Date.now())
      throw new Error('钉钉回复入口已过期且缺少主动发送目标，请在原聊天发送 /tab last。');
    const result = await this.api.request(
      'POST',
      recipient.spaceType === 'IM_GROUP'
        ? '/v1.0/robot/groupMessages/send'
        : '/v1.0/robot/oToMessages/batchSend',
      {
        robotCode: recipient.robotCode,
        ...(recipient.spaceType === 'IM_GROUP'
          ? { openConversationId: recipient.spaceId }
          : { userIds: [recipient.spaceId] }),
        msgKey: type === 'text' ? 'sampleText' : 'sampleMarkdown',
        msgParam: JSON.stringify(content),
      },
      signal,
    );
    if (
      typeof result.processQueryKey !== 'string' ||
      !result.processQueryKey ||
      (result.invalidStaffIdList !== undefined &&
        (!Array.isArray(result.invalidStaffIdList) || result.invalidStaffIdList.length)) ||
      (result.flowControlledStaffIdList !== undefined &&
        (!Array.isArray(result.flowControlledStaffIdList) ||
          result.flowControlledStaffIdList.length))
    )
      throw new Error('钉钉未确认消息受理，请检查机器人发送权限、可用范围和限流。');
    return true;
  }
  async sendManagement(
    message: Incoming,
    view: ManagementView,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sendMarkdown(
      message,
      dingManagementMarkdown(view),
      view.title,
      managementText(view),
      this.budget(signal),
    );
  }
  async stop(): Promise<void> {
    this.stopping.abort();
    this.approvalDetails.stop();
    this.client.disconnect();
    this.replies.clear();
    this.cardRecipients.clear();
    this.cardTargets.clear();
  }
}
