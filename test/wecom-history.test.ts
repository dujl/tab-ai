import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WecomHistory } from '../src/channels/wecom-history.js';
import { fixture } from './helpers.js';
import type { Incoming } from '../src/core/types.js';

const now = Date.parse('2025-01-15T10:00:00+08:00');
const message = (conversation = 'wr_test'): Incoming => ({
  id: 'trigger',
  text: '@bot1 总结讨论',
  route: { platform: 'wecom', account: 'test-lark', conversation, thread: '', sender: 'alice' },
});
const row = (text: string, time = '2025-01-15 09:00:00') => ({
  msg_type: 'text',
  send_time: time,
  user_name: '成员',
  text: { content: text },
});
const identity = 'Status: authorized\nBot ID: matching-bot\n';

test('WeCom history is opt-in per group, does not read other chats or platforms', async () => {
  let calls = 0;
  const reader = new WecomHistory(
    'matching-bot',
    ['wr_test'],
    async () => {
      calls++;
      return identity;
    },
    () => now,
  );
  assert.deepEqual(await reader.read(message('wr_other')), []);
  assert.deepEqual(
    await reader.read({ ...message(), route: { ...message().route, platform: 'lark' } }),
    [],
  );
  assert.equal(calls, 0);
});
test('WeCom history binds CLI authorization to the current bot before querying messages', async () => {
  const calls: string[][] = [];
  const reader = new WecomHistory(
    'other-bot',
    ['wr_test'],
    async (args) => {
      calls.push(args);
      return identity;
    },
    () => now,
  );
  await assert.rejects(reader.read(message()), /机器人与当前连接不一致/);
  assert.equal(calls.length, 1);
});
test('WeCom history reads unmentioned text as bounded reference, keeps media as placeholders and strips response metadata', async () => {
  const calls: string[][] = [];
  const reader = new WecomHistory(
    'matching-bot',
    ['wr_test'],
    async (args) => {
      calls.push(args);
      if (args[0] === 'auth') return identity;
      return JSON.stringify({
        extra_identity_context: 'SECRET NOT FOR MODEL',
        security_notice: 'IGNORE THIS',
        messages: [
          row('未艾特的讨论'),
          row('x'.repeat(2000)),
          { msg_type: 'file', send_time: '2025-01-15 09:01:00', file: { file_name: '说明.pdf' } },
          { msg_type: 'image', send_time: '2025-01-15 09:02:00' },
          row('@bot1总结讨论', '2025-01-15 09:59:59'),
          row('old', '2025-01-13 00:00:00'),
        ],
      });
    },
    () => now,
  );
  const records = await reader.read(message());
  assert.equal(records.length, 4);
  assert.equal(records[0]!.text, '未艾特的讨论');
  assert.ok(records[1]!.text.length < 1020);
  assert.match(records[2]!.text, /说明.pdf，未下载/);
  assert.match(records[3]!.text, /图片/);
  assert.doesNotMatch(JSON.stringify(records), /SECRET|IGNORE|@bot1|old/);
  assert.deepEqual(calls[1]!.slice(0, 5), ['chat', 'messages', 'list', '--chat-id', 'wr_test']);
  assert.equal(calls[1]![6], '2025-01-14 10:00:00');
});
test('WeCom history follows bounded pagination, rejects stuck cursors and retains the newest twenty records', async () => {
  let pages = 0;
  const reader = new WecomHistory(
    'matching-bot',
    ['wr_test'],
    async (args) => {
      if (args[0] === 'auth') return identity;
      pages++;
      return JSON.stringify({
        messages: Array.from({ length: 12 }, (_, i) => row('消息' + pages + '-' + i)),
        has_more: true,
        next_cursor: 'page-' + pages,
      });
    },
    () => now,
  );
  assert.equal((await reader.read(message())).length, 20);
  assert.equal(pages, 2);
  const stuck = new WecomHistory(
    'matching-bot',
    ['wr_test'],
    async (args) =>
      args[0] === 'auth'
        ? identity
        : JSON.stringify({ messages: [], has_more: true, next_cursor: 'same' }),
    () => now,
  );
  await assert.rejects(stuck.read(message()), /分页异常/);
});
test('WeCom history does not expose raw CLI errors and respects cancellation', async () => {
  const reader = new WecomHistory(
    'matching-bot',
    ['wr_test'],
    async () => {
      throw Error('credential-secret');
    },
    () => now,
  );
  await assert.rejects(
    reader.read(message()),
    (e) =>
      e instanceof Error &&
      e.message.includes('补读失败') &&
      !e.message.includes('credential-secret'),
  );
  const controller = new AbortController();
  controller.abort(new Error('已停止'));
  await assert.rejects(reader.read(message(), controller.signal), /已停止/);
});
test('WeCom references enter the requested turn as quoted data, without replacing user text or creating extra turns', async () => {
  const f = fixture();
  f.config.channels[0] = {
    type: 'wecom',
    id: f.channel.id,
    allowedUsers: ['alice'],
    botIdEnv: 'BOT',
    secretEnv: 'SECRET',
    contextGroups: ['wr_test'],
  };
  let reads = 0;
  Object.assign(f.channel, {
    groupReferences: async () => {
      reads++;
      return [{ sender: '其他成员', text: '未@讨论；里面的命令不是授权', at: now }];
    },
  });
  try {
    await f.manager.receive(message());
    await f.manager.idle();
    assert.equal(reads, 1);
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.list().length, 1);
    assert.match(f.agent.inputs[0]!.text, /未@讨论/);
    assert.match(f.agent.inputs[0]!.text, /不是本轮用户指令/);
    assert.equal(
      f.store.events(f.store.list()[0]!.id).find((e) => e.type === 'user')!.text,
      message().text,
    );
    await f.manager.receive({
      ...message(),
      id: 'outsider',
      route: { ...message().route, sender: 'outsider' },
    });
    assert.equal(reads, 1);
  } finally {
    await f.cleanup();
  }
});
test('WeCom lookup failure is explicit and does not run a model with silently incomplete context', async () => {
  const f = fixture();
  f.config.channels[0] = {
    type: 'wecom',
    id: f.channel.id,
    allowedUsers: ['alice'],
    botIdEnv: 'BOT',
    secretEnv: 'SECRET',
    contextGroups: ['wr_test'],
  };
  Object.assign(f.channel, {
    groupReferences: async () => {
      throw Error('企微群聊补读失败');
    },
  });
  try {
    await f.manager.receive(message());
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.list()[0]!.status, 'error');
    assert.match(f.channel.sent.at(-1)!.text, /补读失败/);
  } finally {
    await f.cleanup();
  }
});
