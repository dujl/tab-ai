import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming as baseIncoming, until } from './helpers.js';
const incoming = (...args: Parameters<typeof baseIncoming>) => ({
  ...baseIncoming(...args),
  direct: true,
});
import {
  ManagementCards,
  larkManagementCard,
  wecomManagementCard,
} from '../src/channels/management-cards.js';
import { managementActions, managementScope } from '../src/core/management-view.js';
import type { Incoming, ManagementHandler, ManagementView } from '../src/core/types.js';

function managed() {
  const f = fixture();
  f.config.channels[0]!.manager = true;
  const views: { message: Incoming; view: ManagementView }[] = [],
    cards = new ManagementCards();
  Object.assign(f.channel, {
    onManagementAction(handler: ManagementHandler) {
      cards.handler = handler;
    },
    async sendManagement(message: Incoming, view: ManagementView) {
      views.push(structuredClone({ message, view }));
    },
  });
  f.manager.registerChannel(f.channel);
  const click = async (view: { message: Incoming; view: ManagementView }, command: string) => {
    const index = managementActions(view.view).findIndex((b) => b.command === command);
    assert.ok(index >= 0, command);
    const card = cards.open(view.message, view.view),
      result = cards.submit(card.id, String(index), {
        sender: view.message.route.sender,
        conversation: view.message.route.conversation,
      });
    assert.equal(result.ok, true);
    await result.run!();
    return card;
  };
  return { ...f, views, cards, click };
}

test('session and admin cards have disjoint menus, complete navigation, distinct headers and no model runs', async () => {
  const f = managed();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.settings = { model: 'chosen', effort: 'high' };
    s.nativeId = 'native';
    f.store.save(s);
    const before = f.store.list();
    const sessionCommands = [
      '/tab menu',
      '/tab menu more',
      '/tab menu records',
      '/tab menu tools',
      '/tab menu advanced',
      '/tab menu rename',
      '/tab menu terminal',
      '/tab status',
      '/tab workspace',
      '/tab reset',
      '/tab compact',
      '/tab files',
      '/tab history',
      '/tab tools',
      '/tab pending',
      '/tab instructions',
    ];
    const adminCommands = [
      '/tab admin',
      '/tab admin more',
      '/tab admin system',
      '/tab admin create',
      '/tab admin task',
      '/tab admin select status',
      '/tab admin select stop',
      '/tab admin select lifecycle',
      '/tab admin select records',
      '/tab list',
      '/tab sessions',
      '/tab bots',
      '/tab tasks',
      '/tab help',
      `/tab manage ${s.id} status`,
      `/tab manage ${s.id} records`,
      `/tab manage ${s.id} history`,
      `/tab manage ${s.id} tools`,
    ];
    for (const [scope, commands] of [
      ['session', sessionCommands],
      ['admin', adminCommands],
    ] as const) {
      for (const command of commands) {
        await f.manager.receive(incoming(command));
        const result = f.views.at(-1)!,
          view = result.view;
        assert.equal(view.scope, scope, command);
        assert.ok(view.title.startsWith(scope === 'admin' ? '会话管理中心' : '本会话设置'));
        for (const button of managementActions(view))
          assert.equal(
            managementScope(button.command.split(/\s+/)[1]!),
            scope,
            command + ' -> ' + button.command,
          );
        assert.equal(managementScope(view.navigation!.command.split(/\s+/)[1]!), scope);
        const native = wecomManagementCard(f.cards.open(result.message, view));
        assert.ok(native.button_list!.length <= 6);
        if (command === '/tab menu') {
          assert.deepEqual(
            view.buttons.filter((b) => !b.group).map((b) => b.command),
            ['/tab compact', '/tab reset', '/tab settings', '/tab workspace'],
          );
          for (const text of ['chosen', 'high', f.dir, s.id, 'Codex'])
            assert.ok(JSON.stringify(view.information).includes(text));
        }
        if (command === '/tab admin') {
          assert.deepEqual(
            view.buttons.map((b) => b.command),
            [
              '/tab list',
              '/tab admin select status',
              '/tab admin select stop',
              '/tab admin select lifecycle',
            ],
          );
          assert.equal(view.session, undefined);
        }
      }
    }
    assert.equal(f.agent.inputs.length, 0);
    assert.deepEqual(f.store.list(), before);
  } finally {
    await f.cleanup();
  }
});

