import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { downloadAttachments, attachmentName } from '../src/channels/attachments.js';
import { normalizeLark } from '../src/channels/normalize.js';
import { Store } from '../src/core/store.js';
import { LarkChannel } from '../src/channels/lark.js';
import { larkResourceError } from '../src/channels/lark-errors.js';
import { sessionAttachments } from '../src/core/session-attachments.js';
import { type Incoming, type Session } from '../src/core/types.js';
import { fixture, incoming, until } from './helpers.js';

function upload(text = '', thread = 'topic-1'): Incoming {
  return {
    ...incoming(text, 'alice', thread),
    attachments: [{ key: 'file_test', name: '报告.md', type: 'file' }],
  };
}
function raw(type: string, content: unknown, overrides = {}) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'alice' } },
    message: {
      message_id: 'om-file',
      chat_id: 'chat',
      chat_type: 'p2p',
      message_type: type,
      content: JSON.stringify(content),
      ...overrides,
    },
  };
}
function downloads(
  f: ReturnType<typeof fixture>,
  fetcher = async () => Readable.from(['真实附件内容']),
) {
  Object.assign(f.channel, {
    downloadAttachments: (message: Incoming, session: Session) =>
      downloadAttachments(f.config.dataDir, message, session, fetcher),
  });
}
test('resource errors parse streamed API failures without exposing credentials or mislabeling network errors', async () => {
  const error = {
    response: {
      status: 400,
      data: Readable.from([
        JSON.stringify({
          code: 99991672,
          msg: 'required [im:message:readonly] Authorization secret',
        }),
      ]),
    },
    config: { headers: { Authorization: 'secret' } },
  };
  const result = await larkResourceError(error, '下载', 'cli_test');
  assert.match(result.message, /99991672/);
  assert.match(result.message, /im:message:readonly/);
  assert.match(result.message, /cli_test/);
  assert.ok(!result.message.includes('secret'));
  const invalid = await larkResourceError(
    { response: { status: 400, data: { code: 99992402, msg: 'secret' } } },
    '下载',
    'cli_test',
  );
  assert.match(invalid.message, /参数/);
  assert.ok(!invalid.message.includes('权限'));
  const network = await larkResourceError({ code: 'ETIMEDOUT' }, '下载', 'cli_test');
  assert.match(network.message, /超时/);
  const malformed = await larkResourceError(
    { response: { status: 502, data: Readable.from(['<html>secret</html>']) } },
    '下载',
    'cli_test',
  );
  assert.match(malformed.message, /HTTP 502/);
  assert.ok(!malformed.message.includes('secret'));
  const oversized = await larkResourceError(
    { response: { data: Readable.from(['a'.repeat(70_000)]) } },
    '下载',
    'cli_test',
  );
  assert.ok(oversized.message.length < 200);
});

