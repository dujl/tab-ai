import { setTimeout as delay } from 'node:timers/promises';

export class ManagementDeliveryError extends Error {
  constructor(
    readonly diagnostic: {
      apiCode?: number;
      httpStatus?: number;
      transport?: string;
      requestId?: string;
      attempts: number;
      outcome: 'rejected' | 'unconfirmed';
    },
  ) {
    super(
      `管理消息投递${diagnostic.outcome === 'rejected' ? '被拒绝' : '结果未确认'}（${diagnostic.apiCode !== undefined ? `飞书错误码 ${diagnostic.apiCode}` : diagnostic.httpStatus ? `HTTP ${diagnostic.httpStatus}` : (diagnostic.transport ?? '原因未确认')}；尝试 ${diagnostic.attempts} 次）`,
    );
  }
}
// Caller MUST keep the same UUID, destination and payload for every attempt.
// This retries message delivery only, never a management action or model operation.
export async function deliverManagement<
  T extends { code?: number; data?: { message_id?: string } },
>(send: () => Promise<T>, wait: (ms: number) => Promise<unknown> = delay): Promise<T> {
  for (let attempts = 1; ; attempts++) {
    let failure: unknown;
    try {
      const result = await send();
      if (result.code === 0 && result.data?.message_id) return result;
      failure = { apiCode: result.code === 0 ? undefined : result.code };
    } catch (error) {
      failure = error;
    }
    const e = (failure ?? {}) as {
      apiCode?: unknown;
      code?: unknown;
      name?: unknown;
      response?: { status?: unknown; data?: { code?: unknown }; headers?: Record<string, unknown> };
    };
    const apiCode =
      typeof e.response?.data?.code === 'number'
        ? e.response.data.code
        : typeof e.apiCode === 'number'
          ? e.apiCode
          : undefined;
    const httpStatus = typeof e.response?.status === 'number' ? e.response.status : undefined;
    const transport = [
      'ETIMEDOUT',
      'ECONNABORTED',
      'ECONNRESET',
      'EAI_AGAIN',
      'ENETUNREACH',
      'ECONNREFUSED',
      'ERR_NETWORK',
    ].includes(String(e.code))
      ? String(e.code)
      : e.name === 'TimeoutError'
        ? 'ETIMEDOUT'
        : undefined;
    const rawId = e.response?.headers?.['x-tt-logid'] ?? e.response?.headers?.['x-request-id'];
    const requestId =
      typeof rawId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(rawId) ? rawId : undefined;
    const retry =
      httpStatus === 429 ||
      (httpStatus !== undefined && httpStatus >= 500) ||
      apiCode === 99991400 ||
      !!transport;
    if (retry && attempts < 3) {
      await wait(attempts === 1 ? 500 : 1500);
      continue;
    }
    throw new ManagementDeliveryError({
      apiCode,
      httpStatus,
      transport,
      requestId,
      attempts,
      outcome:
        apiCode !== undefined || (httpStatus !== undefined && httpStatus < 500)
          ? 'rejected'
          : 'unconfirmed',
    });
  }
}
