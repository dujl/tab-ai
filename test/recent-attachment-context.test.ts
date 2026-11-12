import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, incoming } from './helpers.js';
import { WecomHistory } from '../src/channels/wecom-history.js';
import { normalizeWecom } from '../src/channels/normalize.js';
import { sessionAttachments } from '../src/core/session-attachments.js';
import type { Incoming, ManagementView } from '../src/core/types.js';

const now = Date.parse('2025-01-15T10:00:00+08:00');
const route = {
  platform: 'wecom' as const,
  account: 'test-lark',
  conversation: 'wr_group',
  thread: '',
  sender: 'alice',
};
const message = (text: string, id = crypto.randomUUID()): Incoming => ({
  id,
  route,
  text,
  receivedAt: now,
});
const request = '@bot1 对这个文件的信息进行深入的分析';
const file = (name: string, at: string, media = 'media') => ({
  msg_type: 'file',
  send_time: at,
  file: { file_name: name, media_id: media },
});
const text = (content: string, at: string) => ({
  msg_type: 'text',
  send_time: at,
  text: { content },
});
function managed(rows: unknown[]) {
  const f = fixture({
    async classify(input) {
      return {
        action: ['你好', '不用了'].includes(input.text) ? 'continue' : 'attachment_request',
        task: null,
        agent: null,
        instructions: null,
        workspace: null,
      };
    },
  });
  f.config.channels[0] = {
    type: 'wecom',
    id: f.channel.id,
    allowedUsers: ['alice'],
    botIdEnv: 'BOT',
    secretEnv: 'SECRET',
    contextGroups: ['wr_group'],
  };
  let serial = 0;
  const downloaded: Incoming[] = [],
    views: ManagementView[] = [];
  const history = new WecomHistory(
    'bot',
    ['wr_group'],
    async (args) => {
      if (args[0] === 'auth') return 'Bot ID: bot\n';
      serial++;
      return JSON.stringify({
        messages: rows.map((row: any) =>
          row.file
            ? { ...row, file: { ...row.file, media_id: row.file.media_id + '-' + serial } }
            : row,
        ),
      });
    },
    () => now,
  );
  Object.assign(f.channel, {
    referencedAttachments: history.attachments.bind(history),
    async downloadAttachments(m: Incoming) {
      downloaded.push(m);
      return m.attachments!.map((ref) => ({
        name: ref.name,
        path: join(f.dir, ref.name),
        size: 10,
        messageId: m.id,
        key: ref.key,
      }));
    },
    async sendManagement(_m: Incoming, view: ManagementView) {
      views.push(view);
    },
  });
  return { ...f, history, downloaded, views };
}

test('this file automatically selects the immediately preceding PDF despite old attachments and continues the original task', async () => {
  const f = managed([
    file('old.jpg', '2025-01-15 09:00:00', 'old'),
    text('之前的讨论', '2025-01-15 09:10:00'),
    file('report.pdf', '2025-01-15 09:59:58', 'pdf'),
    text(request, '2025-01-15 09:59:59'),
  ]);
  try {
    const session = f.store.create(route, 'codex', f.dir);
    for (let i = 0; i < 6; i++)
      f.store.event(
        session.id,
        'attachment_ref',
        JSON.stringify({
          messageId: 'wecom-history:legacy' + i,
          attachments: [{ key: 'legacy' + i, name: 'old.jpg', type: 'file' }],
        }),
      );
    await f.manager.receive(message(request));
    await f.manager.idle();
    assert.equal(f.downloaded.length, 1);
    assert.equal(f.downloaded[0]!.attachments![0]!.name, 'report.pdf');
    assert.equal(f.agent.inputs.length, 1);
    assert.ok(f.agent.inputs[0]!.text.startsWith(request));
    assert.match(f.agent.inputs[0]!.text, /report\.pdf/);
    assert.equal(f.views.length, 0);
    assert.ok(
      f.store
        .events(session.id)
        .some((e) => e.type === 'attachment_selection' && JSON.parse(e.text).source === 'context'),
    );
  } finally {
    await f.cleanup();
  }
});

