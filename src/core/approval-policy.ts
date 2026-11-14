import type { AgentKind, Session } from './types.js';

// An explicit `native` opts out of the framework default for this session.
export function selectedApprovalPolicy(session: Pick<Session, 'agent' | 'approvalPolicy'>): string {
  return session.approvalPolicy ?? (session.agent === 'codex' ? 'on-request' : 'native');
}
export function nativeApprovalPolicy(
  session: Pick<Session, 'agent' | 'approvalPolicy'>,
): string | undefined {
  const mode = selectedApprovalPolicy(session);
  if (session.agent === 'codex' && mode === 'on-request-auto-review') return 'on-request';
  return mode === 'native' ? undefined : mode;
}
export function nativeApprovalReviewer(session: Pick<Session, 'agent' | 'approvalPolicy'>) {
  if (session.agent !== 'codex' || selectedApprovalPolicy(session) === 'native') return undefined;
  return session.approvalPolicy === 'on-request-auto-review'
    ? ('auto_review' as const)
    : ('user' as const);
}
export function approvalModes(agent: AgentKind) {
  const native = {
    id: 'native',
    label: '沿用原生配置',
    description: '不覆盖原生 Agent 的审批设置，实际行为由原生配置及组织要求决定。',
  };
  if (agent === 'codex')
    return [
      native,
      {
        id: 'untrusted',
        label: '审慎审批：不可信命令需确认',
        description:
          '由 Codex 判断可信命令，其余命令申请审批；不是所有工具每次必问。本机协议支持此策略，其他版本可能不支持。',
      },
      {
        id: 'on-request',
        label: '由 Codex 按需申请审批',
        description: 'Codex 在需要额外权限时申请审批；已获准范围内的操作直接执行。',
      },
      {
        id: 'on-request-auto-review',
        label: '按需审批 · 原生自动审查',
        description:
          '本会话的额外权限申请由 Codex 原生自动审查，按风险与用户授权批准或拒绝，减少人工确认；不是全部允许。可能增加模型用量，需原生版本支持。',
      },
      {
        id: 'never',
        label: '不询问：权限不足时不批准',
        description:
          '不弹出工具权限审批；超出现有权限的操作不能通过询问获得批准。不是允许所有，也不扩大沙箱权限。',
      },
    ];
  if (agent === 'claude')
    return [
      native,
      {
        id: 'default',
        label: '原生默认审批',
        description: '由 Claude Code 的原生权限规则判断是否需要确认。',
      },
      {
        id: 'acceptEdits',
        label: '自动允许文件编辑',
        description: '原生自动批准文件编辑，其他工具仍按权限规则处理。',
      },
      {
        id: 'dontAsk',
        label: '不询问：未预授权则拒绝',
        description: '未预先授权的操作拒绝执行，不代表允许所有工具。',
      },
    ];
  return [native];
}

// A request snapshot, not a promise that inherited native settings are known.
export function approvalPolicyContext(
  agent: AgentKind,
  policy: unknown,
  reported = false,
): { label: string; description: string } {
  const mode = approvalModes(agent).find((m) => m.id === (policy ?? 'native'));
  if (mode)
    return {
      label: mode.label,
      description: (reported ? '原生当前生效策略。' : '本会话设置。') + mode.description,
    };
  if (agent === 'codex' && policy && typeof policy === 'object' && 'granular' in policy) {
    const granular = (policy as { granular: unknown }).granular;
    if (granular && typeof granular === 'object') {
      const names: Record<string, string> = {
        sandbox_approval: '沙箱权限',
        rules: '规则触发',
        mcp_elicitations: 'MCP 确认',
        request_permissions: '权限申请',
        skill_approval: '技能审批',
      };
      const categories = Object.entries(names)
        .filter(([key]) => typeof (granular as Record<string, unknown>)[key] === 'boolean')
        .map(
          ([key, label]) =>
            `${label}：${(granular as Record<string, unknown>)[key] ? '可询问' : '不询问并拒绝'}`,
        );
      return {
        label: '原生分类审批',
        description: categories.length
          ? categories.join('；')
          : '原生返回分类策略；具体范围由原生权限规则决定。',
      };
    }
  }
  return {
    label: '原生自定义策略',
    description: '由原生 Agent 的权限规则处理，框架未将此策略映射为可编辑模式。',
  };
}
