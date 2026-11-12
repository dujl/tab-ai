import type { Incoming } from '../core/types.js';
import { type CardPrompt, approvalDetailParts } from './cards.js';

export interface ApprovalDetails {
  message: Incoming;
  prompt: CardPrompt;
}

// Card callbacks must acknowledge immediately. Delivery is bounded, serialized
// within its original topic, and never retried after an unknown send result.
export class ApprovalDetailsDelivery {
  private stopSignal = new AbortController();
  private queues = new Map<string, Promise<void>>();
  private pending = new Set<string>();
  constructor(
    private account: string,
    private send: (message: Incoming, text: string) => Promise<void>,
    private chunkBytes = 2400,
    private deadlineMs = 30_000,
  ) {}
  enqueue(details: ApprovalDetails): boolean {
    if (this.stopSignal.signal.aborted) return false;
    const id = details.prompt.request.id;
    if (this.pending.has(id)) return true;
    if (this.pending.size >= 16) return false;
    this.pending.add(id);
    const key = JSON.stringify([details.message.route.conversation, details.message.route.thread]);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const job = previous
      .then(async () => {
        const signal = AbortSignal.any([
          this.stopSignal.signal,
          AbortSignal.timeout(this.deadlineMs),
        ]);
        try {
          for (const part of approvalDetailParts(details.prompt, this.chunkBytes))
            await this.bounded(() => this.send(details.message, part), signal);
        } catch {
          if (this.stopSignal.signal.aborted) return;
          console.error(
            `[${this.account}] approval-details failed request=${id}; no automatic retry`,
          );
          await this.bounded(
            () =>
              this.send(
                details.message,
                `tab-ai · 审批 ${id.slice(0, 8)}\n完整详情未确认投递成功。查看详情不会提交审批决定，请以卡片当前状态为准。可使用 /tab inspect ${id} 查看原文。`,
              ),
            AbortSignal.any([this.stopSignal.signal, AbortSignal.timeout(5000)]),
          ).catch(() => {});
        }
      })
      .finally(() => {
        this.pending.delete(id);
        if (this.queues.get(key) === job) this.queues.delete(key);
      });
    this.queues.set(key, job);
    return true;
  }
  private bounded(send: () => Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(new Error('Approval details delivery stopped'));
      };
      const cleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        reject(new Error('Approval details delivery stopped'));
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return send();
        })
        .then(
          () => {
            cleanup();
            resolve();
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
  }
  stop(): void {
    this.stopSignal.abort();
  }
}
