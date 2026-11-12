import { z } from 'zod';
import { type Store } from './store.js';
import {
  type AgentAdapter,
  type AgentKind,
  type AgentSettings,
  type SettingsView,
} from './types.js';

export const agentSettingsSchema = z
  .object({ model: z.string().min(1).max(256), effort: z.string().min(1).max(80).optional() })
  .strict();
const modelsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(256),
      label: z.string().min(1).max(300),
      efforts: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().max(500) })),
      defaultEffort: z.string().optional(),
    }),
  )
  .max(500);
const TTL = 5 * 60_000;

export class SessionSettings {
  private cache = new Map<string, { view: SettingsView; at: number }>();
  private jobs = new Map<string, Promise<void>>();
  private abort = new AbortController();
  constructor(
    private store: Store,
    private agents: Record<AgentKind, AgentAdapter>,
    private active: (id: string) => boolean,
    private refresh: (id: string) => void,
  ) {}
  snapshot(id: string): SettingsView {
    const cached = this.cache.get(id);
    if (!cached || (cached.view.state === 'ready' && Date.now() - cached.at > TTL))
      return { state: 'unloaded', models: [] };
    return structuredClone(cached.view);
  }
  invalidateWorkspace(id: string): void {
    if (this.jobs.has(id)) throw new Error('模型列表正在加载，请稍后再更改工作目录。');
    this.cache.delete(id);
  }
  load(id: string, force = false): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    const existing = this.jobs.get(id);
    if (existing) return existing;
    if (!force && this.snapshot(id).state === 'ready') return Promise.resolve();
    const session = this.store.get(id);
    if (!session) throw new Error('会话不存在');
    if (this.jobs.size >= 4) throw new Error('设置加载繁忙，请稍后重试。');
    this.cache.set(id, { at: Date.now(), view: { state: 'loading', models: [] } });
    const job = (async () => {
      try {
        const adapter = this.agents[session.agent];
        if (!adapter.models) throw new Error('unsupported');
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]);
        const models = modelsSchema.parse(await adapter.models(session, signal));
        signal.throwIfAborted();
        if (!models.length || new Set(models.map((m) => m.id)).size !== models.length)
          throw new Error('Invalid model catalog');
        this.cache.set(id, { at: Date.now(), view: { state: 'ready', models } });
      } catch {
        this.cache.set(id, {
          at: Date.now(),
          view: {
            state: 'error',
            models: [],
            error: '无法读取此 Agent 的模型能力，请检查本机登录和连接后刷新。原设置未改变。',
          },
        });
      } finally {
        this.refresh(id);
      }
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }
  save(id: string, value: AgentSettings, revision: number): void {
    if (this.abort.signal.aborted) throw new Error('服务正在关闭');
    const session = this.store.get(id);
    if (!session) throw new Error('会话不存在');
    if (this.active(id) || ['running', 'waiting', 'detached'].includes(session.status))
      throw new Error('请等待当前任务结束或退出原生终端，再修改设置。');
    if ((session.settingsRevision ?? 0) !== revision)
      throw new Error('设置已被更新，请重新打开设置。');
    const settings = agentSettingsSchema.parse(value),
      catalog = this.snapshot(id);
    if (catalog.state !== 'ready') throw new Error('请先刷新模型列表再保存。');
    const model = catalog.models.find((m) => m.id === settings.model);
    if (!model) throw new Error('模型不在当前 Agent 返回的列表中。');
    if (
      model.efforts.length
        ? !model.efforts.some((e) => e.id === settings.effort)
        : settings.effort !== undefined
    )
      throw new Error('请选择该模型支持的思考深度。');
    session.settings = settings;
    session.settingsRevision = revision + 1;
    this.store.save(session);
    // Settings are not conversation events and never become user/assistant input.
    this.refresh(id);
  }
  async close(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.jobs.values());
  }
}
