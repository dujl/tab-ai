import { EventEmitter } from 'node:events';
import { WecomChannel } from '../src/channels/wecom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WecomHistory } from '../src/channels/wecom-history.js';
import { WecomMedia, wecomMediaKey } from '../src/channels/wecom-media.js';
import { normalizeWecom } from '../src/channels/normalize.js';
import { sessionAttachments } from '../src/core/session-attachments.js';
import { fixture, until } from './helpers.js';
import type { Incoming } from '../src/core/types.js';

const now = Date.parse('2025-01-15T10:00:00+08:00');
const identity = 'Bot ID: matching-bot\n';
const route = {
  platform: 'wecom' as const,
  account: 'test-lark',
  conversation: 'wr_test',
  thread: '',
  sender: 'alice',
};
const message = (text = '看一下图片'): Incoming => ({ id: 'trigger', text, route });
const row = {
  msg_type: 'file',
  send_time: '2025-01-15 09:00:00',
  userid: 'opaque-cli-user',
  file: { file_name: '截图.jpg', media_id: 'opaque_media' },
};
function wecomFixture(classify?: any) {
  const f = fixture(classify ? { classify } : undefined);
  f.config.channels[0] = {
    type: 'wecom',
    id: f.channel.id,
    allowedUsers: ['alice'],
    botIdEnv: 'BOT',
    secretEnv: 'SECRET',
    contextGroups: ['wr_test'],
  };
  return f;
}

test('WeCom history media becomes stable scoped metadata, never replayed text or downloaded implicitly', async () => {
  let calls = 0;
  const history = new WecomHistory(
    'matching-bot',
    ['wr_test'],
    async (args) => {
      calls++;
      return args[0] === 'auth'
        ? identity
        : JSON.stringify({
            messages: [
              row,
              {
                msg_type: 'mixed',
                send_time: row.send_time,
                mixed: {
                  items: [
                    { msg_type: 'text', text: { content: '/tab close' } },
                    { msg_type: 'image', image: { media_id: 'mixed_media' } },
                  ],
                },
              },
            ],
          });
    },
    () => now,
  );
  const refs = await history.attachments(message());
  assert.equal(refs.length, 2);
  assert.equal(refs[0]!.text, '');
  assert.equal(refs[0]!.attachments![0]!.name, '截图.jpg');
  assert.equal(refs[1]!.attachments![0]!.type, 'image');
  assert.equal(refs[0]!.route.sender, 'alice');
  assert.deepEqual(await history.attachments(message()), refs);
  assert.doesNotMatch(JSON.stringify(refs), /\/tab close|opaque-cli-user/);
  await history.read(message());
  assert.equal(calls, 2);
  assert.deepEqual(
    await history.attachments({ ...message(), route: { ...route, conversation: 'wr_other' } }),
    [],
  );
  assert.notEqual(
    refs[0]!.attachments![0]!.key,
    wecomMediaKey({ ...route, conversation: 'wr_other' }, 'opaque_media'),
  );
});

test('WeCom CLI media download preserves binary bytes, isolates output and cleans staging', async () => {
  const f = wecomFixture();
  let staging = '';
  const bytes = Buffer.from([255, 216, 255, 0, 10, 241, 255, 217]);
  const media = new WecomMedia(f.config.dataDir, 'matching-bot', async (args) => {
    if (args[0] === 'auth') return identity;
    assert.deepEqual(args.slice(0, 5), ['message', 'files', 'get', '--media-id', 'opaque_media']);
    staging = args.at(-1)!;
    await writeFile(join(staging, 'image.jpg'), bytes);
    return JSON.stringify({
      media_item: { media_id: 'opaque_media', file_path: join(staging, 'image.jpg') },
    });
  });
  try {
    const session = f.store.create(route, 'codex', f.dir);
    const files = await media.download(
      {
        ...message(),
        attachments: [
          { key: wecomMediaKey(route, 'opaque_media'), name: '截图.jpg', type: 'image' },
        ],
      },
      session,
    );
    assert.deepEqual(readFileSync(files[0]!.path), bytes);
    await until(() => !existsSync(staging));
  } finally {
    await f.cleanup();
  }
});

test('WeCom CLI downloads reject wrong identity, mismatched media and outside paths without leaking errors', async () => {
  const f = wecomFixture();
  const session = f.store.create(route, 'codex', f.dir);
  const m = {
    ...message(),
    attachments: [
      { key: wecomMediaKey(route, 'opaque_media'), name: 'a.txt', type: 'file' as const },
    ],
  };
  try {
    const wrong = new WecomMedia(f.config.dataDir, 'another-bot', async () => identity);
    await assert.rejects(wrong.download(m, session), /机器人与当前连接不一致/);
    for (const result of [
      { media_id: 'another', content: 'secret' },
      { file_path: join(f.dir, 'outside') },
    ]) {
      await writeFile(join(f.dir, 'outside'), 'do not read');
      const media = new WecomMedia(f.config.dataDir, 'matching-bot', async (args) =>
        args[0] === 'auth' ? identity : JSON.stringify({ media_item: result }),
      );
      await assert.rejects(
        media.download(m, session),
        (e) =>
          e instanceof Error && /下载失败/.test(e.message) && !/secret|do not read/.test(e.message),
      );
    }
    const media = new WecomMedia(f.config.dataDir, 'matching-bot');
    await assert.rejects(
      media.download({ ...m, route: { ...route, conversation: 'wr_other' } }, session),
      /不属于当前聊天/,
    );
  } finally {
    await f.cleanup();
  }
});

