import { Readable } from 'node:stream';

// A resource request returns an error body as a stream. Extract only the
// diagnostic fields; never log Axios configs, headers, tokens or raw bodies.
export async function larkResourceError(
  error: unknown,
  operation: string,
  appId: string,
): Promise<Error> {
  const value = error as
    { code?: unknown; name?: string; response?: { status?: unknown; data?: unknown } } | undefined;
  let body = value?.response?.data ?? error;
  if (body instanceof Readable) {
    const stream = body;
    const timer = setTimeout(() => stream.destroy(new Error('error body timeout')), 1000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 65_536) {
          stream.destroy();
          throw new Error('error body too large');
        }
        chunks.push(bytes);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  const data = body as { code?: unknown; msg?: unknown } | undefined;
  const code =
    typeof data?.code === 'number' && Number.isSafeInteger(data.code) ? data.code : undefined;
  const status = typeof value?.response?.status === 'number' ? value.response.status : undefined;
  const suffix = code !== undefined ? `（飞书错误码 ${code}）` : status ? `（HTTP ${status}）` : '';
  const prefix = `${operation}失败${suffix}。`;
  if (code === 99991672 || code === 234009) {
    const scopes = [
      ...new Set(
        typeof data?.msg === 'string' ? (data.msg.match(/\bim:[a-z_]+(?::[a-z_]+)*/g) ?? []) : [],
      ),
    ].slice(0, 8);
    const application = /^cli_[a-zA-Z0-9]+$/.test(appId) ? `应用 ${appId}` : '当前机器人应用';
    return new Error(
      `${prefix}${application}缺少应用身份权限：${scopes.join(' / ') || '请核查消息资源读取权限'}。请在该应用后台开通所需权限并发布生效，再重试；个人用户授权不会替代应用权限。`,
    );
  }
  if (code === 99992402)
    return new Error(`${prefix}请求参数不符合飞书接口要求，请更新 tab-ai 或提供此错误码排查。`);
  if (code === 234003) return new Error(`${prefix}文件不属于指定消息，请重新发送原始附件。`);
  if (code === 234004)
    return new Error(`${prefix}机器人不在文件所在聊天中，请将附件发送到此机器人的会话。`);
  if (code === 234037) return new Error(`${prefix}文件超过飞书下载限制，请压缩或拆分。`);
  if (value?.name === 'TimeoutError' || ['ETIMEDOUT', 'ECONNABORTED'].includes(String(value?.code)))
    return new Error(`${prefix}请求超时，请检查网络后重试。`);
  return new Error(`${prefix}请检查网络及原始文件是否仍可访问；若持续失败，请提供此提示排查。`);
}
