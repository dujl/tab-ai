import { type Store } from './store.js';
import { type AttachmentRef, type LocalAttachment, type Incoming, type Session } from './types.js';
export function attachmentReplyText(message: Incoming, pendingText: string): string {
  const raw = message.text.trim();
  if (
    message.route.platform !== 'wecom' ||
    message.direct ||
    message.route.conversation === message.route.sender
  )
    return raw;
  // The original request gives us an exact address, including names ending in
  // digits. This also handles WeCom's compact "@bot15" representation of @bot1 + 5.
  const address = /^@[^\s@]+(?=\s)/u.exec(pendingText.trim())?.[0];
  if (address && raw.startsWith(address)) {
    let reply = raw;
    while (reply.startsWith(address)) reply = reply.slice(address.length).trim();
    return reply;
  }
  // Otherwise only peel off an explicitly separated leading address. Never guess
  // where digits in an unknown bot name end, or rewrite ordinary Agent input.
  return raw.replace(/^(?:@[^\s@]+\s+)+/u, '').trim();
}
export function attachmentChoice(message: Incoming, pending: Session['pendingAttachmentRequest']) {
  if (!pending || Date.now() - pending.at >= 86400_000) return;
  const reply = attachmentReplyText(message, pending.text);
  const ordinal = /^(?:用|选|选择)?\s*第?\s*(\d+)\s*(?:个附件|个文件|个|份|号)?[。.!！]?$/.exec(
    reply,
  );
  if (ordinal) return { kind: 'ordinal' as const, reply, index: Number(ordinal[1]) - 1 };
  if (pending.options.some((o) => o.name === reply)) return { kind: 'filename' as const, reply };
  if (/^(?:不用了|取消(?:分析|处理)?|先别(?:分析|处理)|不要(?:分析|处理)了?)[。.!！]?$/.test(reply))
    return { kind: 'cancel' as const, reply };
}
export interface SessionAttachment {
  messageId: string;
  ref?: AttachmentRef;
  file?: LocalAttachment;
  at?: number;
  eventId?: number;
}
export function sessionAttachments(store: Store, id: string): SessionAttachment[] {
  const entries: SessionAttachment[] = [];
  for (const event of store.events(id, 5000)) {
    if (event.type === 'attachment_ref') {
      const data = JSON.parse(event.text) as { messageId: string; attachments: AttachmentRef[] };
      for (const ref of data.attachments) {
        const old = entries.find(
          (e) =>
            (ref.sourceId && e.ref?.sourceId === ref.sourceId) ||
            (e.messageId === data.messageId &&
              (e.ref?.key === ref.key ||
                e.file?.key === ref.key ||
                (!e.file?.key && e.file?.name === ref.name))),
        );
        if (old) old.ref = ref;
        else entries.push({ messageId: data.messageId, ref, at: event.at, eventId: event.id });
      }
    } else if (event.type === 'attachment') {
      const file = JSON.parse(event.text) as LocalAttachment;
      const old = entries.find(
        (e) =>
          e.messageId === file.messageId &&
          (file.key
            ? (e.ref?.key ?? e.file?.key) === file.key
            : (e.ref?.name ?? e.file?.name) === file.name),
      );
      if (old) old.file = file;
      else entries.push({ messageId: file.messageId, file, at: event.at, eventId: event.id });
    }
  }
  return entries;
}
export function recentAttachment(
  entries: SessionAttachment[],
  message: Incoming,
  references: Incoming[],
  store: Store,
  sessionId: string,
): SessionAttachment[] | undefined {
  // The intent classifier already decided this is an attachment operation. This
  // check only distinguishes a singular contextual reference from an unqualified list.
  if (
    !/(?:这[个份张]?|该|上述|上面|上一条|刚才|最近)[^\n]{0,24}(?:文件|附件|文档|报告|图片|照片|图)/.test(
      message.text,
    ) ||
    /(?:这些|这[两二三四五六七八九十\d]+[个份张])/.test(message.text)
  )
    return;
  const candidates = references.filter(
    (item) =>
      item.attachmentContext &&
      item.attachmentContext.messagesBefore >= 1 &&
      item.attachmentContext.messagesBefore <= 5,
  );
  if (references.some((item) => item.attachmentContext) && !candidates.length) return;
  if (candidates.length) {
    const nearest = Math.min(...candidates.map((item) => item.attachmentContext!.messagesBefore));
    const keys = new Set(
      candidates
        .filter((item) => item.attachmentContext!.messagesBefore === nearest)
        .flatMap((item) => item.attachments?.map((ref) => ref.sourceId ?? ref.key) ?? []),
    );
    const selected = entries.filter((e) => keys.has(e.ref?.sourceId ?? e.ref?.key ?? ''));
    return selected.length === 1 ? selected : undefined;
  }
  // Live uploads already belong to this session's sender/topic. Old historical
  // registrations must never become "recent" merely because they were synced now.
  const cutoff = message.receivedAt ?? Date.now(),
    events = store.events(sessionId, 5000);
  const live = entries.filter(
    (e) =>
      !e.messageId.startsWith('wecom-history:') &&
      e.at !== undefined &&
      e.at <= cutoff &&
      cutoff - e.at <= 24 * 60 * 60 * 1000 &&
      events.filter(
        (event) => event.type === 'user' && event.id > (e.eventId ?? 0) && event.at <= cutoff,
      ).length < 5,
  );
  if (!live.length) return;
  const nearest = Math.max(...live.map((e) => e.eventId ?? 0)),
    selected = live.filter((e) => e.eventId === nearest);
  return selected.length === 1 ? selected : undefined;
}
export function attachmentList(entries: SessionAttachment[]): string {
  return entries.length
    ? entries
        .map(
          (e, i) =>
            `${i + 1}. ${JSON.stringify(e.ref?.name ?? e.file?.name)} · ${e.file ? `已下载\n${e.file.path}` : '未下载'}`,
        )
        .join('\n\n')
    : '本会话暂无附件。';
}
