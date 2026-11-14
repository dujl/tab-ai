import type { Interaction } from '../core/types.js';
import { sameWorkspace } from '../core/session-workspace.js';

const labels: Record<string, string> = {
  sessionPermissionRules: '本会话授权规则',
  command: '执行命令',
  cwd: '本次执行目录',
  reason: '申请原因',
  description: '操作说明',
  additionalPermissions: '额外权限',
  networkApprovalContext: '网络访问',
  grantRoot: '授权目录',
  changes: '文件修改',
  file_path: '文件路径',
  old_string: '原内容',
  new_string: '新内容',
  content: '内容',
  timeout: '超时设置',
  permission: '权限类型',
  patterns: '授权匹配范围',
  metadata: '原生工具信息',
};
function readable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '未提供';
  if (Array.isArray(value)) return value.map((v) => `- ${readable(v)}`).join('\n');
  if (typeof value === 'object')
    return Object.entries(value)
      .map(([k, v]) => `${labels[k] ?? k}：${readable(v)}`)
      .join('\n');
  return String(value);
}
const compact = (value: string, max = 180) => {
  const chars = Array.from(value.replace(/\s+/g, ' ').trim());
  return chars.slice(0, max).join('') + (chars.length > max ? '…（完整内容见详情）' : '');
};

