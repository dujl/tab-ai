import { DWClient, TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream';
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
export class DingTalkChannel implements Channel {
  readonly platform = 'dingtalk' as const;
  readonly id: string;
  private client: DWClient;
  private cards = new CardRegistry();
  private cardTargets = new Map<
    string,
    { conversation: string; spaceId: string; spaceType: string }
  >();
  private cardRecipients = new Map<
    string,
    { spaceId: string; spaceType: 'IM_GROUP' | 'IM_ROBOT'; robotCode: string }
  >();
  private approvalDetails: ApprovalDetailsDelivery;
  private api: DingTalkApi;
  // Short-lived signed callbacks stay in memory, never in transcripts or model input.
  private replies = new Map<string, { url: string; expires: number }>();
  constructor(
    private config: Extract<ChannelConfig, { type: 'dingtalk' }>,
    resolveSecret = secret,
  ) {
    this.id = config.id;
    this.approvalDetails = new ApprovalDetailsDelivery(this.id, (message, text) =>
      this.send(message, text),
    );
    const clientId = resolveSecret(config.clientIdEnv),
      clientSecret = resolveSecret(config.clientSecretEnv);
    this.api = new DingTalkApi(clientId, clientSecret);
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
              },
            );
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
          // Manager claims the message synchronously before its first await.
          // Acknowledge receipt without waiting for classification or an agent;
          // retries still pass through Manager's persistent message deduplication.
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
    const value = await this.api.request(method, `/v1.0/card/instances${path}`, body);
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
    if (!this.config.cardTemplateId || !recipient) return;
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
  async send(message: Incoming, text: string): Promise<void> {
    if (hasDingMarkdown(text)) {
      await this.sendMarkdown(message, text, 'tab-ai 回复');
      return;
    }
    await this.sendText(message, text);
  }
  private async sendText(message: Incoming, text: string): Promise<void> {
    for (const part of splitText(text)) await this.deliver(message, 'text', { content: part });
  }
  private async sendMarkdown(
    message: Incoming,
    text: string,
    title: string,
    fallback = text,
  ): Promise<void> {
    const parts = dingMarkdownParts(text);
    for (const [index, part] of parts.entries()) {
      const accepted = await this.deliver(message, 'markdown', { title, text: part.markdown });
      if (!accepted) {
        // A single management message can use its complete plain renderer.
        // Multipart delivery falls back only for this rejected part.
        await this.sendText(message, parts.length === 1 && index === 0 ? fallback : part.plain);
      }
    }
  }
  private async deliver(
    message: Incoming,
    type: 'text' | 'markdown',
    content: Record<string, string>,
  ): Promise<boolean> {
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
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('delivery failed');
        result = (await response.json()) as { errcode?: number };
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
    if (!recipient)
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
  async sendManagement(message: Incoming, view: ManagementView): Promise<void> {
    await this.sendMarkdown(
      message,
      dingManagementMarkdown(view),
      view.title,
      managementText(view),
    );
  }
  async stop(): Promise<void> {
    this.approvalDetails.stop();
    this.client.disconnect();
    this.replies.clear();
    this.cardRecipients.clear();
    this.cardTargets.clear();
  }
}
