import type { GroupPermission } from './group-mode.js';
export type Platform = 'lark' | 'dingtalk' | 'wecom' | 'wechat' | 'local';
export type AgentKind = 'codex' | 'claude' | 'opencode';
export const agentNames: Record<AgentKind, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
};
export function agentKind(name: string): AgentKind {
  const normalized = name.toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'codex' || normalized === 'opencode') return normalized;
  if (normalized === 'claude' || normalized === 'claudecode') return 'claude';
  throw new Error(
    `不支持指定的 Agent「${name}」。可选 codex / claude / opencode；未创建会话，也不会改用默认 Agent。`,
  );
}
export interface Route {
  platform: Platform;
  account: string;
  conversation: string;
  thread: string;
  sender: string;
}
export interface Incoming {
  id: string;
  route: Route;
  text: string;
  receivedAt?: number;
  // Server-issued navigation context; never accepted from transport payloads.
  managementOrigin?: string;
  // Metadata for a historical resource, relative to this request's history snapshot.
  attachmentContext?: { sentAt: number; messagesBefore: number };
  // Transport metadata is used for routing, not automatically injected.
  groupMessage?: { mentioned: boolean };
  replyTo?: string;
  direct?: boolean;
  unresolvedQuote?: boolean;
  sessionAnchor?: boolean;
  topicUpdateId?: string;
  topicReportRequested?: boolean;
  ownedTopicRoot?: string;
  attachments?: AttachmentRef[];
  requiresExistingSession?: boolean;
}
export interface AttachmentRef {
  key: string;
  name: string;
  type: 'file' | 'image';
  sourceId?: string;
}
export interface LocalAttachment {
  name: string;
  path: string;
  size: number;
  messageId: string;
  key?: string;
}
export interface Session {
  id: string;
  routeKey: string;
  route: Route;
  agent: AgentKind;
  workspace: string;
  nativeId?: string;
  ownedTopicRoot?: string;
  title?: string;
  // Per-session additions, editable only before the first task; never user text.
  instructions?: string;
  channelContext?: {
    conversationType?: 'direct' | 'group';
    botName?: string;
    domain?: 'feishu' | 'lark';
  };
  pendingInitialTask?: string;
  taskId?: string;
  topicReportsPaused?: boolean;
  // Immediate logical parent; platform threads themselves may remain flat.
  parentSessionId?: string;
  creationKey?: string;
  // Group-topic parent used when parentSessionId is absent.
  topicParentId?: string;
  topicObjective?: string;
  topicCriteria?: string;
  topicReport?: {
    revision: number;
    at: number;
    result: import('./topic-control.js').TopicReport;
    reason?: import('./topic-control.js').TopicReportReason;
  };
  topicProgress?: {
    revision: number;
    at: number;
    result: import('./topic-control.js').TopicReport;
  };
  topicCompleted?: boolean;
  pendingAttachments?: LocalAttachment[];
  pendingAttachmentRequest?: {
    text: string;
    at: number;
    options: { messageId: string; key?: string; sourceId?: string; name: string }[];
  };
  codexDeveloperInstructions?: string;
  codexTaskTools?: 'dynamic' | 'mcp';
  taskToolsEnabled?: boolean;
  imEntry?: { state: 'pending' | 'unknown'; detail: string };
  approvalPolicy?: string;
  settings?: AgentSettings;
  settingsRevision?: number;
  status: 'idle' | 'running' | 'waiting' | 'interrupted' | 'error' | 'detached' | 'closed';
  operation?: 'compact';
  tokenUsage?: NativeUsageSnapshot;
  contextUsageInvalidated?: boolean;
  lastCompactionTokens?: { nativeId: string; before?: number; after?: number; at: number };
  createdAt: number;
  updatedAt: number;
}
export interface Question {
  id: string;
  question: string;
  options?: string[];
  descriptions?: string[];
  multiSelect?: boolean;
  allowOther?: boolean;
  optional?: boolean;
  inputSchema?: import('./mcp-elicitation.js').ElicitationField;
}
export interface Interaction {
  id: string;
  sessionId: string;
  kind: 'approval' | 'question';
  title: string;
  detail: string;
  approvalOptions?: {
    id: import('./approval-decisions.js').ApprovalAction;
    label: string;
    description?: string;
  }[];
  approvalContext?: { label: string; description: string };
  approvalSections?: { label: string; value: string }[];
  approvalSummary?: {
    operation: string;
    facts: { label: string; value: string }[];
    caution?: string;
  };
  questions?: Question[];
  elicitation?: { serverName: string; mode: 'form' | 'url'; url?: string };
  mode?: 'async';
  createdAt: number;
  expiresAt?: number;
}
export interface InteractionDelivery {
  close(status: string): Promise<void>;
}
export type Answer =
  | { allow: boolean; scope?: 'once' | 'session'; cancel?: boolean }
  | { answers: Record<string, string[]>; action?: 'accept' | 'decline' | 'cancel' };