test('management center remains available without a bound session and page navigation never opens local settings', async () => {
  const f = managed();
  try {
    await f.manager.receive(incoming('/tab admin'));
    const home = f.views.at(-1)!;
    const native = wecomManagementCard(f.cards.open(home.message, home.view));
    const nav = native.button_list!.find((b) => b.text === '更多管理')!;
    const card = f.cards.open(home.message, home.view);
    await f.cards.submit(card.id, nav.key, { sender: 'alice', conversation: 'chat-1' }).run!();
    assert.equal(f.views.at(-1)!.view.scope, 'admin');
    assert.equal(f.views.at(-1)!.view.navigation!.command, '/tab admin');
    await f.click(f.views.at(-1)!, '/tab admin');
    assert.equal(f.views.at(-1)!.view.scope, 'admin');
    assert.equal(f.store.list().length, 0);
    await f.manager.receive(incoming('/tab menu'));
    assert.equal(f.views.at(-1)!.view.scope, 'session');
    assert.ok(
      managementActions(f.views.at(-1)!.view).every(
        (b) => !b.command.includes('admin') && !b.command.includes('list'),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test('admin mutations validate the selected target snapshot, retain the source route and do not depend on the source binding', async () => {
  const f = managed();
  try {
    f.config.channels[0]!.manager = true;
    const m = incoming('', 'alice', ''),
      source = f.store.create(m.route, 'codex', f.dir),
      target = f.store.create(
        { ...m.route, conversation: 'target-chat', sender: 'bob' },
        'claude',
        f.dir,
      );
    target.nativeId = 'target-native';
    target.title = 'target';
    f.store.save(target);
    await f.manager.receive({ ...incoming(`/tab manage ${target.id} status`, 'alice', '') });
    let view = f.views.at(-1)!;
    assert.equal(view.view.scope, 'admin');
    assert.equal(view.view.session!.id, target.id);
    assert.ok(view.view.text.startsWith('目标会话：主会话 · target\n目标 ID：' + target.id));
    assert.deepEqual(view.message.route, m.route);
    assert.equal(view.message.sessionAnchor, false);
    const changed = f.store.get(target.id)!;
    changed.title = 'updated target';
    f.store.save(changed);
    await f.click(view, `/tab manage ${target.id} close`);
    assert.equal(f.store.get(target.id)!.status, 'idle');
    assert.match(f.views.at(-1)!.view.text, /目标会话状态/);
    assert.equal(f.views.at(-1)!.view.scope, 'admin');
    await f.manager.receive(incoming(`/tab manage ${target.id} status`, 'alice', ''));
    view = f.views.at(-1)!;
    const replacement = f.store.create(m.route, 'opencode', f.dir),
      snapshot = f.store.get(replacement.id);
    const card = await f.click(view, `/tab manage ${target.id} close`);
    assert.equal(f.store.get(target.id)!.status, 'closed');
    assert.equal(f.store.get(target.id)!.nativeId, 'target-native');
    assert.equal(f.store.current(m.route)!.id, replacement.id);
    assert.deepEqual(f.store.get(replacement.id), snapshot);
    assert.equal(f.store.get(source.id)!.status, 'idle');
    assert.equal(
      f.cards.submit(
        card.id,
        String(managementActions(view.view).findIndex((b) => b.command.endsWith(' close'))),
        { sender: 'alice', conversation: 'chat-1' },
      ).ok,
      false,
    );
    const reply = f.views.at(-1)!;
    assert.equal(reply.view.scope, 'admin');
    assert.deepEqual(reply.message.route, m.route);
    assert.ok(
      !managementActions(reply.view).some(
        (b) => b.command === '/tab settings' || b.command === '/tab menu',
      ),
    );
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('admin card actions recheck access and cannot stop or close another target after role loss', async () => {
  const f = managed();
  try {
    f.config.channels[0]!.manager = true;
    const source = f.store.create(incoming('').route, 'codex', f.dir),
      target = f.store.create({ ...source.route, sender: 'bob' }, 'claude', f.dir);
    await f.manager.receive(incoming(`/tab manage ${target.id} status`));
    const view = f.views.at(-1)!,
      card = f.cards.open(view.message, view.view);
    const index = managementActions(view.view).findIndex((b) => b.command.endsWith(' close'));
    for (const actor of [
      { sender: 'bob', conversation: 'chat-1' },
      { sender: 'alice', conversation: 'other-chat' },
    ])
      assert.equal(f.cards.submit(card.id, String(index), actor).ok, false);
    f.config.channels[0]!.manager = false;
    await f.cards.submit(card.id, String(index), { sender: 'alice', conversation: 'chat-1' })
      .run!();
    assert.equal(f.store.get(target.id)!.status, 'idle');
    assert.equal(f.store.get(source.id)!.status, 'idle');
    assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
    assert.equal(f.views.at(-1), view);
    await f.manager.receive(incoming(`/tab manage ${target.id} status`));
    assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
    assert.equal(f.views.at(-1), view);
  } finally {
    await f.cleanup();
  }
});

test('WeCom target and model pages expose every item and preserve exact button indices with separate return navigation', async () => {
  const f = managed();
  try {
    Object.assign(f.config.channels[0]!, { type: 'wecom' });
    const m = () => ({
      ...incoming('', 'alice', ''),
      route: {
        platform: 'wecom' as const,
        account: 'test-lark',
        conversation: 'chat-1',
        thread: '',
        sender: 'alice',
      },
    });
    const s = f.store.create(m().route, 'codex', f.dir);
    for (let i = 0; i < 6; i++) f.store.create({ ...s.route, thread: 'mux:' + i }, 'codex', f.dir);
    Object.assign(f.agent, {
      async models() {
        return Array.from({ length: 7 }, (_, i) => ({
          id: 'm' + i,
          label: '模型' + i,
          efforts: [],
        }));
      },
    });
    for (const kind of ['targets', 'models'] as const) {
      const seen = new Set<string>();
      let command = kind === 'targets' ? '/tab admin select status' : '/tab settings';
      while (true) {
        await f.manager.receive({ ...m(), text: command });
        const result = f.views.at(-1)!,
          card = f.cards.open(result.message, result.view),
          native = wecomManagementCard(card);
        assert.ok(native.button_list!.length <= 6);
        assert.equal(native.button_list!.length, result.view.buttons.length + 2);
        for (const b of native.button_list!.filter((b) => b.key !== 'details')) {
          const action = managementActions(result.view)[Number(b.key)]!;
          assert.equal(b.text, Array.from(action.label).slice(0, 10).join(''));
          if (kind === 'targets' && action.command.startsWith('/tab manage '))
            seen.add(action.command.split(' ')[2]!);
          if (kind === 'models' && action.command.startsWith('/tab settings choose '))
            seen.add(action.command.split(' ')[3]!);
        }
        assert.equal(
          result.view.navigation!.command,
          kind === 'targets' ? '/tab admin' : '/tab menu',
        );
        const next = result.view.buttons.find((b) => b.label === '下一页');
        if (!next) break;
        command = next.command;
      }
      assert.equal(seen.size, 7);
    }
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.get(s.id)!.settings, undefined);
  } finally {
    await f.cleanup();
  }
});

test('stopping a selected running session leaves the source session untouched and returns only admin actions', async () => {
  const f = managed();
  try {
    const source = f.store.create(incoming('').route, 'codex', f.dir),
      target = f.store.create(incoming('', 'alice', 'other-topic').route, 'codex', f.dir);
    f.agent.handler = async (run) => {
      await new Promise<void>((resolve) =>
        run.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    await f.manager.receive(incoming('long task', 'alice', 'other-topic'));
    await until(() => f.agent.inputs.length === 1);
    await f.manager.receive(incoming(`/tab manage ${target.id} status`));
    const view = f.views.at(-1)!;
    assert.equal(view.view.session!.id, target.id);
    const lark = larkManagementCard(f.cards.open(view.message, view.view));
    assert.ok(JSON.stringify(lark).includes('跨会话管理'));
    assert.ok(!JSON.stringify(lark).includes('/tab menu'));
    await f.click(view, `/tab manage ${target.id} stop`);
    await f.manager.idle();
    assert.equal(f.store.get(source.id)!.status, 'idle');
    assert.notEqual(f.store.get(target.id)!.status, 'running');
    const admin = f.views.filter((v) => v.message.route.thread === source.route.thread).at(-1)!;
    assert.equal(admin.view.scope, 'admin');
    assert.equal(f.store.current(source.route)!.id, source.id);
  } finally {
    await f.cleanup();
  }
});

test('text-channel admin commands remain usable when quoting a menu without a session anchor', async () => {
  const f = managed();
  try {
    Object.assign(f.config.channels[0]!, { type: 'wechat' });
    const m = () => ({
      ...incoming('', 'alice', ''),
      route: {
        platform: 'wechat' as const,
        account: 'test-lark',
        conversation: 'alice',
        thread: '',
        sender: 'alice',
      },
      unresolvedQuote: true,
    });
    const source = f.store.create(m().route, 'codex', f.dir),
      target = f.store.create({ ...source.route, thread: 'mux:child' }, 'claude', f.dir);
    for (const text of [
      '/tab admin',
      '/tab admin more',
      '/tab list',
      `/tab manage ${target.id} status`,
    ]) {
      await f.manager.receive({ ...m(), text });
      const view = f.views.at(-1)!.view;
      assert.equal(view.scope, 'admin');
      assert.ok(!view.text.includes('无法识别引用'));
      assert.ok(!view.text.includes('/tab use'));
    }
    await f.manager.receive({ ...m(), text: `/tab manage ${target.id} close` });
    assert.equal(f.store.get(target.id)!.status, 'closed');
    assert.equal(f.store.get(source.id)!.status, 'idle');
    await f.manager.receive({ ...m(), text: '/tab reset' });
    assert.match(f.views.at(-1)!.view.text, /无法识别引用/);
    assert.equal(f.store.current(source.route)!.id, source.id);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
