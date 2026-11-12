import { compactionTokensText } from './token-usage.js';
// Never persist raw SDK errors: response bodies, URLs and stderr can contain credentials.
export function maintenanceFailure(error: unknown): {
  code: string;
  detail: string;
  rpcCode?: number;
} {
  const text = error instanceof Error ? error.message : '';
  const rawCode = (error as { rpcCode?: unknown } | null)?.rpcCode,
    rpcCode = typeof rawCode === 'number' && Number.isFinite(rawCode) ? rawCode : undefined;
  const choices: [RegExp, string, string][] = [
    [
      /没有压缩完成标记|未确认.*完成|未完成|no.*compaction/i,
      'completion_unconfirmed',
      '原生完成标记缺失或轮次未成功结束，结果未确认。',
    ],
    [/非压缩工具/, 'unexpected_tool', '原生压缩请求了非压缩工具，已停止。'],
    [
      /不匹配|does not match|mismatch/i,
      'identity_mismatch',
      '原生会话或目录校验失败，未继续操作。',
    ],
    [
      /unauthori[sz]ed|authentication|not logged|login|登录|401|403/i,
      'authentication',
      '原生后端认证失败，请检查登录状态和权限。',
    ],
    [/quota|credit|billing|余额|额度/i, 'quota', '原生后端额度或计费限制。'],
    [/rate.?limit|429/i, 'rate_limit', '原生后端限流。'],
    [/timeout|timed out|超时/i, 'timeout', '原生后端超时，结果未确认。'],
    [
      /ECONN|ENET|EAI_AGAIN|network|fetch failed|连接|网络/i,
      'connection',
      '原生后端连接失败，结果未确认。',
    ],
    [/退出|closed|exited/i, 'process_closed', '原生进程已退出，结果未确认。'],
  ];
  for (const [pattern, code, detail] of choices)
    if (pattern.test(text)) return { code, detail, rpcCode };
  return {
    code: 'native_error',
    detail: '原生后端返回错误，结果未确认；请核对后端状态。',
    rpcCode,
  };
}

export interface CompactionRecord {
  tokens?: { nativeId: string; before?: number; after?: number };
  id: string;
  phase: 'accepted' | 'running' | 'completed' | 'noop' | 'failed' | 'unconfirmed';
  startedAt: number;
  updatedAt: number;
  detail: string;
  code?: string;
  rpcCode?: number;
}
export function readCompaction(text?: string): CompactionRecord | undefined {
  try {
    const value = JSON.parse(text ?? '');
    if (
      typeof value.id === 'string' &&
      ['accepted', 'running', 'completed', 'noop', 'failed', 'unconfirmed'].includes(value.phase) &&
      typeof value.detail === 'string' &&
      typeof value.startedAt === 'number' &&
      typeof value.updatedAt === 'number'
    ) {
      if (
        value.tokens &&
        (typeof value.tokens.nativeId !== 'string' ||
          [value.tokens.before, value.tokens.after].some(
            (n) => n !== undefined && (!Number.isSafeInteger(n) || n < 0),
          ))
      )
        delete value.tokens;
      return value;
    }
  } catch {}
}
export function compactionText(value?: CompactionRecord): string {
  if (!value) return '尚无压缩执行记录；打开面板不会开始压缩。';
  const label = {
    accepted: '已受理，尚未调用原生压缩',
    running: '原生压缩执行中',
    completed: '已完成',
    noop: '未执行压缩',
    failed: '失败',
    unconfirmed: '结果未确认',
  }[value.phase];
  return `最近压缩：${label}\n${value.detail}${value.tokens ? `\n${compactionTokensText(value.tokens.before, value.tokens.after)}` : ''}\n操作 ID：${value.id}${value.code ? `\n诊断：${value.code}` : ''}${value.rpcCode !== undefined ? `\n原生错误码：${value.rpcCode}` : ''}`;
}
