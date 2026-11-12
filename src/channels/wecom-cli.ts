import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export type WecomCli = (args: string[], signal?: AbortSignal) => Promise<string>;
const cliFile = fileURLToPath(
  new URL('../../node_modules/@wecom/cli/bin/wecom.js', import.meta.url),
);
export const runWecomCli: WecomCli = (args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliFile, ...args],
      { timeout: 60_000, maxBuffer: 2_000_000, signal },
      (error, stdout) => {
        if (error)
          reject(
            new Error('企微接口调用失败，请检查官方 CLI 授权、权限和网络；附件失效时请重新发送。'),
          );
        else resolve(stdout);
      },
    );
  });
export async function verifyWecomIdentity(
  cli: WecomCli,
  botId: string,
  signal?: AbortSignal,
): Promise<void> {
  const identity = await cli(['auth', 'show'], signal);
  const actual = /^Bot ID\s*[:：]\s*(\S+)\s*$/im.exec(identity)?.[1];
  if (!actual || actual !== botId)
    throw new Error('企微 CLI 授权的机器人与当前连接不一致，请先为同一个机器人授权。');
}
