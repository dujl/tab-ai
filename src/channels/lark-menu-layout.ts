import { PROJECT_URL } from '../brand.js';
import type { SessionInformation } from '../core/types.js';
export type CardElement = Record<string, any>;
export const plain = (content: string) => ({ tag: 'plain_text', content });
export const textBlock = (content: string, caption = false): CardElement => ({
  tag: 'div',
  text: { ...plain(content), ...(caption ? { text_size: 'notation', text_color: 'grey' } : {}) },
});
export const heading = (content: string): CardElement => ({
  tag: 'div',
  text: { ...plain(content), text_size: 'heading-3' },
});
export function buttonRows(buttons: CardElement[]): CardElement[] {
  const rows: CardElement[] = [];
  for (let i = 0; i < buttons.length; i += 2)
    rows.push({
      tag: 'column_set',
      flex_mode: 'bisect',
      columns: buttons.slice(i, i + 2).map((button) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{ ...button, width: 'fill' }],
      })),
    });
  return rows;
}
export function informationElements(info: SessionInformation): CardElement[] {
  const field = (label: string) => {
    const item = info.fields.find((f) => f.label === label);
    return item?.shortValue ?? item?.value ?? '未上报';
  };
  const pair = (left: string, right: string): CardElement => ({
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [left, right].map((value) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [textBlock(value)],
    })),
  });
  return [
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_spacing: '4px',
          elements: [
            heading('会话信息'),
            pair(`状态：${info.status.replace(' · 可继续对话', '')}`, `Agent：${field('Agent')}`),
            textBlock(`模型：${field('模型')}`),
            pair(`思考：${field('思考深度')}`, `审批：${field('审批策略')}`),
            textBlock(`目录：${field('工作目录')}`),
            textBlock(`上下文：${field('上下文占用')}`),
            textBlock(`消耗：${field('Token 消耗')}`),
            ...(info.details.find((f) => f.label === '最近压缩对比')
              ? [textBlock(info.details.find((f) => f.label === '最近压缩对比')!.value)]
              : []),
            {
              tag: 'collapsible_panel',
              expanded: false,
              header: { title: plain('更多信息 · 标识与配置详情') },
              elements: [...info.fields, ...info.details].map((f) =>
                textBlock(`${f.label}：${f.value}`),
              ),
            },
          ],
        },
      ],
    },
  ];
}
export function projectLink(): CardElement {
  return { tag: 'markdown', content: `[tab-ai ↗](${PROJECT_URL})` };
}
// Native initialization/settings still use the same callback contract. Translate
// layout syntax centrally, so those panels and management menus share Card 2.0.
export function toCard2(elements: CardElement[]): CardElement[] {
  return elements.flatMap((element) => {
    if (element.tag === 'action') return buttonRows(toCard2(element.actions));
    if (element.tag === 'note')
      return [textBlock(element.elements.map((e: any) => e.content ?? '').join('\n'), true)];
    const e = { ...element };
    if (e.elements) e.elements = toCard2(e.elements);
    if (e.tag === 'button' || e.tag === 'select_static') {
      if (e.tag === 'button' && e.action_type === 'form_submit') {
        e.form_action_type = 'submit';
        delete e.action_type;
        e.name = `session:${e.value.id}:${e.value.revision}:${e.value.action}`;
        delete e.value;
      } else if (e.value || e.url) {
        e.behaviors = e.url
          ? [{ type: 'open_url', default_url: e.url }]
          : [{ type: 'callback', value: e.value }];
        delete e.value;
        delete e.url;
      }
    }
    return [e];
  });
}

// Form buttons identify their server-issued action by component name. No legacy
// value/behaviors fields are mixed into a Card 2.0 form submission button.
export function normalizeCardCallback(raw: unknown): any {
  const data = raw as any;
  if (data?.action?.value?.kind || typeof data?.action?.name !== 'string') return raw;
  const name = data.action.name as string;
  const session = /^session:([a-f0-9-]{36}):(\d+):([a-z_]+)$/.exec(name);
  const management = /^management:([a-f0-9-]{36}):(settings-save|workspace-save|rename-save)$/.exec(
    name,
  );
  const value = session
    ? { kind: 'session', id: session[1], revision: Number(session[2]), action: session[3] }
    : management
      ? { kind: 'management', id: management[1], key: management[2] }
      : undefined;
  return value ? { ...data, action: { ...data.action, value } } : raw;
}
