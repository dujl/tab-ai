export const sessionControlActions = ['session_menu', 'session_close', 'session_open'] as const;
export function sessionControlCommand(action: string): string | undefined {
  if (action === 'session_menu') return '/tab menu';
  if (action === 'session_close') return '/tab close';
  if (action === 'session_open') return '/tab open';
  return undefined;
}

// Whole-message requests only. Discussion, quotes, negation and compound tasks
// must not accidentally close a session just because they mention this feature.
export function recognizeSessionControl(text: string): string | undefined {
  const value = text
    .trim()
    .replace(/[。.!！]$/, '')
    .trim();
  const prefix = '(?:(?:请帮我|请|帮我|麻烦你?)\\s*)?';
  const target = '(?:(?:当前|这个|本)(?:的)?\\s*)?(?:会话|session)';
  if (
    new RegExp(
      `^${prefix}(?:打开|显示|查看|调出|进入)\\s*${target}\\s*(?:管理|设置)(?:菜单|卡片|面板)?$`,
      'i',
    ).test(value)
  )
    return '/tab menu';
  if (new RegExp(`^${prefix}(?:关闭|结束)\\s*${target}$`, 'i').test(value)) return '/tab close';
  if (new RegExp(`^${prefix}(?:打开|恢复|重新打开)\\s*${target}$`, 'i').test(value))
    return '/tab open';
  return undefined;
}
