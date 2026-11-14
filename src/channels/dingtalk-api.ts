// Shared application token for cards and proactive robot replies. Never expose
// provider responses or fetch errors: they may contain application credentials.
export class DingTalkApi {
  private token?: { value: string; expires: number };
  private refreshing?: Promise<string>;

  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('钉钉应用认证失败');
      const value = (await response.json()) as { accessToken?: unknown; expireIn?: unknown };
      if (
        typeof value?.accessToken !== 'string' ||
        !value.accessToken ||
        typeof value.expireIn !== 'number' ||
        !Number.isFinite(value.expireIn) ||
        value.expireIn <= 0
      )
        throw new Error('钉钉应用认证失败');
      this.token = {
        value: value.accessToken,
        expires: Date.now() + Math.max(0, value.expireIn - 60) * 1000,
      };
      return value.accessToken;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  async request(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      const token = await this.accessToken();
      const response = await fetch(`https://api.dingtalk.com${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      // Invalidate for the next request, without replaying this side effect.
      if (response.status === 401 && this.token?.value === token) this.token = undefined;
      if (!response.ok) throw new Error('request failed');
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid response');
      return value as Record<string, unknown>;
    } catch {
      throw new Error('钉钉请求失败或结果未知，请检查应用权限和网络。');
    }
  }
}