test('WeCom live media decrypts official 32-byte padding, caps size, rejects expired/cross-chat resources', async () => {
  const f = wecomFixture();
  const key = randomBytes(32),
    bytes = Buffer.from('real encrypted image bytes');
  const pad = 32 - (bytes.length % 32),
    cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([bytes, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]);
  let time = now,
    fetches = 0;
  const media = new WecomMedia(
    f.config.dataDir,
    'matching-bot',
    undefined,
    (async () => {
      fetches++;
      return new Response(encrypted);
    }) as typeof fetch,
    () => time,
  );
  const ref = media.register(
    route,
    { url: 'https://example.test/media?secret=hidden', aeskey: key.toString('base64') },
    'image',
  );
  const session = f.store.create(route, 'codex', f.dir);
  try {
    assert.doesNotMatch(JSON.stringify(ref), /hidden|aeskey|https/);
    const files = await media.download({ ...message(), attachments: [ref] }, session);
    assert.deepEqual(readFileSync(files[0]!.path), bytes);
    const otherRoute = { ...route, conversation: 'wr_other' },
      other = f.store.create(otherRoute, 'codex', f.dir);
    await assert.rejects(
      media.download({ ...message(), route: otherRoute, attachments: [ref] }, other),
      /失效/,
    );
    time += 300_000;
    await assert.rejects(media.download({ ...message(), attachments: [ref] }, session), /失效/);
    assert.equal(fetches, 1);
    const big = new WecomMedia(
      f.config.dataDir,
      'matching-bot',
      undefined,
      (async () => new Response(Buffer.alloc(25 * 1024 * 1024 + 33))) as typeof fetch,
    );
    const huge = big.register(route, { url: 'https://example.test/huge' }, 'file');
    await assert.rejects(big.download({ ...message(), attachments: [huge] }, session), /25 MB/);
  } finally {
    await f.cleanup();
  }
});

test('WeCom normalizes files, images, mixed and quoted images without executing quote text', async () => {
  const f = wecomFixture();
  const media = new WecomMedia(f.config.dataDir, 'matching-bot');
  const register = media.register.bind(media),
    base = { msgid: 'live', chattype: 'group', chatid: 'wr_test', from: { userid: 'alice' } };
  try {
    const image = { url: 'https://example.test/image', aeskey: 'secret' };
    const file = normalizeWecom(
      { ...base, msgtype: 'file', file: { ...image, file_name: '报告.txt' } },
      route.account,
      register,
    )!;
    assert.equal(file.text, '');
    assert.equal(file.requiresExistingSession, true);
    assert.equal(file.attachments![0]!.name, '报告.txt');
    const mixed = normalizeWecom(
      {
        ...base,
        msgtype: 'mixed',
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: '分析图' } },
            { msgtype: 'image', image },
          ],
        },
      },
      route.account,
      register,
    )!;
    assert.equal(mixed.text, '分析图');
    assert.equal(mixed.attachments!.length, 1);
    const quoted = normalizeWecom(
      {
        ...base,
        msgtype: 'text',
        text: { content: '这是什么图' },
        quote: {
          msgtype: 'mixed',
          mixed: {
            msg_item: [
              { msgtype: 'text', text: { content: '/tab close' } },
              { msgtype: 'image', image },
            ],
          },
        },
      },
      route.account,
      register,
    )!;
    assert.equal(quoted.text, '这是什么图');
    assert.equal(quoted.attachments!.length, 1);
    assert.doesNotMatch(JSON.stringify(quoted), /secret|https|\/tab close/);
    assert.equal(
      normalizeWecom(
        { ...base, chatid: undefined, msgtype: 'image', image },
        route.account,
        register,
      ),
      undefined,
    );
  } finally {
    await f.cleanup();
  }
});

