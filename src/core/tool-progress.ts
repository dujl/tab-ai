import { randomUUID } from 'node:crypto';
import type { Channel, Incoming, Session, ToolActivity, ToolRunView } from './types.js';
import type { Store } from './store.js';

export const toolStatus: Record<ToolActivity['status'], string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  unknown: '结果未上报',
};
const clip = (text: string, max = 8000) =>
  text.length > max ? text.slice(0, max) + '\n…内容已截断' : text;
export class ToolProgress {
  get runId(): string {
    return this.view.id;
  }
  private view: ToolRunView;
  private entries = new Map<string, ToolActivity>();
  private seen = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private dirty = false;
  private disabled = false;
  private messageId?: string;
  private announced = false;
  private finished = false;
  constructor(
    private session: Session,
    private message: Incoming,
    private store: Store,
    private channel: Channel | undefined,
    private fallback: (text: string) => Promise<void>,
  ) {
    this.view = { id: randomUUID(), agent: session.agent, status: 'running', tools: [], total: 0 };
  }
  record(event: ToolActivity): void {
    if (this.finished || !event.id || !event.name) return;
    const prior = this.entries.get(event.id);
    if (prior && prior.status !== 'running' && event.status === 'running') return;
    const next = {
      ...prior,
      ...event,
      name: clip(event.name, 100),
      ...(event.input !== undefined ? { input: clip(event.input) } : {}),
      ...(event.output !== undefined ? { output: clip(event.output) } : {}),
    };
    if (prior && JSON.stringify(prior) === JSON.stringify(next)) return;
    this.seen.add(event.id);
    this.entries.set(event.id, next);
    if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
    this.store.event(this.session.id, 'tool', JSON.stringify({ runId: this.view.id, ...next }));
    this.dirty = true;
    if (!this.timer)
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          void this.flush();
        },
        this.announced ? 1000 : 0,
      );
  }
  private snapshot(): ToolRunView {
    return {
      ...this.view,
      total: this.seen.size,
      tools: [...this.entries.values()].map((t) => ({ ...t })),
    };
  }
  async flush(): Promise<void> {
    if (this.flight) {
      await this.flight;
      return this.flush();
    }
    if (!this.dirty || this.disabled) return;
    this.dirty = false;
    const snapshot = this.snapshot();
    const job = (async () => {
      try {
        if (this.channel?.sendToolProgress && this.channel.updateToolProgress) {
          if (this.messageId) await this.channel.updateToolProgress(this.messageId, snapshot);
          else this.messageId = await this.channel.sendToolProgress(this.message, snapshot);
        } else if (!this.announced && this.session.route.platform !== 'local') {
          await this.fallback(
            `【tab-ai 工具进度】\n${snapshot.tools.at(-1)?.name ?? '工具执行中'}\n使用 /tab tools 查看本轮调用和结果。`,
          );
        }
        this.announced = true;
      } catch {
        this.disabled = true; // Do not duplicate cards after an uncertain create/update.
        this.store.event(
          this.session.id,
          'delivery_error',
          '工具进度卡片投递失败或结果未知；可用 /tab tools 查看。',
        );
      }
    })();
    this.flight = job;
    try {
      await job;
    } finally {
      if (this.flight === job) this.flight = undefined;
    }
  }
  async finish(status: ToolRunView['status']): Promise<void> {
    if (this.finished) return;
    for (const tool of this.entries.values())
      if (tool.status === 'running')
        this.record({ ...tool, status: status === 'completed' ? 'unknown' : 'interrupted' });
    this.finished = true;
    this.view.status = status;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.seen.size) {
      this.dirty = true;
      await this.flush();
    }
  }
}

export function recentTools(store: Store, id: string): ToolActivity[] {
  const events = store.events(id, 10000).filter((e) => e.type === 'tool');
  const tools = new Map<string, ToolActivity>();
  let runId = '';
  for (const event of events) {
    try {
      const parsed = JSON.parse(event.text) as ToolActivity & { runId: string };
      if (parsed.runId !== runId) {
        runId = parsed.runId;
        tools.clear();
      }
      tools.set(parsed.id, parsed);
    } catch {
      /* Ignore malformed historical records. */
    }
  }
  return [...tools.values()];
}
export function toolsText(store: Store, id: string, selection?: string): string {
  const tools = recentTools(store, id);
  if (!tools.length) return '当前会话暂无工具调用记录。';
  if (selection) {
    const index = Number(selection) - 1;
    if (!/^\d+$/.test(selection) || !tools[index]) return '工具序号无效，请先用 /tab tools 查看。';
    const t = tools[index]!;
    return `${index + 1}. ${t.name} · ${toolStatus[t.status]}\n${t.input ? `\n调用内容\n${t.input}` : ''}${t.output ? `\n\n执行结果\n${t.output}` : ''}${t.exitCode !== undefined ? `\n退出码：${t.exitCode}` : ''}`;
  }
  const start = Math.max(0, tools.length - 20);
  return (
    `最近一轮工具调用：${tools.length} 项${start ? '（列出最后 20 项）' : ''}\n` +
    tools
      .slice(start)
      .map(
        (t, i) =>
          `${start + i + 1}. ${t.name} · ${toolStatus[t.status]}\n${clip((t.input ?? '').replace(/\s+/g, ' '), 120)}`,
      )
      .join('\n\n') +
    '\n\n/tab tools <序号> 查看调用内容和结果。'
  );
}
