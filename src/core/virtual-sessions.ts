import { sessionName } from './session-title.js';
import { type Route, type Session } from './types.js';
export function virtualSessions(route: Route): boolean {
  return ['wechat', 'wecom', 'dingtalk'].includes(route.platform);
}
export function sameChat(a: Route, b: Route): boolean {
  return (
    a.platform === b.platform &&
    a.account === b.account &&
    a.conversation === b.conversation &&
    a.sender === b.sender
  );
}
export function sessionLabel(session: Session): string {
  return `【${sessionName(session)} · ${session.id.slice(0, 8)}】`;
}
export function findChatSession(
  sessions: Session[],
  route: Route,
  reference: string,
): Session | undefined {
  const visible = sessions.filter((s) => sameChat(s.route, route));
  if (reference === 'main')
    return visible.filter((s) => !s.route.thread).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!/^[a-f0-9-]{6,36}$/.test(reference)) return;
  const matches = visible.filter((s) => s.id.startsWith(reference));
  return matches.length === 1 ? matches[0] : undefined;
}