test('history recovery uses two 50-message pages and keeps the pagination token', async () => {
  const f = fixture();
  const channel = new LarkChannel(
    f.config.channels[0] as any,
    () => 'credential',
    f.config.dataDir,
  );
  try {
    const m = upload();
    const session = f.store.create(m.route, 'codex', f.dir);
    const requests: any[] = [];
    (channel as any).client = {
      im: {
        message: {
          get: async () => ({
            code: 0,
            data: { items: [{ message_id: 'topic-1', thread_id: 'omt-1' }] },
          }),
          list: async (request: any) => {
            requests.push(request);
            assert.equal(request.params.page_size, 50);
            assert.equal(request.params.container_id_type, 'thread');
            assert.equal(request.params.container_id, 'omt-1');
            return requests.length === 1
              ? { code: 0, data: { items: [], has_more: true, page_token: 'page2' } }
              : {
                  code: 0,
                  data: {
                    items: [
                      {
                        message_id: 'om-old',
                        sender: { id: 'alice' },
                        msg_type: 'file',
                        body: {
                          content: JSON.stringify({ file_key: 'file_old', file_name: 'old.md' }),
                        },
                        root_id: 'topic-1',
                        thread_id: 'omt-1',
                      },
                    ],
                    has_more: true,
                    page_token: 'page3',
                  },
                };
          },
        },
      },
    };
    assert.equal((await channel.recentAttachments(session)).length, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].params.page_token, 'page2');
    (channel as any).client.im.message.list = async () => ({
      code: 99991672,
      msg: 'required im:message:readonly',
    });
    await assert.rejects(channel.recentAttachments(session), /99991672/);
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});
test('Lark downloads with the matching message ID/resource key and hides provider secrets on failure', async () => {
  const f = fixture();
  const channel = new LarkChannel(
    f.config.channels[0] as any,
    () => 'credential',
    f.config.dataDir,
  );
  try {
    const m = upload();
    const session = f.store.create(m.route, 'codex', f.dir);
    const calls: unknown[] = [];
    (channel as any).client = {
      im: {
        messageResource: {
          get: async (request: unknown) => {
            calls.push(request);
            return { getReadableStream: () => Readable.from(['resource']) };
          },
        },
      },
    };
    const files = await channel.downloadAttachments(m, session);
    assert.equal(readFileSync(files[0]!.path, 'utf8'), 'resource');
    assert.deepEqual(calls, [
      { path: { message_id: m.id, file_key: 'file_test' }, params: { type: 'file' } },
    ]);
    (channel as any).client.im.messageResource.get = async () => {
      throw new Error('Authorization: secret');
    };
    await assert.rejects(
      channel.downloadAttachments(upload(), session),
      (error) =>
        error instanceof Error &&
        !error.message.includes('权限') &&
        !error.message.includes('secret'),
    );
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});
test('Lark normalizes file, image, audio, media and post resources without inventing user text', () => {
  for (const type of ['file', 'audio', 'media']) {
    const m = normalizeLark(
      raw(type, { file_key: 'file_1', file_name: '论文.pdf' }),
      'bot',
      'ou-bot',
    )!;
    assert.equal(m.text, '');
    assert.equal(m.attachments![0]!.name, '论文.pdf');
  }
  assert.equal(
    normalizeLark(raw('image', { image_key: 'img_1' }), 'bot', 'ou-bot')!.attachments![0]!.type,
    'image',
  );
  const post = normalizeLark(
    raw('post', {
      zh_cn: {
        title: '标题',
        content: [
          [
            { tag: 'text', text: '分析这张图' },
            { tag: 'img', image_key: 'img_1' },
          ],
          [{ tag: 'img', image_key: 'img_1' }],
        ],
      },
    }),
    'bot',
    'ou-bot',
  )!;
  assert.equal(post.text, '标题\n分析这张图\n');
  assert.equal(post.attachments!.length, 1);
  assert.equal(normalizeLark(raw('file', { file_key: '../bad' }), 'bot', 'ou-bot'), undefined);
  assert.equal(
    normalizeLark(raw('file', { file_key: 'file_1' }, { chat_type: 'group' }), 'bot', 'ou-bot'),
    undefined,
  );
  assert.equal(
    normalizeLark(
      raw(
        'file',
        { file_key: 'file_1' },
        { chat_type: 'group', thread_id: 'omt_1', root_id: 'om_root' },
      ),
      'bot',
      'ou-bot',
    )!.requiresExistingSession,
    true,
  );
});

test('history recovery filters sender and topic and never replays old text', async () => {
  const f = fixture();
  const channel = new LarkChannel(
    f.config.channels[0] as any,
    () => 'credential',
    f.config.dataDir,
  );
  try {
    const m = upload();
    const session = f.store.create(m.route, 'codex', f.dir);
    const item = {
      message_id: 'om-old',
      sender: { id: 'alice' },
      msg_type: 'file',
      body: { content: JSON.stringify({ file_key: 'file_old', file_name: 'old.md' }) },
      root_id: 'topic-1',
      thread_id: 'omt-1',
    };
    (channel as any).client = {
      im: {
        message: {
          get: async () => ({
            code: 0,
            data: { items: [{ message_id: 'topic-1', thread_id: 'omt-1' }] },
          }),
          list: async () => ({
            code: 0,
            data: {
              items: [
                item,
                { ...item, sender: { id: 'bob' } },
                { ...item, root_id: 'topic-2' },
                { ...item, deleted: true },
                { ...item, msg_type: 'text' },
              ],
            },
          }),
        },
      },
    };
    const recovered = await channel.recentAttachments(session);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.text, '');
    assert.equal(recovered[0]!.route.thread, 'topic-1');
    downloads(f);
    Object.assign(f.channel, { recentAttachments: async () => recovered });
    await f.manager.receive(incoming('/tab files sync'));
    await f.manager.receive(incoming('/tab files sync'));
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.events(session.id).filter((e) => e.type === 'attachment_ref').length, 1);
    assert.equal(f.store.events(session.id).filter((e) => e.type === 'attachment').length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /登记 0 条/);
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});

