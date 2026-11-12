import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type AttachmentRef,
  type Incoming,
  type LocalAttachment,
  type Session,
} from '../core/types.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export function attachmentName(value: string): string {
  // Prefix also prevents special filenames such as AGENTS.md being picked up
  // automatically as workspace instructions. Preserve the extension for readers.
  const clean = value
    .split(/[\\/]/)
    .pop()!
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const characters = [...(clean || 'file')].slice(-100);
  while (Buffer.byteLength(characters.join('')) > 180) characters.shift();
  return `attachment-${characters.join('')}`;
}
export async function downloadAttachments(
  dataDir: string,
  message: Incoming,
  session: Session,
  fetchResource: (ref: AttachmentRef, signal: AbortSignal) => Promise<Readable>,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<LocalAttachment[]> {
  const refs = message.attachments ?? [];
  if (!refs.length) return [];
  if (refs.length > 10) throw new Error('单条消息最多支持 10 个附件，请分批发送。');
  const scope = createHash('sha256')
    .update(JSON.stringify([message.route.account, session.id]))
    .digest('hex');
  const root = resolve(dataDir, 'attachments', scope);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'message-'));
  const result: LocalAttachment[] = [];
  try {
    for (const [index, ref] of refs.entries()) {
      const name = attachmentName(ref.name);
      const path = join(directory, `${index + 1}-${name}`);
      const signal = AbortSignal.timeout(60_000);
      const stream = await fetchResource(ref, signal);
      let size = 0;
      await pipeline(
        stream,
        new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            callback(
              size > maxBytes ? new Error('附件超过 25 MB，请压缩或拆分后重发。') : null,
              chunk,
            );
          },
        }),
        createWriteStream(`${path}.part`, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      await rename(`${path}.part`, path);
      result.push({ name: ref.name, path, size, messageId: message.id, key: ref.key });
    }
    return result;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
