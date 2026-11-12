import { setTimeout as delay } from 'node:timers/promises';

// Only retry replacing the same card with the same terminal state. Never retry
// approval decisions, tool execution or creation of a new message here.
export async function updateLarkCard(
  send: () => Promise<{ code?: number }>,
  wait: (ms: number) => Promise<unknown> = delay,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let failure: unknown;
    try {
      const result = await send();
      if (result.code === 0) return;
      failure = { apiCode: result.code };
    } catch (error) {
      failure = error;
    }
    const error = (failure ?? {}) as {
      apiCode?: unknown;
      code?: unknown;
      name?: unknown;
      response?: { status?: unknown; data?: { code?: unknown } };
    };
    const api =
      typeof error.response?.data?.code === 'number'
        ? error.response.data.code
        : typeof error.apiCode === 'number'
          ? error.apiCode
          : undefined;
    const http = typeof error.response?.status === 'number' ? error.response.status : undefined;
    const transport = [
      'ETIMEDOUT',
      'ECONNABORTED',
      'ECONNRESET',
      'EAI_AGAIN',
      'ENETUNREACH',
      'ECONNREFUSED',
      'ERR_NETWORK',
    ].includes(String(error.code))
      ? String(error.code)
      : error.name === 'TimeoutError'
        ? 'ETIMEDOUT'
        : undefined;
    const retry =
      api !== undefined
        ? api === 99991400
        : http !== undefined
          ? http === 429 || http >= 500
          : !!transport;
    if (retry && attempt < 3) {
      await wait(attempt === 1 ? 500 : 1500);
      continue;
    }
    const diagnostic =
      api !== undefined
        ? `飞书错误码 ${api}`
        : http !== undefined
          ? `HTTP ${http}`
          : transport
            ? `网络 ${transport}`
            : '原因未确认';
    throw new Error(`卡片状态同步失败（${diagnostic}；尝试 ${attempt} 次）`);
  }
}
