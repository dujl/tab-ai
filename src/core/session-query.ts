import { sessionName } from './session-title.js';
import { sessionIdentity } from './session-identity.js';
import { type Route, type Session } from './types.js';

// Recognize standalone management questions only, not examples, negations or
// requests to reason about session implementations. No model prompt is injected.
export function isSessionCountQuery(text: string): boolean {
  const compact = text
    .trim()
    .replace(/[\s\u200B-\u200D\uFEFF]/g, '')
    .replace(/[？?。！!，,]+$/, '')
    .replace(/(?:呢|呀|啊)$/, '');
  return (
    /^(?:(?:请问|请告诉我))?(?:(?:你|机器人|tab-ai))?(?:(?:现在|目前|当前))?(?:(?:一共|总共))?(?:(?:还|已))?(?:有|管理着?)(?:几个|多少个?)(?:会话|sessions?)[？?。！!]?$/i.test(
      compact,
    ) ||
    /^(?:(?:请问|请告诉我))?(?:(?:现在|目前|当前))?(?:(?:你|机器人|tab-ai))?(?:管理的)?(?:会话|sessions?)(?:数量)?(?:有多少个?|有几个|是多少)[？?。！!]?$/i.test(
      compact,
    )
  );
}

export function sessionSummary(sessions: Session[], route: Route, global = false): string {
  const visible = global
    ? sessions
    : sessions.filter(
        (s) =>
          s.route.platform === route.platform &&
          s.route.account === route.account &&
          s.route.conversation === route.conversation &&
          s.route.sender === route.sender,
      );
  const closed = visible.filter((s) => s.status === 'closed').length;
  const running = visible.filter((s) => s.status === 'running').length;
  const waiting = visible.filter((s) => s.status === 'waiting').length;
  return `${global ? '【Manager 全局视图】本实例全部会话记录共' : '当前机器人在本聊天中属于你的会话记录共'} ${visible.length} 个（包含主对话及各话题）。\n打开 ${visible.length - closed} 个，已关闭 ${closed} 个；运行中 ${running} 个，等待确认 ${waiting} 个。\n已关闭记录仍保留，可恢复。此查询不创建或恢复会话，也不调用 Agent；${global ? '包含所有 BOT、聊天、用户及本地会话。' : '不包含其他聊天、其他用户及本地测试会话。'}`;
}

// Deliberately anchored: compound operations, quoted examples and code tasks go
// through semantic routing rather than being swallowed by a status shortcut.
export function isSessionStatusQuery(text: string): boolean {
  const compact = text
    .trim()
    .replace(/[\s\u200B-\u200D\uFEFF]/g, '')
    .replace(/[？?。！!]+$/, '');
  return /^(?:请问)?(?:(?:当前|这个|本|该)的?)?(?:会话|话题|session)(?:(?:现在|当前))?(?:(?:已|已经)?(?:关闭|结束|打开)了吗|是否(?:已|已经)?(?:关闭|结束|打开)|(?:还)?在运行吗|(?:还)?开着吗)$/i.test(
    compact,
  );
}

export function currentSessionStatus(session: Session | undefined, route: Route): string {
  const scope = route.thread ? '当前话题' : '当前主对话';
  if (!session)
    return `【tab-ai 系统 · 当前会话状态】\n${scope}尚未绑定会话。本次查询不会新建或恢复会话。`;
  const state =
    session.operation === 'compact'
      ? '原生会话压缩中'
      : {
          closed: '已关闭',
          idle: '已打开，空闲',
          running: '运行中',
          waiting: '等待确认',
          detached: '已交给原生终端',
          interrupted: '已中断',
          error: '执行出错',
        }[session.status];
  return `【tab-ai 系统 · 当前会话状态】\n范围：${scope}\n名称：${sessionName(session)}\n状态：${state}（${session.status}）\nAgent：${session.agent}\n工作区：${session.workspace}\n${sessionIdentity(session)}${session.status === 'closed' ? '\n历史记录已保留；可在本会话发送 /tab open 恢复。' : ''}`;
}
