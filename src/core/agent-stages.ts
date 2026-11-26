import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AgentKind, AgentSettings, Incoming, Session } from './types.js';

export interface AgentStage {
  id: string;
  sessionId: string;
  ordinal: number;
  agent: AgentKind;
  nativeId?: string;
  settings?: AgentSettings;
  workspace: string;
  state: 'preparing' | 'active' | 'ended' | 'failed' | 'cancelled';
  reason: 'initial' | 'relay' | 'reset' | 'reopen';
  sourceStageId?: string;
  inputReportId?: string;
  createdAt: number;
  activatedAt?: number;
  endedAt?: number;
  endReason?: 'relay' | 'reset' | 'close';
  startEventId?: number;
  endEventId?: number;
  transition?: {
    key: string;
    fingerprint: string;
    phase:
      | 'report_pending'
      | 'awaiting_confirmation'
      | 'activating'
      | 'awaiting_input'
      | 'submitting'
      | 'submitted'
      | 'failed'
      | 'unconfirmed'
      | 'cancelled';
    continueTask: boolean;
    instructions: string;
    error?: string;
    inputEventId?: number;
    inputRunId?: string;
    queueResumeConfirmed?: boolean;
    queue: { id: string; message: Incoming; state: 'pending' | 'processing' | 'unconfirmed' }[];
  };
}

// One row per execution context. This is not another task or a copy of native history.
export class AgentStageStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_stages(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      state TEXT NOT NULL, request_key TEXT UNIQUE, data TEXT NOT NULL,
      UNIQUE(session_id,ordinal));
      CREATE UNIQUE INDEX IF NOT EXISTS stage_active ON agent_stages(session_id) WHERE state='active';
      CREATE UNIQUE INDEX IF NOT EXISTS stage_preparing ON agent_stages(session_id) WHERE state='preparing';
      CREATE INDEX IF NOT EXISTS stage_queued ON agent_stages(session_id) WHERE json_array_length(data,'$.transition.queue')>0;`);
  }
  get(id: string): AgentStage | undefined {
    const row = this.db.prepare('SELECT data FROM agent_stages WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  list(sessionId: string): AgentStage[] {
    return this.db
      .prepare('SELECT data FROM agent_stages WHERE session_id=? ORDER BY ordinal')
      .all(sessionId)
      .map((r) => JSON.parse(String(r.data)));
  }
  queued(): AgentStage[] {
    return this.db
      .prepare(
        "SELECT data FROM agent_stages WHERE json_array_length(data,'$.transition.queue')>0 ORDER BY session_id,ordinal",
      )
      .all()
      .map((r) => JSON.parse(String(r.data)));
  }
  byKey(sessionId: string, key: string): AgentStage | undefined {
    const row = this.db
      .prepare('SELECT data FROM agent_stages WHERE request_key=?')
      .get(JSON.stringify([sessionId, key]));
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  save(stage: AgentStage): void {
    this.db
      .prepare(
        `INSERT INTO agent_stages VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data`,
      )
      .run(
        stage.id,
        stage.sessionId,
        stage.ordinal,
        stage.state,
        stage.transition ? JSON.stringify([stage.sessionId, stage.transition.key]) : null,
        JSON.stringify(stage),
      );
  }
  create(
    session: Session,
    reason: AgentStage['reason'],
    state: AgentStage['state'] = 'active',
  ): AgentStage {
    const stage: AgentStage = {
      id: randomUUID(),
      sessionId: session.id,
      ordinal: Number(
        this.db
          .prepare('SELECT coalesce(max(ordinal),0)+1 n FROM agent_stages WHERE session_id=?')
          .get(session.id)?.n,
      ),
      agent: session.agent,
      nativeId: session.nativeId,
      settings: session.settings ? structuredClone(session.settings) : undefined,
      workspace: session.workspace,
      state,
      reason,
      createdAt: Date.now(),
      ...(state === 'active' ? { activatedAt: Date.now() } : {}),
    };
    this.save(stage);
    return stage;
  }
  sync(session: Session, previous?: Session): void {
    let stage = session.currentStageId ? this.get(session.currentStageId) : undefined;
    if (stage && stage.sessionId !== session.id) throw Error('执行阶段不属于当前会话');
    const reset =
      stage && previous?.currentStageId === stage.id && previous.nativeId && !session.nativeId;
    const reopened = stage?.state === 'ended' && session.status !== 'closed';
    if (reset || reopened) {
      if (stage!.state === 'active') this.end(stage!.id, 'reset');
      stage = this.create(
        session,
        reset ? 'reset' : 'reopen',
        session.status === 'closed' ? 'ended' : 'active',
      );
      session.executionRevision = (session.executionRevision ?? 0) + 1;
    }
    if (!stage) {
      stage = this.create(session, 'initial', session.status === 'closed' ? 'ended' : 'active');
      session.executionRevision ??= 0;
    }
    if (stage.agent !== session.agent) throw Error('必须通过 Agent 接力变更执行后端');
    stage.nativeId = session.nativeId;
    stage.settings = session.settings ? structuredClone(session.settings) : undefined;
    stage.workspace = session.workspace;
    if (session.status === 'closed' && stage.state === 'active') {
      stage.state = 'ended';
      stage.endedAt = Date.now();
      stage.endReason = 'close';
    }
    session.currentStageId = stage.id;
    this.save(stage);
  }
  end(id: string, reason: NonNullable<AgentStage['endReason']>, endEventId?: number): void {
    const stage = this.get(id);
    if (!stage) return;
    stage.state = 'ended';
    stage.endReason = reason;
    stage.endedAt = Date.now();
    stage.endEventId = endEventId;
    this.save(stage);
  }
  recover(): void {
    for (const row of this.db
      .prepare("SELECT data FROM agent_stages WHERE state IN ('active','preparing')")
      .all()) {
      const stage: AgentStage = JSON.parse(String(row.data)),
        t = stage.transition;
      if (!t) continue;
      if (t.phase === 'activating') {
        stage.state = 'failed';
        t.phase = 'failed';
        t.error = '接力准备期间服务重启，原绑定保留；请重新检查后接力。';
      } else if (t.phase === 'submitting') {
        t.phase = 'unconfirmed';
        t.error = '服务重启，交接输入提交结果未确认；未自动重放。';
      }
      for (const q of t.queue) if (q.state === 'processing') q.state = 'unconfirmed';
      this.save(stage);
    }
  }
}