test('downloads preserve bytes, isolate sessions and duplicates, and cannot overwrite instruction files', async () => {
  const f = fixture();
  try {
    const m = upload();
    m.attachments![0]!.name = '../../AGENTS.md';
    const session = f.store.create(m.route, 'codex', f.dir);
    const one = await downloadAttachments(f.config.dataDir, m, session, async () =>
      Readable.from(['hello']),
    );
    const two = await downloadAttachments(f.config.dataDir, m, session, async () =>
      Readable.from(['world']),
    );
    assert.notEqual(one[0]!.path, two[0]!.path);
    assert.equal(readFileSync(one[0]!.path, 'utf8'), 'hello');
    assert.ok(one[0]!.path.startsWith(join(f.config.dataDir, 'attachments')));
    assert.ok(one[0]!.path.endsWith('attachment-AGENTS.md'));
    assert.equal(statSync(one[0]!.path).mode & 0o777, 0o600);
    assert.ok(Buffer.byteLength(attachmentName('中'.repeat(100) + '.pdf')) < 240);
    const other = f.store.create({ ...m.route, thread: 'other' }, 'codex', f.dir);
    const three = await downloadAttachments(f.config.dataDir, m, other, async () =>
      Readable.from(['other']),
    );
    assert.notEqual(one[0]!.path.split('/').at(-3), three[0]!.path.split('/').at(-3));
  } finally {
    await f.cleanup();
  }
});

test('oversize or failed downloads leave no partial files', async () => {
  const f = fixture();
  try {
    const m = upload();
    const session = f.store.create(m.route, 'codex', f.dir);
    await assert.rejects(
      downloadAttachments(f.config.dataDir, m, session, async () => Readable.from(['123456']), 5),
      /25 MB/,
    );
    const root = join(f.config.dataDir, 'attachments');
    for (const dir of readdirSync(root)) assert.deepEqual(readdirSync(join(root, dir)), []);
    await assert.rejects(
      downloadAttachments(f.config.dataDir, m, session, async () => {
        throw new Error('permission');
      }),
      /permission/,
    );
    for (const dir of readdirSync(root)) assert.deepEqual(readdirSync(join(root, dir)), []);
  } finally {
    await f.cleanup();
  }
});

