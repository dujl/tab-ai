import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// One loopback-only native server per operation. OpenCode owns its persisted sessions.
export class OpenCodeServer {
  private dead = new AbortController();
  private closing = false;
  private constructor(
    private child: ChildProcess,
    private base: string,
    private authorization: string,
    private cwd: string,
  ) {
    child.once('exit', () => this.dead.abort(new Error('OpenCode 服务已退出')));
    child.once('error', () => this.dead.abort(new Error('OpenCode 服务进程异常')));
  }
  static async start(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    prefix: string[] = [],
  ): Promise<OpenCodeServer> {
    signal.throwIfAborted();
    const password = randomBytes(32).toString('hex');
    const child = spawn(command, [...prefix, 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd,
      detached: process.platform !== 'win32',
      env: { ...env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Never log native stderr: it may contain provider configuration or credentials.
    child.stderr!.resume();
    try {
      const base = await new Promise<string>((resolve, reject) => {
        let output = '';
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const failure = () => {
          cleanup();
          reject(new Error('无法启动 OpenCode；请检查安装和 agents.opencode.command 配置。'));
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('OpenCode 服务启动超时'));
        }, 20_000);
        const data = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8192);
          const match = /http:\/\/127\.0\.0\.1:(\d+)(?=\s)/.exec(output);
          if (match && Number(match[1]) > 0) {
            cleanup();
            resolve(match[0]);
          }
        };
        function cleanup() {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          child.off('error', failure);
          child.off('exit', failure);
          child.stdout!.off('data', data);
        }
        child.stdout!.on('data', data);
        child.once('error', failure);
        child.once('exit', failure);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      child.stdout!.resume();
      const server = new OpenCodeServer(
        child,
        base,
        `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        cwd,
      );
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('OpenCode 服务启动后退出');
      signal.throwIfAborted();
      return server;
    } catch (error) {
      await stop(child);
      throw error;
    }
  }
  async request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await this.fetch(path, signal, body);
    return (await response.json()) as T;
  }
  async fetch(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    const url = new URL(path, this.base);
    url.searchParams.set('directory', this.cwd);
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: this.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, this.dead.signal]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenCode API ${path}: HTTP ${response.status}；未切换到其他 Agent。`);
    }
    return response;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.dead.abort();
    await stop(this.child);
  }
}
async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  // The installed CLI may be a launcher. Its native server inherits the pipes
  // and can outlive the launcher, so terminate only this operation's own group.
  const signal = (kind: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid!, kind);
      else child.kill(kind);
    } catch {}
  };
  if (child.stdout?.destroyed && child.stderr?.destroyed) {
    signal('SIGTERM');
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal('SIGKILL');
      resolve();
    }, 3000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    signal('SIGTERM');
  });
}

export async function consumeEvents(
  response: Response,
  event: (value: unknown) => void,
): Promise<void> {
  if (!response.body) throw new Error('OpenCode 没有返回事件流');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('OpenCode 事件连接已中断；本轮已停止，未自动重试。');
      buffer += value;
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) event(JSON.parse(data));
      }
      if (buffer.length > 4_000_000) throw new Error('OpenCode 事件过大');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
