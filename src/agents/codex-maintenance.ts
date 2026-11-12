import { codexUsage } from './token-usage.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RpcProcess } from './rpc.js';
import { agentEnvironment } from './environment.js';
import { sameWorkspace } from '../core/session-workspace.js';
import type { AgentUsage, CompactionResult, NativeLoop, Session } from '../core/types.js';
import { codexInstructions } from '../core/channel-instructions.js';
import { prepareCodexInstructions } from './codex-instructions.js';
import { nativeApprovalPolicy } from '../core/approval-policy.js';

const goalSchema = z.object({
  threadId: z.string(),
  objective: z.string(),
  createdAt: z.number(),
  status: z.string(),
});
type Goal = z.infer<typeof goalSchema>;
const key = (goal: Goal) =>
  'goal:' +
  createHash('sha256')
    .update(JSON.stringify([goal.threadId, goal.createdAt, goal.objective]))
    .digest('hex')
    .slice(0, 24);
export class CodexMaintenance {
  private live = new Map<string, RpcProcess>();
  constructor(
    private command: string,
    private secrets: string[],
  ) {}
  attach(id: string, rpc: RpcProcess): void {
    this.live.set(id, rpc);
  }
  detach(id: string, rpc: RpcProcess): void {
    if (this.live.get(id) === rpc) this.live.delete(id);
  }
  private async use<T>(
    session: Session,
    signal: AbortSignal,
    job: (rpc: RpcProcess) => Promise<T>,
    fresh = false,
    restoredUsage?: (value: AgentUsage) => void,
  ): Promise<T> {
    signal.throwIfAborted();
    if (!session.nativeId) throw new Error('此会话尚无原生历史。');
    const live = !fresh && this.live.get(session.id);
    if (live) return job(live);
    const rpc = new RpcProcess(
        this.command,
        ['app-server'],
        session.workspace,
        agentEnvironment(this.secrets),
      ),
      abort = () => {
        void rpc.close();
      };
    signal.addEventListener('abort', abort, { once: true });
    if (restoredUsage)
      rpc.onMessage = (message) => {
        if (message.method === 'thread/tokenUsage/updated') {
          const value = codexUsage(message.params, session.nativeId);
          if (value) restoredUsage(value);
        }
      };
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'tab-ai-management', version: '0.3.0' },
        capabilities: { experimentalApi: true },
      });
      rpc.write({ method: 'initialized' });
      await prepareCodexInstructions(session, rpc);
      const result = z
        .object({ thread: z.object({ id: z.string(), cwd: z.string().optional() }) })
        .parse(
          await rpc.request('thread/resume', {
            threadId: session.nativeId,
            cwd: session.workspace,
            ...(nativeApprovalPolicy(session)
              ? { approvalPolicy: nativeApprovalPolicy(session) }
              : {}),
            ...(session.settings ? { model: session.settings.model } : {}),
            ...(codexInstructions(session)
              ? { developerInstructions: codexInstructions(session) }
              : {}),
          }),
        );
      if (
        result.thread.id !== session.nativeId ||
        (result.thread.cwd && !sameWorkspace(result.thread.cwd, session.workspace))
      )
        throw new Error('原生会话或目录不匹配；未执行管理操作。');
      signal.throwIfAborted();
      return await job(rpc);
    } finally {
      signal.removeEventListener('abort', abort);
      await rpc.close();
    }
  }
  async compact(session: Session, signal: AbortSignal): Promise<CompactionResult> {
    let restored: AgentUsage | undefined;
    return this.use(
      session,
      signal,
      async (rpc) => {
        let usage: AgentUsage | undefined;
        let compacted = false,
          turnId: string | undefined,
          resolve!: () => void,
          reject!: (e: Error) => void;
        const done = new Promise<void>((a, b) => {
          resolve = a;
          reject = b;
        });
        void done.catch(() => {});
        rpc.onFailure = reject;
        const abort = () => reject(new Error('会话压缩已中断；未确认压缩完成。'));
        signal.addEventListener('abort', abort, { once: true });
        rpc.onMessage = (message) => {
          if (message.id !== undefined && message.method) {
            rpc.write({
              id: message.id,
              error: { code: -32601, message: 'Tools are unavailable during compaction' },
            });
            reject(new Error('压缩过程请求了非压缩工具，已停止。'));
            return;
          }
          const data = message.params as any;
          if (data?.threadId !== session.nativeId) return;
          if (message.method === 'turn/started') turnId = data.turn?.id;
          if (message.method === 'thread/tokenUsage/updated' && data.turnId === turnId)
            usage = codexUsage(data, session.nativeId);
          if (message.method === 'item/completed' && data.item?.type === 'contextCompaction')
            compacted = true;
          if (message.method === 'thread/compacted') compacted = true;
          if (message.method === 'turn/completed' && (!turnId || data.turn?.id === turnId)) {
            if (data.turn?.status !== 'completed')
              reject(new Error(data.turn?.error?.message ?? '原生压缩未完成。'));
            else if (compacted) resolve();
            else reject(new Error('原生轮次已结束，但没有压缩完成标记。'));
          }
        };
        try {
          await rpc.request('thread/compact/start', { threadId: session.nativeId });
          await done;
          signal.throwIfAborted();
          return {
            compacted: true,
            ...(usage ? { usage } : {}),
            ...(restored?.contextTokens === undefined
              ? {}
              : { contextBefore: restored.contextTokens }),
          };
        } finally {
          signal.removeEventListener('abort', abort);
        }
      },
      true,
      (value) => {
        restored = value;
      },
    );
  }
  private async goal(rpc: RpcProcess, session: Session): Promise<Goal | null> {
    const result = z
      .object({ goal: goalSchema.nullable() })
      .parse(await rpc.request('thread/goal/get', { threadId: session.nativeId }));
    if (result.goal && result.goal.threadId !== session.nativeId)
      throw new Error('原生目标不属于当前会话。');
    return result.goal;
  }
  async loops(session: Session, signal: AbortSignal): Promise<NativeLoop[]> {
    return this.use(session, signal, async (rpc) => {
      const goal = await this.goal(rpc, session);
      return !goal || goal.status === 'complete'
        ? []
        : [
            {
              id: key(goal),
              label: 'Codex 原生 goal（持续目标）',
              status: goal.status,
              detail: goal.objective,
            },
          ];
    });
  }
  async stopLoop(
    session: Session,
    id: string,
    signal: AbortSignal,
  ): Promise<{ wasActive: boolean }> {
    return this.use(session, signal, async (rpc) => {
      const goal = await this.goal(rpc, session);
      if (!goal || goal.status === 'complete' || key(goal) !== id)
        throw new Error('原生目标已结束或已更换；未清除新的目标。请刷新循环列表。');
      signal.throwIfAborted();
      await rpc.request('thread/goal/clear', { threadId: session.nativeId, origin: 'user' });
      if (await this.goal(rpc, session)) throw new Error('未确认目标已清除，不能报告循环已停止。');
      return { wasActive: goal.status === 'active' };
    });
  }
}
