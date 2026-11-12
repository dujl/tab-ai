import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Session } from './types.js';
import type { TaskRecord } from './task-model.js';
import type { SessionReport } from './report-model.js';
export const reportScope = (session: Pick<Session, 'route'>) =>
  JSON.stringify([
    session.route.platform,
    session.route.account,
    session.route.conversation,
    session.route.sender,
  ]);
export class ReportStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS session_reports(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,task_id TEXT,task_revision INTEGER,version INTEGER NOT NULL,source_key TEXT UNIQUE NOT NULL,trigger TEXT NOT NULL,state TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(session_id,version));CREATE INDEX IF NOT EXISTS reports_pending ON session_reports(state,updated_at);CREATE INDEX IF NOT EXISTS reports_task ON session_reports(task_id,task_revision,trigger);CREATE INDEX IF NOT EXISTS reports_scope ON session_reports(scope,state,updated_at);`,
    );
  }
  request(
    session: Session,
    task: TaskRecord | undefined,
    trigger: SessionReport['trigger'],
    sourceKey: string,
    eventId: number,
    capturePending = false,
  ): SessionReport {
    const old = this.db
      .prepare('SELECT data FROM session_reports WHERE source_key=?')
      .get(sourceKey);
    if (old) return JSON.parse(String(old.data));
    const now = Date.now(),
      version =
        Number(
          this.db
            .prepare('SELECT max(version) AS n FROM session_reports WHERE session_id=?')
            .get(session.id)?.n ?? 0,
        ) + 1;
    const report: SessionReport = {
      id: randomUUID(),
      sessionId: session.id,
      taskId: task?.id,
      taskRevision: task?.revision,
      version,
      sourceKey,
      trigger,
      sourceEventId: eventId,
      endEventId: eventId,
      ...(capturePending ? { capturePending: true } : {}),
      state: 'pending',
      quality: 'pending',
      outcome:
        task?.state === 'completed'
          ? 'completed'
          : task?.state === 'review'
            ? 'submitted'
            : task?.state === 'cancelled'
              ? 'cancelled'
              : 'incomplete',
      ...(task?.result ? { taskResult: structuredClone(task.result) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare('INSERT INTO session_reports VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        report.id,
        session.id,
        task?.id ?? null,
        task?.revision ?? null,
        version,
        sourceKey,
        trigger,
        report.state,
        reportScope(session),
        JSON.stringify(report),
        now,
      );
    return report;
  }
  get(id: string): SessionReport | undefined {
    const row = this.db.prepare('SELECT data FROM session_reports WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  save(report: SessionReport): void {
    report.updatedAt = Date.now();
    this.db
      .prepare('UPDATE session_reports SET state=?,data=?,updated_at=? WHERE id=?')
      .run(report.state, JSON.stringify(report), report.updatedAt, report.id);
  }
  list(id: string, limit = 20, before = Number.MAX_SAFE_INTEGER): SessionReport[] {
    return this.db
      .prepare(
        'SELECT data FROM session_reports WHERE session_id=? AND version<? ORDER BY version DESC LIMIT ?',
      )
      .all(id, before, Math.min(50, Math.max(1, limit)))
      .map((r) => JSON.parse(String(r.data)));
  }
  pending(): SessionReport[] {
    return this.db
      .prepare(
        "SELECT data FROM session_reports r WHERE state='pending' AND version=(SELECT min(version) FROM session_reports x WHERE x.session_id=r.session_id AND x.state='pending') ORDER BY updated_at LIMIT 64",
      )
      .all()
      .map((r) => JSON.parse(String(r.data)));
  }
  task(id: string, revision: number): SessionReport | undefined {
    const r = this.db
      .prepare(
        "SELECT data FROM session_reports WHERE task_id=? AND task_revision=? AND trigger='task' ORDER BY version DESC LIMIT 1",
      )
      .get(id, revision);
    return r ? JSON.parse(String(r.data)) : undefined;
  }
  recover(): void {
    for (const row of this.db
      .prepare("SELECT data FROM session_reports WHERE state='running'")
      .all()) {
      const r = JSON.parse(String(row.data)) as SessionReport;
      r.state = 'pending';
      this.save(r);
    }
  }
  statuses() {
    return this.db
      .prepare(
        'SELECT session_id AS sessionId,max(updated_at) AS revision FROM session_reports GROUP BY session_id',
      )
      .all();
  }
  experiences(scope: string | undefined, q = '', limit = 20) {
    const rows = this.db
      .prepare(
        `SELECT data FROM session_reports WHERE state='ready' ${scope ? 'AND scope=?' : ''} ${q ? 'AND instr(lower(data),lower(?))>0' : ''} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...(scope ? [scope] : []), ...(q ? [q.slice(0, 200)] : []), Math.min(50, limit));
    return rows
      .flatMap((row) => {
        const r = JSON.parse(String(row.data)) as SessionReport;
        return (r.body?.lessons ?? [])
          .filter(
            (lesson) =>
              !q || JSON.stringify(lesson).toLowerCase().includes(q.slice(0, 200).toLowerCase()),
          )
          .map((lesson) => ({
            reportId: r.id,
            sessionId: r.sessionId,
            version: r.version,
            lesson,
          }));
      })
      .slice(0, limit);
  }
}
