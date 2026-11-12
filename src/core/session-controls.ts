import { randomUUID } from 'node:crypto';
import { type Store } from './store.js';
import {
  type Channel,
  type Session,
  type SessionCardClick,
  type SessionCardRecord,
  type SessionCardView,
} from './types.js';
import { type SessionSettings } from './session-settings.js';
import { sessionInstructions } from './session-instructions.js';
import { realpathSync, statSync } from 'node:fs';
import { customWorkspace } from './session-workspace.js';

interface Actions {
  authorized(session: Session, sender: string): boolean;
  active(id: string): boolean;
  close(id: string): void;
  open(id: string): void;
  startInitial(id: string): void;
  settings: SessionSettings;
  workspaces: Record<string, string>;
  pendingCount?(id: string): number;
  information?(session: Session): import('./types.js').SessionInformation;
  taskBoard?(id: string): import('./task-model.js').TaskBoard | undefined;
}
export class SessionControls {
  private jobs = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  constructor(
    private store: Store,
    private channels: Map<string, Channel>,
    private actions: Actions,
  ) {}
  register(channel: Channel): void {
    channel.onSessionAction?.((click) => this.act(channel.id, click));
  }
  private instructionsEditable(session: Session): boolean {
    return (
      session.status === 'idle' &&
      !session.nativeId &&
      !this.actions.active(session.id) &&
      this.store.task(session.id, 'first') === undefined
    );
  }
  snapshot(card: SessionCardRecord): SessionCardView {
    const session = this.store.get(card.sessionId);
    if (!session) throw new Error('会话不存在');
    const events = this.store
      .events(session.id, 1000)
      .filter((e) => ['user', 'response', 'activity', 'error', 'system'].includes(e.type));
    const visible =
      card.view === 'history'
        ? events.filter((e) => ['user', 'response'].includes(e.type)).slice(-6)
        : events.slice(-4);
    return {
      card,
      session,
      information: this.actions.information?.(session),
      pendingCount: this.actions.pendingCount?.(session.id),
      taskBoard: this.actions.taskBoard?.(session.id),
      workspaces: Object.entries(this.actions.workspaces).map(([alias, path]) => ({ alias, path })),
      instructionsEditable: this.instructionsEditable(session),
      active: this.actions.active(session.id),
      current: this.store.current(session.route)?.id === session.id,
      settings: card.view === 'settings' ? this.actions.settings.snapshot(session.id) : undefined,
      events: visible.map((e) => ({
        type: e.type,
        at: e.at,
        text:
          e.text.slice(0, 1200) +
          (e.text.length > 1200 ? '\n…内容已截断，可在工作台查看全文。' : ''),
      })),
    };
  }
  private act(account: string, click: SessionCardClick): SessionCardView {
    const card = this.store.cardById(click.id),
      session = card && this.store.get(card.sessionId);
    if (
      !card ||
      !session ||
      card.delivery !== 'sent' ||
      card.messageId !== click.messageId ||
      session.route.account !== account ||
      session.route.conversation !== click.conversation ||
      session.route.sender !== click.sender ||
      !this.actions.authorized(session, click.sender)
    )
      throw new Error('此卡片不属于当前会话，或你已无权操作。');
    if (
      [
        'close',
        'open',
        'model',
        'effort',
        'save_settings',
        'cancel_settings',
        'save_instructions',
        'save_initial',
        'start_initial',
      ].includes(click.action) &&
      click.revision !== card.revision
    )
      throw new Error('卡片状态已更新，请先刷新卡片再操作。');
    if (click.action === 'save_instructions' || click.action === 'save_initial') {
      if (
        click.action === 'save_instructions' &&
        session.pendingInitialTask !== undefined &&
        card.draftSettings
      )
        throw new Error('请先保存或取消卡片中待保存的模型设置，再开始任务。');
      if (!this.instructionsEditable(session))
        throw new Error(
          '只能在首次任务开始前设置工作目录和附加指令；此会话已开始或未打开，请新建空会话。',
        );
      const preserveLong = (session.instructions?.length ?? 0) > 1000;
      if (preserveLong && click.instructions !== undefined)
        throw new Error('已有指令超过卡片容量，请保留原指令或新建会话。');
      if (
        !preserveLong &&
        click.instructions !== undefined &&
        (typeof click.instructions !== 'string' || click.instructions.length > 1000)
      )
        throw new Error('卡片附加指令最多 1000 字符。');
      const instructions =
        preserveLong || click.instructions === undefined
          ? session.instructions
          : sessionInstructions(click.instructions);
      let workspace = session.workspace;
      if (click.workspacePath?.trim()) {
        workspace = customWorkspace(click.workspacePath);
      } else if (click.workspace?.trim()) {
        if (!Object.hasOwn(this.actions.workspaces, click.workspace))
          throw new Error('请选择已配置的工作区。');
        workspace = this.actions.workspaces[click.workspace]!;
        try {
          if (!statSync(workspace).isDirectory() || realpathSync(workspace) !== workspace)
            throw new Error();
        } catch {
          throw new Error('工作目录已不存在或路径已变更，请检查本机工作区配置。');
        }
      }
      if (workspace !== session.workspace) {
        this.actions.settings.invalidateWorkspace(session.id);
        session.workspace = workspace;
        delete session.settings;
        session.settingsRevision = (session.settingsRevision ?? 0) + 1;
        delete card.draftSettings;
        delete card.draftSettingsRevision;
      }
      session.instructions = instructions;
      delete session.codexDeveloperInstructions;
      this.store.save(session);
    }
    if (
      click.action === 'start_initial' ||
      (click.action === 'save_instructions' && session.pendingInitialTask !== undefined)
    ) {
      if (!this.instructionsEditable(session))
        throw new Error('请先打开此新会话；已执行的任务不能通过初始化按钮重跑。');
      if (card.draftSettings) throw new Error('请先保存或取消卡片中待保存的模型设置，再开始任务。');
      this.actions.startInitial(session.id);
    }
    if (click.action === 'close') this.actions.close(session.id);
    if (click.action === 'open') this.actions.open(session.id);
    if (
      ['settings', 'model', 'effort', 'save_settings', 'cancel_settings'].includes(click.action)
    ) {
      card.view = 'settings';
      if (click.action === 'settings') void this.actions.settings.load(session.id, true);
      if (click.action === 'model' || click.action === 'effort') {
        const catalog = this.actions.settings.snapshot(session.id);
        if (catalog.state !== 'ready') throw new Error('请先刷新模型列表。');
        if (click.action === 'model') {
          const model = catalog.models.find((m) => m.id === click.selection);
          if (!model) throw new Error('无效模型选项');
          card.draftSettings = {
            model: model.id,
            ...(model.defaultEffort && model.efforts.some((e) => e.id === model.defaultEffort)
              ? { effort: model.defaultEffort }
              : {}),
          };
          card.draftSettingsRevision = session.settingsRevision ?? 0;
        } else {
          const draft = card.draftSettings ?? session.settings;
          const model = catalog.models.find((m) => m.id === draft?.model);
          if (!draft || !model?.efforts.some((e) => e.id === click.selection))
            throw new Error('请先选择模型及其支持的思考深度。');
          card.draftSettings = { ...draft, effort: click.selection! };
          card.draftSettingsRevision ??= session.settingsRevision ?? 0;
        }
      }
      if (click.action === 'save_settings') {
        if (!card.draftSettings) throw new Error('请先选择要修改的设置。');
        this.actions.settings.save(
          session.id,
          card.draftSettings,
          card.draftSettingsRevision ?? -1,
        );
      }
      if (click.action === 'save_settings' || click.action === 'cancel_settings') {
        card.view = 'status';
        delete card.draftSettings;
        delete card.draftSettingsRevision;
      }
    } else card.view = click.action === 'history' ? 'history' : 'status';
    card.revision++;
    this.store.saveCard(card);
    this.refresh(session.id);
    return this.snapshot(card);
  }
  refresh(id: string): void {
    const session = this.store.get(id),
      channel = session && this.channels.get(session.route.account);
    if (session?.imEntry) return;
    if (!session || !channel?.sendSessionCard || !channel.updateSessionCard) return;
    const previous = this.jobs.get(id);
    if (previous) {
      previous.dirty = true;
      return;
    }
    const job = { dirty: true, promise: Promise.resolve() };
    this.jobs.set(id, job);
    job.promise = (async () => {
      while (job.dirty) {
        job.dirty = false;
        let card = this.store.card(id);
        if (!card) {
          card = { id: randomUUID(), sessionId: id, revision: 0, delivery: 'new', view: 'status' };
          this.store.saveCard(card);
        }
        // Never repeat an ambiguous create (including a crash after remote delivery).
        if (card.delivery === 'sending' || card.delivery === 'unknown') return;
        const create = card.delivery === 'new';
        card.revision++;
        if (create) card.delivery = 'sending';
        this.store.saveCard(card);
        try {
          if (create) {
            const messageId = await channel.sendSessionCard!(this.snapshot(card));
            card.messageId = messageId;
            card.delivery = 'sent';
            this.store.saveCard(card);
          } else await channel.updateSessionCard!(this.snapshot(card));
        } catch {
          if (create) {
            card.delivery = 'unknown';
            this.store.saveCard(card);
          }
          this.store.event(
            id,
            'delivery_error',
            '会话管理卡片投递或更新失败；可在原话题发送 /tab card 重试，关闭与恢复也可使用文字命令。',
          );
          return;
        }
      }
    })().finally(() => this.jobs.delete(id));
  }
  show(id: string): void {
    if (this.jobs.has(id)) {
      this.refresh(id);
      return;
    }
    const card = this.store.card(id);
    if (card && ['unknown', 'sending'].includes(card.delivery)) {
      // Explicit user retry revokes any uncertain previous card before creating another.
      this.store.saveCard({
        id: randomUUID(),
        sessionId: id,
        revision: 0,
        delivery: 'new',
        view: card.view,
      });
    }
    this.refresh(id);
  }
  showSettings(id: string): void {
    const card = this.store.card(id);
    if (card) {
      card.view = 'settings';
      card.revision++;
      this.store.saveCard(card);
    } else
      this.store.saveCard({
        id: randomUUID(),
        sessionId: id,
        revision: 0,
        delivery: 'new',
        view: 'settings',
      });
    void this.actions.settings.load(id, true);
    this.show(id);
  }
  async drain(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs.values()].map((j) => j.promise));
  }
}
