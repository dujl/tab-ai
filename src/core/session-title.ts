import { type Session, agentNames } from './types.js';

export function taskTitle(text: string): string | undefined {
  const clean = text
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return;
  const chars = [...clean];
  return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : clean;
}
export function sessionName(session: Session): string {
  const name = session.title || '尚无任务';
  return !session.route.thread && session.route.platform !== 'local' ? `主会话 · ${name}` : name;
}
export function sessionListEntry(session: Session, latestTask?: string): string {
  const labels: Record<Session['status'], string> = {
    idle: '空闲',
    running: '运行中',
    waiting: '等待确认',
    interrupted: '已中断',
    error: '出错',
    detached: '原生终端中',
    closed: '已关闭',
  };
  return `${sessionName(session)}\n${agentNames[session.agent]} · ${labels[session.status]}\nID：${session.id}${latestTask ? `\n最近任务：${taskTitle(latestTask) ?? '暂无'}` : '\n尚未执行任务'}`;
}
