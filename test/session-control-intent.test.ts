import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { recognizeSessionControl } from '../src/core/session-control-intent.js';
import { validateTopicDecision } from '../src/core/topic-router.js';
import type { Incoming, ManagementView } from '../src/core/types.js';

test('standalone session requests are recognized without matching negation, questions, code or other targets', () => {
  for (const text of ['关闭会话', '请关闭当前会话。', '帮我结束这个 session', '关闭session'])
    assert.equal(recognizeSessionControl(text), '/tab close', text);
  for (const text of ['打开会话管理', '请显示本会话设置卡片', '查看当前会话管理菜单'])
    assert.equal(recognizeSessionControl(text), '/tab menu', text);
  for (const text of ['恢复当前会话', '打开会话'])
    assert.equal(recognizeSessionControl(text), '/tab open', text);
  for (const text of [
    '不要关闭会话',
    '关闭会话了吗？',
    '如何关闭会话',
    '实现关闭会话功能',
    '“关闭会话”',
    '关闭其他会话',
    '关闭所有session',
    '关闭程序的登录session',
    '关闭会话，然后新开一个',
    '等任务完成后关闭会话',
    '打开会话管理，不用了',
  ])
    assert.equal(recognizeSessionControl(text), undefined, text);
});

for (const platform of ['lark', 'wecom', 'dingtalk', 'wechat'] as const)
  test(`${platform} session menu and close act on the current child without invoking an Agent or changing its main`, async () => {
    const f = fixture({
      async classify() {
        throw Error('Management must bypass classification');
      },
    });
    Object.assign(f.config.channels[0]!, { type: platform });
    const views: { message: Incoming; view: ManagementView }[] = [];
    Object.assign(f.channel, {
      async sendManagement(message: Incoming, view: ManagementView) {
        views.push({ message, view });
      },
    });
    const msg = (text: string) => {
      const m = incoming(text);
      m.route.platform = platform;
      return m;
    };
    try {
      const route = msg('').route,
        main = f.store.create({ ...route, thread: '' }, 'codex', f.dir);
      const child = f.store.create(route, 'codex', f.dir);
      child.nativeId = 'keep-native';
      f.store.save(child);
      f.store.event(child.id, 'user', 'keep history');
      const mainBefore = f.store.get(main.id);
      await f.manager.receive(msg('打开会话管理'));
      assert.match(views.at(-1)!.view.title, /^本会话设置/);
      assert.equal(views.at(-1)!.view.session!.id, child.id);
      assert.deepEqual(views.at(-1)!.message.route, route);
      await f.manager.receive(msg('/tab menu more'));
      assert.ok(views.at(-1)!.view.buttons.some((b) => b.command === '/tab close'));
      await f.manager.receive(msg('关闭会话'));
      await f.manager.idle();
      assert.equal(f.store.get(child.id)!.status, 'closed');
      assert.equal(f.store.get(child.id)!.nativeId, 'keep-native');
      assert.equal(f.channel.closedNotices.length, 1);
      assert.deepEqual(f.channel.closedNotices[0]!.route, route);
      await f.manager.receive(msg('打开会话管理'));
      assert.equal(f.store.get(child.id)!.status, 'closed');
      await f.manager.receive(msg('恢复当前会话'));
      assert.equal(f.store.get(child.id)!.status, 'idle');
      assert.equal(f.agent.inputs.length, 0);
      assert.deepEqual(f.store.get(main.id), mainBefore);
      assert.deepEqual(
        f.store
          .events(child.id)
          .filter((e) => e.type === 'user')
          .map((e) => e.text),
        ['keep history'],
      );
    } finally {
      await f.cleanup();
    }
  });

test('group auto menu and close bypass the running Agent queue; close interrupts and retains history', async () => {
  const f = fixture(),
    views: ManagementView[] = [];
  const config = f.config.channels[0]!;
  if (config.type !== 'lark') throw Error('fixture');
  config.groupModes = { 'chat-1': 'auto' };
  Object.assign(f.channel, {
    async sendManagement(_message: Incoming, view: ManagementView) {
      views.push(view);
    },
  });
  const msg = (text: string) => ({
    ...incoming(text),
    direct: false,
    groupMessage: { mentioned: false },
  });
  f.agent.handler = async (run) => {
    run.hooks.nativeId('active-native');
    await new Promise<void>((resolve) =>
      run.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  try {
    await f.manager.receive(msg('long task'));
    await until(() => f.agent.inputs.length === 1);
    const session = f.store.current(msg('').route)!;
    await f.manager.receive(msg('打开会话管理'));
    assert.equal(views.at(-1)!.session!.id, session.id);
    assert.equal(f.store.get(session.id)!.status, 'running');
    await f.manager.receive(msg('/tab menu more'));
    assert.equal(views.at(-1)!.buttons[0]!.command, '/tab close');
    await f.manager.receive(msg('关闭会话'));
    await f.manager.idle();
    assert.equal(f.store.get(session.id)!.status, 'closed');
    assert.equal(f.store.get(session.id)!.nativeId, 'active-native');
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.channel.closedNotices.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('semantic session controls use the same scoped commands and reject work parameters and stale bindings', async () => {
  const f = fixture({
    async classify({ text }) {
      return {
        action: text.includes('按钮') ? 'session_menu' : 'session_close',
        task: null,
        agent: null,
        instructions: null,
        workspace: null,
      };
    },
  });
  const views: ManagementView[] = [];
  Object.assign(f.channel, {
    async sendManagement(_m: Incoming, v: ManagementView) {
      views.push(v);
    },
  });
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    await f.manager.receive(incoming('让我看看本话题的操作按钮'));
    assert.equal(views.at(-1)!.session!.id, s.id);
    await f.manager.receive(incoming('把这里的 session 关掉'));
    await f.manager.idle();
    assert.equal(f.store.get(s.id)!.status, 'closed');
    assert.equal(f.agent.inputs.length, 0);
    for (const field of ['task', 'workspace', 'agent', 'instructions', 'management'])
      assert.throws(() =>
        validateTopicDecision(
          {
            action: 'session_close',
            task: null,
            workspace: null,
            agent: null,
            instructions: null,
            management: null,
            [field]:
              field === 'management'
                ? { intent: 'group_mode.get', parameters: { mode: null } }
                : 'text',
          },
          { text: 'text', recentUserMessages: [] },
        ),
      );
  } finally {
    await f.cleanup();
  }
  let classify!: () => void;
  const next = fixture({
    async classify() {
      await new Promise<void>((resolve) => {
        classify = resolve;
      });
      return {
        action: 'session_close',
        task: null,
        agent: null,
        instructions: null,
        workspace: null,
      };
    },
  });
  try {
    const old = next.store.create(incoming('').route, 'codex', next.dir);
    const request = next.manager.receive(incoming('把这里的 session 关掉'));
    await until(() => !!classify);
    const replacement = next.store.create(old.route, 'claude', next.dir);
    classify();
    await request;
    assert.equal(next.store.get(old.id)!.status, 'idle');
    assert.equal(next.store.get(replacement.id)!.status, 'idle');
    assert.equal(next.agent.inputs.length, 0);
  } finally {
    classify?.();
    await next.cleanup();
  }
});

test('natural management preserves sender authorization and mention-only group policy', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    await f.manager.receive(incoming('关闭会话', 'not-allowed'));
    await f.manager.receive({
      ...incoming('关闭会话'),
      direct: false,
      groupMessage: { mentioned: false },
    });
    assert.equal(f.store.get(s.id)!.status, 'idle');
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.channel.sent.length, 0);
  } finally {
    await f.cleanup();
  }
});
