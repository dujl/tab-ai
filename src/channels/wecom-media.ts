import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { decryptFile } from '@wecom/aibot-node-sdk';
import { z } from 'zod';
import type { AttachmentRef, Incoming, Route, Session } from '../core/types.js';
import { downloadAttachments, MAX_ATTACHMENT_BYTES } from './attachments.js';
import { runWecomCli, verifyWecomIdentity, type WecomCli } from './wecom-cli.js';

const scope = (route: Route) =>
  createHash('sha256')
    .update(JSON.stringify([route.account, route.conversation]))
    .digest('hex');
export function wecomMediaKey(route: Route, id: string): string {
  return `wecom-media:${scope(route)}:${Buffer.from(id).toString('base64url')}`;
}
export interface WecomLiveResource {
  url: string;
  aeskey?: string;
  filename?: string;
}
const mediaResult = z.object({
  media_item: z.object({
    media_id: z.string().optional(),
    content: z.string().optional(),
    file_path: z.string().optional(),
  }),
});

export class WecomMedia {
  private live = new Map<string, { value: WecomLiveResource; scope: string; at: number }>();
  constructor(
    private dataDir: string,
    private botId: string,
    private cli: WecomCli = runWecomCli,
    private fetcher: typeof fetch = fetch,
    private now = () => Date.now(),
  ) {}
  register(route: Route, resource: WecomLiveResource, type: 'file' | 'image'): AttachmentRef {
    const key =
      'wecom-live:' +
      createHash('sha256')
        .update(JSON.stringify([scope(route), resource.url, resource.aeskey]))
        .digest('hex');
    for (const [id, entry] of this.live)
      if (this.now() - entry.at >= 5 * 60_000) this.live.delete(id);
    this.live.set(key, { value: resource, scope: scope(route), at: this.now() });
    while (this.live.size > 200) this.live.delete(this.live.keys().next().value!);
    return {
      key,
      name: resource.filename || (type === 'image' ? 'image.jpg' : 'attachment'),
      type,
    };
  }
  async download(message: Incoming, session: Session) {
    if (
      message.route.account !== session.route.account ||
      message.route.conversation !== session.route.conversation
    )
      throw new Error('企微附件不属于当前聊天。');
    return downloadAttachments(this.dataDir, message, session, async (ref, signal) => {
      const prefix = `wecom-media:${scope(message.route)}:`;
      if (ref.key.startsWith(prefix))
        return this.historyResource(ref.key.slice(prefix.length), signal);
      const entry = this.live.get(ref.key);
      if (!entry || entry.scope !== scope(message.route) || this.now() - entry.at >= 5 * 60_000)
        throw new Error(
          '企微附件下载链接已失效或服务已重启。已启用群聊补读时可用 /tab files sync 获取历史附件，否则请重新发送并同时说明处理要求。',
        );
      try {
        const url = new URL(entry.value.url);
        if (url.protocol !== 'https:') throw Error('Invalid resource URL');
        const response = await this.fetcher(url, { signal, redirect: 'error' });
        if (!response.ok || !response.body) throw Error('Resource not available');
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for await (const chunk of response.body) {
            length += chunk.byteLength;
            if (length > MAX_ATTACHMENT_BYTES + 32)
              throw new Error('附件超过 25 MB，请压缩或拆分后重发。');
            chunks.push(chunk);
          }
        } finally {
          if (signal.aborted) await response.body.cancel().catch(() => {});
        }
        const encrypted = Buffer.concat(chunks);
        const buffer = entry.value.aeskey ? decryptFile(encrypted, entry.value.aeskey) : encrypted;
        return Readable.from([buffer]);
      } catch (error) {
        if (signal.aborted) throw new Error('企微附件下载超时，请重试。');
        if (error instanceof Error && error.message.includes('25 MB')) throw error;
        throw new Error(
          '企微附件下载或解密失败，链接可能已失效；请重新发送图片或用 /tab files sync 补取历史附件。',
        );
      }
    });
  }
  private async historyResource(encoded: string, signal: AbortSignal): Promise<Readable> {
    const id = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!id || id.length > 256 || Buffer.from(id).toString('base64url') !== encoded)
      throw new Error('企微附件引用无效。');
    await verifyWecomIdentity(this.cli, this.botId, signal);
    // The official CLI confines file output to its CWD and /tmp. macOS
    // os.tmpdir() points into /var/folders, which that policy rejects.
    const root = await realpath(process.platform === 'win32' ? tmpdir() : '/tmp');
    const directory = await mkdtemp(join(root, 'tab-ai-wecom-media-'));
    try {
      const result = mediaResult.parse(
        JSON.parse(
          await this.cli(
            ['message', 'files', 'get', '--media-id', id, '--output-dir', directory],
            signal,
          ),
        ),
      ).media_item;
      if (result.media_id && result.media_id !== id) throw Error('Media identity mismatch');
      if (result.file_path) {
        const path = await realpath(resolve(result.file_path)),
          base = await realpath(directory),
          inside = relative(base, path);
        if (!inside || inside.startsWith('..') || isAbsolute(inside))
          throw Error('Media path outside isolated directory');
        const info = await lstat(path);
        if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
          throw new Error('企微附件不是有效文件或超过 25 MB。');
        // Keep the CLI directory until the consumer has drained the stream.
        const stream = createReadStream(path);
        stream.once('close', () => {
          void rm(directory, { recursive: true, force: true });
        });
        return stream;
      }
      if (result.content === undefined) throw Error('No media bytes');
      const bytes = Buffer.from(result.content, 'utf8');
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('企微附件超过 25 MB。');
      await rm(directory, { recursive: true, force: true });
      return Readable.from([bytes]);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (error instanceof Error && error.message.includes('25 MB')) throw error;
      throw new Error(
        '企微历史附件下载失败，请检查同一机器人 CLI 的授权和媒体读取权限；附件失效时请重发。',
      );
    }
  }
}