// A small, conservative lexer for presentation, never an executable shell parser.
// Only unwrap a shell when its entire argv is a known `shell -c SCRIPT` shape.
// Operators, substitutions and redirects keep the request marked as complex.
function words(command: string): { argv: string[]; complex: boolean } {
  const argv: string[] = [];
  let word = '',
    quote = '',
    started = false,
    complex = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (c === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined) {
        complex = true;
        break;
      }
      // In double quotes the shell only removes these particular escapes.
      word += quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next) ? '\\' + next : next;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else {
        word += c;
        if (c === '$' || c === '`') complex = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        argv.push(word);
        word = '';
        started = false;
      }
      if (c === '\n') complex = true;
      continue;
    }
    if (/[;&|<>$`()*?{}]/.test(c)) complex = true;
    word += c;
    started = true;
  }
  if (started) argv.push(word);
  return { argv, complex: complex || !!quote };
}
function commandSummary(command: string): {
  operation: string;
  caution?: string;
  executors: string;
} {
  let parsed = words(command),
    shells: string[] = [];
  for (let depth = 0; depth < 3; depth++) {
    const exe = parsed.argv[0]?.split('/').at(-1) ?? '';
    if (
      !['sh', 'bash', 'zsh', 'dash', 'fish'].includes(exe) ||
      parsed.complex ||
      parsed.argv.length !== 3 ||
      !/^-[a-z]*c[a-z]*$/.test(parsed.argv[1] ?? '')
    )
      break;
    shells.push(exe);
    parsed = words(parsed.argv[2]!);
  }
  const exe = parsed.argv[0]?.split('/').at(-1) ?? '';
  const executors = [...shells, /^[\w.+-]+$/.test(exe) ? compact(exe, 60) : '未识别执行器'].join(
    ' → ',
  );
  const inline =
    /^(?:python(?:\d(?:\.\d+)?)?|node|ruby|perl)$/.test(exe) &&
    parsed.argv.some((arg) => arg === '-c' || arg === '-e');
  if (inline && !parsed.complex) {
    const flag = parsed.argv.findIndex((arg) => arg === '-c' || arg === '-e');
    const lines = (parsed.argv[flag + 1] ?? '').split('\n').length;
    const name = exe.startsWith('python') ? 'Python' : exe === 'node' ? 'Node.js' : exe;
    return {
      operation: `执行 ${name} 内联脚本（${lines} 行）`,
      executors,
      caution: '脚本摘要仅识别执行器；具体操作请核对完整请求。',
    };
  }
  const operations: Record<string, string> = {
    ls: '列出目录内容',
    cat: '读取文件内容',
    pwd: '查看当前工作目录',
    rg: '搜索文本或文件',
    grep: '搜索文本',
    rm: '删除文件或目录',
    mv: '移动或重命名文件',
    cp: '复制文件',
    mkdir: '创建目录',
    curl: '执行 curl 网络命令',
    wget: '执行 wget 网络命令',
    git: '执行 Git 命令',
    sed: '执行 sed 文本处理',
    python: '执行 Python 程序',
    python3: '执行 Python 程序',
    node: '执行 Node.js 程序',
  };
  return {
    operation: parsed.complex
      ? '执行复合命令或脚本'
      : (operations[exe] ?? `执行 ${/^[\w.+-]+$/.test(exe) ? compact(exe, 60) : '工具命令'}`),
    executors,
    ...(parsed.complex
      ? { caution: '包含 shell 语法，摘要无法代表全部操作；请核对完整请求。' }
      : {}),
  };
}

// Presentation only: the native approval request and the decision are never rewritten.
// Suppress Codex transport bookkeeping and alternative (persistent) approval choices.
const codexMetadata = new Set([
  'kind',
  'threadId',
  'turnId',
  'itemId',
  'startedAtMs',
  'environmentId',
  'approvalId',
  'commandActions',
  'availableDecisions',
  'proposedExecpolicyAmendment',
  'proposedNetworkPolicyAmendments',
]);
export function approvalPresentation(
  params: unknown,
  workspace: string,
  codex = false,
  commandExpected = false,
  tool?: string,
): Pick<Interaction, 'detail' | 'approvalSections' | 'approvalSummary'> {
  const data =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : { request: params };
  const sections: NonNullable<Interaction['approvalSections']> = [];
  if (typeof data.command === 'string' && data.command.length)
    sections.push({ label: labels.command!, value: data.command });
  else if (commandExpected || (codex && data.kind === 'command'))
    sections.push({
      label: labels.command!,
      value: 'Agent 未提供具体命令；请拒绝并在原生终端确认。',
    });
  const executionCwd = typeof data.cwd === 'string' && data.cwd ? data.cwd : undefined;
  const differentDirectory =
    !!executionCwd && executionCwd !== workspace && !sameWorkspace(executionCwd, workspace);
  sections.push(
    { label: labels.cwd!, value: executionCwd ?? '原生未单独提供' },
    { label: '会话默认目录', value: workspace },
  );
  for (const key of ['reason', 'description'])
    if (data[key] != null && data[key] !== '')
      sections.push({ label: labels[key]!, value: readable(data[key]) });
  for (const [key, value] of Object.entries(data)) {
    if (
      ['cwd', 'reason', 'description'].includes(key) ||
      (key === 'command' && typeof value === 'string') ||
      (codex && codexMetadata.has(key)) ||
      value == null
    )
      continue;
    sections.push({ label: labels[key] ?? key, value: readable(value) });
  }
  const facts = [
    { label: labels.cwd!, value: compact(executionCwd ?? '原生未单独提供', 240) },
    { label: '会话默认目录', value: compact(workspace, 240) },
  ];
  let operation = tool ? `调用 ${compact(tool, 60)}` : '执行原生工具操作',
    caution: string | undefined;
  const command = typeof data.command === 'string' ? data.command : undefined;
  if (command) {
    const summary = commandSummary(command);
    operation = summary.operation;
    caution = summary.caution;
    facts.push({ label: '执行器', value: summary.executors });
    const hosts = new Set<string>();
    let urls = 0;
    for (const match of command.matchAll(/https?:\/\/[^\s'"<>\\]+/g)) {
      try {
        const url = new URL(match[0]);
        hosts.add(url.hostname);
        urls++;
      } catch {
        /* Not a literal URL. */
      }
    }
    if (hosts.size)
      facts.push({ label: '命令含网址', value: compact(`${urls} 处 · ${[...hosts].join('、')}`) });
    if (!caution && command.length < 140 && !command.includes('\n'))
      facts.push({ label: '命令预览', value: command });
  } else if (commandExpected) {
    operation = '未提供具体命令';
    caution = '请拒绝并在原生终端确认。';
  } else if (typeof data.file_path === 'string') {
    operation = tool === 'Read' ? '读取文件' : '操作文件';
    facts.push({ label: '文件路径', value: compact(data.file_path) });
  } else if (data.changes) operation = '修改文件';
  const directoryNote = differentDirectory
    ? '本次工具指定了与会话默认目录不同的执行目录；批准将沿用原生请求的目录，不会修改会话设置。'
    : !executionCwd
      ? '原生未提供本次工具执行目录；会话默认目录仅供参考，不能据此确认工具的实际执行目录。'
      : undefined;
  caution = [directoryNote, caution].filter(Boolean).join('\n') || undefined;
  // Native declarations remain explicitly attributed; these are not a model's safety assessment.
  for (const section of sections) {
    if (
      [labels.cwd!, '会话默认目录', '执行命令', '原内容', '新内容', '内容'].includes(
        section.label,
      ) ||
      (section.label === '文件路径' && typeof data.file_path === 'string')
    )
      continue;
    facts.push({
      label:
        section.label === '申请原因' || section.label === '操作说明'
          ? `Agent ${section.label}`
          : section.label,
      value: compact(section.value),
    });
  }
  const priorities = ['额外权限', '网络访问', '授权目录', '权限类型', '授权匹配范围'];
  const primary = facts.filter(
    (f) => [labels.cwd!, '会话默认目录'].includes(f.label) || priorities.includes(f.label),
  );
  const secondary = facts.filter((f) => !primary.includes(f));
  const visibleFacts = [...primary, ...secondary].slice(0, 10);
  if (facts.length > visibleFacts.length)
    visibleFacts.push({
      label: '其他参数',
      value: `${facts.length - visibleFacts.length} 项，查看完整请求。`,
    });
  return {
    approvalSections: sections,
    approvalSummary: { operation, facts: visibleFacts, ...(caution ? { caution } : {}) },
    detail: sections.map((s) => `${s.label}\n${s.value}`).join('\n\n'),
  };
}
