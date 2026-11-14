import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

// Device registration protocol published by DingTalk's official connector:
// https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/bin/dingtalk-connector.js
// The source value selects the vendor's robot registration preset. No OpenClaw
// installation, configuration or runtime is used by this connector.
const base = 'https://oapi.dingtalk.com/app/registration';
export class DingTalkRegistrationError extends Error {}
export interface DingTalkRegistration {
  clientId: string;
  clientSecret: string;
}
export function dingtalkQrUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DingTalkRegistrationError('钉钉返回的授权链接无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'open-dev.dingtalk.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/openapp/registration/openClaw' ||
    !url.searchParams.get('user_code')
  )
    throw new DingTalkRegistrationError('钉钉返回的授权链接无效。');
  return value;
}
const credential = z.string().trim().min(1).max(4096);
export async function registerDingTalk(
  signal: AbortSignal,
  onQr: (url: string, seconds: number) => void,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    pollMs?: number;
    statusGraceMs?: number;
  } = {},
): Promise<DingTalkRegistration> {
  const duration = options.timeoutMs ?? 600_000,
    deadline = AbortSignal.timeout(duration),
    operation = AbortSignal.any([signal, deadline]);
  let expiry: AbortSignal | undefined;
  const post = async (path: 'init' | 'begin' | 'poll', body: unknown) => {
    const response = await (options.fetch ?? fetch)(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([
        operation,
        ...(expiry ? [expiry] : []),
        AbortSignal.timeout(15_000),
      ]),
    });
    if (!response.ok) throw new Error('request failed');
    const value = z
      .object({ errcode: z.number() })
      .passthrough()
      .parse(await response.json());
    if (value.errcode !== 0) throw new Error('platform rejected request');
    return value;
  };
  try {
    operation.throwIfAborted();
    const init = z
      .object({ nonce: credential })
      .parse(await post('init', { source: 'DING_DWS_CLAW' }));
    operation.throwIfAborted();
    const begin = z
      .object({
        device_code: credential,
        verification_uri_complete: z.string(),
        interval: z.number().finite().positive().optional(),
        expires_in: z.number().finite().positive().optional(),
      })
      .parse(await post('begin', { nonce: init.nonce }));
    const expiresMs = Math.min(duration, (begin.expires_in ?? 7200) * 1000);
    expiry = AbortSignal.timeout(Math.ceil(expiresMs));
    const polling = AbortSignal.any([operation, expiry]);
    const interval = options.pollMs ?? Math.min(30, Math.max(3, begin.interval ?? 3)) * 1000;
    onQr(dingtalkQrUrl(begin.verification_uri_complete), Math.ceil(expiresMs / 1000));
    let retrySince: number | undefined;
    const retry = (message: string) => {
      retrySince ??= Date.now();
      if (Date.now() - retrySince >= (options.statusGraceMs ?? 120_000))
        throw new DingTalkRegistrationError(message);
    };
    while (true) {
      await delay(interval, undefined, { signal: polling });
      polling.throwIfAborted();
      let raw: Awaited<ReturnType<typeof post>>;
      try {
        raw = await post('poll', { device_code: begin.device_code });
      } catch {
        polling.throwIfAborted();
        retry('查询钉钉扫码结果失败，请检查网络后重试。');
        continue;
      }
      const status = typeof raw.status === 'string' ? raw.status.trim().toUpperCase() : '';
      if (status === 'WAITING') {
        retrySince = undefined;
        continue;
      }
      if (status === 'SUCCESS') {
        // Return credentials already issued by the server even if cancellation
        // raced with this response; SetupService retains them as a private draft.
        const credentials = z
          .object({ client_id: credential, client_secret: credential })
          .safeParse(raw);
        if (!credentials.success)
          throw new DingTalkRegistrationError(
            '扫码已确认，但未取得完整机器人凭证。请检查钉钉后台后重试。',
          );
        return {
          clientId: credentials.data.client_id,
          clientSecret: credentials.data.client_secret,
        };
      }
      // The official connector tolerates transitional statuses for two minutes.
      // Keep polling this same device flow; never restart remote registration.
      retry(
        status === 'EXPIRED'
          ? '钉钉授权链接已过期，请重新扫码。'
          : status === 'FAIL'
            ? '钉钉授权未完成或已取消，请重新扫码。'
            : '钉钉扫码状态异常，请重新扫码。',
      );
    }
  } catch (error) {
    if (signal.aborted) throw new DingTalkRegistrationError('钉钉扫码已取消。');
    if (deadline.aborted || expiry?.aborted)
      throw new DingTalkRegistrationError('钉钉扫码已超时，请重新获取二维码。');
    if (error instanceof DingTalkRegistrationError) throw error;
    throw new DingTalkRegistrationError(
      '钉钉扫码接入失败，请检查网络后重试；也可选择手动填写已有机器人凭证。',
    );
  }
}
