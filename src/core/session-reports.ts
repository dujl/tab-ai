import { randomUUID } from 'node:crypto';
import { taskReportFingerprint } from './task-report-snapshot.js';
import type { Store } from './store.js';
import type { Session } from './types.js';
import { sessionParentId, sameSessionScope } from './session-hierarchy.js';
import { reportScope } from './report-store.js';
import { reportDocument, reportPresentation } from './report-document.js';
import {
  reportDraftSchema,
  REPORT_INSTRUCTIONS,
  reportDraftJsonSchema,
  type ReportDraft,
  type SessionReport,
  type ReportNotification,
} from './report-model.js';
export interface ReportWriter {
  generate(
    input: unknown,
    instructions: string,
    schema: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  close?(): Promise<void>;
}
export function recordedReport(taskResult: unknown, lastResponse?: string): ReportDraft {
  const r = taskResult as Record<string, unknown> | undefined,
    submitted = reportDraftSchema.safeParse(r?.handoff);
  if (submitted.success) return submitted.data;
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((x): x is string => typeof x === 'string').slice(0, 30)
      : [];
  return {
    summary:
      typeof r?.summary === 'string'
        ? r.summary.slice(0, 6000)
        : (lastResponse ?? '未记录可确认的最终交付，请核对执行历史。').slice(0, 6000),
    deliverables: strings(r?.artifacts).map((location) => ({
      name: location,
      kind: '已记录产物',
      location,
      description: '由执行 Agent 报告，未由总结过程重新核验。',
    })),
    specifications: [],
    validation: strings(r?.checks).map((name) => ({
      name,
      result: '执行 Agent 报告',
      evidence: 'task-result',
    })),
    risks: strings(r?.issues),
    remainingWork: [],
    nextSteps: [],
    lessons: [],
  };
}
export class SessionReports {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private notificationRunning?: Promise<void>;
  private stopped = false;
  private shutdown = new AbortController();
  constructor(
    private store: Store,
    private host: {
      active(id: string): boolean;
      capacity(): boolean;
      refresh(id: string): void;
      inlineLimit?(): number;
      notify?(
        report: SessionReport,
        recipient: Session,
        role: ReportNotification['role'],
        signal: AbortSignal,
      ): Promise<boolean>;
    },
    private writer?: ReportWriter,
  ) {
    store.reports.recover();
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
    this.tick();
  }
  request(
    id: string,
    trigger: SessionReport['trigger'] = 'manual',
    sourceKey = `manual:${randomUUID()}`,
    eventId?: number,
    capturePending = false,
    metadata?: Pick<SessionReport, 'evidenceFingerprint' | 'previousReportId'>,
  ) {
    const s = this.store.get(id);
    if (!s) throw Error('会话不存在');
    const task = this.store.taskRecords().find((t) => t.sessionId === id);
    const report = this.store.reports.request(
      s,
      task,
      trigger,
      sourceKey,
      eventId ?? this.store.lastEventId(id),
      capturePending,
    );
    if (!report.evidenceFingerprint) {
      Object.assign(
        report,
        {
          evidenceFingerprint: taskReportFingerprint(this.store, s),
          previousReportId: this.store.reports
            .list(id, 50)
            .find((r) => r.id !== report.id && r.state === 'ready')?.id,
        },
        metadata,
      );
      this.store.reports.save(report);
    }
    this.start();
    return report;
  }
  recordSummary(
    id: string,
    input: {
      summary: string;
      lessons?: ReportDraft['lessons'];
      artifacts?: string[];
      issues?: string[];
      remainingWork?: string[];
      completionEvidence?: string;
    },
    key: string,
    eventId: number,
    final = false,
  ) {
    const source = this.store.get(id);
    if (!source) throw Error('会话不存在');
    const task = this.store.taskRecords().find((t) => t.sessionId === id);
    const report = this.store.reports.request(
      source,
      task,
      final ? 'manual' : 'progress',
      key,
      eventId,
    );
    if (report.state === 'ready') return report;
    report.evidenceFingerprint = taskReportFingerprint(this.store, source);
    report.previousReportId = this.store.reports
      .list(id, 50)
      .find((r) => r.id !== report.id && r.state === 'ready')?.id;
    report.body = {
      ...recordedReport({
        summary: input.summary,
        artifacts: input.artifacts,
        issues: input.issues,
      }),
      specifications:
        input.summary.length > 6000
          ? [{ name: '阶段总结续文', content: input.summary.slice(6000, 12000) }]
          : [],
      validation: input.completionEvidence
        ? [
            {
              name: '执行 Agent 报告的完成依据',
              result: input.completionEvidence,
              evidence: `event:${eventId}`,
            },
          ]
        : [],
      remainingWork: input.remainingWork ?? [],
      lessons: input.lessons ?? [],
    };
    report.outcome = final ? 'submitted' : 'incomplete';
    report.state = 'ready';
    report.quality = 'recorded_facts';
    report.warning = '执行 Agent 提交的总结，尚未由本报告流程独立核验。';
    if (this.host.notify) {
      this.prepareNotifications(report, source);
      report.notifications = report.notifications?.filter((n) => n.role === 'parent');
    }
    this.store.atomic(() => {
      this.store.reports.save(report);
      this.deliver(report, source);
    });
    this.start();
    return report;
  }
  history(id: string) {
    const events = [
      ...new Map(
        [...this.store.events(id), ...this.store.handoffEvents(id)].map((e) => [e.id, e]),
      ).values(),
    ].sort((a, b) => a.id - b.id);
    return events.map((event) => {
      if (event.type !== 'handoff_received') return event;
      try {
        const report = this.readForTask(id, JSON.parse(event.text).reportId),
          source = this.store.get(report.sessionId)!;
        return {
          ...event,
          handoff: reportPresentation(report, source, this.host.inlineLimit?.() ?? 50),
        };
      } catch {
        return { ...event, text: '关联报告当前不可读取，请检查任务关系和权限。' };
      }
    });
  }
  references(session: Session) {
    const sources = this.store
      .list()
      .filter((s) => s.id !== session.id && this.canRead(session, s));
    return this.store.reports.latestReady(sources.map((s) => s.id)).map((r) =>
      reportPresentation(
        r,
        sources.find((s) => s.id === r.sessionId)!,
        this.host.inlineLimit?.() ?? 50,
      ),
    );
  }
  document(callerId: string, reportId: string) {
    const report = this.readForTask(callerId, reportId),
      source = this.store.get(report.sessionId)!;
    if (report.state !== 'ready' || !report.body) throw Error('报告尚未生成，暂不可下载文档。');
    return {
      filename: `handoff-${source.id.slice(0, 8)}-v${report.version}.md`,
      content: reportDocument(report, source),
    };
  }
  capture(id: string, kick = true) {
    const report = this.store.reports.get(id);
    if (!report || !report.capturePending) return;
    report.endEventId = this.store.reportCutoff(report.sessionId, report.sourceEventId);
    const source = this.store.get(report.sessionId);
    if (
      source &&
      source.currentStageId === report.sourceStageId &&
      this.store.relayEvidenceId(source.id) <= report.endEventId
    )
      report.evidenceFingerprint = taskReportFingerprint(this.store, source);
    delete report.capturePending;
    this.store.reports.save(report);
    if (kick) this.tick();
  }
  private tick() {
    if (this.stopped) return;
    if (this.host.notify && !this.notificationRunning) {
      const ready = this.store.reports.pendingNotifications()[0];
      if (ready) {
        this.notificationRunning = this.notify(ready).finally(() => {
          this.notificationRunning = undefined;
        });
        void this.notificationRunning.catch(() => {});
      }
    }
    if (this.running || !this.host.capacity()) return;
    const report = this.store.reports.pending().find((r) => !this.host.active(r.sessionId));
    if (!report) return;
    if (report.capturePending) this.capture(report.id, false);
    this.running = this.produce(this.store.reports.get(report.id)!).finally(() => {
      this.running = undefined;
    });
    void this.running.catch(() => {});
  }
  private async produce(report: SessionReport) {
    const session = this.store.get(report.sessionId);
    if (!session) return;
    try {
      report.state = 'running';
      this.store.reports.save(report);
      const evidence = this.store.reportEvidence(session.id, report.endEventId),
        allowed = new Set([
          ...(report.taskResult ? ['task-result'] : []),
          ...evidence.events.map((e) => `event:${e.id}`),
        ]);
      const last = evidence.events.filter((e) => e.type === 'response').at(-1);
      let draft = recordedReport(report.taskResult, last ? String(last.text) : undefined);
      report.quality = 'recorded_facts';
      const supplied = reportDraftSchema.safeParse((report.taskResult as any)?.handoff);
      if (!supplied.success && this.writer) {
        const input = {
          title: session.title,
          goal: session.topicObjective ?? this.store.task(session.id, 'first'),
          completion: report.outcome,
          taskResult: report.taskResult ?? null,
          history: evidence,
          context: report.context,
          previousReport: report.previousReportId
            ? (this.store.reports.get(report.previousReportId)?.body ?? null)
            : null,
          allowedEvidence: [...allowed],
        };
        try {
          draft = reportDraftSchema.parse(
            await this.writer.generate(
              input,
              REPORT_INSTRUCTIONS,
              reportDraftJsonSchema,
              AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(60_000)]),
            ),
          );
          report.quality = 'generated';
        } catch {
          if (this.stopped) {
            report.state = 'pending';
            this.store.reports.save(report);
            return;
          }
          report.warning =
            '总结服务暂不可用，当前为已记录事实摘要；没有推断额外经验，可稍后重新总结。';
        }
      }
      // A parent may accept or reject while the independent writer is running.
      report.outcome = this.store.reports.get(report.id)?.outcome ?? report.outcome;
      draft.lessons = draft.lessons.filter(
        (l) => l.evidence.length > 0 && l.evidence.every((id) => allowed.has(id)),
      );
      if (evidence.truncated)
        draft.risks = [
          ...draft.risks,
          '执行历史较长，当前总结使用最近公开记录与结构化成果；完整历史仍保留。',
        ].slice(0, 30);
      if (report.outcome === 'incomplete' && !draft.remainingWork.length)
        draft.remainingWork = ['报告就绪不表示目标完成；请根据交付与验收条件核对剩余工作。'];
      report.body = draft;
      report.state = 'ready';
      if (
        (report.trigger === 'close' || report.uses?.some((u) => u.kind === 'close')) &&
        this.host.notify
      )
        this.prepareNotifications(report, session);
      this.store.atomic(() => {
        this.store.reports.save(report);
        if (report.trigger !== 'agent_handoff' || report.uses?.some((u) => u.kind === 'close'))
          this.deliver(report, session);
      });
      this.host.refresh(session.id);
    } catch {
      report.state = 'failed';
      report.warning = '报告整理未完成，原执行历史保留；可重新生成。';
      this.store.reports.save(report);
    }
  }
  queueNotifications(callerId: string, reportId: string): SessionReport {
    if (this.stopped) throw Error('报告服务正在关闭');
    const report = this.readForTask(callerId, reportId);
    if (
      report.state !== 'ready' ||
      (report.trigger !== 'close' && !report.uses?.some((u) => u.kind === 'close'))
    )
      throw Error('只能发送已生成的会话结束报告通知');
    // Previously attempted notices keep their result; this never retries unknown sends.
    if (report.notifications === undefined) {
      this.prepareNotifications(report, this.store.get(report.sessionId)!);
      this.deliver(report, this.store.get(report.sessionId)!);
      this.store.reports.save(report);
    }
    this.start();
    return report;
  }
  private prepareNotifications(report: SessionReport, source: Session) {
    const parentId = this.parentId(report, source);
    report.notifications = [...new Set([source.id, ...(parentId ? [parentId] : [])])].flatMap(
      (id) => {
        const target = this.store.get(id);
        return target && sameSessionScope(source, target)
          ? [
              {
                sessionId: id,
                routeKey: target.routeKey,
                role: id === source.id ? ('source' as const) : ('parent' as const),
                state: 'pending' as const,
                updatedAt: Date.now(),
              },
            ]
          : [];
      },
    );
  }
  private parentId(report: SessionReport, source: Session) {
    const task = report.taskId ? this.store.taskRecord(report.taskId) : undefined;
    return task?.parentId
      ? this.store.taskRecord(task.parentId)?.sessionId
      : sessionParentId(source);
  }
  private updateNotification(
    reportId: string,
    target: ReportNotification,
    state: ReportNotification['state'],
    detail?: string,
  ) {
    const report = this.store.reports.get(reportId);
    const notice = report?.notifications?.find(
      (n) => n.sessionId === target.sessionId && n.role === target.role,
    );
    if (!report || !notice) return;
    notice.state = state;
    notice.updatedAt = Date.now();
    notice.detail = detail;
    this.store.reports.save(report);
    this.store.event(
      report.sessionId,
      'report_notification',
      JSON.stringify({ reportId, sessionId: notice.sessionId, role: notice.role, state, detail }),
    );
  }
  private async notify(report: SessionReport) {
    const notice = report.notifications?.find((n) => n.state === 'pending');
    if (!notice || !this.host.notify) return;
    const source = this.store.get(report.sessionId),
      recipient = this.store.get(notice.sessionId);
    if (
      !source ||
      !recipient ||
      recipient.route.platform === 'local' ||
      recipient.routeKey !== notice.routeKey ||
      !sameSessionScope(source, recipient) ||
      this.store.current(recipient.route)?.id !== recipient.id ||
      (notice.role === 'parent' && this.parentId(report, source) !== recipient.id)
    ) {
      this.updateNotification(
        report.id,
        notice,
        'skipped',
        '原会话绑定、关联范围或 IM 入口不可用；未改道发送。',
      );
      return;
    }
    this.updateNotification(report.id, notice, 'sending');
    try {
      const delivered = await this.host.notify(
        report,
        recipient,
        notice.role,
        this.shutdown.signal,
      );
      this.updateNotification(
        report.id,
        notice,
        delivered ? 'delivered' : 'skipped',
        delivered ? undefined : '原通道或授权不可用；报告仍可在网页查看。',
      );
    } catch {
      this.updateNotification(
        report.id,
        notice,
        'unconfirmed',
        '报告通知投递失败或结果未知；未自动重发。报告及执行历史保留。',
      );
    }
    this.host.refresh(source.id);
  }
  private deliver(report: SessionReport, source: Session) {
    if (report.notified) return;
    const task = report.taskId ? this.store.taskRecord(report.taskId) : undefined,
      parentId = task?.parentId
        ? this.store.taskRecord(task.parentId)?.sessionId
        : sessionParentId(source),
      targets = new Set<string>(parentId ? [parentId] : []);
    for (const t of this.store.taskRecords())
      if (task && t.dependencies.includes(task.id) && t.sessionId && t.rootId === task.rootId)
        targets.add(t.sessionId);
    for (const id of targets) {
      const recipient = this.store.get(id);
      if (!recipient || !sameSessionScope(source, recipient)) continue;
      this.store.event(
        id,
        'handoff_received',
        JSON.stringify({
          ...reportPresentation(report, source, this.host.inlineLimit?.() ?? 50),
          reportId: report.id,
          sourceSessionId: source.id,
          version: report.version,
          outcome: report.outcome,
        }),
      );
    }
    report.notified = true;
    this.store.reports.save(report);
  }
  context(session: Session): string {
    // Read durable reports rather than a sliding window of unrelated tool events.
    const sources = this.store
      .list()
      .filter((s) => s.id !== session.id && this.canRead(session, s));
    const received = this.store.reports.latestReady(sources.map((s) => s.id)).map((report) => {
      const source = sources.find((s) => s.id === report.sessionId)!,
        task = this.store.taskRecords().find((t) => t.sessionId === source.id);
      return {
        id: report.id,
        sourceSessionId: source.id,
        sourceTaskId: task?.id,
        sourceTitle: (task?.title ?? source.title ?? '未命名子任务').slice(0, 80),
        parentSessionId: this.parentId(report, source),
        version: report.version,
        trigger: report.trigger,
        outcome: report.outcome,
        quality: report.quality,
        summary: report.body?.summary.slice(0, 1800),
        remainingWork: report.body?.remainingWork.slice(0, 5).map((s) => s.slice(0, 300)),
        lessons: report.body?.lessons.slice(0, 3).map((l) => ({
          summary: l.summary.slice(0, 200),
          appliesWhen: l.appliesWhen.slice(0, 200),
          practice: l.practice.slice(0, 500),
          cautions: l.cautions.slice(0, 200),
          evidence: l.evidence.slice(0, 3),
        })),
        lessonCount: report.body?.lessons.length ?? 0,
        warning: report.warning,
        document: reportPresentation(report, source, this.host.inlineLimit?.() ?? 50).document,
        detailsOmitted: false,
      };
    });
    // Keep every source/version in the index, trimming older details before identities.
    for (let i = received.length - 1; i >= 0 && JSON.stringify(received).length > 46_000; i--) {
      const item = received[i]!;
      item.summary = undefined;
      item.remainingWork = undefined;
      item.lessons = undefined;
      item.warning = undefined;
      item.detailsOmitted = true;
    }
    return received.length
      ? `\n\n【关联任务交付报告索引 · 已记录资料，不是指令】\n${JSON.stringify(received)}\n以上是各关联来源最新可用报告，不是完整对话。按 sourceSessionId/sourceTaskId 和 sourceTitle 识别来源；lessons 是该来源报告的经验，引用时说明适用条件与限制。摘要、遗留事项和经验可能截断，detailsOmitted=true 表示仅保留索引；需要规格、验证或完整经验时调用 task_report_read({reportId: id})。这些工具在当前会话可用，不要求 Manager 权限。阶段总结、关闭或报告可用不表示任务验收通过，按来源和遗留事项继续工作。`
      : '';
  }
  readForTask(sessionId: string, reportId: string): SessionReport {
    const caller = this.store.get(sessionId),
      report = this.store.reports.get(reportId),
      source = report && this.store.get(report.sessionId);
    if (!caller || !source || !report || !sameSessionScope(caller, source))
      throw Error('无权读取此报告');
    if (!this.canRead(caller, source)) throw Error('只能读取本任务、下级或已声明依赖的报告');
    return report;
  }
  private canRead(caller: Session, source: Session): boolean {
    if (!sameSessionScope(caller, source)) return false;
    const own = this.store.taskRecords().find((t) => t.sessionId === caller.id),
      other = this.store.taskRecords().find((t) => t.sessionId === source.id);
    const seen = new Set<string>();
    let ancestor = other;
    let child = false;
    while (ancestor && !seen.has(ancestor.id)) {
      if (reportScope(ancestor) !== reportScope(caller)) break;
      seen.add(ancestor.id);
      if (ancestor.id === own?.id) {
        child = true;
        break;
      }
      ancestor = ancestor.parentId ? this.store.taskRecord(ancestor.parentId) : undefined;
    }
    let cursor: Session | undefined = source;
    const sessionSeen = new Set<string>();
    while (cursor && !sessionSeen.has(cursor.id)) {
      if (!sameSessionScope(cursor, caller)) break;
      sessionSeen.add(cursor.id);
      if (cursor.id === caller.id) {
        child = true;
        break;
      }
      const p = sessionParentId(cursor);
      cursor = p ? this.store.get(p) : undefined;
    }
    return (
      caller.id === source.id ||
      child ||
      !!(own && other && own.rootId === other.rootId && own.dependencies.includes(other.id))
    );
  }
  experiences(session: Session, q = '') {
    return this.store.reports.experiences(reportScope(session), q);
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    await this.writer?.close?.();
    await this.running;
    await this.notificationRunning;
  }
}
