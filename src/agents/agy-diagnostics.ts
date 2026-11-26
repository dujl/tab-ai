import {
  mkdtempSync,
  writeFileSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Native ACP redirects stderr to a file. Keep each process isolated and only
// expose fixed error categories, never raw log lines, paths or credentials.
export function agyFailure(text: string): { message: string; terminal: boolean } | undefined {
  const signInFailed = /authentication required|silent sign-in failed/i.test(text);
  if (signInFailed && /keyring[^\n]*(?:exit status 36|interaction is not allowed)/i.test(text))
    return {
      message:
        'Antigravity CLI 无法访问 macOS 登录钥匙串，静默登录失败。请在图形登录会话中启动服务，并确认 AGY 已登录且可访问钥匙串，然后重试；本轮未自动重试。',
      terminal: true,
    };
  const connection =
    /\bEOF\b|connection (?:reset|refused)|network.*(?:failed|error)|(?:request|connection|TLS).*timed? ?out/i.test(
      text,
    );
  if (/unknown model key|failed to construct executor|model not found/i.test(text))
    return {
      message:
        'Antigravity CLI 原生模型初始化失败：模型不存在或未成功加载。' +
        (connection ? '模型目录请求同时发生连接中断。' : '') +
        '请刷新模型目录并核对本会话模型。',
      terminal: true,
    };
  if (
    signInFailed ||
    /invalid_grant|UNAUTHENTICATED|authentication failed|unauthorized\b|\b401\b/i.test(text)
  )
    return {
      message: 'Antigravity CLI 原生认证失败，请检查该 CLI 的登录状态。',
      terminal: signInFailed || /invalid_grant/i.test(text),
    };
  if (/RESOURCE_EXHAUSTED|quota exceeded|rate limit|\b429\b/i.test(text))
    return {
      message: 'Antigravity CLI 原生服务报告额度或频率限制，请核对当前账号用量。',
      terminal: false,
    };
  if (connection)
    return {
      message: 'Antigravity CLI 原生服务连接失败或超时，请检查该进程的网络和代理连接。',
      terminal: false,
    };
  return undefined;
}

export class AgyDiagnostics {
  private directory = mkdtempSync(join(tmpdir(), 'tab-ai-agy-'));
  readonly file = join(this.directory, 'acp.log');
  private promptOffset = 0;
  constructor() {
    writeFileSync(this.file, '', { mode: 0o600 });
  }
  beginPrompt() {
    const fd = openSync(this.file, 'r');
    try {
      this.promptOffset = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  }
  failure() {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, 'r');
      const size = fstatSync(fd).size,
        bytes = Math.min(Math.max(0, size - this.promptOffset), 16_384),
        buffer = Buffer.alloc(bytes);
      readSync(fd, buffer, 0, bytes, size - bytes);
      const errors = buffer
        .toString('utf8')
        .split('\n')
        .filter(
          (line) =>
            /^(?:[EFW]\d{4}\s|ERROR\b|FATAL\b|error:|fatal:)/i.test(line) ||
            /^I\d{4}\s.*boot\.go:\d+\] Silent sign-in failed\b/.test(line),
        );
      return agyFailure(errors.join('\n'));
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  close() {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
