import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, until } from './helpers.js';
import { normalizeWecom } from '../src/channels/normalize.js';
import { attachmentChoice, attachmentReplyText } from '../src/core/session-attachments.js';
import type { Incoming } from '../src/core/types.js';

const original = '@bot1 将这个文件输出为在线文档';
const group = {
  platform: 'wecom' as const,
  account: 'test-lark',
  conversation: 'wr_group',
  thread: '',
  sender: 'alice',
};
function setup(cached = false) {
  let classify = 0,
    lookups = 0,
    downloads = 0,
    historyFailure = false;
  const f = fixture({
    async classify() {
      classify++;
      throw Error('Selection must not need an intent model');
    },
  });
  f.config.channels[0] = {
    type: 'wecom',
    id: 'test-lark',
    allowedUsers: ['alice'],
    botIdEnv: 'ID',
    secretEnv: 'SECRET',
  };
  const session = f.store.create(group, 'codex', f.dir);
  const options = Array.from({ length: 6 }, (_, i) => ({
    messageId: 'history-' + i,
    sourceId: 'source-' + i,
    key: 'key-' + i,
    name: i === 4 ? '示例扫描件 2025-01-15 10.00.pdf' : `file-${i}.pdf`,
  }));
  for (const o of options)
    f.store.event(
      session.id,
      'attachment_ref',
      JSON.stringify({
        messageId: o.messageId,
        attachments: [{ key: o.key, sourceId: o.sourceId, name: o.name, type: 'file' }],
      }),
    );
  if (cached) {
    const o = options[4]!;
    f.store.event(
      session.id,
      'attachment',
      JSON.stringify({
        messageId: o.messageId,
        key: o.key,
        name: o.name,
        path: join(f.dir, o.name),
        size: 10,
      }),
    );
  }
  session.pendingAttachmentRequest = { text: original, at: Date.now(), options };
  f.store.save(session);
  Object.assign(f.channel, {
    async referencedAttachments() {
      lookups++;
      if (historyFailure) throw Error('Should not query CLI for cached file');
      return [];
    },
    async downloadAttachments(message: Incoming) {
      downloads++;
      return message.attachments!.map((ref) => ({
        messageId: message.id,
        key: ref.key,
        name: ref.name,
        path: join(f.dir, ref.name),
        size: 10,
      }));
    },
  });
  const message = (text: string): Incoming =>
    normalizeWecom(
      {
        msgid: crypto.randomUUID(),
        chattype: 'group',
        chatid: group.conversation,
        from: { userid: 'alice' },
        msgtype: 'text',
        text: { content: text },
      },
      'test-lark',
    )!;
  return {
    ...f,
    session,
    options,
    message,
    setHistoryFailure() {
      historyFailure = true;
    },
    counts: () => ({ classify, lookups, downloads }),
  };
}

for (const text of ['@bot1 5', '@bot1\u00a05', '@bot15', '@bot1 选择第5个', '@bot1 @bot1 5'])
  test(`addressed WeCom attachment answer ${JSON.stringify(text)} continues the saved task`, async () => {
    const f = setup();
    try {
      const m = f.message(text);
      assert.equal(m.text, text); // Ordinary user text is preserved by the transport.
      await f.manager.receive(m);
      await f.manager.idle();
      assert.equal(f.counts().classify, 0);
      assert.equal(f.counts().downloads, 1);
      assert.equal(f.agent.inputs.length, 1);
      assert.ok(f.agent.inputs[0]!.text.startsWith(original));
      assert.match(f.agent.inputs[0]!.text, /示例扫描件/);
      const selections = f.store
        .events(f.session.id)
        .filter((e) => e.type === 'attachment_selection');
      assert.equal(selections.length, 1);
      assert.equal(JSON.parse(selections[0]!.text).files[0].messageId, 'history-4');
      assert.equal(JSON.parse(selections[0]!.text).source, 'reply');
      assert.ok(!f.store.get(f.session.id)!.pendingAttachmentRequest);
      assert.ok(!f.channel.sent.some((m) => m.text.includes('不能确定')));
    } finally {
      await f.cleanup();
    }
  });

