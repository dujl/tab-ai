import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

const envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).passthrough().optional(),
});
export type RpcMessage = z.infer<typeof envelope>;

export class RpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  private diagnostics = '';
  onMessage: (message: RpcMessage) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, stdio: 'pipe', shell: false });
    this.child.stderr.on('data', (chunk) => {
      this.diagnostics = (this.diagnostics + String(chunk)).slice(-4000);
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', (code) =>
      this.fail(new Error(`Agent 进程退出 (${code}): ${this.diagnostics}`)),
    );
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', (line) => {
      try {
        const message = envelope.parse(JSON.parse(line));
        if (typeof message.id === 'number' && !message.method) {
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error)
            request.reject(
              Object.assign(new Error(message.error.message), {
                rpcCode: typeof message.error.code === 'number' ? message.error.code : undefined,
              }),
            );
          else request.resolve(message.result);
        } else this.onMessage(message);
      } catch (error) {
        this.fail(
          new Error(`Agent 协议错误: ${error instanceof Error ? error.message : 'invalid JSON'}`),
        );
      }
    });
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.onFailure(error);
    this.child.kill('SIGTERM');
  }
  write(message: object): void {
    if (this.closed) throw new Error('Agent 连接已经关闭');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Agent 连接已经关闭'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent 请求超时: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.fail(new Error('Agent connection closed'));
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2000);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
