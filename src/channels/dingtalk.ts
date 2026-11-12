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
import { normalizeDingTalk } from './normalize.js';
import { channelError, splitText } from './common.js';
import type { ManagementView } from '../core/types.js';
import { managementText } from '../core/management-view.js';
import { approvalOptions } from '../core/approval-decisions.js';

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
  private token?: { value: string; expires: number };
  private clientId: string;
  private clientSecret: string;
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
    this.clientId = resolveSecret(config.clientIdEnv);
    this.clientSecret = resolveSecret(config.clientSecretEnv);
    this.client = new DWClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      debug: false,
      keepAlive: true,
    });
  }
  async start(onMessage: (message: Incoming) => Promise<void>): Promise<void> {
    this.client.registerCallbackListener(TOPIC_ROBOT, (event) => {
      void (async () => {
        try {
          const raw = JSON.parse(event.data) as Record<string, unknown>;
          const message = normalizeDingTalk(raw, this.id);
          if (message) {
            if (
              typeof raw.robotCode === 'string' &&
              (raw.conversationType === '2' || typeof raw.senderStaffId === 'string')
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
            const expires =
              typeof raw.sessionWebhookExpiredTime === 'number'
                ? raw.sessionWebhookExpiredTime
                : Date.now() + 55 * 60_000;
            for (const [key, value] of this.replies)
              if (value.expires < Date.now()) this.replies.delete(key);
            this.replies.set(message.route.conversation, {
              url: checkedWebhook(raw.sessionWebhook),
              expires,
            });
            await onMessage(message);
          }
          this.client.socketCallBackResponse(event.headers.messageId, { status: 'SUCCESS' });
        } catch {
          channelError(this.id);
        }
      })();
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
      this.client.socketCallBackResponse(event.headers.messageId, result);
    });
    await this.client.connect();
    if (!this.client.connected) {
      this.client.disconnect();
      throw new Error('钉钉连接失败，请检查凭证、Stream 模式、应用发布状态和网络。');
    }
  }
  private async cardApi(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.token || this.token.expires <= Date.now()) {
      const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('钉钉卡片认证失败');
      const value = (await response.json()) as { accessToken?: string; expireIn?: number };
      if (!value.accessToken || typeof value.expireIn !== 'number')
        throw new Error('钉钉卡片认证失败');
      this.token = {
        value: value.accessToken,
        expires: Date.now() + Math.max(0, value.expireIn - 60) * 1000,
      };
    }
    const response = await fetch(`https://api.dingtalk.com/v1.0/card/instances${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': this.token.value,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('钉钉拒绝卡片请求');
    const value = (await response.json()) as Record<string, unknown>;
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
    const reply = this.replies.get(message.route.conversation);
    if (!reply || reply.expires <= Date.now())
      throw new Error('DingTalk reply URL expired; send /tab last in the conversation');
    for (const part of splitText(text)) {
      const response = await fetch(reply.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: part } }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('DingTalk delivery failed');
      const result = (await response.json()) as { errcode?: number };
      if (result.errcode !== 0) throw new Error('DingTalk rejected the message');
    }
  }
  async sendManagement(message: Incoming, view: ManagementView): Promise<void> {
    const reply = this.replies.get(message.route.conversation);
    if (!reply || reply.expires <= Date.now())
      throw new Error('钉钉回复入口已过期，请在原聊天发送 /tab menu。');
    // Native webhook Markdown needs no tenant template and does not invent
    // callback buttons. Exact commands remain usable in every tenant.
    for (const part of splitText(managementText(view), 5000)) {
      const escaped = part.replace(
        /[&<>]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!,
      );
      const response = await fetch(reply.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: {
            title: view.title,
            text: escaped
              .split('\n')
              .map((line) => '> ' + line + '  ')
              .join('\n'),
          },
        }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('钉钉管理菜单投递失败或结果未知');
      if (((await response.json()) as { errcode?: number }).errcode !== 0)
        await this.send(message, part);
    }
  }
  async stop(): Promise<void> {
    this.approvalDetails.stop();
    this.client.disconnect();
  }
}
