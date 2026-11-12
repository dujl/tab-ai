import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { ManagementCards } from '../src/channels/management-cards.js';
import { managementView, managementActions, adminOnlyAction } from '../src/core/management-view.js';
import { normalizeLark } from '../src/channels/normalize.js';
import type { Incoming, ManagementHandler, ManagementView, Channel } from '../src/core/types.js';

function setup(manager = true) {
  const f = fixture();
  f.config.channels[0]!.manager = manager;
  const cards = new ManagementCards(),
    views: { message: Incoming; view: ManagementView }[] = [];
  Object.assign(f.channel, {
    onManagementAction(
      handler: ManagementHandler,
      authorize: Parameters<NonNullable<Channel['onManagementAction']>>[1],
    ) {
      cards.handler = handler;
      cards.authorize = authorize;
      cards.details = async (m, t) => f.channel.send(m, t);
    },
    async sendManagement(message: Incoming, view: ManagementView) {
      views.push(structuredClone({ message, view }));
    },
  });
  f.manager.registerChannel(f.channel);
  return { ...f, cards, views };
}
const dm = (text: string) => ({ ...incoming(text, 'alice', ''), direct: true });
const commands = [
  '/tab admin',
  '/tab admin more',
  '/tab list',
  '/tab sessions',
  '/tab bots',
  '/tab bot-role test-lark manager',
  '你有几个会话',
];

test('cross-session center requires both Manager role and a verified DM; groups, scoped bots and unknown routes reveal no inventory', async () => {
  for (const manager of [false, true])
    for (const direct of [false, true, undefined]) {
      const f = setup(manager);
      try {
        const privateSession = f.store.create(
          { ...incoming('').route, conversation: 'other' },
          'codex',
          f.dir,
        );
        privateSession.title = 'PRIVATE';
        f.store.save(privateSession);
        const before = f.store.list();
        for (const text of [...commands, `/tab manage ${privateSession.id} close`]) {
          await f.manager.receive({
            ...incoming(text, 'alice', ''),
            ...(direct !== undefined ? { direct } : {}),
            ...(direct === false ? { groupMessage: { mentioned: true } } : {}),
          });
          if (manager && direct === true) {
            assert.equal(f.views.at(-1)!.view.scope, 'admin');
            continue;
          }
          assert.equal(f.views.length, 0);
          assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
          assert.doesNotMatch(f.channel.sent.at(-1)!.text, /PRIVATE/);
        }
        if (!(manager && direct === true)) assert.deepEqual(f.store.list(), before);
        assert.equal(f.agent.inputs.length, 0);
      } finally {
        await f.cleanup();
      }
    }
});

test('group help/settings and task/topic/group-mode results contain no center navigation even for a Manager BOT', async () => {
  for (const manager of [false, true]) {
    const f = setup(manager);
    try {
      const msg = (text: string) => ({
        ...incoming(text, 'alice', ''),
        direct: false,
        groupMessage: { mentioned: true },
      });
      const s = f.store.create(msg('').route, 'codex', f.dir, undefined, {
        conversationType: 'group',
      });
      for (const text of [
        '/tab menu',
        '/tab help',
        '/tab tasks',
        '/tab group-mode',
        '/tab new codex',
      ]) {
        await f.manager.receive(msg(text));
        const v = f.views.at(-1)!.view;
        assert.equal(v.scope, 'session', text);
        assert.ok(!v.title.includes('会话管理中心'));
        assert.ok(
          managementActions(v).every((b) => !adminOnlyAction(b.command.split(/\s+/)[1] ?? '')),
        );
        assert.doesNotMatch(v.text, /\/tab (?:admin|list|sessions|manage|bots|bot-role)(?:\s|$)/m);
      }
      assert.equal(f.store.get(s.id)!.status, 'idle');
      assert.equal(f.agent.inputs.length, 0);
      const child = f.store.list().find((x) => !!x.route.thread)!;
      assert.equal(child.topicParentId, s.id);
      assert.equal(f.config.channels[0]!.manager, manager);
    } finally {
      await f.cleanup();
    }
  }
});

test('DM menu callbacks preserve verified chat kind without an existing session and recheck role before full-text disclosure or mutation', async () => {
  const f = setup();
  try {
    await f.manager.receive(dm('/tab admin'));
    const home = f.views.at(-1)!,
      card = f.cards.open(home.message, home.view);
    const list = f.cards.submit(card.id, '0', { sender: 'alice', conversation: 'chat-1' });
    assert.equal(list.ok, true);
    await list.run!();
    assert.equal(f.views.at(-1)!.view.scope, 'admin');
    assert.equal(f.views.at(-1)!.message.direct, true);
    assert.equal(f.store.list().length, 0);
    f.config.channels[0]!.manager = false;
    for (const key of ['0', 'details'])
      assert.equal(
        f.cards.submit(card.id, key, { sender: 'alice', conversation: 'chat-1' }).ok,
        false,
      );
    // Even a callback accepted just before revocation rechecks at execution time.
    const count = f.views.length;
    await list.run!();
    assert.equal(f.views.length, count);
    assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
  } finally {
    await f.cleanup();
  }
});

