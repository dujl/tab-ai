import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { lockDirectory } from '../instance-lock.js';
import { randomUUID } from 'node:crypto';
import type { Session } from './types.js';
import type { TaskRecord } from './task-model.js';
import { sessionParentId, sameSessionScope } from './session-hierarchy.js';

export const UNIFIED_TASK_MIGRATION = 'unified-tasks-v1';
export function interactiveTask(
  session: Session,
  firstTask: string | undefined,
  parent: TaskRecord | undefined,
): TaskRecord {
  const report = session.topicReport,
    final = report?.result;
  const completed = !!(
    session.topicCompleted &&
    final?.kind === 'final' &&
    final.completionEvidence?.trim() &&
    final.remainingWork?.length === 0
  );
  const task: TaskRecord = {
    id: session.id,
    sessionId: session.id,
    rootId: parent?.rootId ?? session.id,
    ...(parent ? { parentId: parent.id } : {}),
    key: `adopt-session:${session.id}`,
    originSession: true,
    executionMode: 'interactive',
    title: /^【(?:tab-ai|GenesisBot) (?:话题交付摘要|话题阶段汇报)/.test(session.title ?? '')
      ? '群主任务'
      : (session.title ?? `${session.agent} 任务`),
    objective: session.topicObjective ?? firstTask ?? '',
    criteria: session.topicCriteria ?? '按用户目标完成并提供可核验成果',
    context: '',
    agent: session.agent,
    workspace: session.workspace,
    route: { ...session.route },
    dependencies: [],
    state: session.topicReportsPaused ? 'paused' : completed ? 'completed' : 'waiting',
    revision: completed ? report!.revision : 0,
    autoTurns: 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  const progress = session.topicProgress ?? report;
  if (progress) task.progress = { summary: progress.result.summary, at: progress.at };
  if (completed)
    task.result = {
      summary: final!.summary,
      artifacts: final!.artifacts,
      checks: [final!.completionEvidence!],
      issues: final!.issues,
    };
  return task;
}
// Build the complete plan before any write. Native sessions and existing orchestrated
// tasks are never rewritten. Interactive records do not enroll a session in scheduling.
export function unifiedTaskPlan(
  sessions: Session[],
  tasks: TaskRecord[],
  firstTask: (id: string) => string | undefined,
  strict = true,
): TaskRecord[] {
  const bySession = new Map<string, TaskRecord>(),
    byId = new Map(tasks.map((t) => [t.id, t])),
    ss = new Map(sessions.map((s) => [s.id, s]));
  for (const task of tasks)
    if (task.sessionId) {
      if (bySession.has(task.sessionId)) throw Error('同一 Session 关联多个任务，迁移未执行');
      if (strict && !ss.has(task.sessionId)) throw Error('任务关联的 Session 不存在，迁移未执行');
      bySession.set(task.sessionId, task);
    }
  const result = new Map<string, TaskRecord>(),
    visiting = new Set<string>();
  const visit = (session: Session): TaskRecord => {
    if (result.has(session.id)) return result.get(session.id)!;
    if (visiting.has(session.id)) throw Error('会话层级存在循环，迁移未执行');
    visiting.add(session.id);
    const existing = bySession.get(session.id);
    if (session.taskId) {
      const task = byId.get(session.taskId);
      if (!task || (strict && task.sessionId !== session.id))
        throw Error('Session 的任务关联无效，迁移未执行');
      if (existing && existing.id !== task.id) throw Error('任务关联冲突，迁移未执行');
      result.set(session.id, task);
      visiting.delete(session.id);
      return task;
    }
    if (existing && existing.executionMode !== 'interactive')
      throw Error('任务缺少对应的 Session 反向关联，迁移未执行');
    if (byId.has(session.id) && byId.get(session.id) !== existing)
      throw Error('任务 ID 与历史 Session ID 冲突，迁移未执行');
    const parentId = sessionParentId(session),
      parent = parentId ? ss.get(parentId) : undefined;
    if (parentId && (!parent || !sameSessionScope(session, parent)))
      throw Error('父会话不存在或范围不匹配，迁移未执行');
    const task = interactiveTask(
      session,
      firstTask(session.id),
      parent ? visit(parent) : undefined,
    );
    if (existing?.state === 'cancelled') task.state = 'cancelled';
    result.set(session.id, task);
    visiting.delete(session.id);
    return task;
  };
  for (const session of sessions) visit(session);
  // Validate the acceptance hierarchy independently of navigation sourceSessionId.
  const all = new Map([...tasks, ...result.values()].map((t) => [t.id, t]));
  if (strict)
    for (const task of all.values()) {
      const seen = new Set<string>();
      let current: TaskRecord | undefined = task;
      while (current) {
        if (seen.has(current.id)) throw Error('任务层级存在循环，迁移未执行');
        seen.add(current.id);
        if (!current.parentId) {
          if (task.rootId !== current.id) throw Error('任务根节点不一致，迁移未执行');
          break;
        }
        const parent = all.get(current.parentId);
        if (
          !parent ||
          !sameSessionScope(current as unknown as Session, parent as unknown as Session)
        )
          throw Error('任务父级无效，迁移未执行');
        current = parent;
      }
    }
  return [...result.values()].filter(
    (t) =>
      t.executionMode === 'interactive' &&
      JSON.stringify(t) !== JSON.stringify(bySession.get(t.sessionId!)),
  );
}
export const TASK_MIGRATION_SCHEMA = `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, data TEXT NOT NULL)`;
export const TASK_SESSION_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS task_records_session ON task_records(json_extract(data,'$.sessionId')) WHERE json_extract(data,'$.sessionId') IS NOT NULL`;
export function writeUnifiedTask(db: DatabaseSync, task: TaskRecord): void {
  db.prepare(
    'INSERT INTO task_records VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root_id=excluded.root_id,parent_id=excluded.parent_id,creation_key=excluded.creation_key,data=excluded.data',
  ).run(task.id, task.rootId, task.parentId ?? null, task.key, JSON.stringify(task));
}
export function hasUnifiedTaskModel(db: DatabaseSync): boolean {
  return (
    !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get() &&
    !!db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(UNIFIED_TASK_MIGRATION)
  );
}
export async function migrateTaskDatabase(file: string, apply = false) {
  if (!existsSync(file)) throw Error('数据库不存在，请先初始化服务');
  const unlock = apply ? lockDirectory(dirname(file)) : undefined;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: !apply });
  } catch (error) {
    unlock?.();
    throw error;
  }
  let backupFile: string | undefined;
  try {
    const sessions = db
        .prepare('SELECT data FROM sessions ORDER BY id')
        .all()
        .map((r) => JSON.parse(String(r.data)) as Session),
      tasks = db
        .prepare('SELECT data FROM task_records ORDER BY id')
        .all()
        .map((r) => JSON.parse(String(r.data)) as TaskRecord);
    const plan = unifiedTaskPlan(sessions, tasks, (id) => {
      const row = db
        .prepare("SELECT text FROM events WHERE session_id=? AND type='user' ORDER BY id LIMIT 1")
        .get(id);
      return row ? String(row.text) : undefined;
    });
    const result = {
      migration: UNIFIED_TASK_MIGRATION,
      sessions: sessions.length,
      tasksBefore: tasks.length,
      create: plan.filter((t) => !tasks.some((old) => old.id === t.id)).length,
      update: plan.filter((t) => tasks.some((old) => old.id === t.id)).length,
      alreadyApplied: hasUnifiedTaskModel(db),
      applied: apply,
      backupFile,
    };
    if (!apply) return result;
    if (result.alreadyApplied && !plan.length) return { ...result, tasksAfter: tasks.length };
    backupFile = `${file}.before-unified-tasks-${randomUUID()}.bak`;
    await backup(db, backupFile);
    chmodSync(backupFile, 0o600);
    db.exec('BEGIN IMMEDIATE');
    try {
      const latestSessions = db
          .prepare('SELECT data FROM sessions ORDER BY id')
          .all()
          .map((r) => JSON.parse(String(r.data))),
        latestTasks = db
          .prepare('SELECT data FROM task_records ORDER BY id')
          .all()
          .map((r) => JSON.parse(String(r.data)));
      if (
        JSON.stringify(latestSessions) !== JSON.stringify(sessions) ||
        JSON.stringify(latestTasks) !== JSON.stringify(tasks)
      )
        throw Error('备份期间数据发生变化，未执行迁移，请重新预览');
      for (const task of plan) writeUnifiedTask(db, task);
      db.exec(TASK_MIGRATION_SCHEMA);
      db.exec(TASK_SESSION_INDEX);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run(
        UNIFIED_TASK_MIGRATION,
        Date.now(),
        JSON.stringify({
          created: result.create,
          updated: result.update,
          sessions: result.sessions,
          backupFile,
        }),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ...result, backupFile, tasksAfter: tasks.length + result.create };
  } finally {
    try {
      db.close();
    } finally {
      unlock?.();
    }
  }
}
