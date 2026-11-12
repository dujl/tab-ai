import { agentNames, type ToolRunView } from '../core/types.js';
import { toolStatus } from '../core/tool-progress.js';
import { toolRunAppearance } from './lark-card-status.js';
const escape = (s: string) => s.replace(/[&<>*~\[\]()#_`]/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (s: string, n: number) =>
  Array.from(s).slice(0, n).join('') + (Array.from(s).length > n ? '…' : '');
export function larkToolCard(view: ToolRunView) {
  const appearance = toolRunAppearance(view),
    status = appearance.label;
  const latest = view.tools.filter((t) => t.status === 'running').at(-1) ?? view.tools.at(-1);
  let tools = view.tools.slice(-8);
  const build = () => ({
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
      summary: { content: `${agentNames[view.agent]} · ${status} · ${view.total} 次工具调用` },
    },
    header: {
      template: appearance.color,
      title: { tag: 'plain_text', content: `${agentNames[view.agent]} · ${status}` },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `**${status}**${latest ? ' · ' + escape(short(`${latest.name} · ${latest.input ?? ''}`.replace(/\s+/g, ' '), 110)) : ''}`,
        },
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: { tag: 'plain_text', content: `已调用 ${view.total} 次工具 · 点击展开` },
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
            icon_position: 'right',
            icon_expanded_angle: -180,
          },
          elements: tools.map((t) => ({
            tag: 'collapsible_panel',
            expanded: false,
            header: {
              title: {
                tag: 'plain_text',
                content: `${toolStatus[t.status]} · ${t.name} · ${short((t.input ?? '').replace(/\s+/g, ' '), 70)}`,
              },
            },
            elements: [
              {
                tag: 'markdown',
                content: `**调用内容**\n${escape(short(t.input ?? '未提供参数', 400))}`,
              },
              ...(t.output
                ? [{ tag: 'markdown', content: `**执行结果**\n${escape(short(t.output, 800))}` }]
                : []),
              ...(t.exitCode !== undefined
                ? [{ tag: 'markdown', content: `退出码：${t.exitCode}` }]
                : []),
            ],
          })),
        },
        {
          tag: 'markdown',
          text_size: 'notation',
          content: `tab-ai 执行记录 · 展示最近 ${tools.length}/${view.total} 项，详情可能截断；/tab tools 按序号查看。`,
        },
      ],
    },
  });
  let card = build();
  while (Buffer.byteLength(JSON.stringify(card)) > 24000 && tools.length > 1) {
    tools = tools.slice(1);
    card = build();
  }
  return card;
}
