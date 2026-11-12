import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { ManagementCards, wecomManagementCard } from '../src/channels/management-cards.js';
import { managementActions } from '../src/core/management-view.js';
import type { Incoming, ManagementHandler, ManagementView } from '../src/core/types.js';

function managed() {
  const f = fixture(),
    views: { message: Incoming; view: ManagementView }[] = [],
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
  return { ...f, views, cards };
}

test('common actions stay on the first WeCom card and every secondary menu is reachable within four buttons', async () => {
  const f = managed();
  try {
    Object.assign(f.config.channels[0]!, { type: 'wecom' });
    const m = { ...incoming(''), route: { ...incoming('').route, platform: 'wecom' as const } },
      s = f.store.create(m.route, 'codex', f.dir);
    await f.manager.receive({ ...m, text: '/tab menu' });
    const home = f.views.at(-1)!;
    assert.deepEqual(
      home.view.buttons.filter((b) => !b.group).map((b) => b.label),
      ['压缩会话', '重置会话…', '模型与思考', '工作目录'],
    );
    const native = wecomManagementCard(f.cards.open(home.message, home.view));
    assert.deepEqual(
      native.button_list!.map((b) => b.text),
      ['压缩会话', '重置会话…', '模型与思考', '工作目录', '更多本会话', '查看全文'],
    );
    const queue = ['/tab menu more'],
      visited = new Set<string>(),
      commands = new Set<string>();
    while (queue.length) {
      const command = queue.shift()!;
      if (visited.has(command)) continue;
      visited.add(command);
      await f.manager.receive({ ...incoming(command), route: m.route });
      const view = f.views.at(-1)!.view;
      assert.ok(view.buttons.length <= 4);
      for (const b of managementActions(view)) {
        commands.add(b.command);
        if (b.command.startsWith('/tab menu ')) queue.push(b.command);
      }
    }
    for (const c of [
      'status',
      'history',
      'last',
      'files',
      'tools',
      'pending',
      'loops',
      'instructions',
      'report',
      'experience',
    ])
      assert.ok(commands.has('/tab ' + c), c);
    for (const [status, label] of [
      ['running', '关闭会话'],
      ['closed', '恢复会话'],
    ] as const) {
      s.status = status;
      f.store.save(s);
      await f.manager.receive({ ...incoming('/tab menu more'), route: m.route });
      assert.equal(f.views.at(-1)!.view.buttons[0]!.label, label);
    }
    s.status = 'idle';
    f.store.save(s);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('reset confirms in the original route, archives native history, preserves configuration and starts no model until the next task', async () => {
  for (const platform of ['lark', 'wecom', 'dingtalk', 'wechat'] as const) {
    const f = managed();
    try {
      Object.assign(f.config.channels[0]!, { type: platform });
      const m = incoming('', 'alice', platform === 'lark' ? 'topic-1' : '');
      m.route.platform = platform;
      f.agent.handler = async (run) => {
        assert.equal(run.session.nativeId, undefined);
        run.hooks.nativeId('new-native');
        run.hooks.text('new answer');
      };
      const s = f.store.create(m.route, 'codex', f.dir, 'session instructions');
      Object.assign(s, {
        nativeId: 'old-native',
        settings: { model: 'selected', effort: 'high' },
        codexDeveloperInstructions: 'native instructions',
        ownedTopicRoot: 'om_root',
        pendingInitialTask: 'do not replay',
        pendingAttachments: [{ name: 'old.jpg', path: '/old.jpg', size: 1, messageId: 'old' }],
      });
      f.store.save(s);
      f.store.event(s.id, 'user', 'old secret task');
      f.store.event(s.id, 'response', 'old answer');
      f.store.recordGroupMessage({ ...m, id: 'before', text: 'old group context' });
      const other = f.store.create({ ...m.route, conversation: 'unrelated' }, 'claude', f.dir),
        otherSnapshot = f.store.get(other.id);
      await f.manager.receive({ ...m, text: '/tab reset' });
      assert.equal(f.store.current(m.route)!.id, s.id);
      assert.equal(f.store.get(s.id)!.status, 'idle');
      const confirm = f.views.at(-1)!,
        card = f.cards.open(confirm.message, confirm.view);
      assert.match(confirm.view.text, /不继承旧 Agent 对话/);
      assert.equal(
        f.cards.submit(card.id, '0', { sender: 'bob', conversation: m.route.conversation }).ok,
        false,
      );
      await f.cards.submit(card.id, '0', { sender: 'alice', conversation: m.route.conversation })
        .run!();
      const fresh = f.store.current(m.route)!;
      assert.notEqual(fresh.id, s.id);
      assert.deepEqual(fresh.route, s.route);
      assert.equal(fresh.agent, s.agent);
      assert.equal(fresh.workspace, s.workspace);
      assert.equal(fresh.nativeId, undefined);
      assert.equal(fresh.pendingAttachments, undefined);
      assert.equal(fresh.pendingInitialTask, undefined);
      assert.deepEqual(fresh.settings, s.settings);
      assert.equal(fresh.instructions, s.instructions);
      assert.equal(fresh.codexDeveloperInstructions, s.codexDeveloperInstructions);
      assert.equal(fresh.ownedTopicRoot, s.ownedTopicRoot);
      assert.equal(f.store.get(s.id)!.status, 'closed');
      assert.equal(f.store.get(s.id)!.nativeId, 'old-native');
      assert.ok(f.store.events(s.id).some((e) => e.text === 'old secret task'));
      assert.deepEqual(f.store.get(other.id), otherSnapshot);
      assert.equal(f.agent.inputs.length, 0);
      assert.equal(
        f.cards.submit(card.id, '0', { sender: 'alice', conversation: m.route.conversation }).ok,
        false,
      );
      await f.manager.receive({ ...m, id: 'replay', text: confirm.view.buttons[0]!.command });
      assert.equal(f.store.current(m.route)!.id, fresh.id);
      f.store.recordGroupMessage({ ...m, id: 'after', text: 'new message' });
      assert.deepEqual(f.store.groupContext(fresh, { ...m, id: 'after' }).records, []);
      await f.manager.receive({ ...m, id: 'task', text: 'new task' });
      await f.manager.idle();
      assert.equal(f.agent.inputs.length, 1);
      assert.equal(f.agent.inputs[0]!.session.id, fresh.id);
      assert.equal(f.store.get(fresh.id)!.nativeId, 'new-native');
      assert.ok(!f.agent.inputs[0]!.text.includes('old secret task'));
      assert.ok(f.views.every((v) => v.message.route.conversation === m.route.conversation));
    } finally {
      await f.cleanup();
    }
  }
});

test('reset rejects stale confirmation, running work, downloads, native terminal and task-tree sessions', async () => {
  const f = managed();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'keep';
    f.store.save(s);
    await f.manager.receive(incoming('/tab reset'));
    const confirm = f.views.at(-1)!.view.buttons[0]!.command;
    s.title = 'changed';
    f.store.save(s);
    await f.manager.receive(incoming(confirm));
    assert.match(f.views.at(-1)!.view.text, /状态已变化/);
    for (const status of ['running', 'waiting', 'detached'] as const) {
      s.status = status;
      f.store.save(s);
      await f.manager.receive(incoming('/tab reset'));
      assert.match(f.views.at(-1)!.view.text, /请先停止/);
    }
    s.status = 'idle';
    s.taskId = 'task';
    f.store.save(s);
    await f.manager.receive(incoming('/tab reset'));
    assert.match(f.views.at(-1)!.view.text, /任务树会话/);
    delete s.taskId;
    f.store.save(s);
    const downloading = (f.manager as unknown as { downloading: Set<string> }).downloading;
    downloading.add(s.id);
    await f.manager.receive(incoming('/tab reset'));
    assert.match(f.views.at(-1)!.view.text, /附件下载/);
    downloading.clear();
    f.agent.handler = async (run) => {
      await new Promise<void>((resolve) =>
        run.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    await f.manager.receive(incoming('long task'));
    await until(() => f.agent.inputs.length === 1);
    await f.manager.receive(incoming('/tab reset'));
    assert.match(f.views.at(-1)!.view.text, /请先停止/);
    f.manager.stop(s.id);
    await f.manager.idle();
    assert.equal(f.store.current(s.route)!.id, s.id);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.get(s.id)!.nativeId, 'keep');
  } finally {
    await f.cleanup();
  }
});
