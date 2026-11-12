import { PROJECT_URL } from '../brand.js';
import {
  normalizeCardCallback,
  buttonRows,
  heading,
  informationElements,
  projectLink,
  textBlock,
  type CardElement,
} from './lark-menu-layout.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TemplateCard } from '@wecom/aibot-node-sdk';
import type { Incoming, ManagementHandler, ManagementView } from '../core/types.js';
import { managementText, managementActions } from '../core/management-view.js';
import { splitText } from './common.js';

export interface ManagementCard {
  id: string;
  message: Incoming;
  view: ManagementView;
  expires: number;
  messageId?: string;
  used: Set<number>;
  busy?: boolean;
}
// Only server-issued opaque keys are accepted. Callbacks never supply commands,
// target session IDs, credentials, or a different routing destination.
export class ManagementCards {
  private entries = new Map<string, ManagementCard>();
  handler?: ManagementHandler;
  authorize?: (message: Incoming, scope?: ManagementView['scope']) => boolean;
  open(message: Incoming, view: ManagementView): ManagementCard {
    for (const [id, card] of this.entries) if (card.expires <= Date.now()) this.entries.delete(id);
    if (this.entries.size >= 200) this.entries.delete(this.entries.keys().next().value!);
    const card = {
      id: randomUUID(),
      message: structuredClone(message),
      view: structuredClone(view),
      expires: Date.now() + 15 * 60_000,
      used: new Set<number>(),
    };
    this.entries.set(card.id, card);
    return card;
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }
  get(id: string): ManagementCard | undefined {
    return this.entries.get(id);
  }
  remove(id: string): void {
    this.entries.delete(id);
  }
  submit(
    id: string,
    key: string,
    actor: { sender: string; conversation: string; messageId?: string },
    input?: { workspace: string } | { name: string },
  ): { ok: boolean; message: string; run?: () => Promise<void> } {
    const card = this.entries.get(id);
    if (!card || card.expires <= Date.now())
      return {
        ok: false,
        message: card
          ? `管理菜单已过期，请发送 ${card.view.scope === 'admin' ? '/tab admin' : '/tab menu'}。`
          : '管理菜单已过期或服务已重启，请重新打开对应菜单。',
      };
    if (
      actor.sender !== card.message.route.sender ||
      actor.conversation !== card.message.route.conversation ||
      (card.messageId && actor.messageId !== card.messageId)
    )
      return { ok: false, message: '仅原聊天中的菜单发起人可操作。' };
    if (this.authorize && !this.authorize(card.message, card.view.scope))
      return { ok: false, message: '当前聊天或 BOT 管理权限已变化，请重新打开菜单。' };
    if (key === 'details')
      return {
        ok: true,
        message: '已请求完整内容。',
        run: async () => {
          if (this.authorize && !this.authorize(card.message, card.view.scope)) return;
          await this.details?.(card.message, managementText(card.view));
        },
      };
    if (!/^(0|[1-9]\d*)$/.test(key)) return { ok: false, message: '无效管理操作。' };
    const index = Number(key),
      button = managementActions(card.view)[index];
    if (!button || !/^\/tab\s+[^\r\n]+$/.test(button.command) || !this.handler)
      return {
        ok: false,
        message: `管理操作不可用，请发送 ${card.view.scope === 'admin' ? '/tab admin' : '/tab menu'}。`,
      };
    if (input) {
      const validWorkspace =
        'workspace' in input &&
        card.view.workspaceEditor &&
        button.command === '/tab workspace' &&
        button.mutation;
      const validName =
        'name' in input &&
        card.view.renameEditor &&
        button.command === '/tab rename' &&
        button.mutation;
      if (!validWorkspace && !validName) return { ok: false, message: '无效表单操作。' };
      if (
        'name' in input &&
        (!input.name.trim() ||
          [...input.name.trim()].length > 60 ||
          /[\x00-\x1f\x7f]/.test(input.name))
      )
        return { ok: false, message: '请输入 1～60 个字的会话名称，不包含换行或控制字符。' };
    }
    if (button.disabledReason) return { ok: false, message: button.disabledReason };
    if (card.busy) return { ok: false, message: '正在处理上一次操作，请稍后。' };
    if (button.mutation && card.used.has(index))
      return { ok: false, message: '此操作已提交，请刷新菜单查看状态。' };
    if (button.mutation) card.used.add(index);
    // Generate a fresh receipt and drop original attachments/quotes. The route,
    // owner and expected session remain those captured when the card was sent.
    const message: Incoming = {
      id: randomUUID(),
      managementOrigin: card.id,
      text: input
        ? 'workspace' in input
          ? '/tab workspace ' + (input.workspace.trim() || card.view.workspaceEditor!.current)
          : '/tab rename ' + input.name.trim()
        : button.command,
      direct: card.message.direct,
      route: { ...card.message.route },
      ...(card.message.replyTo ? { replyTo: card.message.replyTo } : {}),
      ...(card.message.groupMessage
        ? { groupMessage: { ...card.message.groupMessage, mentioned: true } }
        : {}),
    };
    return {
      ok: true,
      message: '已提交管理操作。',
      run: async () => {
        if (card.busy) return;
        card.busy = true;
        try {
          await this.handler!(message, card.view.session, !!button.mutation, card.view.scope);
        } finally {
          card.busy = false;
        }
      },
    };
  }
  details?: (message: Incoming, text: string) => Promise<void>;
}
const plain = (content: string) => ({ tag: 'plain_text', content });
export function larkManagementCard(
  card: ManagementCard,
  text = card.view.text,
  buttons = true,
  qrKey?: string,
) {
  const actions = managementActions(card.view).map((button, index) => ({ button, index }));
  const makeButton = ({ button, index }: (typeof actions)[number]): CardElement => ({
    tag: 'button',
    text: plain(button.label),
    type: /重置|关闭|取消任务/.test(button.label)
      ? 'danger'
      : button.group === 'urgent'
        ? 'primary_filled'
        : 'default',
    ...(button.disabledReason
      ? { disabled: true, disabled_tips: plain(button.disabledReason) }
      : {}),
    behaviors: [
      { type: 'callback', value: { kind: 'management', id: card.id, key: String(index) } },
    ],
  });
  const elements: CardElement[] = [];
  if (buttons && card.view.information)
    elements.push(...informationElements(card.view.information), { tag: 'hr' });
  elements.push(heading(card.view.scope === 'admin' ? '管理操作' : '会话管理'));
  if (text) elements.push(textBlock(text));
  if (buttons && card.view.authorization?.url && card.view.authorization.status !== 'ready') {
    elements.push({
      tag: 'button',
      text: plain('申请群消息权限'),
      type: 'primary',
      behaviors: [{ type: 'open_url', default_url: card.view.authorization.url }],
    });
    if (qrKey) elements.push({ tag: 'img', img_key: qrKey, alt: plain('群消息权限申请二维码') });
  }
  if (buttons) {
    const models = actions.filter((a) => /^\/tab settings choose /.test(a.button.command));
    const efforts = actions.filter((a) => /^\/tab settings apply /.test(a.button.command));
    const workspaceSave = card.view.workspaceEditor
      ? actions.find((a) => a.button.command === '/tab workspace' && a.button.mutation)
      : undefined;
    const renameSave = card.view.renameEditor
      ? actions.find((a) => a.button.command === '/tab rename' && a.button.mutation)
      : undefined;
    const special = new Set([
      ...models,
      ...efforts,
      ...(workspaceSave ? [workspaceSave] : []),
      ...(renameSave ? [renameSave] : []),
    ]);
    if (models.length)
      elements.push({
        tag: 'select_static',
        width: 'fill',
        placeholder: plain('选择模型（尚未保存）'),
        options: models.map((a) => ({ text: plain(a.button.label), value: String(a.index) })),
        behaviors: [
          { type: 'callback', value: { kind: 'management', id: card.id, key: 'select' } },
        ],
      });
    if (efforts.length === 1 && efforts[0]!.button.command.split(/\s+/)[4] === '-')
      elements.push(
        { ...makeButton(efforts[0]!), text: plain('保存设置'), type: 'primary_filled' },
        textBlock('此模型不提供可选思考档位。', true),
      );
    else if (efforts.length)
      elements.push({
        tag: 'form',
        name: 'model_settings',
        elements: [
          {
            tag: 'select_static',
            name: 'decision',
            required: true,
            width: 'fill',
            placeholder: plain('选择思考深度'),
            disabled: efforts.every((a) => !!a.button.disabledReason),
            options: efforts.map((a) => ({
              text: plain(a.button.label.replace(/^保存 · /, '')),
              value: String(a.index),
            })),
          },
          {
            tag: 'button',
            name: `management:${card.id}:settings-save`,
            disabled: efforts.every((a) => !!a.button.disabledReason),
            text: plain('保存设置'),
            type: 'primary_filled',
            form_action_type: 'submit',
          },
        ],
      });
    if (workspaceSave)
      elements.push({
        tag: 'form',
        name: 'workspace_settings',
        elements: [
          {
            tag: 'input',
            name: 'workspace',
            input_type: 'multiline_text',
            rows: 3,
            max_length: 1000,
            label: plain('自定义工作目录'),
            label_position: 'top',
            default_value:
              card.view.workspaceEditor!.current.length <= 1000
                ? card.view.workspaceEditor!.current
                : '',
            placeholder: plain('绝对路径或 ~/ 路径；留空保留当前目录'),
          },
          {
            tag: 'button',
            name: `management:${card.id}:workspace-save`,
            text: plain('保存工作目录'),
            type: 'primary_filled',
            form_action_type: 'submit',
          },
        ],
      });
    if (renameSave)
      elements.push({
        tag: 'form',
        name: 'rename_session',
        elements: [
          {
            tag: 'input',
            name: 'session_name',
            label: plain('会话名称'),
            label_position: 'top',
            input_type: 'text',
            required: true,
            max_length: 60,
            default_value: card.view.renameEditor!.current,
            placeholder: plain('输入新的会话名称（1～60 个字）'),
            disabled: !!renameSave.button.disabledReason,
          },
          {
            tag: 'button',
            name: `management:${card.id}:rename-save`,
            text: plain('保存名称'),
            type: 'primary_filled',
            form_action_type: 'submit',
            disabled: !!renameSave.button.disabledReason,
          },
        ],
      });
    const remaining = actions.filter(
      (a) =>
        !special.has(a) &&
        !(
          a.index === card.view.buttons.length &&
          card.view.buttons.some((b) => b.command === a.button.command)
        ),
    );
    const navigation = remaining.find((a) => a.index === card.view.buttons.length);
    const content = remaining.filter((a) => a !== navigation);
    elements.push(
      ...buttonRows(content.filter((a) => a.button.group !== 'secondary').map(makeButton)),
    );
    const secondary = content.filter((a) => a.button.group === 'secondary');
    if (secondary.length) elements.push(...buttonRows(secondary.map(makeButton)));
    if (navigation) elements.push({ ...makeButton(navigation), type: 'default', width: 'fill' });
    const reasons = [
      ...new Set(
        actions.flatMap((a) => (a.button.disabledReason ? [a.button.disabledReason] : [])),
      ),
    ];
    reasons.forEach((reason) => elements.push(textBlock(reason, true)));
  }
  const root = card.view.scope === 'admin' ? '/tab admin' : '/tab menu';
  elements.push(
    textBlock(
      `${card.view.scope === 'admin' ? '跨会话管理 · 须明确选择目标' : '仅当前会话'} · 仅发起人可操作 · 菜单 15 分钟内有效\n更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 按钮不可用时发送 ${root}`,
      true,
    ),
    projectLink(),
  );
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true, enable_forward: false },
    header: {
      title: plain(card.view.title),
      ...(card.view.information ? { subtitle: plain(card.view.information.name) } : {}),
      template: card.view.tone ?? (card.view.action?.includes('error') ? 'red' : 'blue'),
    },
    body: { elements },
  };
}
export function wecomManagementCard(card: ManagementCard): TemplateCard {
  const summary = card.view.information
    ? `会话信息\n${card.view.information.status}\n${card.view.information.fields.map((f) => `${f.label}：${f.value}`).join('\n')}\n\n会话管理\n${card.view.text}`
    : card.view.text;
  const chars = Array.from(summary),
    long = chars.length > 280;
  const items = card.view.buttons.map((button, index) => ({ button, index }));
  const ordered = [
    ...items.filter((i) => /^\/tab (?:list \d+|settings page \d+)$/.test(i.button.command)),
    ...items.filter((i) => !/^\/tab (?:list \d+|settings page \d+)$/.test(i.button.command)),
  ];
  const buttons = ordered.slice(0, 4).map(({ button, index }) => ({
    text: Array.from(button.label).slice(0, 10).join(''),
    key: String(index),
    style: 1,
  }));
  if (card.view.navigation)
    buttons.push({
      text: Array.from(card.view.navigation.label).slice(0, 10).join(''),
      key: String(card.view.buttons.length),
      style: 3,
    });
  buttons.push({ text: card.view.overview?.detailLabel ?? '查看全文', key: 'details', style: 3 });
  if (card.view.overview) {
    const clip = (text: string, limit: number) => {
      const points = Array.from(text.replace(/[\r\n\t]+/g, ' '));
      return points.length > limit ? points.slice(0, limit - 1).join('') + '…' : points.join('');
    };
    return {
      card_type: 'button_interaction',
      task_id: card.id,
      source: { desc: 'tab-ai 系统', desc_color: 0 },
      main_title: { title: '系统提示词与通道', desc: '仅当前会话 · 仅发起人可操作' },
      sub_title_text: `${card.view.overview.summary}\n项目 GitHub：${PROJECT_URL}`,
      horizontal_content_list: card.view.overview.facts
        .slice(0, 6)
        .map((f) => ({ keyname: clip(f.label, 5), value: clip(f.value, 26) })),
      button_list: buttons,
      card_action: { type: 0 },
    };
  }
  return {
    card_type: 'button_interaction',
    task_id: card.id,
    source: { desc: 'tab-ai 系统', desc_color: 0 },
    main_title: {
      title: Array.from(card.view.title).slice(0, 26).join(''),
      desc:
        card.view.scope === 'admin' ? '跨会话管理 · 须明确选择目标' : '仅当前会话 · 仅发起人可操作',
    },
    quote_area: {
      title: '管理信息',
      quote_text: chars.slice(0, 280).join('') + (long ? '\n…点击查看全文' : ''),
    },
    sub_title_text: `项目 GitHub：${PROJECT_URL}\n按钮不可用时发送 ${card.view.scope === 'admin' ? '/tab admin' : '/tab menu'}；填写参数请使用文字命令。`,
    button_list: buttons,
    card_action: { type: 0 },
  };
}
const larkAction = z.object({
  operator: z.object({ open_id: z.string() }),
  context: z.object({ open_chat_id: z.string(), open_message_id: z.string() }),
  action: z.object({
    option: z.string().max(30).optional(),
    form_value: z
      .object({
        decision: z.string().max(30).optional(),
        workspace: z.string().max(1000).nullish(),
        session_name: z.string().max(120).optional(),
      })
      .optional(),
    value: z.object({
      kind: z.literal('management'),
      id: z.string().uuid(),
      key: z.string().max(30),
    }),
  }),
});
export function larkManagementAction(cards: ManagementCards, raw: unknown) {
  const parsed = larkAction.safeParse(normalizeCardCallback(raw));
  if (!parsed.success) return { ok: false, message: '无效管理菜单，请发送 /tab menu。' };
  const data = parsed.data;
  let key = data.action.value.key;
  const card = cards.get(data.action.value.id);
  if (key === 'select' || key === 'settings-save') {
    const chosen = key === 'select' ? data.action.option : data.action.form_value?.decision;
    const command =
      chosen && /^\d+$/.test(chosen)
        ? managementActions(card?.view ?? { title: '', text: '', buttons: [] })[Number(chosen)]
            ?.command
        : undefined;
    if (
      !command ||
      !(key === 'select'
        ? /^\/tab settings choose /.test(command)
        : /^\/tab settings apply /.test(command))
    )
      return { ok: false, message: '无效模型选项，请重新打开设置。' };
    key = chosen!;
  }
  if (key === 'workspace-save' || key === 'rename-save') {
    const rename = key === 'rename-save';
    if (!card?.view.session || (rename ? !card.view.renameEditor : !card.view.workspaceEditor))
      return { ok: false, message: '编辑面板已失效，请重新打开。' };
    const command = rename ? '/tab rename' : '/tab workspace';
    const index = card.view.buttons.findIndex((b) => b.command === command && b.mutation);
    if (index < 0) return { ok: false, message: '无效表单操作。' };
    return cards.submit(
      card.id,
      String(index),
      {
        sender: data.operator.open_id,
        conversation: data.context.open_chat_id,
        messageId: data.context.open_message_id,
      },
      rename
        ? { name: data.action.form_value?.session_name ?? '' }
        : { workspace: data.action.form_value?.workspace ?? '' },
    );
  }
  return cards.submit(data.action.value.id, key, {
    sender: data.operator.open_id,
    conversation: data.context.open_chat_id,
    messageId: data.context.open_message_id,
  });
}
const detail = z.object({ task_id: z.string().uuid(), event_key: z.string().max(30) });
const wecomAction = z.object({
  from: z.object({ userid: z.string() }),
  chatid: z.string().optional(),
  chattype: z.enum(['group', 'single']).optional(),
  event: z.object({ template_card_event: detail.optional() }).passthrough(),
});
export function wecomManagementAction(cards: ManagementCards, raw: unknown) {
  const parsed = wecomAction.safeParse(raw);
  if (!parsed.success) return;
  const data = parsed.data,
    action = detail.safeParse(data.event.template_card_event ?? data.event);
  if (!action.success || !cards.has(action.data.task_id)) return;
  if (data.chattype === 'group' && !data.chatid)
    return {
      ok: false,
      message: '无法确认原群，未执行。',
      run: undefined,
      card: undefined,
      sender: data.from.userid,
    };
  return {
    ...cards.submit(action.data.task_id, action.data.event_key, {
      sender: data.from.userid,
      conversation: data.chatid ?? data.from.userid,
    }),
    card: cards.get(action.data.task_id),
    sender: data.from.userid,
  };
}
export const managementChunks = (view: ManagementView) => splitText(view.text, 5000);
