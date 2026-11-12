import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming } from './helpers.js';
import { normalizeWecom } from '../src/channels/normalize.js';
import { ManagementCards } from '../src/channels/management-cards.js';
import { managementView, managementText } from '../src/core/management-view.js';

test('ordinary prose, quoted commands and similarly named inputs retain their original text', async () => {
  const f = fixture();
  try {
    for (const text of [
      '讨论 /tab status 的行为',
      '`/tab close`',
      '/tab-other',
      '/table',
      '/tab-ai',
    ]) {
      await f.manager.receive(incoming(text, 'alice', ''));
      await f.manager.idle();
      assert.equal(f.agent.inputs.at(-1)!.text, text);
    }
  } finally {
    await f.cleanup();
  }
});

test('all IM platforms dispatch branded commands to the same native session without invoking intent classification', async () => {
  for (const platform of ['lark', 'wechat', 'wecom', 'dingtalk'] as const) {
    const f = fixture({
      async classify() {
        throw Error('Command must not invoke classifier');
      },
    });
    try {
      f.config.channels[0] = { ...f.config.channels[0]!, type: platform } as any;
      Object.assign(f.channel, {
        sendManagement: async (message: any, view: any) =>
          f.channel.send(message, managementText(view)),
      });
      const m = incoming('', 'alice', '');
      m.route.platform = platform;
      m.direct = true;
      const session = f.store.create(m.route, 'claude', f.dir);
      session.nativeId = 'keep-native';
      f.store.save(session);
      for (const action of ['status', 'menu', 'files', 'pending'])
        await f.manager.receive({ ...m, id: crypto.randomUUID(), text: '/tab ' + action });
      assert.equal(f.agent.inputs.length, 0);
      assert.equal(f.store.current(m.route)!.id, session.id);
      assert.equal(f.store.get(session.id)!.nativeId, 'keep-native');
      assert.ok(f.channel.sent.length >= 4);
      assert.ok(f.channel.sent.some((s) => s.text.includes('/tab settings')));
      assert.ok(!f.channel.sent.some((s) => s.text.includes('无法判断管理意图')));
    } finally {
      await f.cleanup();
    }
  }
});

test('WeCom addressed group commands preserve ordinary addressed prose', () => {
  const message = normalizeWecom(
    {
      msgid: 'id',
      chattype: 'group',
      chatid: 'group',
      from: { userid: 'alice' },
      msgtype: 'text',
      text: { content: '@bot1 /tab status' },
    },
    'wecom-bot',
  )!;
  assert.equal(message.text, '/tab status');
  assert.equal(message.route.conversation, 'group');
  const text = '@bot1 请解释 /tab status 的作用';
  assert.equal(
    normalizeWecom(
      {
        msgid: 'id',
        chattype: 'group',
        chatid: 'group',
        from: { userid: 'alice' },
        msgtype: 'text',
        text: { content: text },
      },
      'wecom-bot',
    )!.text,
    text,
  );
});

test('management card commands enforce ownership and dispatch the selected branded action', async () => {
  const f = fixture();
  try {
    const m = incoming(''),
      session = f.store.create(m.route, 'codex', f.dir),
      cards = new ManagementCards(),
      view = managementView('menu', '本会话菜单', session, [
        { label: '状态', command: '/tab status' },
      ]),
      card = cards.open(m, view);
    let text = '';
    cards.handler = async (message) => {
      text = message.text;
    };
    assert.equal(
      cards.submit(card.id, '0', { sender: 'bob', conversation: m.route.conversation }).ok,
      false,
    );
    const action = cards.submit(card.id, '0', {
      sender: 'alice',
      conversation: m.route.conversation,
    });
    assert.equal(action.ok, true);
    await action.run!();
    assert.equal(text, '/tab status');
  } finally {
    await f.cleanup();
  }
});

test('directed commands stay controls in the selected child task', async () => {
  const f = fixture();
  try {
    const m = incoming('', 'alice', ''),
      root = f.store.create(m.route, 'codex', f.dir);
    f.manager.tasks.adoptSession(root.id);
    const child = await f.manager.tasks.createChild(root.id, {
      key: 'child',
      title: '独立研究',
      objective: '研究',
      criteria: '核验',
      start: false,
    });
    for (const text of [
      `/tab task-to ${child.id} /tab status`,
      `/tab task-to ${child.id} /tab menu`,
    ])
      await f.manager.receive({ ...m, id: crypto.randomUUID(), text });
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.taskJobs().filter((j) => j.taskId === child.id).length, 0);
    assert.ok(
      f.channel.sent.filter((s) => s.message.route.thread === child.route.thread).length >= 2,
    );
  } finally {
    await f.cleanup();
  }
});
