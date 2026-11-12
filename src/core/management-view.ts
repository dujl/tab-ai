import { PROJECT_URL } from '../brand.js';
import { sessionInformation } from './session-information.js';
import type { ManagementButton, ManagementView, Session } from './types.js';
import { createHash } from 'node:crypto';
import { instructionsOverview } from './instructions-view.js';
export const managementRevision = (session: Session, task?: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([session, task ?? null]))
    .digest('hex');

const titles: Record<string, string> = {
  'menu:delivery': '任务与交付',
  'menu:tools': '审批与执行',
  'menu:advanced': '更多操作',
  'menu:records': '记录与附件',
  'menu:more': '更多本会话',
  'menu:controls': '常用设置',
  'menu:maintenance': '持续任务与终端',
  report: '交付与经验报告',
  experience: '可复用经验',
  todos: 'Agent 待办',
  approval: '审批策略',
  topics: '关联话题与成果',
  'topic-report': '话题进度与汇报',
  reset: '重置会话',
  compact: '会话压缩',
  loops: '持续任务管理',
  help: '管理菜单',
  menu: '管理菜单',
  status: '会话状态',
  sessions: '会话概览',
  list: '会话列表',
  tasks: '任务管理',
  bots: '机器人与权限',
  workspace: '工作目录',
  settings: '模型与思考',
  instructions: '会话附加指令',
  files: '会话附件',
  history: '最近对话',
  tools: '工具记录',
  pending: '待处理请求',
  close: '会话已关闭',
  open: '会话已打开',
  stop: '任务已停止',
  new: '新建会话',
  init: '初始化会话',
  rename: '会话名称',
  'group-mode': '群接收模式',
  'bot-role': '机器人权限',
  manage: '会话管理',
};
export function adminOnlyAction(action: string): boolean {
  return ['admin', 'manage', 'list', 'sessions', 'bots', 'bot-role'].includes(
    action.split(':')[0]!,
  );
}
export function managementScope(action: string, adminAvailable = true): 'session' | 'admin' {
  if (!adminAvailable) return 'session';
  return [
    'admin',
    'manage',
    'list',
    'sessions',
    'bots',
    'bot-role',
    'group-mode',
    'help',
    'new',
    'topic',
    'tasks',
    'task',
    'task-status',
    'task-pause',
    'task-resume',
    'task-cancel',
    'task-to',
  ].includes(action.split(':')[0]!)
    ? 'admin'
    : 'session';
}
export function managementActions(view: ManagementView): ManagementButton[] {
  return [...view.buttons, ...(view.navigation ? [view.navigation] : [])];
}
export function sessionLifecycleButton(session: Session): ManagementButton {
  return session.status === 'closed'
    ? { label: '恢复会话', command: '/tab open', mutation: true }
    : ['running', 'waiting'].includes(session.status) || session.operation
      ? { label: '停止当前任务', command: '/tab stop', mutation: true }
      : { label: '结束会话', command: '/tab close', mutation: true };
}
export function commonSessionButtons(session?: Session): ManagementButton[] {
  if (!session)
    return [
      { label: '会话状态', command: '/tab status' },
      { label: '初始化会话', command: '/tab init' },
    ];
  return sessionSettingButtons();
}
function sessionSettingButtons(): ManagementButton[] {
  return [
    { label: '压缩会话', command: '/tab compact' },
    { label: '重置会话…', command: '/tab reset' },
    { label: '模型与思考', command: '/tab settings' },
    { label: '工作目录', command: '/tab workspace' },
  ];
}
export function sessionHomeButtons(
  session: Session | undefined,
  rich: boolean,
  pendingCount = 0,
): ManagementButton[] {
  const buttons = commonSessionButtons(session);
  if (!session) return buttons;
  if (rich) {
    const urgent: ManagementButton | undefined =
      session.status === 'closed'
        ? { label: '恢复会话', command: '/tab open', mutation: true }
        : session.status === 'waiting' && pendingCount
          ? { label: `处理待办（${pendingCount}）`, command: '/tab pending' }
          : ['running', 'waiting'].includes(session.status) || session.operation
            ? {
                label: session.operation === 'compact' ? '停止压缩' : '停止当前轮',
                command: '/tab stop',
                mutation: true,
              }
            : session.status === 'detached'
              ? { label: '查看交回方式', command: '/tab menu terminal' }
              : undefined;
    if (urgent) buttons.unshift({ ...urgent, group: 'urgent' });
    buttons.push(
      { label: '审批与执行', command: '/tab menu tools', group: 'secondary' },
      { label: '任务与交付', command: '/tab menu delivery', group: 'secondary' },
      { label: '更多操作', command: '/tab menu advanced', group: 'secondary' },
    );
  }
  return buttons;
}
// Session pages contain only current-session commands. Navigation has its own slot.
export const managementMenuPages: Record<string, ManagementButton[]> = {
  more: [
    { label: '审批与执行', command: '/tab menu tools' },
    { label: '任务与交付', command: '/tab menu delivery' },
    { label: '更多操作', command: '/tab menu advanced' },
  ],
  controls: sessionSettingButtons(),
  records: [
    { label: '最近对话', command: '/tab history' },
    { label: '重发最近结果', command: '/tab last' },
    { label: '附件管理', command: '/tab files' },
    { label: '工具与请求', command: '/tab menu tools' },
  ],
  tools: [
    { label: 'Agent 待办', command: '/tab todos' },
    { label: '审批策略', command: '/tab approval' },
    { label: '工具记录', command: '/tab tools' },
    { label: '待处理请求', command: '/tab pending' },
  ],
  advanced: [
    { label: '修改名称', command: '/tab menu rename' },
    { label: '附加指令', command: '/tab instructions' },
    { label: '持续任务与终端', command: '/tab menu maintenance' },
  ],
  maintenance: [
    { label: '持续任务管理', command: '/tab loops' },
    { label: '原生终端交接', command: '/tab menu terminal' },
    { label: '常用设置', command: '/tab menu controls' },
    { label: '会话状态', command: '/tab status' },
  ],
  research: [
    { label: '交付与经验', command: '/tab menu delivery' },
    { label: '持续任务管理', command: '/tab loops' },
    { label: '会话状态', command: '/tab status' },
  ],
  delivery: [
    { label: '本任务分支', command: '/tab topics' },
    { label: '本任务交付报告', command: '/tab report' },
    { label: '可复用经验', command: '/tab experience' },
  ],
};
export const adminMenuButtons: ManagementButton[] = [
  { label: '会话列表', command: '/tab list' },
  { label: '目标详情', command: '/tab admin select status' },
  { label: '停止目标任务', command: '/tab admin select stop' },
  { label: '结束／恢复', command: '/tab admin select lifecycle' },
];
export const adminMenuPages: Record<string, ManagementButton[]> = {
  more: [
    { label: '会话概览', command: '/tab sessions' },
    { label: '目标历史与工具', command: '/tab admin select records' },
    { label: '新建会话／任务', command: '/tab admin create' },
    { label: '任务与权限', command: '/tab admin system' },
  ],
  system: [
    { label: '任务树管理', command: '/tab tasks' },
    { label: '机器人与权限', command: '/tab bots' },
    { label: '管理命令说明', command: '/tab help' },
  ],
};
export function managementView(
  action: string,
  text: string,
  session?: Session,
  extra?: ManagementButton[],
  adminAvailable = true,
): ManagementView {
  const button = (label: string, command: string, mutation = false): ManagementButton => ({
    label,
    command,
    ...(mutation ? { mutation: true } : {}),
  });
  const scope = managementScope(action, adminAvailable),
    home = action === 'menu' || action === 'admin';
  const buttons = (
    extra ??
    (action === 'instructions'
      ? [button('刷新信息', '/tab instructions')]
      : scope === 'admin'
        ? adminMenuButtons
        : action === 'status' && session
          ? [
              sessionLifecycleButton(session),
              { label: '刷新状态', command: '/tab status' },
              ...(session.pendingInitialTask !== undefined &&
              !session.nativeId &&
              session.status === 'idle'
                ? [button('开始首个任务', '/tab begin', true)]
                : []),
            ]
          : commonSessionButtons(session))
  ).filter((b) => adminAvailable || !adminOnlyAction(b.command.split(/\s+/)[1] ?? ''));
  const navigation = {
    label: home
      ? scope === 'admin'
        ? '更多管理'
        : buttons.some((b) => b.group === 'secondary')
          ? '刷新信息'
          : '更多本会话'
      : scope === 'admin'
        ? '返回管理中心'
        : '返回本会话',
    command: home
      ? scope === 'admin'
        ? '/tab admin more'
        : buttons.some((b) => b.group === 'secondary')
          ? '/tab menu'
          : '/tab menu more'
      : scope === 'admin'
        ? '/tab admin'
        : '/tab menu',
  };
  return {
    action,
    ...(scope === 'session' && session ? { information: sessionInformation(session) } : {}),
    title: `${scope === 'admin' ? '会话管理中心' : '本会话设置'}${home ? '' : ` · ${titles[action] ?? '管理结果'}`}`,
    text,
    buttons,
    scope,
    navigation,
    ...(session
      ? {
          session: {
            id: session.id,
            updatedAt: session.updatedAt,
            version: managementRevision(session),
          },
        }
      : {}),
    ...(action === 'instructions' && session ? { overview: instructionsOverview(session) } : {}),
  };
}
export function managementText(view: ManagementView): string {
  const buttons = managementActions(view);
  const information = view.information
    ? `会话信息\n${view.information.name} · ${view.information.status}\n${[...view.information.fields, ...view.information.details].map((f) => `${f.label}：${f.value}`).join('\n')}\n\n会话管理\n`
    : '';
  return `${view.title}\n\n${information}${view.text}${buttons.length ? '\n\n可用操作（复制命令发送）：\n' + buttons.map((b) => `${b.label}：${b.command}`).join('\n') : ''}\n\n项目 GitHub：${PROJECT_URL}`;
}
