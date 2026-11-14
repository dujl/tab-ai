import type { Session } from './types.js';

export const MAX_SESSION_DEPTH = 8;
export const MAX_SESSION_DESCENDANTS = 100;
// Resolve explicit parents before group-topic links without changing stored sessions.
export const sessionParentId = (s: Session): string | undefined =>
  s.parentSessionId ?? s.topicParentId;
export const sameSessionScope = (a: Session, b: Session): boolean =>
  a.route.platform === b.route.platform &&
  a.route.account === b.route.account &&
  a.route.conversation === b.route.conversation &&
  a.route.sender === b.route.sender;
export function sessionChildren(sessions: Session[], parent: Session): Session[] {
  return sessions.filter(
    (s) => !s.taskId && sessionParentId(s) === parent.id && sameSessionScope(s, parent),
  );
}
export function sessionDescendants(
  sessions: Session[],
  parent: Session,
): { session: Session; depth: number }[] {
  const result: { session: Session; depth: number }[] = [],
    seen = new Set([parent.id]);
  const visit = (p: Session, depth: number) => {
    for (const session of sessionChildren(sessions, p)) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      result.push({ session, depth });
      visit(session, depth + 1);
    }
  };
  visit(parent, 1);
  return result;
}
export function validateSessionParent(
  sessions: Session[],
  child: Session | undefined,
  parent: Session,
): void {
  if (parent.taskId || child?.taskId)
    throw Error('任务会话请使用新增子任务；普通子会话不改变任务树的验收关系');
  if (child && !sameSessionScope(child, parent))
    throw Error('父子会话必须属于同一 BOT、聊天和用户');
  const byId = new Map(sessions.map((s) => [s.id, s])),
    seen = new Set(child ? [child.id] : []);
  let current = parent,
    depth = 1;
  while (true) {
    if (seen.has(current.id)) throw Error('会话父子关系不能形成循环');
    seen.add(current.id);
    const id = sessionParentId(current);
    if (!id) break;
    const ancestor = byId.get(id);
    if (!ancestor || ancestor.taskId || !sameSessionScope(current, ancestor))
      throw Error('父会话的层级关系无效，请先检查祖先关系');
    current = ancestor;
    depth++;
  }
  if (depth > MAX_SESSION_DEPTH) throw Error(`普通子会话最多嵌套 ${MAX_SESSION_DEPTH} 层`);
  if (
    sessionDescendants(sessions, current).filter((s) => s.session.id !== child?.id).length >=
    MAX_SESSION_DESCENDANTS
  )
    throw Error(`本会话树最多关联 ${MAX_SESSION_DESCENDANTS} 个子会话`);
}
