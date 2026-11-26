import { z } from 'zod';
import type { AgentKind, AgentUsage, Session, TokenBreakdown } from './types.js';
import {
  matchingLedger,
  collectedUsage,
  type ArchivedUsageSummary,
  type NormalizedUsage,
} from './usage-ledger.js';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const tokenBreakdownSchema = z.object({
  inputTokens: count,
  cachedInputTokens: count.optional(),
  outputTokens: count,
  totalTokens: count.optional(),
  cacheWriteInputTokens: count.optional(),
  reasoningOutputTokens: count.optional(),
});
export const agentUsageSchema = z.object({
  source: z.enum(['codex', 'claude', 'opencode', 'traecli', 'agy']),
  last: tokenBreakdownSchema.optional(),
  total: tokenBreakdownSchema.optional(),
  totalScope: z.enum(['session', 'query', 'pipeline']).optional(),
  sampleId: z.string().min(1).max(300).optional(),
  complete: z.boolean().optional(),
  actualModel: z.string().max(300).optional(),
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
export function compactTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 999_500) {
    const k = n / 1_000;
    return k < 100 ? `${k.toFixed(1).replace(/\.0$/, '')}K` : `${Math.round(k)}K`;
  }
  if (n < 999_500_000) {
    const m = n / 1_000_000;
    return m < 10
      ? `${m.toFixed(2).replace(/\.00$/, '')}M`
      : m < 100
        ? `${m.toFixed(1).replace(/\.0$/, '')}M`
        : `${Math.round(m)}M`;
  }
  const b = n / 1_000_000_000;
  return b < 10
    ? `${b.toFixed(2).replace(/\.00$/, '')}B`
    : b < 100
      ? `${b.toFixed(1).replace(/\.0$/, '')}B`
      : `${Math.round(b)}B`;
}
function formatUsageTime(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function normalizeBreakdown(
  value: TokenBreakdown,
  source?: AgentKind | string,
): NormalizedUsage {
  const input = value.inputTokens + (value.cacheWriteInputTokens ?? 0);
  const partialInput = source !== 'codex' && value.cacheWriteInputTokens === undefined;
  const total = value.totalTokens ?? input + value.outputTokens;
  const partialTotal = partialInput && value.totalTokens === undefined;
  const note = value.totalTokens !== undefined && value.totalTokens !== input + value.outputTokens;
  return {
    input,
    output: value.outputTokens,
    total,
    partialInput,
    partialTotal,
    ...(note ? { note: true } : {}),
    ...(value.cachedInputTokens !== undefined ? { cacheRead: value.cachedInputTokens } : {}),
    ...(value.cacheWriteInputTokens !== undefined
      ? { cacheWrite: value.cacheWriteInputTokens }
      : {}),
    ...(value.reasoningOutputTokens !== undefined
      ? { reasoning: value.reasoningOutputTokens }
      : {}),
  };
}
export function combineNormalized(
  items: (NormalizedUsage | undefined)[],
): NormalizedUsage | undefined {
  const valid = items.filter((item): item is NormalizedUsage => !!item);
  if (!valid.length) return undefined;
  const result: NormalizedUsage = {
    input: 0,
    output: 0,
    total: 0,
    partialInput: false,
    partialTotal: false,
  };
  for (const item of valid) {
    result.input += item.input;
    result.output += item.output;
    result.total += item.total;
    if (item.partialInput) result.partialInput = true;
    if (item.partialTotal) result.partialTotal = true;
    if (item.note) result.note = true;
  }
  for (const field of ['cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const present = valid.filter((item) => item[field] !== undefined);
    if (!present.length) continue;
    result[field] = present.reduce((sum, item) => sum + item[field]!, 0);
    const partialField = `${field}Partial` as const;
    if (present.length < valid.length || present.some((item) => item[partialField])) {
      result[partialField] = true;
    }
  }
  return result;
}
export function formatNormalized(n: NormalizedUsage | undefined) {
  const number = (v: number | undefined, partial = false) =>
    v === undefined ? '未上报' : `${partial ? '≥' : ''}${tokens(v)}`;
  const shortNumber = (v: number | undefined, partial = false) =>
    v === undefined ? '未上报' : `${partial ? '≥' : ''}${compactTokens(v)}`;
  return {
    hasValue: !!n,
    total: number(n?.total, n?.partialTotal),
    input: number(n?.input, n?.partialInput),
    output: number(n?.output),
    cacheRead: number(n?.cacheRead, n?.cacheReadPartial),
    cacheWrite: number(n?.cacheWrite, n?.cacheWritePartial),
    reasoning: number(n?.reasoning, n?.reasoningPartial),
    short: {
      total: shortNumber(n?.total, n?.partialTotal),
      input: shortNumber(n?.input, n?.partialInput),
      output: shortNumber(n?.output),
      cacheRead: shortNumber(n?.cacheRead, n?.cacheReadPartial),
      cacheWrite: shortNumber(n?.cacheWrite, n?.cacheWritePartial),
      reasoning: shortNumber(n?.reasoning, n?.reasoningPartial),
    },
    note: n?.note ? '原生合计与分项口径不同，以原生合计为准' : undefined,
    cacheRatio:
      n &&
      n.cacheRead !== undefined &&
      !n.cacheReadPartial &&
      n.input > 0 &&
      !n.partialInput &&
      n.cacheRead <= n.input
        ? `${((n.cacheRead / n.input) * 100).toFixed(1)}%`
        : '未上报',
  };
}
export type UsageBreakdownView = ReturnType<typeof formatNormalized>;
export function usageBreakdown(value: TokenBreakdown | undefined, source?: string) {
  return formatNormalized(value ? normalizeBreakdown(value, source) : undefined);
}
function currentSessionUsage(session: Session) {
  const usage = currentUsage(session),
    ledger = matchingLedger(session),
    snapshot = session.tokenUsage;
  const useLedgerNative =
    ledger?.native &&
    ((ledger.segments ?? 1) > 1 ||
      snapshot?.origin !== 'native-history' ||
      ledger.nativeAt! >= (snapshot?.totalAt ?? snapshot?.at ?? 0));
  const native = useLedgerNative
    ? ledger!.native
    : usage?.totalScope === 'session' || usage?.totalScope === 'pipeline'
      ? usage.total
      : undefined;
  const collected = ledger?.recordedRuns ? collectedUsage(ledger) : undefined;
  const total = native ?? collected;
  const round = ledger?.current;
  const partial = native ? (ledger?.segments ?? 1) > 1 : !!ledger?.partial || !!round?.partial;
  const compactions =
    ledger?.compactions ??
    (session.nativeId && session.lastCompactionTokens?.nativeId === session.nativeId ? 1 : 0);
  return {
    usage,
    ledger,
    snapshot,
    useLedgerNative,
    native,
    collected,
    total,
    partial,
    compactions,
    round,
  };
}
export function archiveSessionUsage(
  session: Session,
  reason: 'reset' | 'relay' = 'reset',
): ArchivedUsageSummary {
  const prev = session.archivedTokenUsage;
  const current = currentSessionUsage(session);
  const currentNorm = current.total
    ? normalizeBreakdown(current.total, session.agent)
    : current.usage?.total
      ? normalizeBreakdown(current.usage.total, session.agent)
      : undefined;
  const currentPartial = current.total
    ? current.partial
    : current.usage?.total
      ? current.usage.complete === false
      : false;
  const hadUnreportedContext = !!session.nativeId && !currentNorm;
  const aggregate = combineNormalized([prev?.aggregate, currentNorm]);
  const sinceCandidates = [prev?.since, current.ledger?.since].filter(
    (v): v is number => v !== undefined,
  );
  const since = sinceCandidates.length ? Math.min(...sinceCandidates) : undefined;
  return {
    resets: (prev?.resets ?? 0) + (reason === 'reset' ? 1 : 0),
    ...(reason === 'relay' || prev?.relays
      ? { relays: (prev?.relays ?? 0) + (reason === 'relay' ? 1 : 0) }
      : {}),
    compactions: (prev?.compactions ?? 0) + current.compactions,
    recordedContexts: (prev?.recordedContexts ?? 0) + (currentNorm ? 1 : 0),
    partial: (prev?.partial ?? false) || currentPartial || hadUnreportedContext,
    ...(aggregate ? { aggregate } : {}),
    ...(since !== undefined ? { since } : {}),
    lastResetAt: Date.now(),
  };
}
export interface SubtreeChildUsage {
  key: string;
  sessionId?: string;
  taskId?: string;
  title: string;
  agent: AgentKind;
  depth: number;
  resets: number;
  relays?: number;
  compactions: number;
  partial: boolean;
  task: UsageBreakdownView;
  session: UsageBreakdownView;
}
export interface SubtreeUsageInfo {
  descendantCount: number;
  recordedDescendants: number;
  resets: number;
  compactions: number;
  partial: boolean;
  total: UsageBreakdownView;
  childrenTotal: UsageBreakdownView;
  children?: SubtreeChildUsage[];
}
export interface SubtreeCatalogNode {
  key: string;
  sessionId?: string;
  taskId?: string;
  parentKey?: string;
  title: string;
  agent: AgentKind;
}
function taskOwnState(session: Session | undefined) {
  if (!session) {
    return {
      resets: 0,
      relays: 0,
      compactions: 0,
      partial: false,
      hasSessionHistory: false,
      sessionNorm: undefined as NormalizedUsage | undefined,
      taskNorm: undefined as NormalizedUsage | undefined,
    };
  }
  const archived = session.archivedTokenUsage;
  const current = currentSessionUsage(session);
  const sessionNorm = current.total ? normalizeBreakdown(current.total, session.agent) : undefined;
  const resets = archived?.resets ?? 0;
  const relays = archived?.relays ?? 0;
  const compactions = (archived?.compactions ?? 0) + current.compactions;
  const taskNorm = combineNormalized([archived?.aggregate, sessionNorm]);
  const partial =
    (archived?.partial ?? false) ||
    current.partial ||
    ((resets > 0 || relays > 0) && !!session.nativeId && !sessionNorm);
  const hasSessionHistory =
    !!session.nativeId || resets > 0 || !!sessionNorm || !!archived?.aggregate;
  return { resets, relays, compactions, partial, hasSessionHistory, sessionNorm, taskNorm };
}
export function computeSubtreeUsageMap(
  entries: SubtreeCatalogNode[],
  sessionsById: Map<string, Session>,
  includeChildren = false,
): Map<string, SubtreeUsageInfo> {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const childrenByKey = new Map<string, SubtreeCatalogNode[]>();
  for (const entry of entries) {
    let parent = entry.parentKey;
    const seen = new Set([entry.key]);
    let validParent: string | undefined = parent;
    while (parent) {
      if (seen.has(parent) || !byKey.has(parent)) {
        validParent = undefined;
        break;
      }
      seen.add(parent);
      parent = byKey.get(parent)!.parentKey;
    }
    if (validParent) {
      const list = childrenByKey.get(validParent) ?? [];
      list.push(entry);
      childrenByKey.set(validParent, list);
    }
  }
  const result = new Map<string, SubtreeUsageInfo>();
  const ownByKey = new Map(
    entries.map((e) => [
      e.key,
      taskOwnState(e.sessionId ? sessionsById.get(e.sessionId) : undefined),
    ]),
  );
  for (const entry of entries) {
    if (!entry.sessionId) continue;
    const descendants: { node: SubtreeCatalogNode; depth: number }[] = [];
    const visited = new Set([entry.key]);
    const walk = (key: string, depth: number) => {
      for (const child of childrenByKey.get(key) ?? []) {
        if (visited.has(child.key)) continue;
        visited.add(child.key);
        descendants.push({ node: child, depth });
        walk(child.key, depth + 1);
      }
    };
    walk(entry.key, 1);
    if (!descendants.length) continue;
    const own = ownByKey.get(entry.key)!;
    const childStates = descendants.map(({ node, depth }) => ({
      node,
      depth,
      own: ownByKey.get(node.key)!,
    }));
    const recordedDescendants = childStates.filter((c) => !!c.own.taskNorm).length;
    const childrenNormalized = combineNormalized(childStates.map((c) => c.own.taskNorm));
    const subtreeNormalized = combineNormalized([
      own.taskNorm,
      ...childStates.map((c) => c.own.taskNorm),
    ]);
    const resets = own.resets + childStates.reduce((sum, c) => sum + c.own.resets, 0);
    const compactions =
      own.compactions + childStates.reduce((sum, c) => sum + c.own.compactions, 0);
    const partial =
      own.partial ||
      childStates.some((c) => c.own.partial || (c.own.hasSessionHistory && !c.own.taskNorm));
    result.set(entry.sessionId, {
      descendantCount: descendants.length,
      recordedDescendants,
      resets,
      compactions,
      partial,
      total: formatNormalized(subtreeNormalized),
      childrenTotal: formatNormalized(childrenNormalized),
      ...(includeChildren
        ? {
            children: childStates.map(({ node, depth, own: cOwn }) => ({
              key: node.key,
              sessionId: node.sessionId,
              taskId: node.taskId,
              title: node.title,
              agent: node.agent,
              depth,
              resets: cOwn.resets,
              ...(cOwn.relays ? { relays: cOwn.relays } : {}),
              compactions: cOwn.compactions,
              partial: cOwn.partial,
              task: formatNormalized(cOwn.taskNorm),
              session: formatNormalized(cOwn.sessionNorm),
            })),
          }
        : {}),
    });
  }
  return result;
}
export function usageInformation(session: Session, subtree?: SubtreeUsageInfo) {
  const {
    usage,
    ledger,
    snapshot,
    useLedgerNative,
    native,
    collected,
    total,
    partial: sessionPartial,
    compactions: currentCompactions,
    round,
  } = currentSessionUsage(session);
  const context = !session.contextUsageInvalidated ? usage?.contextTokens : undefined;
  const window = usage?.modelContextWindow;
  const totalScope = native
    ? (ledger?.segments ?? 1) > 1
      ? '原生分段累计 · 部分统计'
      : (useLedgerNative ? ledger?.nativeScope : usage?.totalScope) === 'pipeline'
        ? '原生流水线累计（可能含恢复历史）'
        : '原生会话累计'
    : collected
      ? `已采集累计${ledger?.partial ? ' · 部分统计' : ''}`
      : undefined;
  const totalScopeShort = native
    ? (ledger?.segments ?? 1) > 1
      ? '原生分段累计'
      : (useLedgerNative ? ledger?.nativeScope : usage?.totalScope) === 'pipeline'
        ? '原生流水线累计'
        : '原生会话累计'
    : collected
      ? '已采集累计'
      : '累计未上报';
  const roundLabel =
    round?.kind === 'compact'
      ? round.status === 'running'
        ? '本次压缩已采集'
        : '最近压缩消耗'
      : round?.status === 'running'
        ? '本轮已采集'
        : '最近一轮';
  const cumulative = {
    ...usageBreakdown(total, session.agent),
    scope: totalScope ?? '累计未上报',
    at: native
      ? useLedgerNative
        ? ledger?.nativeAt
        : (snapshot?.totalAt ?? snapshot?.at)
      : ledger?.collectedAt,
    partial: sessionPartial,
  };
  const currentRound = {
    ...usageBreakdown(round?.value, session.agent),
    label: roundLabel,
    status: round?.status,
    partial: round?.partial ?? true,
    reason: round?.reason,
    at: round?.sampledAt,
    runId: round?.runId,
  };
  const archived = session.archivedTokenUsage;
  const resets = archived?.resets ?? 0;
  const relays = archived?.relays ?? 0;
  const changes = [resets ? `${resets} 次重置` : '', relays ? `${relays} 次接力` : '']
    .filter(Boolean)
    .join(' · ');
  const compactions = (archived?.compactions ?? 0) + currentCompactions;
  const currentSessionNorm = total ? normalizeBreakdown(total, session.agent) : undefined;
  const taskNormalized = combineNormalized([archived?.aggregate, currentSessionNorm]);
  const taskBreakdown = formatNormalized(taskNormalized);
  const archivedBreakdown = formatNormalized(archived?.aggregate);
  const taskPartial =
    (archived?.partial ?? false) ||
    cumulative.partial ||
    ((resets > 0 || relays > 0) && !!session.nativeId && !currentSessionNorm);
  const taskCumulative = {
    ...taskBreakdown,
    resets,
    relays,
    compactions,
    archivedTotal: archivedBreakdown.total,
    archivedShort: archivedBreakdown.short.total,
    hasArchived: archivedBreakdown.hasValue,
    partial: taskPartial,
    at: cumulative.at ?? archived?.lastResetAt,
    scope:
      resets > 0 || relays > 0
        ? `本任务累计（含 ${changes}${compactions > 0 ? ` · ${compactions} 次压缩` : ''}${taskPartial ? ' · 部分统计' : ''}）`
        : compactions > 0
          ? `${cumulative.scope}（已压缩 ${compactions} 次）`
          : cumulative.scope,
  };
  const comparison =
    session.nativeId && session.lastCompactionTokens?.nativeId === session.nativeId
      ? session.lastCompactionTokens
      : undefined;
  const detail = (v: ReturnType<typeof formatNormalized>) =>
    `输入 ${v.input} · 输出 ${v.output} · 缓存读取 ${v.cacheRead} · 缓存写入 ${v.cacheWrite}${v.note ? `（${v.note}）` : ''}`;
  const contextKindLabel =
    context === undefined
      ? undefined
      : usage?.contextKind === 'last-call'
        ? '最近调用参考'
        : '原生估算';
  const contextShort =
    context === undefined
      ? session.contextUsageInvalidated
        ? '待原生更新'
        : '未上报'
      : `${compactTokens(context)}${window ? ` / ${compactTokens(window)} · ${((context / window) * 100).toFixed(1)}%` : ' tokens'}`;
  const totalShort = total
    ? cumulative.short.total
    : usage?.total
      ? `${usageBreakdown(usage.total, session.agent).short.total}（本次调用）`
      : usage?.last
        ? `${usageBreakdown(usage.last, session.agent).short.total}（最近调用）`
        : '未上报';
  const roundShort = round?.value
    ? `${currentRound.short.total}${round.partial ? '（部分）' : ''}`
    : round?.status === 'running'
      ? '等待上报'
      : '历史未采集';
  const since =
    archived?.since !== undefined && ledger?.since !== undefined
      ? Math.min(archived.since, ledger.since)
      : (ledger?.since ?? archived?.since);
  return {
    context:
      context === undefined
        ? session.contextUsageInvalidated
          ? '待原生更新（压缩或中止后数值未确认）'
          : '未上报'
        : `${tokens(context)}${window ? ` / ${tokens(window)} · ${((context / window) * 100).toFixed(1)}%` : ' tokens'}（${contextKindLabel}）`,
    contextShort,
    contextKindLabel,
    total: total
      ? `${cumulative.total} tokens（${totalScope}）`
      : usage?.total
        ? `${usageBreakdown(usage.total, session.agent).total} tokens（本次原生调用；会话累计未采集）`
        : usage?.last
          ? `${usageBreakdown(usage.last, session.agent).total} tokens（最近调用；累计未上报）`
          : '未上报累计值',
    totalShort,
    totalScopeShort,
    round: round?.value
      ? `${currentRound.total} tokens${round.partial ? '（部分统计）' : ''}`
      : round?.status === 'running'
        ? '等待本轮上报'
        : '历史未采集',
    roundShort,
    currentNativeId: session.nativeId,
    resets,
    relays,
    compactions,
    cumulative,
    taskCumulative,
    currentRound,
    ...(subtree ? { subtree } : {}),
    contextAt:
      usage?.contextTokens === undefined ? undefined : (snapshot?.contextAt ?? snapshot?.at),
    contextPercent: context !== undefined && window ? (context / window) * 100 : undefined,
    since,
    details: [
      ...(usage && snapshot?.origin === 'native-history'
        ? [{ label: '用量来源', value: '原生会话历史（只读）' }]
        : []),
      { label: '累计输入与输出', value: detail(cumulative) },
      ...(resets > 0 || relays > 0
        ? [
            {
              label: '本任务累计（含上下文变更）',
              value:
                `${taskCumulative.total} tokens（${detail(taskCumulative)}）` +
                (archivedBreakdown.hasValue ? `；其中历史已归档 ${archivedBreakdown.total}` : ''),
            },
          ]
        : []),
      ...(resets > 0 || relays > 0 || compactions > 0
        ? [
            {
              label: '上下文重置与压缩',
              value: `已重置 ${resets} 次 · 已接力 ${relays} 次 · 已压缩 ${compactions} 次（压缩不减少会话累计；重置后新会话从零计起，历史消耗保留在本任务累计）`,
            },
          ]
        : []),
      ...(subtree
        ? [
            {
              label: '含子任务总计',
              value: `${subtree.total.total} tokens（${detail(subtree.total)}；含 ${subtree.descendantCount} 个子任务，${subtree.recordedDescendants}/${subtree.descendantCount} 已采集）`,
            },
          ]
        : []),
      {
        label: roundLabel,
        value: round?.value
          ? detail(currentRound) + (round.partial ? '（部分统计）' : '')
          : round?.status === 'running'
            ? '等待本轮上报'
            : '历史未采集',
      },
      ...(round?.reason ? [{ label: '本轮统计说明', value: round.reason }] : []),
      ...(round?.actualModel ? [{ label: '原生上报模型', value: round.actualModel }] : []),
      ...(usage?.last
        ? [{ label: '最近调用用量', value: detail(usageBreakdown(usage.last, session.agent)) }]
        : []),
      { label: '思考 Token（已含于输出）', value: cumulative.reasoning },
      { label: '缓存读取占输入', value: cumulative.cacheRatio },
      ...(comparison
        ? [
            {
              label: '最近压缩对比',
              value: compactionTokensText(comparison.before, comparison.after),
            },
          ]
        : []),
      ...(usage ? [{ label: '用量采样时间', value: formatUsageTime(snapshot!.at) }] : []),
      ...(usage?.contextTokens === undefined
        ? []
        : [
            {
              label: '上下文采样时间',
              value: formatUsageTime(snapshot?.contextAt ?? snapshot!.at),
            },
          ]),
      ...(cumulative.at === undefined
        ? []
        : [{ label: '累计采样时间', value: formatUsageTime(cumulative.at) }]),
      ...(round?.sampledAt === undefined
        ? []
        : [{ label: '本轮采样时间', value: formatUsageTime(round.sampledAt) }]),
      ...(since !== undefined ? [{ label: '采集起点', value: formatUsageTime(since) }] : []),
      {
        label: '用量口径',
        value:
          '当前会话仅统计当前原生上下文，重置上下文后重新计起；本任务累计汇总本任务历次重置与压缩的已确认消耗；含子任务总计单独汇总本任务及全部后代子任务，不与自身消耗混淆。输入包含缓存读取及单独上报的缓存写入，思考已包含在输出；原生估算不是账单；未上报不代表零。',
      },
    ],
  };
}
export function compactionTokensText(before?: number, after?: number): string {
  const known = before !== undefined && after !== undefined;
  const delta = known ? before - after : undefined;
  return `上下文 tokens：${before === undefined ? '未上报' : tokens(before)} → ${after === undefined ? '待原生更新' : tokens(after)}${delta === undefined ? '' : `（${delta >= 0 ? '减少' : '增加'} ${tokens(Math.abs(delta))}${before! > 0 ? ` · ${((Math.abs(delta) / before!) * 100).toFixed(1)}%` : ''}）`}`;
}
