import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function sameWorkspace(actual: string, expected: string): boolean {
  try {
    return realpathSync(actual) === realpathSync(expected);
  } catch {
    return false;
  }
}

export function customWorkspace(value: string): string {
  const input = value.trim();
  if (!input || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input))
    throw new Error('工作目录格式无效，请填写本机目录路径。');
  const path =
    input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(path)) throw new Error('请填写绝对路径或 ~/ 开头的目录。');
  try {
    const workspace = realpathSync(path);
    if (!statSync(workspace).isDirectory()) throw new Error();
    accessSync(workspace, constants.R_OK | constants.X_OK);
    return workspace;
  } catch {
    throw new Error(
      '工作目录不存在、不是文件夹或无法访问。请先在运行 tab-ai 的机器上创建目录，再保存。',
    );
  }
}

export function sessionWorkspace(value: string, presets: Record<string, string>): string {
  if (Object.hasOwn(presets, value)) {
    const path = presets[value]!;
    const resolved = customWorkspace(path);
    if (resolved !== path) throw new Error('预设工作目录路径已变更，请检查本机工作区配置。');
    return resolved;
  }
  if (isAbsolute(value) || value === '~' || value.startsWith('~/')) return customWorkspace(value);
  throw new Error(
    '工作区不存在。请填写已配置的工作区别名，或绝对路径、~/ 开头的目录；未创建会话。',
  );
}
