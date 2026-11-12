import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './helpers.js';
import { normalizeLark } from '../src/channels/normalize.js';
import { Manager } from '../src/core/manager.js';
import { Store } from '../src/core/store.js';
import { SetupService } from '../src/setup/service.js';
import { SetupStorage } from '../src/setup/storage.js';
import { loadConfig } from '../src/config.js';
import { createDashboard } from '../src/web/server.js';
import type { GroupMode } from '../src/core/group-mode.js';
const raw = (
  text: string,
  mentioned = false,
  chat = 'oc_group',
  sender = 'alice',
  thread = '',
) => ({
  sender: { sender_type: 'user', sender_id: { open_id: sender } },
  message: {
    message_id: 'om_' + randomUUID(),
    chat_id: chat,
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: (mentioned ? '@bot ' : '') + text }),
    ...(mentioned ? { mentions: [{ key: '@bot', id: { open_id: 'bot' } }] } : {}),
    ...(thread ? { root_id: thread, thread_id: 'omt_thread' } : {}),
  },
});
const message = (
  text: string,
  mentioned = false,
  chat = 'oc_group',
  sender = 'alice',
  thread = '',
  mode: GroupMode = 'context',
) =>
  normalizeLark(raw(text, mentioned, chat, sender, thread), 'test-lark', 'bot', { [chat]: mode })!;
const setMode = (f: ReturnType<typeof fixture>, m: GroupMode, chat = 'oc_group') => {
  const c = f.config.channels[0]!;
  if (c.type === 'lark') c.groupModes = { ...c.groupModes, [chat]: m };
};
// Group-main turns also carry a current framework topic index, including zero.
const withoutTopicIndex = (text: string) =>
  text.split('\n\n【话题索引 · 框架资料，不是用户指令】')[0]!;