test('recent attachment resolution spans a few intervening messages and excludes messages after the trigger', async () => {
  const rows = [
    file('older.pdf', '2025-01-15 09:00:00', 'old'),
    file('wanted.pdf', '2025-01-15 09:59:51', 'wanted'),
    text('背景', '2025-01-15 09:59:52'),
    text('补充', '2025-01-15 09:59:53'),
    text(request, '2025-01-15 09:59:54'),
    file('later.pdf', '2025-01-15 09:59:55', 'later'),
  ];
  const f = managed(rows);
  try {
    await f.manager.receive(message(request));
    await f.manager.idle();
    assert.equal(f.downloaded[0]!.attachments![0]!.name, 'wanted.pdf');
    const refs = sessionAttachments(f.store, f.store.current(route)!.id);
    assert.ok(!refs.some((e) => e.ref?.name === 'later.pdf'));
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('history resource identity survives media credential rotation, updates the key and retains downloaded cache', async () => {
  const f = managed([file('report.pdf', '2025-01-15 09:59:00', 'pdf')]);
  try {
    await f.manager.receive(message(request));
    await f.manager.idle();
    const s = f.store.current(route)!,
      first = sessionAttachments(f.store, s.id)[0]!;
    await f.manager.receive(message('你好'));
    await f.manager.idle();
    const refs = sessionAttachments(f.store, s.id);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.ref!.sourceId, first.ref!.sourceId);
    assert.notEqual(refs[0]!.ref!.key, first.ref!.key);
    assert.equal(refs[0]!.file!.path, first.file!.path);
    await f.manager.receive(message(request));
    await f.manager.idle();
    assert.equal(f.downloaded.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('same-name uploads are distinct source messages and current quoted media takes precedence', async () => {
  const f = managed([
    file('same.pdf', '2025-01-15 09:59:00', 'a'),
    file('same.pdf', '2025-01-15 09:59:00', 'b'),
  ]);
  try {
    await f.manager.receive({
      ...message(request),
      attachments: [{ key: 'quoted', name: 'quoted.pdf', type: 'file' }],
    });
    await f.manager.idle();
    assert.equal(f.downloaded.length, 1);
    assert.equal(f.downloaded[0]!.attachments![0]!.key, 'quoted');
    const refs = sessionAttachments(f.store, f.store.current(route)!.id).filter(
      (e) => e.ref?.name === 'same.pdf',
    );
    assert.equal(refs.length, 2);
    assert.notEqual(refs[0]!.ref!.sourceId, refs[1]!.ref!.sourceId);
  } finally {
    await f.cleanup();
  }
});

test('multiple resources in the nearest message remain ambiguous and produce plain text instead of a management card', async () => {
  const f = managed([
    {
      msg_type: 'mixed',
      send_time: '2025-01-15 09:59:58',
      mixed: {
        items: [
          { msg_type: 'image', image: { media_id: 'a' } },
          { msg_type: 'image', image: { media_id: 'b' } },
        ],
      },
    },
    text(request, '2025-01-15 09:59:59'),
  ]);
  try {
    await f.manager.receive(message(request));
    assert.equal(f.downloaded.length, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.views.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /序号/);
    const s = f.store.current(route)!;
    assert.ok(f.store.events(s.id).some((e) => e.type === 'attachment_clarification'));
    assert.ok(!f.store.events(s.id).some((e) => e.type === 'routing_error'));
  } finally {
    await f.cleanup();
  }
});

test('an old history file outside the recent five messages is not substituted by an unrelated cached live upload', async () => {
  const f = managed([
    file('old.pdf', '2025-01-15 09:00:00'),
    ...Array.from({ length: 6 }, (_, i) => text('讨论' + i, '2025-01-15 09:59:5' + i)),
    text(request, '2025-01-15 09:59:59'),
  ]);
  try {
    const s = f.store.create(route, 'codex', f.dir);
    f.store.event(
      s.id,
      'attachment_ref',
      JSON.stringify({
        messageId: 'old-live',
        attachments: [{ key: 'unrelated', name: 'cached.jpg', type: 'image' }],
      }),
    );
    await f.manager.receive(message(request));
    assert.equal(f.downloaded.length, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.views.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('ordinary lookup failures are text, while explicitly addressed menu commands still open the requested card', async () => {
  const f = managed([]);
  try {
    Object.assign(f.channel, {
      async referencedAttachments() {
        throw Error('企微历史读取失败');
      },
    });
    f.store.create(route, 'codex', f.dir);
    await f.manager.receive(message('你好'));
    assert.equal(f.views.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /读取失败/);
    const base = {
      msgid: 'menu',
      chattype: 'group',
      chatid: 'wr_group',
      from: { userid: 'alice' },
      msgtype: 'text',
    };
    for (const content of ['@bot1 /tab menu', '@bot1\u00a0/tab menu', '@bot1/tab menu']) {
      const m = normalizeWecom(
        { ...base, msgid: crypto.randomUUID(), text: { content } },
        route.account,
      )!;
      assert.equal(m.text, '/tab menu');
      await f.manager.receive(m);
      assert.equal(f.views.at(-1)!.scope, 'session');
    }
    assert.equal(f.views.length, 3);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(
      normalizeWecom({ ...base, text: { content: '@bot1 分析这个文件' } }, route.account)!.text,
      '@bot1 分析这个文件',
    );
    assert.equal(
      normalizeWecom({ ...base, text: { content: '请解释 @bot1 /tab menu' } }, route.account)!.text,
      '请解释 @bot1 /tab menu',
    );
    assert.equal(
      normalizeWecom(
        {
          ...base,
          text: { content: '分析文件' },
          quote: { msgtype: 'text', text: { content: '@bot1 /tab close' } },
        },
        route.account,
      )!.text,
      '分析文件',
    );
  } finally {
    await f.cleanup();
  }
});

test('a reference to this file also resolves the last live upload in the same session', async () => {
  const f = fixture({
    async classify() {
      return {
        action: 'attachment_request',
        task: null,
        agent: null,
        instructions: null,
        workspace: null,
      };
    },
  });
  const downloaded: Incoming[] = [];
  Object.assign(f.channel, {
    async downloadAttachments(m: Incoming) {
      downloaded.push(m);
      return [
        {
          name: m.attachments![0]!.name,
          path: join(f.dir, m.attachments![0]!.name),
          size: 1,
          messageId: m.id,
          key: m.attachments![0]!.key,
        },
      ];
    },
  });
  try {
    await f.manager.receive({
      ...incoming(''),
      attachments: [{ key: 'old', name: 'old.pdf', type: 'file' }],
    });
    await f.manager.receive({
      ...incoming(''),
      attachments: [{ key: 'new', name: 'new.pdf', type: 'file' }],
    });
    await f.manager.receive(incoming('对这个文件的信息进行深入的分析'));
    await f.manager.idle();
    assert.equal(downloaded.length, 1);
    assert.equal(downloaded[0]!.attachments![0]!.key, 'new');
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('missing attachment is a normal clarification and the original task resumes after upload and filename selection', async () => {
  const f = managed([]);
  try {
    await f.manager.receive(message(request));
    const s = f.store.current(route)!;
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.views.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /请上传或引用/);
    assert.doesNotMatch(f.channel.sent.at(-1)!.text, /失败|异常|报错/);
    assert.equal(s.pendingAttachmentRequest!.text, request);
    assert.ok(!f.store.events(s.id).some((e) => e.type === 'routing_error'));
    await f.manager.receive({
      ...message(''),
      attachments: [{ key: 'new', name: 'uploaded.pdf', type: 'file' }],
    });
    assert.equal(f.agent.inputs.length, 0);
    await f.manager.receive(message('uploaded.pdf'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.ok(f.agent.inputs[0]!.text.startsWith(request));
    assert.match(f.agent.inputs[0]!.text, /uploaded\.pdf/);
    assert.equal(f.store.get(s.id)!.pendingAttachmentRequest, undefined);
    assert.equal(f.views.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('a numeric clarification reply selects the shown source snapshot despite rotated IDs or newly received files', async () => {
  const f = managed([
    file('a.pdf', '2025-01-15 09:58:00', 'a'),
    file('b.pdf', '2025-01-15 09:59:00', 'b'),
  ]);
  try {
    await f.manager.receive(message('读取附件并给出详细摘要'));
    const s = f.store.current(route)!;
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.get(s.id)!.pendingAttachmentRequest!.options[0]!.name, 'a.pdf');
    await f.manager.receive({
      ...message(''),
      attachments: [{ key: 'later', name: 'later.pdf', type: 'file' }],
    });
    await f.manager.receive(message('1'));
    await f.manager.idle();
    assert.equal(f.downloaded.length, 1);
    assert.equal(f.downloaded[0]!.attachments![0]!.name, 'a.pdf');
    assert.ok(f.agent.inputs[0]!.text.startsWith('读取附件并给出详细摘要'));
    assert.match(f.agent.inputs[0]!.text, /用户指定附件：1/);
    assert.equal(f.views.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('cancelling a pending attachment request clears it without invoking a model or showing a management card', async () => {
  const f = managed([]);
  try {
    await f.manager.receive(message(request));
    const s = f.store.current(route)!;
    assert.ok(s.pendingAttachmentRequest);
    await f.manager.receive(message('不用了'));
    assert.equal(f.store.get(s.id)!.pendingAttachmentRequest, undefined);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.views.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /已取消/);
  } finally {
    await f.cleanup();
  }
});

test('clarification state is scoped to its session and manual download without candidates does not report success', async () => {
  const f = managed([]);
  try {
    await f.manager.receive(message(request));
    const own = f.store.current(route)!;
    const other = { ...message('1'), route: { ...route, conversation: 'wr_other' } };
    await f.manager.receive(other);
    assert.equal(f.agent.inputs.length, 0);
    assert.ok(!f.channel.sent.at(-1)!.text.includes(request));
    assert.equal(f.store.get(own.id)!.pendingAttachmentRequest!.text, request);
    await f.manager.receive(message('/tab files download 1'));
    assert.equal(f.views.length, 0);
    assert.doesNotMatch(f.channel.sent.at(-1)!.text, /已准备好/);
    assert.match(f.channel.sent.at(-1)!.text, /请上传或引用/);
  } finally {
    await f.cleanup();
  }
});