export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  input?: string;
  output?: string;
  exitCode?: number;
}
export interface ToolRunView {
  id: string;
  agent: AgentKind;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  tools: ToolActivity[];
  total: number;
}
export interface AgentHooks {
  nativeId(id: string): void;
  text(text: string): void;
  activity(text: string): void;
  usage?(value: AgentUsage): void;
  tool?(event: ToolActivity): void;
  plan?(value: AgentPlan): void;
  capabilities?(value: { plans: boolean }): void;
  ask(
    request: Omit<Interaction, 'id' | 'sessionId' | 'createdAt'>,
    signal: AbortSignal,
  ): Promise<Answer>;
  askAsync?(request: Omit<Interaction, 'id' | 'sessionId' | 'createdAt'>): void;
}
export interface AgentPlan {
  source: AgentKind;
  nativeTurnId?: string;
  explanation?: string;
  steps: {
    id?: string;
    text: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  }[];
}
export interface AgentRun {
  session: Session;
  text: string;
  signal: AbortSignal;
  hooks: AgentHooks;
  taskBridge?: { url: string; token: string };
  priorPlan?: AgentPlan;
}
export interface AgentAdapter {
  historicalUsage?(session: Session): NativeUsageSnapshot | undefined;
  supportsPlans?: boolean;
  requiresPlanDiscovery?: boolean;
  release?(sessionId: string): Promise<void>;
  close?(): Promise<void>;
  supportsWorkspaceSwitch?: boolean;
  run(input: AgentRun): Promise<void>;
  resumeCommand(session: Session): string[];
  models?(session: Session, signal: AbortSignal): Promise<AgentModel[]>;
  steer?(session: Session, text: string, signal: AbortSignal): Promise<boolean>;
  compact?(session: Session, signal: AbortSignal): Promise<CompactionResult>;
  loops?(session: Session, signal: AbortSignal): Promise<NativeLoop[]>;
  stopLoop?(session: Session, id: string, signal: AbortSignal): Promise<{ wasActive: boolean }>;
}
export interface NativeUsageSnapshot {
  nativeId: string;
  at: number;
  value: AgentUsage;
  origin?: 'native-history';
  compactedAt?: number;
  contextInvalidated?: boolean;
}
export interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
}
export interface AgentUsage {
  source: AgentKind;
  last?: TokenBreakdown;
  total?: TokenBreakdown;
  totalScope?: 'session' | 'query';
  contextTokens?: number;
  modelContextWindow?: number;
  contextKind?: 'native' | 'last-call';
}
export interface CompactionResult {
  compacted: boolean;
  detail?: string;
  usage?: AgentUsage;
  contextBefore?: number;
}
export interface NativeLoop {
  id: string;
  label: string;
  status: string;
  detail: string;
}
export interface AgentSettings {
  model: string;
  effort?: string;
}
export interface AgentModel {
  id: string;
  label: string;
  efforts: { id: string; label: string }[];
  defaultEffort?: string;
}
export interface SettingsView {
  state: 'unloaded' | 'loading' | 'ready' | 'error';
  models: AgentModel[];
  error?: string;
}
export type SessionAction =
  | 'close'
  | 'open'
  | 'status'
  | 'history'
  | 'settings'
  | 'model'
  | 'effort'
  | 'save_settings'
  | 'cancel_settings'
  | 'save_instructions'
  | 'save_initial'
  | 'start_initial';
