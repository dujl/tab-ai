import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

// Protocol used by @wecom/wecom-openclaw-cli; no OpenClaw runtime is required.
const base = 'https://work.weixin.qq.com/ai/qc';
export class WecomRegistrationError extends Error {}
export interface WecomRegistration {
  botId: string;
  secret: string;
}
export function wecomQrUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WecomRegistrationError('企业微信返回的授权链接无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'work.weixin.qq.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/ai/qc/c'
  ) {
    throw new WecomRegistrationError('企业微信返回的授权链接无效。');
  }
  return value;
}
const credential = z.string().trim().min(1).max(4096);
export async function registerWecom(
  signal: AbortSignal,
  onQr: (url: string, seconds: number) => void,
  options: { fetch?: typeof fetch; timeoutMs?: number; pollMs?: number } = {},
): Promise<WecomRegistration> {
  const duration = options.timeoutMs ?? 300_000;
  const deadline = AbortSignal.timeout(duration);
  const operation = AbortSignal.any([signal, deadline]);
  const request = async (url: URL): Promise<unknown> => {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([operation, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error('request failed');
    return response.json();
  };
  try {
    operation.throwIfAborted();
    const generate = new URL(`${base}/generate`);
    generate.searchParams.set('source', 'tab-ai');
    generate.searchParams.set(
      'plat',
      String(({ darwin: 1, win32: 2, linux: 3 } as Record<string, number>)[process.platform] ?? 0),
    );
    const qr = z
      .object({ data: z.object({ scode: credential, auth_url: z.string() }) })
      .safeParse(await request(generate));
    if (!qr.success) throw new WecomRegistrationError('未取得企业微信二维码，请稍后重试。');
    onQr(wecomQrUrl(qr.data.data.auth_url), Math.floor(duration / 1000));
    const query = new URL(`${base}/query_result`);
    query.searchParams.set('scode', qr.data.data.scode);
    let failures = 0;
    while (true) {
      operation.throwIfAborted();
      let raw: unknown;
      try {
        raw = await request(query);
        failures = 0;
      } catch {
        operation.throwIfAborted();
        if (++failures >= 3)
          throw new WecomRegistrationError('查询企业微信扫码结果失败，请检查网络后重试。');
        await delay(options.pollMs ?? 3000, undefined, { signal: operation });
        continue;
      }
      const result = z
        .object({ data: z.object({ status: z.string(), bot_info: z.unknown().optional() }) })
        .safeParse(raw);
      if (!result.success) throw new WecomRegistrationError('企业微信扫码响应异常，请重试。');
      if (result.data.data.status === 'success') {
        const info = z
          .object({ botid: credential, secret: credential })
          .safeParse(result.data.data.bot_info);
        if (!info.success)
          throw new WecomRegistrationError(
            '扫码已确认，但未取得完整机器人凭证。请检查企业微信后台后重试。',
          );
        return { botId: info.data.botid, secret: info.data.secret };
      }
      await delay(options.pollMs ?? 3000, undefined, { signal: operation });
    }
  } catch (error) {
    if (signal.aborted) throw new WecomRegistrationError('企业微信扫码已取消。');
    if (deadline.aborted)
      throw new WecomRegistrationError('企业微信扫码已超时，请重新获取二维码。');
    if (error instanceof WecomRegistrationError) throw error;
    throw new WecomRegistrationError('企业微信扫码接入失败，请检查网络后重试。');
  }
}