test('addressed replies reuse the selected cache without CLI lookup or another download', async () => {
  const f = setup(true);
  try {
    f.setHistoryFailure();
    await f.manager.receive(f.message('@bot1 5'));
    await f.manager.idle();
    assert.deepEqual(f.counts(), { classify: 0, lookups: 0, downloads: 0 });
    assert.equal(f.agent.inputs.length, 1);
    assert.match(f.agent.inputs[0]!.text, /本地文件/);
  } finally {
    await f.cleanup();
  }
});

test('an addressed full filename also resumes the original conversion request from cache', async () => {
  const f = setup(true);
  try {
    await f.manager.receive(f.message('@bot1 ' + f.options[4]!.name));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.ok(f.agent.inputs[0]!.text.startsWith(original));
    assert.deepEqual(f.counts(), { classify: 0, lookups: 0, downloads: 0 });
  } finally {
    await f.cleanup();
  }
});

test('numeric selection stays bound to the displayed source when later attachments arrive', async () => {
  const f = setup();
  try {
    f.store.event(
      f.session.id,
      'attachment_ref',
      JSON.stringify({
        messageId: 'newer',
        attachments: [{ key: 'new', name: 'new.pdf', sourceId: 'new-source', type: 'file' }],
      }),
    );
    await f.manager.receive(f.message('@bot15'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.match(f.agent.inputs[0]!.text, /示例扫描件/);
    assert.ok(!f.agent.inputs[0]!.text.includes('new.pdf'));
  } finally {
    await f.cleanup();
  }
});

test('addressed cancellation clears pending work without a classifier, CLI lookup or work run', async () => {
  const f = setup();
  try {
    await f.manager.receive(f.message('@bot1 不用了'));
    assert.deepEqual(f.counts(), { classify: 0, lookups: 0, downloads: 0 });
    assert.equal(f.agent.inputs.length, 0);
    assert.ok(!f.store.get(f.session.id)!.pendingAttachmentRequest);
    assert.match(f.channel.sent.at(-1)!.text, /已取消/);
  } finally {
    await f.cleanup();
  }
});

test('addressed replies cannot use another group or sender pending selection', async () => {
  const f = setup();
  try {
    const m = f.message('@bot1 5');
    m.route.conversation = 'wr_other';
    await f.manager.receive(m);
    const other = f.message('@bot1 5');
    other.route.sender = 'bob';
    await f.manager.receive(other);
    assert.equal(f.counts().downloads, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.ok(f.store.get(f.session.id)!.pendingAttachmentRequest);
  } finally {
    await f.cleanup();
  }
});

test('a binding change during attachment reference refresh cannot apply an old choice to a new session', async () => {
  const f = setup();
  let release!: (v: Incoming[]) => void;
  Object.assign(f.channel, {
    referencedAttachments: () =>
      new Promise<Incoming[]>((r) => {
        release = r;
      }),
  });
  try {
    const receiving = f.manager.receive(f.message('@bot1 5'));
    await until(() => !!release);
    const fresh = f.store.create(group, 'codex', f.dir);
    release([]);
    await receiving;
    assert.equal(f.counts().downloads, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.current(group)!.id, fresh.id);
    assert.match(f.channel.sent.at(-1)!.text, /会话或列表已变化/);
  } finally {
    await f.cleanup();
  }
});

test('unknown compact bot names are not guessed, and other platforms keep ordinary text untouched', async () => {
  const f = setup();
  try {
    const pending = { ...f.session.pendingAttachmentRequest!, text: '处理附件' };
    assert.equal(attachmentChoice(f.message('@bot15'), pending), undefined);
    assert.equal(
      attachmentReplyText(
        { ...f.message('@bot1 5'), route: { ...group, platform: 'lark' } },
        original,
      ),
      '@bot1 5',
    );
    assert.equal(attachmentReplyText(f.message('请解释 @bot1 5'), original), '请解释 @bot1 5');
  } finally {
    await f.cleanup();
  }
});
