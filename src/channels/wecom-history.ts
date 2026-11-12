import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GroupReference, Incoming, AttachmentRef } from '../core/types.js';
import { runWecomCli, verifyWecomIdentity, type WecomCli } from './wecom-cli.js';
import { wecomMediaKey } from './wecom-media.js';

const content = z.object({ content: z.string() });
const media = z.object({
  file_name: z.string().optional(),
  media_id: z.string().min(1).max(256).optional(),
});
const messageSchema = z.object({
  userid: z.string().optional(),
  user_name: z.string().optional(),
  send_time: z.string(),
  msg_type: z.enum(['text', 'image', 'file', 'voice', 'video', 'mixed']),
  text: content.optional(),
  file: media.optional(),
  image: media.optional(),
  voice: media.optional(),
  video: media.optional(),
  mixed: z
    .object({
      items: z
        .array(
          z.object({ msg_type: z.string(), text: content.optional(), image: media.optional() }),
        )
        .optional(),
    })
    .optional(),
});
const responseSchema = z.object({
  messages: z.array(messageSchema),
  has_more: z.boolean().optional(),
  next_cursor: z.string().optional(),
});
const localTime = (date: Date) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
const normalized = (text: string) => text.replace(/\s/g, '');

/** Read on demand, never turn history rows into executable Incoming messages. */
export class WecomHistory {
  private cached = new Map<
    string,
    { at: number; limit: number; rows: z.infer<typeof messageSchema>[] }
  >();
  constructor(
    private botId: string,
    private groups: string[],
    private cli: WecomCli = runWecomCli,
    private now = () => Date.now(),
  ) {}
  private async rows(
    message: Incoming,
    signal?: AbortSignal,
    limit = 21,
  ): Promise<z.infer<typeof messageSchema>[]> {
    if (message.route.platform !== 'wecom' || !this.groups.includes(message.route.conversation))
      return [];
    if (signal?.aborted) throw signal.reason;
    const key = JSON.stringify([message.route.account, message.route.conversation, message.id]);
    const old = this.cached.get(key);
    if (old && old.limit >= limit && this.now() - old.at < 15_000) return old.rows;
    await verifyWecomIdentity(this.cli, this.botId, signal);
    const end = this.now(),
      begin = end - 24 * 60 * 60 * 1000;
    const rows: z.infer<typeof messageSchema>[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const args = [
        'chat',
        'messages',
        'list',
        '--chat-id',
        message.route.conversation,
        '--begin-time',
        localTime(new Date(begin)),
        '--end-time',
        localTime(new Date(end)),
      ];
      if (cursor) args.push('--cursor', cursor);
      const parsed = responseSchema.safeParse(JSON.parse(await this.cli(args, signal)));
      if (!parsed.success)
        throw new Error('企微群聊补读返回格式异常，请检查 CLI 授权与消息读取权限。');
      rows.push(...parsed.data.messages);
      if (rows.length >= limit || !parsed.data.has_more) break;
      cursor = parsed.data.next_cursor;
      if (!cursor || cursors.has(cursor)) throw new Error('企微群聊补读分页异常，请稍后重试。');
      cursors.add(cursor);
    }
    const filtered = rows
      .filter((row) => {
        const at = Date.parse(row.send_time.replace(' ', 'T') + '+08:00');
        return Number.isFinite(at) && at >= begin && at <= end;
      })
      .sort((a, b) => a.send_time.localeCompare(b.send_time))
      .slice(-100);
    this.cached.set(key, { at: this.now(), limit, rows: filtered });
    while (this.cached.size > 20) this.cached.delete(this.cached.keys().next().value!);
    return filtered;
  }
  async attachments(message: Incoming, signal?: AbortSignal): Promise<Incoming[]> {
    try {
      const cutoff = message.receivedAt ?? this.now();
      const rows = (await this.rows(message, signal, 100)).filter(
        (row) => Date.parse(row.send_time.replace(' ', 'T') + '+08:00') <= cutoff,
      );
      const text = normalized(message.text);
      const trigger = text
        ? rows.findLastIndex((row) => {
            const value = normalized(row.text?.content ?? '');
            return value === text || value.startsWith(text + '**quote**');
          })
        : -1;
      const before = trigger >= 0 ? trigger : rows.length,
        occurrences = new Map<string, number>();
      return rows.slice(0, before).flatMap((row, index) => {
        const refs: AttachmentRef[] = [];
        const add = (
          value: z.infer<typeof media> | undefined,
          type: 'file' | 'image',
          name: string,
        ) => {
          if (!value?.media_id) return;
          const ref = {
            key: wecomMediaKey(message.route, value.media_id),
            name: value.file_name || name,
            type,
          };
          if (!refs.some((r) => r.key === ref.key)) refs.push(ref);
        };
        if (row.msg_type === 'mixed') {
          for (const item of row.mixed?.items || []) {
            if (item.msg_type === 'image') add(item.image, 'image', 'image.jpg');
          }
        } else if (row.msg_type === 'image') add(row.image, 'image', 'image.jpg');
        else if (row.msg_type === 'file') add(row.file, 'file', 'attachment');
        else if (row.msg_type === 'voice') add(row.voice, 'file', 'voice.amr');
        else if (row.msg_type === 'video') add(row.video, 'file', 'video.mp4');
        if (!refs.length) return [];
        // CLI media IDs rotate between reads. Identity describes the source row,
        // while key remains the newest transport credential used for downloading.
        const signature = JSON.stringify([
          message.route.account,
          message.route.conversation,
          row.send_time,
          row.msg_type,
          refs.map((r) => [r.name, r.type]),
        ]);
        const occurrence = occurrences.get(signature) ?? 0;
        occurrences.set(signature, occurrence + 1);
        const digest = createHash('sha256')
          .update(JSON.stringify([signature, occurrence]))
          .digest('hex');
        const id = 'wecom-history:' + digest;
        refs.forEach((ref, index) => {
          ref.sourceId = `wecom-source:${digest}:${index}`;
        });
        // These are resource registrations for the requesting session, never replayed tasks.
        return [
          {
            id,
            route: { ...message.route },
            text: '',
            attachments: refs,
            attachmentContext: {
              sentAt: Date.parse(row.send_time.replace(' ', 'T') + '+08:00'),
              messagesBefore: before - index,
            },
          },
        ];
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof Error && error.message.startsWith('企微')) throw error;
      throw new Error('企微历史附件读取失败，请检查 CLI 授权与群聊权限。');
    }
  }
  async read(message: Incoming, signal?: AbortSignal): Promise<GroupReference[]> {
    if (message.route.platform !== 'wecom' || !this.groups.includes(message.route.conversation))
      return [];
    try {
      const rows = await this.rows(message, signal);
      const records = rows
        .flatMap((row) => {
          const at = Date.parse(row.send_time.replace(' ', 'T') + '+08:00');
          let text = row.text?.content || '';
          if (row.msg_type === 'mixed')
            text = (row.mixed?.items || [])
              .map((item) =>
                item.msg_type === 'text'
                  ? item.text?.content || ''
                  : `[${item.msg_type}附件，未下载]`,
              )
              .join('\n');
          else if (row.msg_type !== 'text')
            text = `[${({ image: '图片', file: '文件', voice: '语音', video: '视频' } as Record<string, string>)[row.msg_type] || row.msg_type}：${row.file?.file_name || '附件'}，未下载]`;
          if (!text) return [];
          return [
            {
              sender: (row.user_name || row.userid || '群成员').slice(0, 100),
              text: text.length > 1000 ? text.slice(0, 1000) + '…[截断]' : text,
              at,
            },
          ];
        })
        .sort((a, b) => a.at - b.at);
      // CLI has no stable message ID. Remove only the newest matching trigger;
      // do not pretend a text fingerprint guarantees incremental deduplication.
      const trigger = records.findLastIndex(
        (row) => normalized(row.text) === normalized(message.text),
      );
      if (trigger >= 0) records.splice(trigger, 1);
      return records.slice(-20);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof Error && error.message.startsWith('企微')) throw error;
      throw new Error('企微群聊补读失败，请检查官方 CLI 的授权和群消息读取权限。');
    }
  }
}
