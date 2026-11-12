import { sessionInformation } from '../core/session-information.js';
import {
  heading,
  informationElements,
  normalizeCardCallback,
  projectLink,
  toCard2,
} from './lark-menu-layout.js';
import { taskStateNames } from '../core/task-model.js';
import { sessionName } from '../core/session-title.js';
import { agentNames } from '../core/types.js';
import { z } from 'zod';
import { type SessionCardClick, type SessionCardView } from '../core/types.js';
const plain = (content: string) => ({ tag: 'plain_text', content });
export function larkSessionCard(view: SessionCardView) {
  const { session, card } = view;
  const place = session.route.thread ? '话题' : '主对话';
  const button = (label: string, action: SessionCardClick['action'], type = 'default') => ({
    tag: 'button',
    text: plain(label),
    type,
    value: { kind: 'session', id: card.id, revision: card.revision, action },
  });
  const actions: object[] = [
    button('刷新信息', 'status'),
    button('最近对话', 'history'),
    button(card.view === 'settings' ? '刷新模型列表' : '模型 / 思考', 'settings'),
  ];
  if (session.status !== 'detached') {
    if (session.status === 'closed' || !view.current)
      actions.push(button('打开 / 恢复', 'open', 'primary'));
    if (session.status !== 'closed') actions.push(button('关闭会话', 'close', 'danger'));
  }
  const taskElements: object[] = [];
  if (view.taskBoard) {
    const board = view.taskBoard;
    taskElements.push({
      tag: 'div',
      text: plain(
        `tab-ai 任务树 · ${board.current.parentId ? '子任务' : '主任务'}\n${taskStateNames[board.current.state]} · ${board.tasks.filter((t) => t.state === 'completed').length}/${board.tasks.length} 已完成\n任务 ID：${board.current.id}`,
      ),
    });
    for (const task of board.tasks) {
      taskElements.push({
        tag: 'div',
        text: plain(
          `${task.parentId ? '↳ ' : ''}${task.title} · ${task.waitingForUser ? '等待用户回答' : taskStateNames[task.state]}\n${task.id.slice(0, 8)}${task.error ? '\n' + task.error.slice(0, 200) : ''}`,
        ),
      });
      if (task.link && /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(task.link))
        taskElements.push({
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: plain(task.id === board.root.id ? '进入主任务' : '进入此子任务'),
              type: 'default',
              url: task.link,
            },
          ],
        });
    }
    if (board.current.result)
      taskElements.push({
        tag: 'div',
        text: plain(`最新成果\n${board.current.result.summary.slice(0, 1000)}`),
      });
    taskElements.push({
      tag: 'note',
      elements: [
        plain(
          '在此话题输入即交给当前任务。/tab tasks 查看任务树；/tab task-to <任务短ID> 内容 定向补充；/tab task-pause、task-resume、task-cancel 管理任务。',
        ),
      ],
    });
  }
  const events = view.events
    .map(
      (e) =>
        `${e.type === 'user' ? '你' : e.type === 'response' ? 'Agent' : e.type === 'activity' ? '当前活动' : '状态'} · ${new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}\n${e.text}`,
    )
    .join('\n\n');
  const settings: object[] = [];
  const instructions: object[] = [];
  if (session.pendingInitialTask !== undefined)
    instructions.push({
      tag: 'div',
      text: plain(
        `等待初始化 · 首个任务尚未执行\n${session.pendingInitialTask.slice(0, 600)}${session.pendingInitialTask.length > 600 ? '\n…任务原文已完整保留。' : ''}`,
      ),
    });
  if (view.instructionsEditable) {
    const longWorkspace = session.workspace.length > 1000;
    const longInstructions = (session.instructions?.length ?? 0) > 1000;
    instructions.push(
      {
        tag: 'div',
        text: plain(
          `会话初始化\n已保存工作目录：${session.workspace}\n当前目录已保存，无需重复填写；需要调整时再修改下方设置。${session.pendingInitialTask !== undefined ? '点击“保存并开始任务”后执行首个任务。' : '保存后再发送任务。'}`,
        ),
      },
      {
        tag: 'form',
        name: 'session_role_form',
        elements: [
          {
            tag: 'input',
            name: 'session_workspace_path',
            input_type: 'multiline_text',
            rows: 3,
            max_length: 1000,
            default_value: longWorkspace ? '' : session.workspace,
            placeholder: plain(
              longWorkspace
                ? '当前目录较长，已完整保存；留空继续使用上方目录'
                : '填写已存在的绝对路径或 ~/ 路径；留空保留当前目录',
            ),
            label: plain('工作目录'),
            label_position: 'top',
          },
          ...(longInstructions
            ? []
            : [
                {
                  tag: 'input',
                  name: 'session_instructions',
                  input_type: 'multiline_text',
                  rows: 4,
                  max_length: 1000,
                  default_value: session.instructions ?? '',
                  placeholder: plain('例如：你是一位文学编辑，始终用中文回复。'),
                  label: plain('系统提示词 / 附加指令（可选）'),
                  label_position: 'top',
                },
              ]),
          ...(session.pendingInitialTask !== undefined
            ? [
                {
                  ...button('仅保存设置', 'save_initial'),
                  name: 'save_initial_only',
                  action_type: 'form_submit',
                },
              ]
            : []),
          {
            ...button(
              session.pendingInitialTask !== undefined ? '保存并开始任务' : '保存初始化设置',
              'save_instructions',
              'primary',
            ),
            name: 'save_session_role',
            action_type: 'form_submit',
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          plain(
            longInstructions
              ? '已有长指令完整保留，此处仅选择工作目录。'
              : '系统提示词最多 1000 字符，留空保存可清除。工作目录和指令在首次任务开始后锁定；目录变更后模型沿用该目录原生配置。',
          ),
        ],
      },
      {
        tag: 'note',
        elements: [
          plain(
            '默认使用上方已保存的工作目录；子会话未指定目录时继承直接父会话目录。无需修改即可保存，留空也会保留当前目录。如需更换，请填写本机已存在的绝对路径或 ~/ 路径，保存后生效。',
          ),
        ],
      },
    );
    if (session.pendingInitialTask !== undefined)
      instructions.push({
        tag: 'action',
        actions: [button('使用当前设置直接开始任务', 'start_initial')],
      });
  } else
    instructions.push({
      tag: 'note',
      elements: [
        plain(
          session.status === 'closed'
            ? '初始化设置：会话已关闭。首次任务前可恢复后填写；已有任务的会话需新建。'
            : `系统附加指令：${session.instructions ? '已设置，可用 /tab instructions 查看。' : '未设置，沿用原生指令。'}此会话已开始执行任务，角色指令已锁定；工作目录可通过 /tab workspace 修改，支持范围由 Agent 决定。`,
        ),
      ],
    });
  const configured = session.settings
    ? `${session.settings.model} · ${session.settings.effort ?? '此模型未提供思考档位'}`
    : '沿用原生会话 / 本机配置';
  const footer = `${agentNames[session.agent]} · 模型：${session.settings?.model ?? '沿用原生配置'} · 思考深度：${session.settings ? (session.settings.effort ?? '无可选档位') : '沿用原生配置'}`;
  if (card.view === 'settings') {
    settings.push({
      tag: 'div',
      text: plain(
        `会话设置\n已保存：${configured}\n选择后点击“保存设置”，从下一轮生效；不添加对话消息。`,
      ),
    });
    if (view.settings?.state === 'ready') {
      const models = view.settings.models;
      const chosen = card.draftSettings ?? session.settings;
      const model = models.find((m) => m.id === chosen?.model);
      const select = (
        action: 'model' | 'effort',
        placeholder: string,
        options: { id: string; label: string }[],
        selected?: string,
      ) => ({
        tag: 'select_static',
        placeholder: plain(placeholder),
        ...(options.some((o) => o.id === selected) ? { initial_option: selected } : {}),
        options: options.map((o) => ({ text: plain(o.label.slice(0, 80)), value: o.id })),
        value: { kind: 'session', id: card.id, revision: card.revision, action },
      });
      settings.push({
        tag: 'action',
        actions: [select('model', '选择模型', models.slice(0, 100), chosen?.model)],
      });
      if (model?.efforts.length)
        settings.push({
          tag: 'action',
          actions: [
            select(
              'effort',
              '选择思考深度',
              model.efforts.map((e) => ({ id: e.id, label: `${e.id} · ${e.label}` })),
              chosen?.effort,
            ),
          ],
        });
      else if (model) settings.push({ tag: 'div', text: plain('此模型未提供可选择的思考深度。') });
      if (models.length > 100)
        settings.push({
          tag: 'note',
          elements: [plain('卡片展示前 100 个模型，完整列表可在本机工作台查看。')],
        });
      if (card.draftSettings) {
        settings.push({
          tag: 'div',
          text: plain(
            `待保存：${card.draftSettings.model} · ${card.draftSettings.effort ?? (model?.efforts.length ? '请选择思考深度' : '无思考档位')}`,
          ),
        });
        const busy = view.active || ['running', 'waiting', 'detached'].includes(session.status);
        settings.push({
          tag: 'action',
          actions: [
            ...(busy ? [] : [button('保存设置', 'save_settings', 'primary')]),
            button('取消修改', 'cancel_settings'),
          ],
        });
        if (busy)
          settings.push({
            tag: 'note',
            elements: [plain('当前任务结束或退出原生终端后，才可保存设置。')],
          });
      }
    } else
      settings.push({
        tag: 'div',
        text: plain(
          view.settings?.state === 'loading'
            ? '正在读取 Agent 模型能力…'
            : (view.settings?.error ?? '点击“刷新模型列表”读取可用选项。'),
        ),
      });
  }
  return {
    schema: '2.0',
    config: { width_mode: 'default', update_multi: true, enable_forward: false },
    header: {
      title: plain(`本会话设置 · ${sessionName(session)}`),
      template: session.status === 'closed' ? 'grey' : 'blue',
    },
    body: {
      elements: [
        ...informationElements(view.information ?? sessionInformation(session)),
        { tag: 'hr' },
        heading('会话管理'),
        ...toCard2([
          ...taskElements,
          ...(card.view === 'settings'
            ? settings
            : [
                {
                  tag: 'div',
                  text: plain(
                    `${card.view === 'history' ? '最近 6 条对话记录' : '运行状态 / 最近活动'}\n\n${events || `尚无对话。打开后，在此${place}发送消息开始。`}`,
                  ),
                },
              ]),
          ...instructions,
          { tag: 'action', actions },
          {
            tag: 'note',
            elements: [
              plain(
                `${footer}\n仅会话发起人可操作。关闭保留历史，恢复后等待新消息；设置修改从下一轮生效。`,
              ),
            ],
          },
        ]),
        projectLink(),
      ],
    },
  };
}
const clickSchema = z.object({
  operator: z.object({ open_id: z.string().min(1) }),
  context: z.object({ open_message_id: z.string().min(1), open_chat_id: z.string().min(1) }),
  action: z.object({
    option: z.string().max(256).optional(),
    form_value: z
      .object({
        session_workspace_path: z
          .string()
          .max(1000)
          .nullish()
          .transform((value) => value ?? undefined),
        session_workspace: z
          .string()
          .max(512)
          .nullish()
          .transform((value) => value || undefined),
        session_instructions: z
          .string()
          .max(1000)
          .nullish()
          .transform((value) => value ?? undefined),
      })
      .optional(),
    value: z.object({
      kind: z.literal('session'),
      id: z.string().uuid(),
      revision: z.number().int().min(0),
      action: z.enum([
        'close',
        'open',
        'status',
        'history',
        'settings',
        'model',
        'effort',
        'save_settings',
        'cancel_settings',
        'save_instructions',
        'save_initial',
        'start_initial',
      ]),
    }),
  }),
});
export function larkSessionAction(
  raw: unknown,
  handler?: (click: SessionCardClick) => SessionCardView,
) {
  try {
    const parsed = clickSchema.safeParse(normalizeCardCallback(raw));
    if (!parsed.success || !handler)
      throw new Error('会话卡片暂不可用，请在原话题发送 /tab card。');
    const { operator, context, action } = parsed.data;
    const view = handler({
      ...action.value,
      selection: action.option,
      instructions: action.form_value?.session_instructions,
      workspace: action.form_value?.session_workspace,
      workspacePath: action.form_value?.session_workspace_path,
      sender: operator.open_id,
      conversation: context.open_chat_id,
      messageId: context.open_message_id,
    });
    // Updates are serialized with lifecycle updates by SessionControls. Returning a raw
    // card here could overwrite a newer running/closed state after the callback returns.
    return {
      toast: {
        type: 'success',
        content:
          action.value.action === 'save_initial'
            ? '初始化设置已保存，任务尚未开始'
            : action.value.action === 'start_initial'
              ? '首个任务已开始'
              : action.value.action === 'save_instructions'
                ? '初始化设置已保存；有待执行任务时将立即开始'
                : action.value.action === 'save_settings'
                  ? '设置已保存，下轮生效'
                  : ['model', 'effort'].includes(action.value.action)
                    ? '已选择，请点击保存设置'
                    : action.value.action === 'cancel_settings'
                      ? '已取消修改'
                      : action.value.action === 'settings'
                        ? '正在读取模型选项'
                        : action.value.action === 'close'
                          ? '会话已关闭，历史已保留'
                          : action.value.action === 'open'
                            ? `会话已打开，可在${view.session.route.thread ? '原话题' : '主对话'}继续发送消息`
                            : view.card.view === 'history'
                              ? '正在更新最近对话'
                              : '正在更新当前状态',
      },
    };
  } catch (error) {
    return {
      toast: { type: 'error', content: error instanceof Error ? error.message : '操作失败' },
    };
  }
}