test('old group admin cards and crafted direct commands cannot close another session', async () => {
  const f = setup();
  try {
    const target = f.store.create(
        { ...incoming('').route, conversation: 'elsewhere' },
        'codex',
        f.dir,
      ),
      message = { ...incoming('', 'alice', ''), direct: false };
    const card = f.cards.open(
      message,
      managementView('manage', 'old menu', target, [
        { label: 'close', command: `/tab manage ${target.id} close`, mutation: true },
      ]),
    );
    assert.equal(
      f.cards.submit(card.id, '0', { sender: 'alice', conversation: 'chat-1' }).ok,
      false,
    );
    await f.cards.handler!(
      { ...message, text: `/tab manage ${target.id} close` },
      card.view.session,
      true,
      'admin',
    );
    assert.equal(f.store.get(target.id)!.status, 'idle');
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('auto group /tab status bypasses the model and active task queue, while context requires a mention', async () => {
  const f = setup();
  try {
    const c = f.config.channels[0]!;
    assert.equal(c.type, 'lark');
    if (c.type !== 'lark') return;
    c.groupModes = { chat: 'auto' };
    const raw = (text: string, mentioned = false) => ({
      sender: { sender_type: 'user', sender_id: { open_id: 'alice' } },
      message: {
        message_id: 'om_' + crypto.randomUUID(),
        chat_id: 'chat',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: (mentioned ? '@bot ' : '') + text }),
        ...(mentioned ? { mentions: [{ key: '@bot', id: { open_id: 'bot' } }] } : {}),
      },
    });
    for (const thread of ['', 'topic']) {
      const r = raw('/tab status');
      Object.assign(r.message, thread ? { thread_id: 'omt_topic', root_id: thread } : {});
      const m = normalizeLark(r, c.id, 'bot', c.groupModes)!;
      assert.ok(m);
      await f.manager.receive(m);
      assert.equal(f.views.at(-1)!.view.scope, 'session');
      assert.match(f.views.at(-1)!.view.text, /尚未绑定会话/);
    }
    assert.equal(f.views.length, 2);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.list().length, 0);
    c.groupModes.chat = 'context';
    const passive = normalizeLark(raw('/tab status'), c.id, 'bot', c.groupModes)!;
    await f.manager.receive(passive);
    assert.equal(f.views.length, 2);
    await f.manager.receive(normalizeLark(raw('/tab status', true), c.id, 'bot', c.groupModes)!);
    assert.equal(f.views.length, 3);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

for (const platform of ['wecom', 'dingtalk', 'wechat'] as const)
  test(`${platform} follows the same Manager-DM restriction with native chat metadata`, async () => {
    const f = setup();
    try {
      Object.assign(f.config.channels[0]!, { type: platform });
      for (const direct of [false, true]) {
        const m = { ...dm('/tab admin'), direct, route: { ...dm('').route, platform } };
        await f.manager.receive(m);
        if (direct) assert.equal(f.views.at(-1)!.view.scope, 'admin');
        else {
          assert.equal(f.views.length, 0);
          assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
        }
      }
      assert.equal(f.agent.inputs.length, 0);
    } finally {
      await f.cleanup();
    }
  });

test('an automatic group status command responds while an Agent is running without stopping or restarting it', async () => {
  const f = setup();
  try {
    const c = f.config.channels[0]!;
    if (c.type !== 'lark') throw Error('fixture');
    c.groupModes = { 'chat-1': 'auto' };
    f.agent.handler = async (run) => {
      await new Promise<void>((resolve) =>
        run.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    const m = (text: string) => ({
      ...incoming(text, 'alice', ''),
      direct: false,
      groupMessage: { mentioned: false },
    });
    await f.manager.receive(m('long running task'));
    await until(() => f.agent.inputs.length === 1);
    assert.equal(f.agent.inputs.length, 1);
    const session = f.store.current(m('').route)!,
      before = f.agent.inputs[0]!.signal;
    await f.manager.receive(m('/tab status'));
    assert.match(f.views.at(-1)!.view.text, /运行中/);
    assert.ok(f.views.at(-1)!.view.text.includes(session.id));
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(before.aborted, false);
  } finally {
    await f.cleanup();
  }
});
