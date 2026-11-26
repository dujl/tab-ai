import type { SessionReport } from './report-model.js';
import type { Session } from './types.js';

export function reportPresentation(report: SessionReport, source: Session, limit = 50) {
  const summary = report.body?.summary ?? '暂无可确认的总结',
    points = Array.from(summary),
    long = points.length > limit;
  const first = (summary.split(/[。！？\n]/u)[0] || summary).trim();
  const chars = Array.from(first);
  return {
    reportId: report.id,
    version: report.version,
    sourceSessionId: source.id,
    sourceTitle: source.title ?? '未命名子任务',
    kind: report.trigger === 'progress' ? 'progress' : 'handoff',
    outcome: report.outcome,
    summary: long ? chars.slice(0, Math.max(0, limit - 1)).join('') + '…' : summary,
    ...(long
      ? { document: { filename: `handoff-${source.id.slice(0, 8)}-v${report.version}.md` } }
      : {}),
  };
}

// The versioned report is the durable document source; this deterministic export
// never interprets Markdown as HTML or invokes an external document service.
export function reportDocument(report: SessionReport, source: Session): string {
  const b = report.body,
    list = (items: string[] | undefined) =>
      items?.length ? items.map((s) => `- ${s}`).join('\n') : '未记录';
  return (
    [
      '# 任务报告',
      `来源：${source.title ?? '未命名子任务'}\n\nSession：${source.id}\n\n报告：${report.id} · v${report.version}\n\n类型：${report.trigger === 'progress' ? '阶段总结（不表示完成）' : report.trigger}\n\n完成状态：${report.outcome}\n\n生成时间：${new Date(report.createdAt).toISOString()}`,
      '## 总结',
      b?.summary ?? '暂无可确认的总结',
      ...(report.context
        ? [
            '## 任务背景',
            `目标：${report.context.objective ?? '参见任务原始要求'}\n\n验收：${report.context.criteria ?? '未设置'}\n\n工作目录：${report.context.workspace}\n\n用户附加指令：${report.context.instructions ?? '未设置'}`,
          ]
        : []),
      '## 产物',
      list(
        b?.deliverables.map(
          (d) => `${d.name}（${d.kind}）\n  位置：${d.location}\n  ${d.description}`,
        ),
      ),
      '## 接续规格',
      list(b?.specifications.map((s) => `${s.name}\n\n${s.content}`)),
      '## 验证',
      list(b?.validation.map((v) => `${v.name}：${v.result}；依据：${v.evidence}`)),
      '## 风险',
      list(b?.risks),
      '## 遗留事项',
      list(b?.remainingWork),
      '## 下一步',
      list(b?.nextSteps),
      '## 可复用经验',
      b?.lessons.length
        ? b.lessons
            .map(
              (l, i) =>
                `### ${i + 1}. ${l.summary}\n\n适用条件：${l.appliesWhen}\n\n做法：${l.practice}\n\n限制：${l.cautions}\n\n依据：${l.evidence.join('、')}`,
            )
            .join('\n\n')
        : '未记录有依据的可复用经验。',
      ...(report.warning ? ['## 资料限制', report.warning] : []),
      '报告是接续资料，关闭、阶段总结和报告就绪均不代表验收通过。',
    ].join('\n\n') + '\n'
  );
}
