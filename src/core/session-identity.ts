import { agentNames, type Session } from './types.js';
import { agentInstructions, channelInstructions } from './channel-instructions.js';

const shellArg = (value: string) =>
  /^[a-zA-Z0-9_-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function sessionIdentity(session: Session): string {
  const agent = agentNames[session.agent];
  const lines = [
    `${agent} 原生 ID：${session.nativeId ?? '尚未启动，首次启动后自动显示'}`,
    `tab-ai 管理 ID：${session.id}`,
  ];
  lines.push(
    `附加指令：${session.instructions ? `已设置（${session.instructions.length} 字符），首次任务开始后固定；/tab instructions 查看` : '未设置，沿用原生指令'}`,
  );
  if (channelInstructions(session))
    lines.push('通道背景：自动附加当前聊天平台背景；/tab instructions 查看。');
  if (session.nativeId) {
    const settings = session.settings;
    const agyMode =
      session.agent === 'agy' &&
      session.approvalPolicy &&
      ['accept-edits', 'auto', 'plan'].includes(session.approvalPolicy)
        ? ` --mode ${shellArg(session.approvalPolicy)}`
        : '';
    const options =
      (settings
        ? ` --model ${shellArg(settings.model)}${session.agent === 'traecli' && settings.provider ? ` -c ${shellArg(`model_provider=${JSON.stringify(settings.provider)}`)}` : ''}${settings.effort && session.agent !== 'opencode' ? (session.agent === 'codex' || session.agent === 'traecli' ? ` -c ${shellArg(`model_reasoning_effort=${JSON.stringify(settings.effort)}`)}` : ` --effort ${shellArg(settings.effort)}`) : ''}`
        : '') + agyMode;
    if (agentInstructions(session))
      lines.push(
        session.agent === 'opencode'
          ? '此会话的通道背景和附加指令由 tab-ai 逐轮传入；请在 tab-ai 中恢复以保持一致。'
          : session.agent === 'agy'
            ? '此会话的通道背景和附加指令通过 ACP 附加系统提示传入；当前原生终端无等价参数，请在 tab-ai 中恢复以保持一致。'
            : `保持附加指令的终端恢复：tab-ai native ${session.id}`,
      );
    else
      lines.push(
        `本机原生恢复：${session.agent === 'codex' || session.agent === 'traecli' ? `${session.agent} resume` : session.agent === 'claude' ? 'claude --resume' : session.agent === 'agy' ? 'agy --resume' : 'opencode --session'} ${shellArg(session.nativeId)}${session.agent === 'codex' || session.agent === 'traecli' ? ` --cd ${shellArg(session.workspace)}` : ''}${options}`,
      );
    if (session.agent === 'opencode' && session.settings?.effort)
      lines.push(
        'OpenCode 原生终端的思考档位请在终端中确认；此版本 CLI 未提供 TUI 的 --variant 参数。',
      );
    lines.push('在此工作区、同一本机用户和原生配置下运行；会话运行中须先停止任务并交还原生终端。');
  }
  return lines.join('\n');
}