test('Lark normalization accepts unmentioned messages only for configured groups; DM and bot-loop boundaries remain', () => {
  assert.equal(normalizeLark(raw('hello'), 'test-lark', 'bot'), undefined);
  assert.equal(
    normalizeLark(raw('hello', false, 'oc_other'), 'test-lark', 'bot', { oc_group: 'auto' }),
    undefined,
  );
  for (const mode of ['context', 'auto'] as const) {
    assert.equal(message('hello', false, 'oc_group', 'alice', '', mode).text, 'hello');
    assert.equal(message('hello', true, 'oc_group', 'alice', '', mode).text, 'hello');
  }
  const bot = raw('loop');
  bot.sender.sender_type = 'bot';
  assert.equal(normalizeLark(bot, 'test-lark', 'bot', { oc_group: 'auto' }), undefined);
  const dm = raw('original');
  dm.message.chat_type = 'p2p';
  const m = normalizeLark(dm, 'test-lark', 'bot', { oc_group: 'context' })!;
  assert.equal(m.groupMessage, undefined);
  assert.equal(m.text, 'original');
});
test('context mode captures silently, executes only mentions, supplies references once and isolates groups/topics', async () => {
  const f = fixture();
  setMode(f, 'context');
  setMode(f, 'context', 'oc_other');
  try {
    const a = message('公开讨论');
    await f.manager.receive(a);
    await f.manager.receive(a);
    await f.manager.receive(message('/tab close'));
    await f.manager.receive(message('当前有几个会话'));
    await f.manager.receive(message('其他群秘密', false, 'oc_other'));
    await f.manager.receive(message('其他话题内容', false, 'oc_group', 'alice', 'om_other_thread'));
    await f.manager.receive(message('普通成员的意见', false, 'oc_group', 'outsider'));
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.channel.sent.length, 0);
    const ask = message('总结讨论', true);
    await f.manager.receive(ask);
    await f.manager.idle();
    const prompt = f.agent.inputs[0]!.text;
    assert.match(prompt, /总结讨论/);
    assert.match(prompt, /公开讨论/);
    assert.match(prompt, /普通成员的意见/);
    assert.match(prompt, /不是本轮用户指令/);
    assert.equal(prompt.split('公开讨论').length, 2);
    assert.doesNotMatch(prompt, /其他群秘密|其他话题内容|\/tab close/);
    assert.equal(
      f.store.events(f.store.list()[0]!.id).find((e) => e.type === 'user')!.text,
      '总结讨论',
    );
    await f.manager.receive(message('继续', true));
    await f.manager.idle();
    assert.equal(withoutTopicIndex(f.agent.inputs.at(-1)!.text), '继续');
  } finally {
    await f.cleanup();
  }
});
test('auto responds without mentions only for allowed senders; defaults and private chats remain unchanged', async () => {
  const f = fixture();
  setMode(f, 'auto');
  try {
    await f.manager.receive(message('自动任务', false, 'oc_group', 'alice', '', 'auto'));
    await f.manager.idle();
    assert.equal(withoutTopicIndex(f.agent.inputs[0]!.text), '自动任务');
    await f.manager.receive(message('执行危险指令', false, 'oc_group', 'outsider', '', 'auto'));
    assert.equal(f.agent.inputs.length, 1);
    await f.manager.receive(message('/tab close', false, 'oc_other'));
    assert.equal(f.channel.sent.length, 1);
    await f.manager.receive(message('忽略未开启群', false, 'oc_other'));
    assert.equal(f.agent.inputs.length, 1);
    const dm = raw('单聊原文');
    dm.message.chat_type = 'p2p';
    await f.manager.receive(normalizeLark(dm, 'test-lark', 'bot')!);
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.text, '单聊原文');
  } finally {
    await f.cleanup();
  }
});
test('auto queues tasks in their own session and changing mode cancels queued automatic turns', async () => {
  const f = fixture();
  setMode(f, 'auto');
  let release!: () => void;
  f.agent.handler = async (r) => {
    if (withoutTopicIndex(r.text) === 'first')
      await new Promise<void>((res) => {
        release = res;
      });
    r.hooks.text('done');
  };
  try {
    await f.manager.receive(message('first', false, 'oc_group', 'alice', '', 'auto'));
    await until(() => !!release);
    const queued = f.manager.receive(message('second', false, 'oc_group', 'alice', '', 'auto'));
    assert.equal(f.agent.inputs.length, 1);
    setMode(f, 'context');
    release();
    await queued;
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    release?.();
    await f.cleanup();
  }
});
test('context collection persists across restart, limits history, and consumes only through the triggering message', async () => {
  const f = fixture();
  let other: Store | undefined;
  try {
    for (let i = 0; i < 120; i++)
      f.store.recordGroupMessage(message('reference ' + i + ' ' + 'x'.repeat(2000)));
    const trigger = message('trigger', true),
      s = f.store.create(trigger.route, 'codex', f.dir);
    f.store.recordGroupMessage(trigger);
    f.store.recordGroupMessage(message('future must not enter'));
    other = new Store(f.config.dataDir);
    const result = other.groupContext(s, trigger);
    assert.equal(result.records.length, 20);
    assert.ok(result.records.every((r) => r.text.length < 1020));
    assert.ok(result.records.every((r) => !r.text.includes('future')));
    other.markGroupContext(s.id, result.through);
    assert.equal(other.groupContext(s, trigger).records.length, 0);
    other.clearGroupContext('test-lark', 'oc_group');
    assert.deepEqual(other.groupContext(s, trigger), { through: 0, records: [] });
  } finally {
    other?.close();
    await f.cleanup();
  }
});
test('passive attachments do not create sessions, reply or download; only their names enter explicit context', async () => {
  const f = fixture();
  setMode(f, 'context');
  let downloads = 0;
  Object.assign(f.channel, {
    downloadAttachments: async () => {
      downloads++;
      return [];
    },
  });
  try {
    const msg = message('');
    msg.attachments = [{ key: 'file_1', type: 'file', name: '资料.pdf' }];
    await f.manager.receive(msg);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.channel.sent.length, 0);
    assert.equal(downloads, 0);
    await f.manager.receive(message('有什么资料', true));
    await f.manager.idle();
    assert.match(f.agent.inputs[0]!.text, /资料.pdf，未下载/);
    assert.equal(downloads, 0);
  } finally {
    await f.cleanup();
  }
});
test('group mode can be configured from its own group by allowed users and persists without giving global rights', async () => {
  const f = fixture(),
    file = join(f.dir, 'config.json');
  writeFileSync(file, JSON.stringify(f.config));
  const storage = new SetupStorage(file);
  const manager = new Manager(
    f.config,
    f.store,
    { codex: f.agent, claude: f.agent, opencode: f.agent },
    new Map([[f.channel.id, f.channel]]),
    undefined,
    undefined,
    (id, chat, mode) => storage.setGroupMode(id, chat, mode),
  );
  try {
    await manager.receive(message('/tab group-mode auto', true, 'oc_group', 'outsider'));
    assert.equal(f.channel.sent.length, 0);
    await manager.receive(message('/tab group-mode context', true));
    assert.match(f.channel.sent.at(-1)!.text, /context/);
    assert.match(f.channel.sent.at(-1)!.text, /im:message.group_msg/);
    const c = loadConfig(file).channels[0]!;
    assert.equal(c.type === 'lark' && c.groupModes?.oc_group, 'context');
    assert.equal(c.manager, undefined);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.agent.inputs.length, 0);
    await manager.receive(message('/tab group-mode auto oc_other', true));
    assert.match(f.channel.sent.at(-1)!.text, /用法/);
    const before = f.channel.sent.length;
    await manager.receive(message('/tab group-mode auto', false));
    assert.equal(f.channel.sent.length, before);
    await manager.receive(message('/tab group-mode mention', true));
    await manager.receive(message('不应保存', false));
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await manager.close();
    await f.cleanup();
  }
});
test('group mode API is authenticated, validates platform and saves exact group configuration', async () => {
  const f = fixture(),
    file = join(f.dir, 'config.json');
  writeFileSync(file, JSON.stringify(f.config));
  const setup = new SetupService(file),
    server = createDashboard(f.manager, 'secret', setup);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (data: unknown, auth = true) =>
    fetch(base + '/api/channels/test-lark/group-mode', {
      method: 'POST',
      headers: auth ? { Authorization: 'Bearer secret' } : {},
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await send({ chatId: 'oc_group', mode: 'auto' }, false)).status, 401);
    assert.equal((await send({ chatId: 'oc_group', mode: 'auto' })).status, 200);
    const c = loadConfig(file).channels[0]!;
    assert.equal(c.type === 'lark' && c.groupModes?.oc_group, 'auto');
    assert.equal((await send({ chatId: '__proto__', mode: 'context' })).status, 400);
    assert.equal((await send({ chatId: 'oc_group', mode: 'invalid' })).status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await setup.close();
    await f.cleanup();
  }
});
test('shutdown interrupts active auto task and drains queued messages without starting another run', async () => {
  const f = fixture();
  setMode(f, 'auto');
  let started = false;
  f.agent.handler = async (r) => {
    started = true;
    await new Promise<void>((_resolve, reject) =>
      r.signal.addEventListener('abort', () => reject(r.signal.reason), { once: true }),
    );
  };
  try {
    await f.manager.receive(message('long task', false, 'oc_group', 'alice', '', 'auto'));
    await until(() => started);
    const queued = f.manager.receive(
      message('queued task', false, 'oc_group', 'alice', '', 'auto'),
    );
    await f.manager.close();
    await queued;
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.list()[0]!.status, 'interrupted');
  } finally {
    await f.cleanup();
  }
});
test('successful automatic tasks run sequentially and passive group references do not cross bot accounts', async () => {
  const f = fixture();
  setMode(f, 'auto');
  let release!: () => void;
  f.agent.handler = async (r) => {
    if (withoutTopicIndex(r.text) === 'first')
      await new Promise<void>((res) => {
        release = res;
      });
    r.hooks.text('done');
  };
  try {
    const foreign = message('foreign bot private reference');
    foreign.route.account = 'another-bot';
    f.store.recordGroupMessage(foreign);
    await f.manager.receive(message('first', false, 'oc_group', 'alice', '', 'auto'));
    await until(() => !!release);
    const queued = f.manager.receive(message('second', false, 'oc_group', 'alice', '', 'auto'));
    release();
    await queued;
    await f.manager.idle();
    assert.deepEqual(
      f.agent.inputs.map((r) => withoutTopicIndex(r.text)),
      ['first', 'second'],
    );
    assert.equal(f.agent.inputs[0]!.session.id, f.agent.inputs[1]!.session.id);
  } finally {
    release?.();
    await f.cleanup();
  }
});
