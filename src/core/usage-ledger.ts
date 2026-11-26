import type { DatabaseSync } from 'node:sqlite';
import type { AgentKind, AgentUsage, Session, TokenBreakdown } from './types.js';

const fields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'reasoningOutputTokens',
] as const;
type Field = (typeof fields)[number];
type Counters = Record<Field, { value: number; missing: number }>;
export interface UsageRun {
  sessionId: string;
  stageId?: string;
  runId: string;
  agent: AgentKind;
  nativeId?: string;
  kind: 'turn' | 'compact';
  startedAt: number;
  endedAt?: number;
  sampledAt?: number;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  value?: TokenBreakdown;
  partial: boolean;
  reason?: string;
  actualModel?: string;
  baseline?: TokenBreakdown;
  fresh: boolean;
  counterReset?: boolean;
  authoritative?: boolean;
}
export interface UsageSummary {
  agent: AgentKind;
  nativeId?: string;
  since: number;
  counters: Counters;
  partial: boolean;
  current: UsageRun;
  native?: TokenBreakdown;
  nativeRaw?: TokenBreakdown;
  nativeOffset?: TokenBreakdown;
  nativeBase?: TokenBreakdown;
  nativeAt?: number;
  nativeScope?: 'session' | 'pipeline';
  segments: number;
  recordedRuns: number;
  compactions?: number;
  collectedAt?: number;
}
export interface NormalizedUsage {
  input: number;
  output: number;
  total: number;
  partialInput: boolean;
  partialTotal: boolean;
  note?: boolean;
  cacheRead?: number;
  cacheReadPartial?: boolean;
  cacheWrite?: number;
  cacheWritePartial?: boolean;
  reasoning?: number;
  reasoningPartial?: boolean;
}
export interface ArchivedUsageSummary {
  resets: number;
  relays?: number;
  compactions: number;
  recordedContexts: number;
  partial: boolean;
  aggregate?: NormalizedUsage;
  since?: number;
  lastResetAt: number;
}
const zero = (): TokenBreakdown => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});
export function addUsage(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  const result = {} as TokenBreakdown;
  for (const key of [...fields, 'totalTokens'] as const) {
    if (a[key] !== undefined && b[key] !== undefined) result[key] = a[key]! + b[key]!;
  }
  return result;
}
function delta(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown | undefined {
  const result = {} as TokenBreakdown;
  for (const key of [...fields, 'totalTokens'] as const) {
    if (a[key] === undefined || b[key] === undefined) continue;
    if (a[key]! < b[key]!) return;
    result[key] = a[key]! - b[key]!;
  }
  return result;
}
export function collectedUsage(summary: UsageSummary): TokenBreakdown | undefined {
  const c = summary.counters;
  if (!c.inputTokens || !c.outputTokens || !summary.current) return;
  const result = {} as TokenBreakdown;
  for (const key of fields) if (!c[key].missing) result[key] = c[key].value;
  return result;
}
export function matchingLedger(session: Session): UsageSummary | undefined {
  const ledger = session.tokenLedger;
  return ledger && ledger.agent === session.agent && ledger.nativeId === session.nativeId
    ? ledger
    : undefined;
}

// Runs and message snapshots are durable. A result replaces its previous snapshot;
// message samples never get added again just because a transport replays them.
export class UsageLedger {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_runs (session_id TEXT NOT NULL, run_id TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,run_id));
      CREATE INDEX IF NOT EXISTS usage_runs_page ON usage_runs(session_id,started_at,run_id);
      CREATE TABLE IF NOT EXISTS usage_samples (session_id TEXT NOT NULL, run_id TEXT NOT NULL, sample_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,run_id,sample_id));`);
  }
  get(sessionId: string, runId: string): UsageRun | undefined {
    const row = this.db
      .prepare('SELECT data FROM usage_runs WHERE session_id=? AND run_id=?')
      .get(sessionId, runId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private save(run: UsageRun): void {
    this.db
      .prepare(
        'INSERT INTO usage_runs VALUES (?,?,?,?) ON CONFLICT(session_id,run_id) DO UPDATE SET data=excluded.data',
      )
      .run(run.sessionId, run.runId, run.startedAt, JSON.stringify(run));
  }
  list(sessionId: string, before?: number, limit = 20) {
    const rows = this.db
      .prepare(
        'SELECT rowid,data FROM usage_runs WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?',
      )
      .all(sessionId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    return {
      runs: rows.slice(0, limit).map((row) => {
        const {
          baseline: _baseline,
          fresh: _fresh,
          authoritative: _authoritative,
          ...run
        } = JSON.parse(String(row.data)) as UsageRun;
        return { ...run, cursor: Number(row.rowid) };
      }),
      nextBefore: rows.length > limit ? Number(rows[limit - 1]!.rowid) : undefined,
    };
  }
  begin(session: Session, runId: string, kind: UsageRun['kind'], baseline?: AgentUsage): void {
    if (this.get(session.id, runId)) return;
    const summary = matchingLedger(session);
    const run: UsageRun = {
      stageId: session.currentStageId,
      sessionId: session.id,
      runId,
      agent: session.agent,
      nativeId: session.nativeId,
      kind,
      startedAt: Date.now(),
      status: 'running',
      partial: true,
      fresh: !session.nativeId,
      baseline:
        baseline?.totalScope === 'session' || baseline?.totalScope === 'pipeline'
          ? baseline.complete === false && summary?.nativeRaw
            ? summary.nativeRaw
            : baseline.total
          : undefined,
    };
    session.tokenLedger = summary ?? {
      agent: session.agent,
      nativeId: session.nativeId,
      since: run.startedAt,
      counters: Object.fromEntries(
        fields.map((key) => [key, { value: 0, missing: 0 }]),
      ) as Counters,
      partial: !!session.nativeId,
      current: run,
      segments: 1,
      recordedRuns: 0,
    };
    if (!session.tokenLedger.nativeRaw && run.baseline) {
      session.tokenLedger.nativeRaw = session.tokenLedger.native = run.baseline;
      session.tokenLedger.nativeScope =
        baseline?.totalScope === 'pipeline' ? 'pipeline' : 'session';
      session.tokenLedger.nativeAt = session.tokenUsage?.totalAt ?? session.tokenUsage?.at;
    }
    if (kind === 'compact') {
      session.tokenLedger.compactions = (session.tokenLedger.compactions ?? 0) + 1;
    }
    session.tokenLedger.current = run;
    this.save(run);
  }
  bind(session: Session, runId: string): void {
    const run = this.get(session.id, runId),
      summary = session.tokenLedger;
    if (!run || !summary || !run.fresh || run.nativeId || summary.current.runId !== runId) return;
    run.nativeId = summary.nativeId = session.nativeId;
    summary.current = run;
    this.save(run);
  }
  record(session: Session, value: AgentUsage, runId: string): void {
    const run = this.get(session.id, runId);
    if (!run || run.status !== 'running' || run.agent !== session.agent) return;
    if (run.nativeId && run.nativeId !== session.nativeId) return;
    const summary = session.tokenLedger;
    if (
      !summary ||
      summary.agent !== session.agent ||
      (summary.nativeId && summary.nativeId !== session.nativeId)
    )
      return;
    const previous = run.value;
    run.nativeId = summary.nativeId = session.nativeId;
    if (value.actualModel) run.actualModel = value.actualModel;
    if (value.total && (value.totalScope === 'session' || value.totalScope === 'pipeline')) {
      const raw = value.total;
      if (value.complete === false && summary.nativeRaw && !delta(raw, summary.nativeRaw)) {
        run.partial = true;
        run.reason = '失败结果计数回退，保留此前已确认用量';
        summary.partial = true;
        summary.current = run;
        this.save(run);
        return;
      }
      run.sampledAt = Date.now();
      if (summary.nativeRaw && !delta(raw, summary.nativeRaw)) {
        summary.nativeOffset = summary.native ?? summary.nativeRaw;
        summary.nativeBase = raw;
        summary.segments++;
        run.counterReset = true;
        summary.partial = true;
      }
      summary.nativeRaw = raw;
      const segment = summary.nativeBase ? delta(raw, summary.nativeBase) : raw;
      summary.native =
        summary.nativeOffset && segment ? addUsage(summary.nativeOffset, segment) : raw;
      summary.nativeScope = value.totalScope;
      summary.nativeAt = run.sampledAt;
      const baseline = run.baseline ?? (run.fresh ? zero() : undefined);
      const difference = baseline && !run.counterReset ? delta(raw, baseline) : undefined;
      if (difference) {
        run.value = difference;
        run.partial = value.complete === false;
        run.reason = undefined;
      } else {
        run.partial = true;
        run.reason = run.counterReset ? '原生计数已回退，本轮无法准确归属' : '缺少可靠轮初基线';
      }
      run.authoritative = true;
    } else if (value.total && value.totalScope === 'query') {
      run.sampledAt = Date.now();
      run.value = value.total;
      run.partial = value.complete !== true;
      run.reason = run.partial ? '原生轮次记录尚未完整确认' : undefined;
      run.authoritative = true;
    } else if (value.last && value.sampleId && !run.authoritative) {
      run.sampledAt = Date.now();
      this.db
        .prepare(
          'INSERT INTO usage_samples VALUES (?,?,?,?) ON CONFLICT(session_id,run_id,sample_id) DO UPDATE SET data=excluded.data',
        )
        .run(session.id, runId, value.sampleId, JSON.stringify(value.last));
      const samples = this.db
        .prepare('SELECT data FROM usage_samples WHERE session_id=? AND run_id=?')
        .all(session.id, runId);
      run.value = samples.reduce((sum, row) => addUsage(sum, JSON.parse(String(row.data))), zero());
      run.partial = true;
      run.reason = '已采集消息；等待最终累计确认';
    }
    if (previous || run.value)
      for (const key of fields) {
        const counter = summary.counters[key];
        if (previous) {
          counter.value -= previous[key] ?? 0;
          if (previous[key] === undefined) counter.missing--;
        }
        if (run.value) {
          counter.value += run.value[key] ?? 0;
          if (run.value[key] === undefined) counter.missing++;
        }
      }
    if (!previous && run.value) summary.recordedRuns++;
    if (run.value && run.sampledAt) summary.collectedAt = run.sampledAt;
    summary.current = run;
    this.save(run);
  }
  finish(session: Session, runId: string, status: Exclude<UsageRun['status'], 'running'>): void {
    const run = this.get(session.id, runId),
      summary = matchingLedger(session);
    if (!run || run.status !== 'running' || !summary) return;
    run.status = status;
    run.endedAt = Date.now();
    if (status !== 'completed' || !run.value) run.partial = true;
    if (run.partial) summary.partial = true;
    summary.current = run;
    this.save(run);
  }
  recover(session: Session): void {
    const summary = matchingLedger(session);
    if (summary?.current.status === 'running')
      this.finish(session, summary.current.runId, 'interrupted');
  }
}
