import { ReportStore } from './report-store.js';
import type { TaskRecord, TaskJob } from './task-model.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type AgentKind,
  type Incoming,
  type Route,
  type Session,
  type SessionCardRecord,
  routeKey,
} from './types.js';
import { recentTools } from './tool-progress.js';
import { taskTitle } from './session-title.js';
import { sessionInstructions } from './session-instructions.js';
import type { TopicUpdate } from './topic-control.js';
import { sessionChildren } from './session-hierarchy.js';
import {
  unifiedTaskPlan,
  hasUnifiedTaskModel,
  TASK_MIGRATION_SCHEMA,
  TASK_SESSION_INDEX,
  UNIFIED_TASK_MIGRATION,
  writeUnifiedTask,
} from './task-migration.js';
import { readCompaction } from './maintenance-diagnostics.js';

export interface StoredEvent {
  id: number;
  sessionId: string;
  type: string;
  text: string;
  at: number;
}
export interface InboxMessage {
  id: string;
  state: 'pending' | 'processing' | 'done' | 'interrupted';
  message: Incoming;
  detail?: string;
}
export const INBOX_LIMITS = {
  rows: 1000,
  bytes: 32 * 1024 * 1024,
  messageBytes: 256 * 1024,
} as const;
export class InboxCapacityError extends Error {}
export class Store {
  private db: DatabaseSync;
  private receiptCleanup?: NodeJS.Timeout;
  readonly reports: ReportStore;
  private unifiedTasks = false;
  taskModelUnified(): boolean {
    return this.unifiedTasks;
  }
  enableEmptyTaskModel(): void {
    if (this.list().length || this.taskRecords().length)
      throw Error('已有数据请先执行 migrate-tasks');
    this.db.exec(TASK_MIGRATION_SCHEMA);
    this.db.exec(TASK_SESSION_INDEX);
    this.db
      .prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)')
      .run(UNIFIED_TASK_MIGRATION, Date.now(), JSON.stringify({ fresh: true }));
    this.unifiedTasks = true;
  }
  private savepointSequence = 0;
  private unit<T>(fn: () => T): T {
    const name = `unit_${++this.savepointSequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }
  private syncInteractiveTasks(id?: string, subtree = false): void {
    if (!this.unifiedTasks) return;
    let sessions: Session[];
    if (id) {
      const seed = subtree
        ? "SELECT ? UNION SELECT s.id FROM sessions s JOIN affected a ON coalesce(json_extract(s.data,'$.parentSessionId'),json_extract(s.data,'$.topicParentId'))=a.id"
        : 'SELECT ?';
      sessions = this.db
        .prepare(
          `WITH RECURSIVE affected(id) AS (${seed}),family(id) AS (SELECT id FROM affected UNION SELECT coalesce(json_extract(s.data,'$.parentSessionId'),json_extract(s.data,'$.topicParentId')) FROM sessions s JOIN family f ON s.id=f.id WHERE coalesce(json_extract(s.data,'$.parentSessionId'),json_extract(s.data,'$.topicParentId')) IS NOT NULL) SELECT data FROM sessions WHERE id IN (SELECT id FROM family)`,
        )
        .all(id)
        .map((r) => JSON.parse(String(r.data)) as Session);
    } else sessions = this.list();
    if (!sessions.length) return;
    const ids = sessions.map((s) => s.id),
      taskIds = sessions.flatMap((s) => (s.taskId ? [s.taskId] : [])),
      marks = ids.map(() => '?').join(',');
    const tasks = id
      ? this.db
          .prepare(
            `SELECT data FROM task_records WHERE json_extract(data,'$.sessionId') IN (${marks})${taskIds.length ? ` OR id IN (${taskIds.map(() => '?').join(',')})` : ''}`,
          )
          .all(...ids, ...taskIds)
          .map((r) => JSON.parse(String(r.data)) as TaskRecord)
      : this.taskRecords();
    const first = new Map(
      this.db
        .prepare(
          `SELECT session_id,text FROM events WHERE id IN (SELECT min(id) FROM events WHERE type='user' AND session_id IN (${marks}) GROUP BY session_id)`,
        )
        .all(...ids)
        .map((r) => [String(r.session_id), String(r.text)]),
    );
    for (const task of unifiedTaskPlan(sessions, tasks, (session) => first.get(session), false))
      writeUnifiedTask(this.db, task);
  }
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'state.sqlite'));
    chmodSync(join(directory, 'state.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS task_records (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, creation_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_jobs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, job_key TEXT UNIQUE NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS task_jobs_pending ON task_jobs(state,at);
      CREATE TABLE IF NOT EXISTS topic_updates (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, child_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(child_id,revision));
      CREATE INDEX IF NOT EXISTS topic_updates_parent ON topic_updates(parent_id,state,at);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, route_key TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_route ON sessions(route_key, updated_at);
      CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(coalesce(json_extract(data,'$.parentSessionId'),json_extract(data,'$.topicParentId')));
      CREATE TABLE IF NOT EXISTS bindings (route_key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS message_inbox (id TEXT PRIMARY KEY, receipt_key TEXT UNIQUE NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS message_inbox_state ON message_inbox(state,at);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_cards (session_id TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL, message_id TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(account,message_id));
      CREATE INDEX IF NOT EXISTS group_messages_scope ON group_messages(account,chat,thread,id);
      CREATE TABLE IF NOT EXISTS group_context_cursors (session_id TEXT PRIMARY KEY, last_id INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
      CREATE INDEX IF NOT EXISTS events_session_type ON events(session_id,type,id);
    `);
    this.reports = new ReportStore(this.db);
    this.unifiedTasks = hasUnifiedTaskModel(this.db);
    for (const session of this.list()) {
      // Recover an explicit native-policy choice from its audit event when the field is absent.
      if (session.agent === 'codex' && session.approvalPolicy === undefined) {
        const choice = this.db
          .prepare(
            "SELECT text FROM events WHERE session_id=? AND type='system' AND text LIKE '已修改本会话审批策略：%' ORDER BY id DESC LIMIT 1",
          )
          .get(session.id);
        if (String(choice?.text ?? '').startsWith('已修改本会话审批策略：native；')) {
          session.approvalPolicy = 'native';
          this.db
            .prepare('UPDATE sessions SET data=? WHERE id=?')
            .run(JSON.stringify(session), session.id);
        }
      }
      // Coordination is intrinsic; discard stored topicControl preferences without changing session identity.
      if ('topicControl' in session) {
        delete (session as Session & { topicControl?: boolean }).topicControl;
        this.db
          .prepare('UPDATE sessions SET data=? WHERE id=?')
          .run(JSON.stringify(session), session.id);
      }
      if (session.operation === 'compact') {
        delete session.operation;
        if (session.status === 'running') session.status = 'interrupted';
        this.save(session);
        const last = readCompaction(this.latestEvent(session.id, 'compaction')?.text);
        if (last?.phase === 'running') {
          session.contextUsageInvalidated = true;
          this.save(session);
        }
        if (last && ['accepted', 'running'].includes(last.phase))
          this.event(
            session.id,
            'compaction',
            JSON.stringify({
              ...last,
              phase: last.phase === 'accepted' ? 'failed' : 'unconfirmed',
              updatedAt: Date.now(),
              code: 'service_restarted',
              detail:
                last.phase === 'accepted'
                  ? '服务重启；原生压缩尚未调用，未自动重试。'
                  : '服务重启，原生压缩结果未确认；未自动重试。',
            }),
          );
        this.event(
          session.id,
          'system',
          '服务重启，原生压缩结果未确认；未自动重试，会话 ID 和历史保留。',
        );
      }
      if (!session.title) {
        const title = taskTitle(this.task(session.id, 'first') ?? '');
        if (title) {
          session.title = title;
          // Metadata backfill must not reorder histories, reopen sessions or change IDs.
          this.db
            .prepare('UPDATE sessions SET data=? WHERE id=?')
            .run(JSON.stringify(session), session.id);
        }
      }
      if (session.status === 'running' || session.status === 'waiting') {
        session.status = 'interrupted';
        this.save(session);
        this.event(session.id, 'system', '服务重启，上一轮已中断；未自动重跑。');
        for (const tool of recentTools(this, session.id))
          if (tool.status === 'running')
            this.event(session.id, 'tool', JSON.stringify({ ...tool, status: 'interrupted' }));
      }
    }
    // Untyped reports cannot establish completion or trigger automatic delivery.
    for (const job of this.topicUpdates().filter((j) => j.state === 'pending' && !j.reason)) {
      job.state = 'cancelled';
      this.saveTopicUpdate(job);
      this.event(
        job.childId,
        'system',
        '旧版本待回传报告未区分阶段进度与最终交付，已取消自动回传；原摘要保留，可明确要求重新汇报。',
      );
    }
    this.recoverTaskJobs();
    for (const job of this.topicUpdates().filter((j) => j.state === 'running')) {
      job.state = 'interrupted';
      this.saveTopicUpdate(job);
      this.event(
        job.parentId,
        'system',
        '服务重启，话题摘要投递轮次结果未确认；未自动重跑，可用 /tab topics 查看已提交成果。',
      );
    }
    this.db.prepare('DELETE FROM group_messages WHERE at < ?').run(Date.now() - 86400_000);
    this.syncInteractiveTasks();
    this.db
      .prepare("UPDATE message_inbox SET state='interrupted',detail=? WHERE state='processing'")
      .run('处理可能已开始，未自动重跑；请核对原文和会话历史。');
    this.db.prepare("DELETE FROM message_inbox WHERE state='done'").run();
    this.pruneReceipts();
    this.receiptCleanup = setInterval(() => {
      try {
        this.pruneReceipts();
      } catch {
        console.error('Receipt cleanup failed');
      }
    }, 60_000).unref();
  }
  atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  taskRecord(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT data FROM task_records WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.data)) as TaskRecord) : undefined;
  }
  taskRecords(): TaskRecord[] {
    return this.db
      .prepare('SELECT data FROM task_records ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(String(r.data)) as TaskRecord);
  }
  taskByKey(key: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT data FROM task_records WHERE creation_key=?').get(key);
    return row ? (JSON.parse(String(row.data)) as TaskRecord) : undefined;
  }
  saveTask(task: TaskRecord): void {
    task.updatedAt = Date.now();
    writeUnifiedTask(this.db, task);
  }
  taskJobs(): TaskJob[] {
    return this.db
      .prepare('SELECT data FROM task_jobs ORDER BY at,rowid')
      .all()
      .map((r) => JSON.parse(String(r.data)) as TaskJob);
  }
  enqueueTask(taskId: string, key: string, text: string): TaskJob {
    const existing = this.db.prepare('SELECT data FROM task_jobs WHERE job_key=?').get(key);
    if (existing) return JSON.parse(String(existing.data)) as TaskJob;
    const job: TaskJob = { id: randomUUID(), taskId, key, text, state: 'pending', at: Date.now() };
    this.db
      .prepare('INSERT INTO task_jobs VALUES (?,?,?,?,?,?)')
      .run(job.id, taskId, key, job.state, JSON.stringify(job), job.at);
    return job;
  }
  saveTaskJob(job: TaskJob): void {
    this.db
      .prepare('UPDATE task_jobs SET state=?,data=? WHERE id=?')
      .run(job.state, JSON.stringify(job), job.id);
  }
  private recoverTaskJobs(): void {
    for (const job of this.taskJobs())
      if (job.state === 'running') {
        job.state = 'interrupted';
        this.saveTaskJob(job);
        const task = this.taskRecord(job.taskId);
        if (task && !['completed', 'review', 'cancelled'].includes(task.state)) {
          task.state = 'blocked';
          task.error =
            '服务重启，上轮可能已执行部分操作；未自动重跑。请使用 /tab task-resume 明确继续。';
          this.saveTask(task);
        }
      }
    for (const task of this.taskRecords())
      if (task.state === 'provisioning') {
        task.state = 'blocked';
        task.error = '创建过程被中断，话题投递结果可能未知；未重复创建。';
        this.saveTask(task);
      }
  }
  claim(key: string): boolean {
    return (
      this.db.prepare('INSERT OR IGNORE INTO receipts VALUES (?, ?)').run(key, Date.now())
        .changes === 1
    );
  }
  acceptIncoming(message: Incoming): string | undefined {
    return this.unit(() => {
      const key = JSON.stringify([message.route.platform, message.route.account, message.id]);
      if (!this.claim(key)) return;
      const id = randomUUID();
      // Persist normalized text and route only, never signed callbacks or raw events.
      const source: Incoming = {
        id: message.id,
        text: message.text,
        route: { ...message.route },
        direct: message.direct,
        receivedAt: message.receivedAt ?? Date.now(),
      };
      const data = JSON.stringify(source);
      const size = Buffer.byteLength(data);
      if (size > INBOX_LIMITS.messageBytes)
        throw new InboxCapacityError(
          '消息超过收件箱单条 256 KiB 限制，本条未接收或执行；请缩短后重发。',
        );
      const usage = this.db
        .prepare(
          'SELECT count(*) AS rows,coalesce(sum(length(CAST(data AS BLOB)) + 1024),0) AS bytes FROM message_inbox',
        )
        .get()!;
      // Reserve space for an interruption diagnostic. The enclosing transaction
      // rolls the receipt back on rejection, allowing an explicit later retry.
      if (
        Number(usage.rows) >= INBOX_LIMITS.rows ||
        Number(usage.bytes) + size + 1024 > INBOX_LIMITS.bytes
      )
        throw new InboxCapacityError(
          '收件箱已达 1000 条或 32 MiB 上限，本条未接收或执行。请用 /tab inbox 核对中断记录，确认后用 /tab inbox dismiss <短ID> 清理，再重新发送。',
        );
      this.db
        .prepare('INSERT INTO message_inbox VALUES (?,?,?,?,?,?)')
        .run(id, key, 'pending', data, null, Date.now());
      return id;
    });
  }
  inbox(): InboxMessage[] {
    return this.db
      .prepare(
        "SELECT id,state,data,detail FROM message_inbox WHERE state != 'done' ORDER BY at,rowid",
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        state: String(row.state) as InboxMessage['state'],
        message: JSON.parse(String(row.data)) as Incoming,
        ...(row.detail ? { detail: String(row.detail) } : {}),
      }));
  }
  startIncoming(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE message_inbox SET state='processing' WHERE id=? AND state='pending'")
        .run(id).changes === 1
    );
  }
  finishIncoming(id: string, interrupted = false, detail?: string): void {
    if (!interrupted) {
      this.releaseIncoming(id);
      return;
    }
    this.db
      .prepare("UPDATE message_inbox SET state='interrupted',detail=? WHERE id=?")
      .run(detail?.slice(0, 256) ?? null, id);
  }
  dismissIncoming(id: string): boolean {
    return this.releaseIncoming(id, true);
  }
  private releaseIncoming(id: string, interruptedOnly = false): boolean {
    return this.unit(() => {
      const condition = interruptedOnly ? "id=? AND state='interrupted'" : 'id=?';
      this.db
        .prepare(
          `UPDATE receipts SET at=? WHERE key IN (SELECT receipt_key FROM message_inbox WHERE ${condition})`,
        )
        .run(Date.now(), id);
      return this.db.prepare(`DELETE FROM message_inbox WHERE ${condition}`).run(id).changes === 1;
    });
  }
  private pruneReceipts(): void {
    this.db
      .prepare(
        'DELETE FROM receipts WHERE at < ? AND key NOT IN (SELECT receipt_key FROM message_inbox)',
      )
      .run(Date.now() - 7 * 86400_000);
  }
  get(id: string): Session | undefined {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.data)) as Session) : undefined;
  }
  current(route: Route): Session | undefined {
    const row = this.db
      .prepare('SELECT session_id FROM bindings WHERE route_key=?')
      .get(routeKey(route));
    return row ? this.get(String(row.session_id)) : undefined;
  }
  topicUpdates(): TopicUpdate[] {
    return this.db
      .prepare('SELECT data FROM topic_updates ORDER BY at,rowid')
      .all()
      .map((r) => JSON.parse(String(r.data)) as TopicUpdate);
  }
  saveTopicUpdate(job: TopicUpdate): void {
    this.db
      .prepare(
        'INSERT INTO topic_updates VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,state=excluded.state,data=excluded.data',
      )
      .run(job.id, job.parentId, job.childId, job.revision, job.state, JSON.stringify(job), job.at);
  }
  create(
    route: Route,
    agent: AgentKind,
    workspace: string,
    instructions?: string,
    channelContext?: Session['channelContext'],
    taskId?: string,
  ): Session {
    const additions = sessionInstructions(instructions);
    const session: Session = {
      id: randomUUID(),
      routeKey: routeKey(route),
      route,
      agent,
      workspace,
      ...(taskId ? { taskId } : {}),
      ...(additions ? { instructions: additions } : {}),
      ...(channelContext ? { channelContext } : {}),
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.save(session);
    this.bind(session);
    return session;
  }
  bind(session: Session): void {
    this.db
      .prepare('INSERT OR REPLACE INTO bindings VALUES (?, ?)')
      .run(session.routeKey, session.id);
  }
  attachTaskTopic(id: string, expectedRouteKey: string, destination: Incoming): Session {
    return this.atomic(() => {
      const session = this.get(id);
      if (
        !session?.taskId ||
        session.routeKey !== expectedRouteKey ||
        this.current(session.route)?.id !== id
      )
        throw Error('任务入口绑定已变化');
      const target = destination.route;
      if (
        target.platform !== 'lark' ||
        !target.thread.startsWith('om_') ||
        ['platform', 'account', 'conversation', 'sender'].some(
          (k) => (target as any)[k] !== (session.route as any)[k],
        )
      )
        throw Error('仅可补建原 BOT、原聊天和原用户的任务话题');
      const occupied = this.current(target);
      if (occupied && occupied.id !== id) throw Error('目标话题已绑定其他会话');
      this.db
        .prepare('DELETE FROM bindings WHERE route_key=? AND session_id=?')
        .run(session.routeKey, id);
      session.route = { ...target };
      session.routeKey = routeKey(target);
      session.ownedTopicRoot = destination.ownedTopicRoot;
      delete session.imEntry;
      this.save(session);
      this.bind(session);
      const task = this.taskRecord(session.taskId);
      if (!task) throw Error('任务不存在');
      task.route = { ...target };
      this.saveTask(task);
      return session;
    });
  }
  resetSession(previous: Session): Session {
    return this.atomic(() => {
      if (this.current(previous.route)?.id !== previous.id)
        throw new Error('会话绑定已变化，未重置。');
      const fresh = this.create(
        previous.route,
        previous.agent,
        previous.workspace,
        previous.instructions,
        previous.channelContext,
      );
      if (previous.topicReportsPaused) fresh.topicReportsPaused = true;
      if (previous.parentSessionId) fresh.parentSessionId = previous.parentSessionId;
      if (previous.topicParentId) fresh.topicParentId = previous.topicParentId;
      if (previous.topicObjective) fresh.topicObjective = previous.topicObjective;
      if (previous.topicCriteria) fresh.topicCriteria = previous.topicCriteria;
      for (const child of sessionChildren(this.list(), previous)) {
        child.parentSessionId = fresh.id;
        if (child.topicParentId) child.topicParentId = fresh.id;
        this.save(child);
      }
      for (const job of this.topicUpdates().filter(
        (j) =>
          (j.parentId === previous.id || j.childId === previous.id) &&
          ['pending', 'running'].includes(j.state),
      )) {
        job.state = 'cancelled';
        this.saveTopicUpdate(job);
      }
      if (previous.settings) fresh.settings = structuredClone(previous.settings);
      if (previous.codexDeveloperInstructions !== undefined)
        fresh.codexDeveloperInstructions = previous.codexDeveloperInstructions;
      if (previous.ownedTopicRoot) fresh.ownedTopicRoot = previous.ownedTopicRoot;
      this.save(fresh);
      this.save({ ...previous, status: 'closed' });
      this.event(
        previous.id,
        'system',
        `会话已重置，新会话：${fresh.id}；旧历史和原生会话 ID 保留。`,
      );
      this.event(
        fresh.id,
        'system',
        `由 ${previous.id} 重置创建；未继承旧 Agent 对话、待执行任务或附件。`,
      );
      // The new native context must not replay previously collected group messages.
      const r = fresh.route,
        through = this.db
          .prepare(
            'SELECT MAX(id) AS id FROM group_messages WHERE account=? AND chat=? AND thread=?',
          )
          .get(r.account, r.conversation, r.thread);
      this.markGroupContext(fresh.id, Number(through?.id ?? 0));
      return fresh;
    });
  }
  replaceMainWorkspace(previous: Session, workspace: string): Session {
    if (previous.route.thread) throw Error('主会话绑定已变化');
    return this.replaceSessionWorkspace(previous, workspace);
  }
  replaceSessionWorkspace(previous: Session, workspace: string): Session {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.current(previous.route)?.id !== previous.id) throw new Error('会话绑定已变化');
      const updated = { ...previous, workspace };
      this.save(updated);
      if (previous.taskId) {
        const task = this.taskRecord(previous.taskId);
        if (!task) throw Error('任务记录不存在');
        task.workspace = workspace;
        this.saveTask(task);
      }
      this.event(
        previous.id,
        'system',
        `工作目录已从 ${previous.workspace} 切换至 ${workspace}；保留当前会话、原生上下文和设置，下一轮使用新目录。`,
      );
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  save(session: Session): void {
    const before = this.get(session.id),
      stamp = session.updatedAt;
    try {
      this.unit(() => {
        session.updatedAt = Date.now();
        this.db
          .prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?)')
          .run(session.id, session.routeKey, JSON.stringify(session), session.updatedAt);
        this.syncInteractiveTasks(
          session.id,
          before?.parentSessionId !== session.parentSessionId ||
            before?.topicParentId !== session.topicParentId ||
            before?.taskId !== session.taskId,
        );
      });
    } catch (error) {
      session.updatedAt = stamp;
      throw error;
    }
  }
  list(): Session[] {
    return this.db
      .prepare('SELECT data FROM sessions ORDER BY updated_at DESC')
      .all()
      .map((row) => JSON.parse(String(row.data)) as Session);
  }
  event(sessionId: string, type: string, text: string): StoredEvent {
    return this.unit(() => {
      const at = Date.now(),
        result = this.db
          .prepare('INSERT INTO events(session_id,type,text,at) VALUES (?,?,?,?)')
          .run(sessionId, type, text, at);
      if (type === 'user') this.syncInteractiveTasks(sessionId);
      return { id: Number(result.lastInsertRowid), sessionId, type, text, at };
    });
  }
  reportEvidence(id: string, end: number) {
    const total = Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE session_id=? AND id<=? AND type IN ('user','response','tool','system','context_reset')",
        )
        .get(id, end)?.n ?? 0,
    );
    const rows = this.db
      .prepare(
        "SELECT id,type,text,at FROM (SELECT id,type,text,at FROM events WHERE session_id=? AND id<=? AND type IN ('user','response','tool','system','context_reset') ORDER BY id DESC LIMIT 200) ORDER BY id",
      )
      .all(id, end) as unknown as { id: number; type: string; text: string; at: number }[];
    for (const r of rows)
      if (r.type === 'tool') {
        try {
          const t = JSON.parse(r.text);
          r.text = JSON.stringify({ name: t.name, status: t.status, exitCode: t.exitCode });
        } catch {
          r.text = '{}';
        }
      }
    let budget = 48000,
      clipped = total > rows.length;
    const bounded = rows
      .reverse()
      .flatMap((r) => {
        if (budget <= 0) {
          clipped = true;
          return [];
        }
        const raw = String(r.text),
          text = raw.slice(0, Math.min(3000, budget));
        budget -= text.length;
        if (raw.length > text.length) clipped = true;
        return [{ ...r, text }];
      })
      .reverse();
    return {
      total,
      truncated: clipped,
      events: bounded.map((r) => {
        if (r.type === 'tool') {
          try {
            const t = JSON.parse(String(r.text));
            return {
              id: r.id,
              type: r.type,
              text: JSON.stringify({ name: t.name, status: t.status, exitCode: t.exitCode }),
              at: r.at,
            };
          } catch {
            return { id: r.id, type: r.type, text: '工具记录无法解析', at: r.at };
          }
        }
        return { ...r, text: String(r.text).slice(0, 3000) };
      }),
    };
  }
  lastEventId(id: string): number {
    return Number(
      this.db.prepare('SELECT max(id) AS n FROM events WHERE session_id=?').get(id)?.n ?? 0,
    );
  }
  reportCutoff(id: string, after: number): number {
    const opened = this.db
      .prepare(
        "SELECT min(id) AS n FROM events WHERE session_id=? AND id>? AND type='session_reopened'",
      )
      .get(id, after)?.n;
    return opened ? Number(opened) - 1 : this.lastEventId(id);
  }
  task(sessionId: string, position: 'first' | 'last' = 'last'): string | undefined {
    const row = this.db
      .prepare(
        `SELECT text FROM events WHERE session_id=? AND type='user' ORDER BY id ${position === 'first' ? 'ASC' : 'DESC'} LIMIT 1`,
      )
      .get(sessionId);
    return row ? String(row.text) : undefined;
  }
  events(sessionId: string, limit = 200): StoredEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM (SELECT id, session_id as sessionId, type, text, at FROM events WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id',
      )
      .all(sessionId, limit) as unknown as StoredEvent[];
  }
  latestEvent(sessionId: string, type: string): StoredEvent | undefined {
    return this.db
      .prepare(
        'SELECT id,session_id AS sessionId,type,text,at FROM events WHERE session_id=? AND type=? ORDER BY id DESC LIMIT 1',
      )
      .get(sessionId, type) as unknown as StoredEvent | undefined;
  }
  planEvents(sessionId: string, limit: number, before?: number): StoredEvent[] {
    return this.db
      .prepare(
        "WITH latest AS (SELECT id,session_id AS sessionId,type,text,at,row_number() OVER (PARTITION BY json_extract(text,'$.runId') ORDER BY id DESC) AS rank FROM events WHERE session_id=? AND type='agent_plan' AND json_valid(text) AND json_extract(text,'$.runId') IS NOT NULL) SELECT id,sessionId,type,text,at FROM latest WHERE rank=1 AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, before ?? null, before ?? null, limit) as unknown as StoredEvent[];
  }
  planRunEvent(sessionId: string, runId: string): StoredEvent | undefined {
    return this.db
      .prepare(
        "SELECT id,session_id AS sessionId,type,text,at FROM events WHERE session_id=? AND type='agent_run' AND json_valid(text) AND json_extract(text,'$.runId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId, runId) as unknown as StoredEvent | undefined;
  }
  recordEvents(
    sessionId: string,
    query: import('./execution-records.js').RecordQuery,
  ): StoredEvent[] {
    const filter = "(? IS NULL OR id<?) AND (?='' OR instr(lower(text),lower(?))>0)";
    const sql =
      query.kind === 'tools'
        ? `WITH latest AS (SELECT id,session_id AS sessionId,type,text,at,row_number() OVER (PARTITION BY json_extract(text,'$.runId'),json_extract(text,'$.id') ORDER BY id DESC) AS rank FROM events WHERE session_id=? AND type='tool' AND json_valid(text) AND json_extract(text,'$.runId') IS NOT NULL AND json_extract(text,'$.id') IS NOT NULL) SELECT id,sessionId,type,text,at FROM latest WHERE rank=1 AND ${filter} ORDER BY id DESC LIMIT ?`
        : `SELECT id,session_id AS sessionId,type,text,at FROM events WHERE session_id=? AND type='interaction' AND json_valid(text) AND json_extract(text,'$.kind')='approval' AND ${filter} ORDER BY id DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(
        sessionId,
        query.before ?? null,
        query.before ?? null,
        query.q,
        query.q,
        query.limit + 1,
      ) as unknown as StoredEvent[];
  }
  interactionEvent(sessionId: string, id: string): StoredEvent | undefined {
    return this.db
      .prepare(
        "SELECT id,session_id AS sessionId,type,text,at FROM events WHERE session_id=? AND type='interaction' AND json_valid(text) AND json_extract(text,'$.id')=? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId, id) as unknown as StoredEvent | undefined;
  }
  interactionHistory(sessionId: string, id: string): StoredEvent[] {
    return this.db
      .prepare(
        "SELECT id,session_id AS sessionId,type,text,at FROM events WHERE session_id=? AND type IN ('decision','interaction_timeout','interaction_closed') AND json_valid(text) AND json_extract(text,'$.id')=? ORDER BY id",
      )
      .all(sessionId, id) as unknown as StoredEvent[];
  }
  recordGroupMessage(message: Incoming): void {
    const r = message.route;
    const text = [
      message.text,
      ...(message.attachments ?? []).map((a) => `[附件：${a.name}，未下载]`),
    ]
      .filter(Boolean)
      .join('\n');
    const clipped = text.length > 1000 ? text.slice(0, 1000) + '…[截断]' : text;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO group_messages(account,chat,thread,message_id,sender,text,at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(r.account, r.conversation, r.thread, message.id, r.sender, clipped, Date.now());
    this.db.prepare('DELETE FROM group_messages WHERE at < ?').run(Date.now() - 86400_000);
    this.db
      .prepare(
        'DELETE FROM group_messages WHERE account=? AND chat=? AND id NOT IN (SELECT id FROM group_messages WHERE account=? AND chat=? ORDER BY id DESC LIMIT 100)',
      )
      .run(r.account, r.conversation, r.account, r.conversation);
  }
  groupContext(
    session: Session,
    message: Incoming,
  ): { through: number; records: { sender: string; text: string; at: number }[] } {
    const r = message.route;
    const current = this.db
      .prepare(
        'SELECT id FROM group_messages WHERE account=? AND chat=? AND thread=? AND message_id=?',
      )
      .get(r.account, r.conversation, r.thread, message.id);
    if (!current) return { through: 0, records: [] };
    const through = Number(current.id);
    const last = this.db
      .prepare('SELECT last_id FROM group_context_cursors WHERE session_id=?')
      .get(session.id);
    const records = this.db
      .prepare(
        'SELECT sender,text,at FROM (SELECT id,sender,text,at FROM group_messages WHERE account=? AND chat=? AND thread=? AND id>? AND id<? AND at>? ORDER BY id DESC LIMIT 20) ORDER BY id',
      )
      .all(
        r.account,
        r.conversation,
        r.thread,
        Number(last?.last_id ?? 0),
        through,
        Date.now() - 86400_000,
      ) as unknown as { sender: string; text: string; at: number }[];
    return { through, records };
  }
  markGroupContext(id: string, through: number): void {
    if (through)
      this.db
        .prepare(
          'INSERT INTO group_context_cursors VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)',
        )
        .run(id, through);
  }
  clearGroupContext(account: string, chat: string): void {
    this.db.prepare('DELETE FROM group_messages WHERE account=? AND chat=?').run(account, chat);
  }
  close(): void {
    clearInterval(this.receiptCleanup);
    this.db.close();
  }
  card(sessionId: string): SessionCardRecord | undefined {
    const row = this.db.prepare('SELECT data FROM session_cards WHERE session_id=?').get(sessionId);
    return row ? (JSON.parse(String(row.data)) as SessionCardRecord) : undefined;
  }
  cardById(id: string): SessionCardRecord | undefined {
    const row = this.db.prepare('SELECT data FROM session_cards WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.data)) as SessionCardRecord) : undefined;
  }
  saveCard(card: SessionCardRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO session_cards VALUES (?, ?, ?)')
      .run(card.sessionId, card.id, JSON.stringify(card));
  }
}