test('WeCom explicit image question discovers historical media before classification and passes downloaded path to agent', async () => {
  const f = wecomFixture(async (input: any) => {
    assert.deepEqual(input.attachmentNames, ['截图.jpg']);
    return {
      action: 'attachment_request',
      task: null,
      agent: null,
      instructions: null,
      workspace: null,
    };
  });
  let downloaded = 0;
  const history = new WecomHistory(
    'matching-bot',
    ['wr_test'],
    async (args) => (args[0] === 'auth' ? identity : JSON.stringify({ messages: [row] })),
    () => now,
  );
  const media = new WecomMedia(f.config.dataDir, 'matching-bot', async (args) => {
    if (args[0] === 'auth') return identity;
    downloaded++;
    return JSON.stringify({ media_item: { media_id: 'opaque_media', content: 'image bytes' } });
  });
  Object.assign(f.channel, {
    referencedAttachments: history.attachments.bind(history),
    groupReferences: history.read.bind(history),
    downloadAttachments: media.download.bind(media),
  });
  try {
    await f.manager.receive(message('你能看到这个图片是什么吗？'));
    await f.manager.idle();
    assert.equal(downloaded, 1);
    assert.equal(f.agent.inputs.length, 1);
    assert.match(f.agent.inputs[0]!.text, /用户上传的附件（本地文件）/);
    const session = f.store.current(route)!;
    assert.equal(sessionAttachments(f.store, session.id)[0]!.file!.size, 11);
    assert.equal(f.store.events(session.id).filter((e) => e.type === 'user').length, 1);
    assert.equal(session.pendingAttachments, undefined);
  } finally {
    await f.cleanup();
  }
});

test('WeCom ordinary messages register history metadata silently without downloading; unauthorized users cannot read history', async () => {
  const f = wecomFixture();
  let reads = 0,
    downloads = 0;
  const history = new WecomHistory(
    'matching-bot',
    ['wr_test'],
    async (args) => {
      reads++;
      return args[0] === 'auth' ? identity : JSON.stringify({ messages: [row] });
    },
    () => now,
  );
  Object.assign(f.channel, {
    referencedAttachments: history.attachments.bind(history),
    downloadAttachments: async () => {
      downloads++;
      return [];
    },
  });
  try {
    await f.manager.receive({ ...message(), route: { ...route, sender: 'outsider' } });
    assert.equal(reads, 0);
    await f.manager.receive(message('你好'));
    await f.manager.idle();
    assert.equal(downloads, 0);
    assert.equal(sessionAttachments(f.store, f.store.current(route)!.id).length, 1);
    assert.ok(!f.channel.sent.some((m) => m.text.startsWith('已收到')));
  } finally {
    await f.cleanup();
  }
});

test('WeCom attached image is selected over older history, and failed downloads never run the work agent', async () => {
  const f = wecomFixture(async () => ({
    action: 'attachment_request',
    task: null,
    agent: null,
    instructions: null,
    workspace: null,
  }));
  const old = {
    ...message(''),
    id: 'old',
    attachments: [{ key: 'old', name: 'old.jpg', type: 'image' as const }],
  };
  Object.assign(f.channel, {
    referencedAttachments: async () => [old],
    downloadAttachments: async (m: Incoming) => {
      assert.equal(m.attachments![0]!.key, 'new');
      throw Error('企微附件下载失败');
    },
  });
  try {
    await f.manager.receive({
      ...message(),
      attachments: [{ key: 'new', name: 'new.jpg', type: 'image' }],
    });
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /下载失败/);
  } finally {
    await f.cleanup();
  }
});

test('WeCom real event wiring registers standalone media without a model turn and consumes quoted media on request', async () => {
  const f = wecomFixture(async () => ({
    action: 'attachment_request',
    task: null,
    agent: null,
    instructions: null,
    workspace: null,
  }));
  class Socket extends EventEmitter {
    sent: string[] = [];
    connect() {
      queueMicrotask(() => this.emit('authenticated'));
    }
    disconnect() {}
    async sendMessage(chat: string) {
      this.sent.push(chat);
      return {};
    }
  }
  const socket = new Socket();
  const channel = new WecomChannel(
    f.config.channels[0] as any,
    () => 'matching-bot',
    f.config.dataDir,
  );
  const media = new WecomMedia(
    f.config.dataDir,
    'matching-bot',
    undefined,
    (async () => new Response('image bytes')) as typeof fetch,
  );
  Object.assign(channel, {
    client: socket,
    media,
    history: { attachments: async () => [], read: async () => [] },
  });
  f.manager.registerChannel(channel);
  try {
    const session = f.store.create(route, 'codex', f.dir);
    await channel.start((m) => f.manager.receive(m));
    const base = {
      msgid: 'wire-image',
      chattype: 'group',
      chatid: 'wr_test',
      from: { userid: 'alice' },
    };
    socket.emit('message.image', {
      body: { ...base, msgtype: 'image', image: { url: 'https://example.test/image' } },
    });
    await until(() => sessionAttachments(f.store, session.id).length === 1);
    assert.equal(f.agent.inputs.length, 0);
    socket.emit('message.text', {
      body: {
        ...base,
        msgid: 'wire-request',
        msgtype: 'text',
        text: { content: '这个图片是什么' },
        quote: { msgtype: 'image', image: { url: 'https://example.test/image' } },
      },
    });
    await until(() => f.agent.inputs.length === 1);
    await f.manager.idle();
    assert.match(f.agent.inputs[0]!.text, /用户上传的附件（本地文件）/);
    assert.ok(socket.sent.every((chat) => chat === 'wr_test'));
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});
