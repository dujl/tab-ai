import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

// Wire protocol: https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
export const WECHAT_BASE = 'https://ilinkai.weixin.qq.com';
export function wechatBase(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com'))
  )
    throw new Error('微信 API 地址无效');
  return url.origin;
}
export function wechatQrUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))
  )
    throw new Error('微信授权链接无效');
  return url.href;
}
export class WechatApiError extends Error {
  constructor(readonly code?: number) {
    super(
      code === -14
        ? '微信登录已失效，请重新扫码接入。'
        : `微信请求失败${code === undefined ? '，请检查网络或重新扫码' : `（错误码 ${code}）`}。`,
    );
  }
}
export class WechatApi {
  constructor(
    readonly base = WECHAT_BASE,
    private token?: string,
    private request: typeof fetch = fetch,
  ) {
    wechatBase(base);
  }
  async call(
    endpoint: string,
    data: Record<string, unknown> | undefined,
    signal: AbortSignal,
    timeoutMs = 40_000,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(0x000300),
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString(
        'base64',
      );
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
    }
    try {
      const response = await this.request(`${this.base}/ilink/bot/${endpoint}`, {
        method: data ? 'POST' : 'GET',
        headers,
        ...(data
          ? {
              body: JSON.stringify({
                ...data,
                ...(this.token
                  ? { base_info: { channel_version: '0.3.0', bot_agent: 'tab-ai/0.3.0' } }
                  : {}),
              }),
            }
          : {}),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok) throw new WechatApiError(response.status);
      // JSON.parse source context (Node >=22) preserves uint64 message IDs exactly.
      const result: unknown = JSON.parse(await response.text(), ((
        key: string,
        value: unknown,
        context?: { source: string },
      ) => {
        if (['message_id', 'svr_id', 'msg_id'].includes(key) && typeof value === 'number') {
          if (context?.source) return context.source;
          if (!Number.isSafeInteger(value)) throw new WechatApiError();
          return String(value);
        }
        return value;
      }) as Parameters<typeof JSON.parse>[1]);
      const status = z
        .object({ ret: z.number().optional(), errcode: z.number().optional() })
        .parse(result);
      if (status.ret || status.errcode) throw new WechatApiError(status.errcode || status.ret);
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WechatApiError) throw error;
      throw new WechatApiError(); // Fetch errors can include token-bearing request details.
    }
  }
}
export interface WechatLogin {
  botId: string;
  token: string;
  baseUrl: string;
  userId: string;
}
export async function loginWechat(
  signal: AbortSignal,
  onQr: (url: string, seconds: number) => void,
  verify: () => Promise<string>,
  request: typeof fetch = fetch,
): Promise<WechatLogin> {
  let api = new WechatApi(WECHAT_BASE, undefined, request);
  const qr = z
    .object({ qrcode: z.string().min(1), qrcode_img_content: z.string().min(1) })
    .parse(await api.call('get_bot_qrcode?bot_type=3', { local_token_list: [] }, signal));
  onQr(wechatQrUrl(qr.qrcode_img_content), 300);
  const expiresAt = Date.now() + 300_000;
  let code: string | undefined;
  while (!signal.aborted && Date.now() < expiresAt) {
    let raw: unknown;
    try {
      raw = await api.call(
        `get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}${code ? `&verify_code=${encodeURIComponent(code)}` : ''}`,
        undefined,
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      await delay(1500, undefined, { signal });
      continue;
    }
    code = undefined;
    const value = z
      .object({
        status: z.string(),
        bot_token: z.string().optional(),
        ilink_bot_id: z.string().optional(),
        baseurl: z.string().optional(),
        ilink_user_id: z.string().optional(),
        redirect_host: z.string().optional(),
      })
      .parse(raw);
    if (value.status === 'confirmed')
      return {
        botId: z.string().min(1).parse(value.ilink_bot_id),
        token: z.string().min(1).parse(value.bot_token),
        baseUrl: wechatBase(value.baseurl ?? api.base),
        userId: z.string().min(1).parse(value.ilink_user_id),
      };
    if (
      value.status === 'expired' ||
      value.status === 'verify_code_blocked' ||
      value.status === 'binded_redirect'
    )
      throw new WechatApiError();
    if (value.status === 'scaned_but_redirect') {
      const host = z.string().min(1).parse(value.redirect_host);
      api = new WechatApi(
        wechatBase(host.startsWith('https://') ? host : `https://${host}`),
        undefined,
        request,
      );
    } else if (value.status === 'need_verifycode') code = await verify();
    else if (!['wait', 'scaned'].includes(value.status)) throw new WechatApiError();
    await delay(1000, undefined, { signal });
  }
  signal.throwIfAborted();
  throw new WechatApiError();
}