export interface SessionCardRecord {
  id: string;
  sessionId: string;
  messageId?: string;
  delivery: 'new' | 'sending' | 'sent' | 'unknown';
  revision: number;
  view: 'status' | 'history' | 'settings';
  draftSettings?: AgentSettings;
  draftSettingsRevision?: number;
}
export interface SessionCardView {
  information?: SessionInformation;
  card: SessionCardRecord;
  session: Session;
  active: boolean;
  current: boolean;
  events: { type: string; text: string; at: number }[];
  settings?: SettingsView;
  instructionsEditable?: boolean;
  pendingCount?: number;
  taskBoard?: import('./task-model.js').TaskBoard;
  workspaces?: { alias: string; path: string }[];
}
export interface SessionCardClick {
  id: string;
  revision: number;
  action: SessionAction;
  sender: string;
  conversation: string;
  messageId: string;
  selection?: string;
  instructions?: string;
  workspace?: string;
  workspacePath?: string;
}
export interface GroupReference {
  sender: string;
  text: string;
  at: number;
}
export interface ManagementButton {
  label: string;
  command: string;
  mutation?: boolean;
  group?: 'urgent' | 'secondary';
  disabledReason?: string;
}
export interface SessionInformation {
  name: string;
  status: string;
  fields: { label: string; value: string; shortValue?: string }[];
  details: { label: string; value: string }[];
}
export interface ManagementView {
  action?: string;
  tone?: 'blue' | 'green' | 'orange' | 'red' | 'grey';
  information?: SessionInformation;
  workspaceEditor?: { current: string };
  renameEditor?: { current: string };
  title: string;
  text: string;
  buttons: ManagementButton[];
  // Compact native-card overview; text remains the complete, unabridged detail.
  authorization?: GroupPermission;
  overview?: { summary: string; facts: { label: string; value: string }[]; detailLabel?: string };
  scope?: 'session' | 'admin';
  navigation?: ManagementButton;
  session?: { id: string; updatedAt: number; version: string };
}
export type ManagementHandler = (
  message: Incoming,
  expected: ManagementView['session'],
  mutation: boolean,
  scope?: ManagementView['scope'],
) => Promise<void>;
export interface Channel {
  id: string;
  platform: Platform;
  start(onMessage: (message: Incoming) => Promise<void>): Promise<void>;
  send(message: Incoming, text: string): Promise<void>;
  checkGroupPermission?(chatId: string): Promise<GroupPermission>;
  sendManagement?(message: Incoming, view: ManagementView): Promise<void>;
  sendManagementFallback?(message: Incoming, text: string): Promise<void>;
  onManagementAction?(
    handler: ManagementHandler,
    authorize?: (message: Incoming, scope?: ManagementView['scope']) => boolean,
  ): void;
  downloadAttachments?(message: Incoming, session: Session): Promise<LocalAttachment[]>;
  recentAttachments?(session: Session): Promise<Incoming[]>;
  referencedAttachments?(message: Incoming, signal: AbortSignal): Promise<Incoming[]>;
  groupReferences?(message: Incoming, signal: AbortSignal): Promise<GroupReference[]>;
  sendSessionClosed?(
    session: Session,
    notice: { id: string; at: number; recovery: string },
  ): Promise<void>;
  recordSessionMessage?(message: Incoming, session: Session): void;
  createTopic?(message: Incoming, title?: string): Promise<Incoming>;
  renameTopic?(session: Session, title: string): Promise<void>;
  topicLink?(session: Session): Promise<string | undefined>;
  sendInteraction?(
    message: Incoming,
    request: Interaction,
    answer: (sender: string, answer: Answer) => void,
  ): Promise<InteractionDelivery | undefined>;
  sendToolProgress?(message: Incoming, view: ToolRunView): Promise<string>;
  updateToolProgress?(messageId: string, view: ToolRunView): Promise<void>;
  stop(): Promise<void>;
  onSessionAction?(handler: (click: SessionCardClick) => SessionCardView): void;
  sendSessionCard?(view: SessionCardView): Promise<string>;
  updateSessionCard?(view: SessionCardView): Promise<void>;
}
export function routeKey(route: Route): string {
  return JSON.stringify([
    route.platform,
    route.account,
    route.conversation,
    route.thread,
    route.sender,
  ]);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
