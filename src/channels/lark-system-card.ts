import { type Session } from '../core/types.js';
import { sessionName } from '../core/session-title.js';
const escape = (text: string) => text.replace(/[&<>*~\[\]()#_`]/g, (c) => `&#${c.charCodeAt(0)};`);
export function larkClosedCard(session: Session, notice: { at: number; recovery: string }) {
  return {
    schema: '2.0',
    config: { width_mode: 'compact', summary: { content: 'tab-ai 系统通知：会话已关闭' } },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: 'tab-ai · 会话已关闭' },
      subtitle: { tag: 'plain_text', content: '系统状态通知' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'grey-50',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                {
                  tag: 'markdown',
                  content: `**${escape(sessionName(session))}**\n历史记录已保留，当前任务已停止。`,
                },
              ],
            },
          ],
        },
        { tag: 'markdown', content: `恢复方式：${escape(notice.recovery)}` },
        {
          tag: 'markdown',
          text_size: 'notation',
          content: `<font color='grey'>${escape(new Date(notice.at).toLocaleString('zh-CN', { hour12: false }))} · ${session.id.slice(0, 8)}</font>`,
        },
      ],
    },
  };
}
