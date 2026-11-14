import { loginWechat, WechatApiError, type WechatLogin } from '../channels/wechat-api.js';
import { registerApp } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { type Draft } from './storage.js';
import {
  registerDingTalk,
  DingTalkRegistrationError,
  type DingTalkRegistration,
} from './dingtalk-registration.js';
import {
  registerWecom,
  WecomRegistrationError,
  type WecomRegistration,
} from './wecom-registration.js';

export const LARK_SCOPES = [
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message.group_msg',
  'im:message:readonly',
  'im:message:send_as_bot',
];
export const GUIDES = {
  wechat: {
    title: '微信（个人微信）',
    url: 'https://github.com/Tencent/openclaw-weixin',
    steps: [
      '使用微信扫描二维码，并在手机上确认登录。',
      '如微信要求验证码，在向导中输入手机显示的验证码。',
      '扫码账号私聊机器人发送任意文字，验证双向连接后确认启用。',
      '当前支持文字私聊；审批和提问使用文字命令，独立会话使用 /tab new 和 /tab use 切换。',
    ],
  },
  lark: {
    title: '飞书 / Lark',
    url: 'https://open.feishu.cn/app',
    steps: [
      '推荐扫码创建：在手机上确认应用与权限，凭证将自动保存到服务器。',
      '已有应用可选择凭证接入，开启机器人能力。',
      `授权：${LARK_SCOPES.join('、')}。`,
      '事件配置选择长连接，订阅 im.message.receive_v1；回调配置也选择长连接并添加 card.action.trigger，以支持审批和答题按钮。',
      '创建时一并申请 im:message.group_msg 群全量消息权限并发布审核生效；群模式仍默认仅 @，context / auto 需另外按群设置。',
      '发布应用并设置可用范围。扫码功能或权限预填是否可用取决于平台/租户；若配对收不到消息，按上述步骤检查后台。',
    ],
  },
  dingtalk: {
    title: '钉钉',
    url: 'https://open-dev.dingtalk.com/',
    steps: [
      '推荐使用钉钉扫码，在手机确认创建或绑定机器人，Client ID 和 Secret 自动保存。',
      '扫码完成后私聊机器人发送“你好”，收到回执后在向导核对账号并确认启用，无需复制配对码。',
      '已有应用也可手动填写凭证：开启 Stream 机器人、发布并设置可用范围。',
      '长任务回复需要开通单聊及群聊对应的机器人主动发送消息权限；按官方发送接口文档检查授权，权限变更后发布生效。',
      '复制 Client ID（AppKey）和 Client Secret（AppSecret）到下一步。',
      '按钮卡片可选：开通互动卡片实例写权限，按 docs/chat-interactions.md 创建 tab-ai 模板，并填写模板 ID；不配置时使用文字回答。',
      '手动凭证接入需私聊发送向导给出的配对码；无需填写用户 staffId。',
    ],
  },
  wecom: {
    title: '企业微信',
    url: 'https://work.weixin.qq.com/',
    steps: [
      '推荐使用企业微信扫码创建 / 授权，Bot ID 和 Secret 自动获取。',
      '已有机器人也可选择凭证接入：使用 API 长连接模式，传统群机器人 Webhook 不适用。',
      '扫码接入后私聊机器人发送任意文字，在向导核对账号并确认启用；已有凭证接入仍使用配对码。',
      '这是企业微信接入，不是个人微信；平台权限或审批要求以手机提示为准。',
    ],
  },
};

export class SetupError extends Error {}
export type Registration = Awaited<ReturnType<typeof registerApp>>;
export interface SetupProviders {
  dingtalkRegister?(
    signal: AbortSignal,
    onQr: (url: string, seconds: number) => void,
  ): Promise<DingTalkRegistration>;
  wecomRegister?(
    signal: AbortSignal,
    onQr: (url: string, seconds: number) => void,
  ): Promise<WecomRegistration>;
  wechatLogin?(
    signal: AbortSignal,
    onQr: (url: string, seconds: number) => void,
    verify: () => Promise<string>,
  ): Promise<WechatLogin>;
  register(
    domain: 'feishu' | 'lark',
    signal: AbortSignal,
    onUrl: (url: string, seconds: number) => void,
    name: string,
  ): Promise<Registration>;
  identify(draft: Draft, signal: AbortSignal): Promise<{ name: string; botOpenId?: string }>;
}
export const providers: SetupProviders = {
  dingtalkRegister: registerDingTalk,
  wecomRegister: registerWecom,
  wechatLogin: loginWechat,
  register: (domain, signal, onUrl, name) =>
    registerApp({
      domain: domain === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn',
      source: 'tab-ai',
      signal,
      createOnly: true,
      appPreset: { name, desc: '连接本机 Codex / Claude Code 的开发助手' },
      addons: {
        preset: false,
        scopes: { tenant: LARK_SCOPES },
        events: { items: { tenant: ['im.message.receive_v1'] } },
        callbacks: { items: ['card.action.trigger'] },
      },
      onQRCodeReady: (info) => onUrl(info.url, info.expireIn),
    }),
  async identify(draft, signal) {
    if (draft.type !== 'lark')
      return { name: draft.displayName ?? `${GUIDES[draft.type].title}机器人` };
    const base = draft.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const tokenResponse = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: draft.credentialId, app_secret: draft.credentialSecret }),
      signal: requestSignal,
      redirect: 'error',
    });
    if (!tokenResponse.ok)
      throw new SetupError('飞书凭证验证失败，请检查 App ID、App Secret 和网络。');
    const token = z
      .object({ code: z.number(), tenant_access_token: z.string().optional() })
      .parse(await tokenResponse.json());
    if (token.code !== 0 || !token.tenant_access_token)
      throw new SetupError(`飞书拒绝凭证（错误码 ${token.code}），请重新复制应用凭证。`);
    const response = await fetch(`${base}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token.tenant_access_token}` },
      signal: requestSignal,
      redirect: 'error',
    });
    if (!response.ok) throw new SetupError('无法读取飞书机器人信息，请检查机器人能力是否开启。');
    const info = z
      .object({
        code: z.number(),
        bot: z.object({ open_id: z.string(), app_name: z.string().optional() }).optional(),
      })
      .parse(await response.json());
    if (info.code !== 0 || !info.bot?.open_id)
      throw new SetupError(
        `飞书机器人未就绪（错误码 ${info.code}），请检查机器人能力、发布和可用范围。`,
      );
    return { name: info.bot.app_name ?? '飞书机器人', botOpenId: info.bot.open_id };
  },
};

export function safeSetupError(error: unknown): string {
  if (error instanceof DingTalkRegistrationError) return error.message;
  if (error instanceof WecomRegistrationError) return error.message;
  if (error instanceof WechatApiError)
    return error.code === -14
      ? error.message
      : `${error.message}机器人尚未启用；已取得的登录信息会保留，可在向导选择‘继续未完成配置’重试。`;
  if (error instanceof SetupError) return error.message;
  const code = z.object({ code: z.string() }).safeParse(error);
  if (code.success) {
    if (code.data.code === 'access_denied') return '已取消平台授权；没有启用机器人。';
    if (code.data.code === 'expired_token') return '平台授权链接已过期，请重试。';
  }
  return '接入未完成。请检查凭证、网络、机器人模式、权限、发布状态及可用范围；未启用机器人。';
}