test('uploads only persist metadata; ordinary turns do not download and explicit commands prepare files', async () => {
  const f = fixture();
  let fetched = 0;
  downloads(f, async () => {
    fetched++;
    return Readable.from(['data']);
  });
  try {
    const m = upload();
    await f.manager.receive(m);
    let session = f.store.current(m.route)!;
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(session.instructions, undefined);
    assert.equal(f.store.task(session.id), undefined);
    assert.equal(session.pendingAttachments, undefined);
    assert.equal(fetched, 0);
    // A fresh store can read attachment metadata after restart.
    const reopened = new Store(f.config.dataDir);
    assert.equal(sessionAttachments(reopened, session.id).length, 1);
    reopened.close();
    await f.manager.receive(m);
    assert.equal(f.store.events(session.id).filter((e) => e.type === 'attachment_ref').length, 1);
    await f.manager.receive(incoming('/tab files'));
    assert.match(f.channel.sent.at(-1)!.text, /未下载/);
    assert.equal(fetched, 0);
    await f.manager.receive(incoming('先别下载，聊点别的'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.text, '先别下载，聊点别的');
    assert.equal(fetched, 0);
    await f.manager.receive(incoming('/tab files download 1'));
    assert.equal(fetched, 1);
    await f.manager.receive(incoming('请总结文件'));
    await f.manager.idle();
    assert.match(f.agent.inputs[1]!.text, /^请总结文件\n/);
    assert.match(f.agent.inputs[1]!.text, /attachment-报告.md/);
    assert.equal(f.store.task(session.id), '请总结文件');
    session = f.store.get(session.id)!;
    assert.equal(session.pendingAttachments, undefined);
    await f.manager.receive(incoming('继续'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[2]!.text, '继续');
    await f.manager.receive(incoming('/tab files download 1'));
    assert.equal(fetched, 1);
  } finally {
    await f.cleanup();
  }
});

test('attachments are scoped by sender and topic; unauthorized or unknown group topics do not download', async () => {
  const f = fixture();
  let fetched = 0;
  downloads(f, async () => {
    fetched++;
    return Readable.from(['ok']);
  });
  try {
    const m = upload();
    await f.manager.receive({ ...m, route: { ...m.route, sender: 'stranger' } });
    await f.manager.receive({ ...upload(), requiresExistingSession: true });
    assert.equal(fetched, 0);
    assert.equal(f.store.list().length, 0);
    await f.manager.receive(m);
    await f.manager.receive(incoming('其他人', 'bob'));
    await f.manager.idle();
    await f.manager.receive(incoming('其他话题', 'alice', 'topic-2'));
    await f.manager.idle();
    assert.deepEqual(
      f.agent.inputs.map((x) => x.text),
      ['其他人', '其他话题'],
    );
    const session = f.store.current(m.route)!;
    f.manager.closeSession(session.id);
    await f.manager.receive(upload());
    await f.manager.receive(incoming('/tab files download all'));
    assert.equal(fetched, 0);
  } finally {
    await f.cleanup();
  }
});

test('download failures are visible and never run the associated task', async () => {
  const f = fixture({
    async classify() {
      return {
        action: 'attachment_request',
        workspace: null,
        task: null,
        agent: null,
        instructions: null,
      };
    },
  });
  downloads(f, async () => {
    throw new Error('附件下载失败，请重发');
  });
  try {
    await f.manager.receive(upload('总结文件'));
    assert.equal(f.agent.inputs.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /下载失败/);
    assert.equal(f.store.list()[0]!.pendingAttachments, undefined);
  } finally {
    await f.cleanup();
  }
});

test('explicit semantic attachment requests download only the named file; ambiguous multiple files require selection', async () => {
  const f = fixture({
    async classify(input) {
      assert.ok(input.attachmentNames?.includes('报告.md'));
      return {
        action: 'attachment_request',
        workspace: null,
        task: null,
        agent: null,
        instructions: null,
      };
    },
  });
  let fetched = 0;
  downloads(f, async () => {
    fetched++;
    return Readable.from(['file']);
  });
  try {
    await f.manager.receive(upload());
    const other = upload();
    other.attachments![0] = { key: 'file_other', name: '其他.txt', type: 'file' };
    await f.manager.receive(other);
    assert.equal(fetched, 0);
    await f.manager.receive(incoming('下载附件'));
    assert.equal(fetched, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /序号/);
    await f.manager.receive(incoming('读取报告.md 给我摘要'));
    await f.manager.idle();
    assert.equal(fetched, 1);
    assert.match(f.agent.inputs[0]!.text, /attachment-报告.md/);
    assert.ok(!f.agent.inputs[0]!.text.includes('其他.txt'));
    await f.manager.receive(incoming('/tab files download all'));
    assert.equal(fetched, 2);
    await f.manager.receive(incoming('/tab files download all'));
    assert.equal(fetched, 2);
  } finally {
    await f.cleanup();
  }
});

test('initial task cannot start during download; latest settings and attachment metadata survive', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  downloads(f, async () => {
    await gate;
    return Readable.from(['ok']);
  });
  try {
    const m = upload();
    const session = f.store.create(m.route, 'codex', f.dir);
    session.pendingInitialTask = '初始任务';
    f.store.save(session);
    await f.manager.receive(m);
    const job = f.manager.receive(incoming('/tab files download 1'));
    await until(() =>
      (f.manager as unknown as { downloading: Set<string> }).downloading.has(session.id),
    );
    await f.manager.receive(incoming('/tab begin'));
    assert.equal(f.agent.inputs.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /仍在下载/);
    const latest = f.store.get(session.id)!;
    latest.instructions = '角色指令';
    f.store.save(latest);
    release();
    await job;
    assert.equal(f.store.get(session.id)!.instructions, '角色指令');
    assert.equal(f.store.get(session.id)!.pendingInitialTask, '初始任务');
    await f.manager.receive(incoming('/tab begin'));
    await f.manager.idle();
    assert.match(f.agent.inputs[0]!.text, /初始任务/);
    assert.match(f.agent.inputs[0]!.text, /attachment-/);
  } finally {
    release?.();
    await f.cleanup();
  }
});
