import { z } from 'zod';
import type { AgentUsage, Session } from './types.js';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const tokenBreakdownSchema = z.object({
  inputTokens: count,
  cachedInputTokens: count,
  outputTokens: count,
  totalTokens: count.optional(),
  cacheWriteInputTokens: count.optional(),
  reasoningOutputTokens: count.optional(),
});
export const agentUsageSchema = z.object({
  source: z.enum(['codex', 'claude', 'opencode']),
  last: tokenBreakdownSchema.optional(),
  total: tokenBreakdownSchema.optional(),
  totalScope: z.enum(['session', 'query']).optional(),
  contextTokens: count.optional(),
  modelContextWindow: count.positive().optional(),
  contextKind: z.enum(['native', 'last-call']).optional(),
});
export function currentUsage(session: Session): AgentUsage | undefined {
  const snapshot = session.tokenUsage;
  if (
    !session.nativeId ||
    snapshot?.nativeId !== session.nativeId ||
    !Number.isFinite(snapshot.at) ||
    snapshot.at < 0 ||
    snapshot.at > 8640000000000000
  )
    return;
  const parsed = agentUsageSchema.safeParse(snapshot.value);
  return parsed.success && parsed.data.source === session.agent ? parsed.data : undefined;
}
export const tokens = (n: number) => n.toLocaleString('en-US');
export function usageInformation(session: Session) {
  const usage = currentUsage(session),
    context = !session.contextUsageInvalidated ? usage?.contextTokens : undefined,
    window = usage?.modelContextWindow,
    total = usage?.total,
    comparison =
      session.lastCompactionTokens?.nativeId === session.nativeId
        ? session.lastCompactionTokens
        : undefined;
  return {
    context:
      context === undefined
        ? session.contextUsageInvalidated
          ? '待原生更新（压缩后数值未确认）'
          : '未上报'
        : `${tokens(context)}${window ? ` / ${tokens(window)} · ${((context / window) * 100).toFixed(1)}%` : ' tokens'}（${usage?.contextKind === 'last-call' ? '最近调用参考' : '原生估算'}）`,
    total: total
      ? `${tokens(total.totalTokens ?? total.inputTokens + total.outputTokens + (total.cacheWriteInputTokens ?? 0))} tokens（${usage?.totalScope === 'query' ? '本次原生调用' : '原生会话累计'}）`
      : usage?.last
        ? `${tokens(usage.last.inputTokens + usage.last.outputTokens + (usage.last.cacheWriteInputTokens ?? 0))} tokens（最近调用；累计未上报）`
        : '未上报累计值',
    details: [
      ...(usage && session.tokenUsage?.origin === 'native-history'
        ? [{ label: '用量来源', value: '原生会话历史（只读）' }]
        : []),
      ...(usage?.last
        ? [
            {
              label: '最近调用用量',
              value: `输入 ${tokens(usage.last.inputTokens)}（含缓存读取 ${tokens(usage.last.cachedInputTokens)}） · 输出 ${tokens(usage.last.outputTokens)}${usage.last.cacheWriteInputTokens === undefined ? '' : ` · 缓存写入 ${tokens(usage.last.cacheWriteInputTokens)}`}`,
            },
          ]
        : []),
      ...(total
        ? [
            {
              label: '累计输入与输出',
              value: `输入 ${tokens(total.inputTokens)}（含缓存读取 ${tokens(total.cachedInputTokens)}） · 输出 ${tokens(total.outputTokens)}${total.cacheWriteInputTokens === undefined ? '' : ` · 缓存写入 ${tokens(total.cacheWriteInputTokens)}`}`,
            },
          ]
        : []),
      ...(comparison
        ? [
            {
              label: '最近压缩对比',
              value: compactionTokensText(comparison.before, comparison.after),
            },
          ]
        : []),
      ...(usage
        ? [{ label: '用量采样时间', value: new Date(session.tokenUsage!.at).toISOString() }]
        : []),
      {
        label: '用量口径',
        value:
          '上下文为最近一次原生统计或调用参考，并非实时计数；累计消耗不会因压缩而减少。缓存读取已包含在输入中，思考 tokens 已包含在输出中；原生估算不等于账单。未上报不代表零。',
      },
    ],
  };
}
export function compactionTokensText(before?: number, after?: number): string {
  const known = before !== undefined && after !== undefined;
  const delta = known ? before - after : undefined;
  return `上下文 tokens：${before === undefined ? '未上报' : tokens(before)} → ${after === undefined ? '待原生更新' : tokens(after)}${delta === undefined ? '' : `（${delta >= 0 ? '减少' : '增加'} ${tokens(Math.abs(delta))}${before! > 0 ? ` · ${((Math.abs(delta) / before!) * 100).toFixed(1)}%` : ''}）`}`;
}
