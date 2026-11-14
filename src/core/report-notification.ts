import type { SessionReport, ReportNotification } from './report-model.js';
import type { Session } from './types.js';
import { reportPresentation } from './report-document.js';

export function reportNotificationStatus(notice: ReportNotification): string {
  const states = {
    pending: '待发送',
    sending: '发送中',
    delivered: '已送达',
    unconfirmed: '结果未确认，未自动重发',
    skipped: '未发送',
  };
  return `${notice.role === 'source' ? '原会话' : '直接父会话'}通知：${states[notice.state]}${notice.detail ? `（${notice.detail}）` : ''}`;
}

const excerpt = (text: string, limit: number) =>
  (text.length > limit ? text.slice(0, limit) + '…' : text)
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

export function reportNotification(
  report: SessionReport,
  source: Session,
  role: ReportNotification['role'],
  inlineLimit = 50,
) {
  const outcomes = {
    completed: '目标已完成（按验收记录）',
    submitted: '已提交，待验收',
    incomplete: '尚未确认完成',
    cancelled: '已取消',
    unknown: '完成情况待核对',
  };
  const body = report.body,
    presentation = reportPresentation(report, source, inlineLimit);
  return [
    `来源：${excerpt(source.title ?? '未命名会话', 100)} · ${source.id.slice(0, 8)}`,
    `报告 v${report.version} · ${outcomes[report.outcome]}`,
    report.trigger === 'progress'
      ? '阶段总结，任务仍在进行；供父会话接续，不表示验收完成。'
      : role === 'parent' && report.trigger === 'close'
        ? '子会话已关闭，以下为交接资料；未自动启动父会话或确认整个任务完成。'
        : report.trigger === 'close'
          ? '会话已关闭，历史和报告保留；关闭不代表目标已验收。'
          : '子任务已提交总结，请结合验收条件核对。',
    '',
    excerpt(presentation.summary, inlineLimit),
    ...(presentation.document
      ? [
          '',
          `更详细的信息在交接文档：${presentation.document.filename}。`,
          '网页会话历史中也可查看、下载完整文档。',
        ]
      : []),
    ...(body?.lessons.length
      ? ['', `可复用经验 ${body.lessons.length} 条：`, '适用条件、做法、限制及来源见完整报告。']
      : []),
    ...(report.warning ? ['', excerpt(report.warning, 600)] : []),
    '',
    `报告 ID：${report.id}`,
  ].join('\n');
}
