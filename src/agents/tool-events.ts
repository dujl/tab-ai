import type { ToolActivity } from '../core/types.js';

export const toolText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value == null
      ? ''
      : JSON.stringify(
          value,
          (_key, entry) => {
            if (entry && typeof entry === 'object' && ['image', 'audio'].includes(entry.type))
              return { type: entry.type, content: '二进制内容省略' };
            if (typeof entry === 'string' && entry.startsWith('data:'))
              return '[内嵌二进制内容省略]';
            return entry;
          },
          2,
        );
const object = (v: unknown): Record<string, any> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
export function codexTool(value: unknown, done: boolean): ToolActivity | undefined {
  const item = object(value);
  if (!item || typeof item.id !== 'string') return;
  let name: string, input: unknown, output: unknown;
  switch (item.type) {
    case 'commandExecution':
      name = '执行命令';
      input = [item.command, item.cwd ? `工作目录：${item.cwd}` : ''].filter(Boolean).join('\n');
      output = item.aggregatedOutput;
      break;
    case 'fileChange':
      name = '修改文件';
      input = Array.isArray(item.changes) ? item.changes.map((c: any) => c.path).join('\n') : '';
      output = item.changes;
      break;
    case 'mcpToolCall':
      name = `${item.server ?? 'MCP'} / ${item.tool ?? '工具'}`;
      input = item.arguments;
      output = item.error ?? item.result;
      break;
    case 'dynamicToolCall':
      name = item.tool ?? '调用工具';
      input = item.arguments;
      output = item.contentItems;
      break;
    case 'webSearch':
      name = '搜索网页';
      input = item.query ?? item.action;
      output = item.action;
      break;
    case 'imageView':
      name = '查看图片';
      input = item.path;
      break;
    case 'imageGeneration':
      name = '生成图片';
      input = item.revisedPrompt;
      break;
    case 'collabAgentToolCall':
      name = '调用子 Agent';
      input = item.prompt ?? item.tool;
      output = item.agentsStates;
      break;
    default:
      return;
  }
  return {
    id: item.id,
    name,
    status: done
      ? ['failed', 'declined'].includes(item.status) ||
        item.success === false ||
        item.error ||
        (typeof item.exitCode === 'number' && item.exitCode !== 0)
        ? 'failed'
        : 'completed'
      : 'running',
    input: toolText(input),
    ...(output != null ? { output: toolText(output) } : {}),
    ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
  };
}
export function openCodeTool(
  value: unknown,
): { sessionId: string; event: ToolActivity } | undefined {
  const part = object(value),
    state = object(part?.state);
  if (
    !part ||
    part.type !== 'tool' ||
    !state ||
    typeof part.sessionID !== 'string' ||
    typeof part.callID !== 'string' ||
    typeof part.tool !== 'string'
  )
    return;
  if (!['pending', 'running', 'completed', 'error'].includes(state.status)) return;
  return {
    sessionId: part.sessionID,
    event: {
      id: `${part.sessionID}:${part.callID}`,
      name: part.tool,
      input: toolText(object(state.input)?.command ?? state.input),
      status:
        state.status === 'completed'
          ? 'completed'
          : state.status === 'error'
            ? 'failed'
            : 'running',
      ...(state.output != null || state.error != null
        ? { output: toolText(state.error ?? state.output) }
        : {}),
    },
  };
}

function acpContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const entry = object(item);
    if (!entry) continue;
    if (entry.type === 'text' && typeof entry.text === 'string') parts.push(entry.text);
    else if (entry.type === 'content') {
      const inner = object(entry.content);
      if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text);
    } else if (entry.type === 'diff' && typeof entry.path === 'string')
      parts.push(`diff: ${entry.path}`);
  }
  return parts.length ? parts.join('\n') : undefined;
}

export function acpTool(
  value: unknown,
  prior?: { name: string; input?: string },
): ToolActivity | undefined {
  const update = object(value);
  if (!update || typeof update.toolCallId !== 'string') return;
  const kindNames: Record<string, string> = {
    read: '读取文件',
    edit: '修改文件',
    delete: '删除文件',
    move: '移动文件',
    search: '搜索内容',
    execute: '执行命令',
    think: '推理分析',
    fetch: '网络请求',
    other: '调用工具',
  };
  const name =
    (typeof update.title === 'string' && update.title.trim()) ||
    prior?.name ||
    (typeof update.kind === 'string' ? (kindNames[update.kind] ?? update.kind) : '调用工具');
  const rawInput = object(update.rawInput);
  const input =
    update.rawInput !== undefined
      ? toolText(rawInput?.command ?? rawInput?.CommandLine ?? update.rawInput)
      : prior?.input;
  const rawOutput = object(update.rawOutput);
  const exitCode =
    typeof rawOutput?.exitCode === 'number'
      ? rawOutput.exitCode
      : typeof rawOutput?.exit_code === 'number'
        ? rawOutput.exit_code
        : undefined;
  const output =
    update.rawOutput !== undefined ? toolText(update.rawOutput) : acpContentText(update.content);
  const status: ToolActivity['status'] =
    update.status === 'completed'
      ? exitCode !== undefined && exitCode !== 0
        ? 'failed'
        : 'completed'
      : update.status === 'failed' || update.status === 'error'
        ? 'failed'
        : update.status === 'cancelled'
          ? 'interrupted'
          : 'running';
  return {
    id: update.toolCallId,
    name,
    status,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}
