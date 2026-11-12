import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture as baseFixture, incoming as baseIncoming, until } from './helpers.js';
const incoming = (...args: Parameters<typeof baseIncoming>) => ({
  ...baseIncoming(...args),
  direct: true,
});
const fixture = (...args: Parameters<typeof baseFixture>) => {
  const f = baseFixture(...args);
  f.config.channels[0]!.manager = true;
  return f;
};
import { isSessionCountQuery, isSessionStatusQuery } from '../src/core/session-query.js';

test('main query works without a current session and never exposes another route owner', async () => {
  const f = fixture({
    async classify() {
      throw new Error('must not classify management commands');
    },
  });
  try {
    const base = incoming('', 'alice', '').route;
    for (const route of [
      { ...base, sender: 'bob' },
      { ...base, conversation: 'other' },
      { ...base, account: 'other' },
      { ...base, platform: 'wecom' as const },
    ])
      f.store.create(route, 'codex', f.dir);
    const before = f.store.list();
    for (const thread of ['', 'om_no_session']) {
      const request = incoming('/tab main', 'alice', thread);
      await f.manager.receive(request);
      assert.match(f.channel.sent.at(-1)!.text, /尚未创建主会话/);
      assert.equal(f.channel.sent.at(-1)!.message.route.thread, thread);
      assert.equal(f.store.current(request.route), undefined);
    }
    assert.deepEqual(f.store.list(), before);
    assert.equal(f.agent.inputs.length, 0);
    const count = f.channel.sent.length;
    await f.manager.receive(incoming('/tab main', 'eve', ''));
    assert.equal(f.channel.sent.length, count);
  } finally {
    await f.cleanup();
  }
});

for (const agent of ['codex', 'claude'] as const)
  test(`main query returns bound ${agent} session from a topic without changing closed sessions`, async () => {
    const f = fixture({
      async classify() {
        throw new Error('must not classify management commands');
      },
    });
    try {
      const route = incoming('', 'alice', '').route;
      const main = f.store.create(route, agent, f.dir);
      main.nativeId = `${agent}-main-native`;
      f.store.save(main);
      // A newer historical record must not replace the explicitly bound main session.
      const other = f.store.create(route, agent, f.dir);
      other.nativeId = 'wrong-native';
      f.store.save(other);
      f.store.bind(main);
      const topic = f.store.create({ ...route, thread: 'om_topic' }, agent, f.dir);
      topic.nativeId = 'topic-native';
      f.store.save(topic);
      f.manager.closeSession(main.id);
      f.manager.closeSession(topic.id);
      const before = f.store.list(),
        history = f.store.events(main.id);
      for (const thread of ['', 'om_topic', 'om_unbound']) {
        await f.manager.receive(incoming('/tab main', 'alice', thread));
        const result = f.channel.sent.at(-1)!;
        assert.ok(result.text.includes(`tab-ai 管理 ID：${main.id}`));
        assert.ok(
          result.text.includes(
            `${agent === 'codex' ? 'Codex' : 'Claude Code'} 原生 ID：${agent}-main-native`,
          ),
        );
        assert.ok(!result.text.includes('wrong-native'));
        assert.ok(!result.text.includes('topic-native'));
        assert.match(result.text, /closed/);
        assert.equal(result.message.route.thread, thread);
      }
      assert.equal(f.store.current(route)!.id, main.id);
      assert.equal(f.store.current(topic.route)!.id, topic.id);
      assert.deepEqual(f.store.list(), before);
      assert.deepEqual(f.store.events(main.id), history);
      assert.equal(f.agent.inputs.length, 0);
    } finally {
      await f.cleanup();
    }
  });

test('standalone session-count questions are recognized without intercepting ordinary task text', () => {
  for (const text of [
    '你有几个会话',
    '当前还有几个会话？',
    '目前有多少个会话',
    '你当前管理几个会话',
    '当前你管理的会话有多少个',
    '会话数量是多少',
    '你有几个 session',
    '请问你现在一共有几个会话？',
  ])
    assert.equal(isSessionCountQuery(text), true, text);
  for (const text of [
    '“你有几个会话”',
    '解释“你有几个会话”是什么意思',
    '不要查询你有几个会话',
    '设计一个统计当前有几个会话的功能',
    '你有几个会话，然后删除它们',
    '代码里有几个会话类',
  ])
    assert.equal(isSessionCountQuery(text), false, text);
});

test('count works before a session exists and after close without running an agent or changing bindings', async () => {
  const f = fixture();
  try {
    await f.manager.receive(incoming('你有几个会话', 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /共 0 个/);
    assert.equal(f.store.list().length, 0);
    await f.manager.receive(incoming('hello', 'alice', ''));
    await f.manager.idle();
    const main = f.store.current(incoming('', 'alice', '').route)!;
    f.manager.closeSession(main.id);
    const before = f.store.list(),
      history = f.store.events(main.id);
    for (const text of ['你有几个会话', '/tab sessions']) {
      const request = incoming(text, 'alice', '');
      await f.manager.receive(request);
      assert.match(f.channel.sent.at(-1)!.text, /打开 0 个，已关闭 1 个/);
      const count = f.channel.sent.length;
      await f.manager.receive(request);
      assert.equal(f.channel.sent.length, count);
    }
    assert.equal(f.agent.inputs.length, 1);
    assert.deepEqual(f.store.list(), before);
    assert.deepEqual(f.store.events(main.id), history);
    assert.equal(f.store.current(main.route)!.id, main.id);
    await f.manager.receive(incoming('ordinary task', 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /会话已关闭/);
  } finally {
    await f.cleanup();
  }
});

test('ordinary BOT cannot query session inventory even in a direct chat', async () => {
  const f = fixture();
  try {
    f.config.channels[0]!.manager = false;
    const base = incoming('', 'alice', '').route;
    for (const route of [
      base,
      { ...base, thread: 'om_topic' },
      { ...base, sender: 'bob' },
      { ...base, conversation: 'other' },
      { ...base, account: 'other' },
      { ...base, platform: 'local' as const },
    ])
      f.store.create(route, 'codex', f.dir);
    const topic = f.store.current({ ...base, thread: 'om_topic' })!;
    f.manager.closeSession(topic.id);
    for (const thread of ['', 'om_topic']) {
      await f.manager.receive(incoming('你有几个会话', 'alice', thread));
      assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
      assert.doesNotMatch(f.channel.sent.at(-1)!.text, /共 2 个/);
    }
    const sent = f.channel.sent.length;
    await f.manager.receive(incoming('你有几个会话', 'eve', ''));
    assert.equal(f.channel.sent.length, sent);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.list().length, 6);
  } finally {
    await f.cleanup();
  }
});

test('query remains available while waiting for approval and does not settle it', async () => {
  const f = fixture();
  f.agent.handler = async (run) => {
    await run.hooks.ask({ kind: 'approval', title: 'test', detail: 'test' }, run.signal);
  };
  try {
    await f.manager.receive(incoming('run', 'alice', ''));
    await until(() => f.manager.interactions().length === 1);
    const pending = f.manager.interactions()[0]!;
    await f.manager.receive(incoming('你有几个会话', 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /等待确认 1 个/);
    assert.equal(f.manager.interactions()[0]!.id, pending.id);
    assert.equal(f.agent.inputs.length, 1);
    f.manager.answer(pending.sessionId, pending.id, { allow: false });
    await f.manager.idle();
  } finally {
    await f.cleanup();
  }
});

test('semantic manager-DM queries bypass closed state and preserve native contexts', async () => {
  for (const text of [
    '帮我看一下目前总共开了几个会话呢？',
    'How many sessions do I have?',
    '统计一下已关闭和运行中的会话数量',
  ]) {
    const f = fixture({
      async classify() {
        return {
          action: 'session_query',
          workspace: null,
          instructions: null,
          task: null,
          agent: null,
        };
      },
    });
    try {
      const route = incoming('', 'alice', '').route;
      const main = f.store.create(route, 'codex', f.dir);
      main.nativeId = 'keep-native';
      f.store.save(main);
      f.manager.closeSession(main.id);
      f.store.create({ ...route, thread: 'independent' }, 'opencode', f.dir);
      f.store.create({ ...route, sender: 'bob' }, 'claude', f.dir);
      const before = f.store.list(),
        history = f.store.events(main.id);
      await f.manager.receive(incoming(text, 'alice', ''));
      assert.match(f.channel.sent.at(-1)!.text, /共 3 个/);
      assert.match(f.channel.sent.at(-1)!.text, /打开 2 个，已关闭 1 个/);
      assert.equal(f.agent.inputs.length, 0);
      assert.deepEqual(f.store.list(), before);
      assert.deepEqual(f.store.events(main.id), history);
      assert.equal(f.store.current(route)!.nativeId, 'keep-native');
    } finally {
      await f.cleanup();
    }
  }
});
test('count quick path tolerates invisible text markers, sentence punctuation and natural question endings', () => {
  for (const text of [
    '当前有几个会话',
    '当前有几个会话呢？',
    '当前有几个会话，',
    '\u200b当前 有几个 会话\uFEFF？',
  ])
    assert.equal(isSessionCountQuery(text), true, text);
});

test('current-status shortcut does not capture counts, operations, examples or implementation questions', () => {
  for (const text of [
    '会话关闭了吗？',
    '当前会话已经关闭了吗',
    '这个 session 还在运行吗？',
    '请问本话题是否已关闭？',
  ])
    assert.equal(isSessionStatusQuery(text), true, text);
  for (const text of [
    '当前有几个会话',
    '关闭会话',
    '不要查询会话关闭了吗',
    '解释“会话关闭了吗”',
    '会话关闭了吗？如果关闭请恢复',
    '实现判断会话是否关闭的功能',
  ])
    assert.equal(isSessionStatusQuery(text), false, text);
});

test('status uses the current bound topic or main session and never invokes or resumes an agent', async () => {
  const f = fixture({
    async classify() {
      throw new Error('exact status must bypass the classifier');
    },
  });
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    main.nativeId = 'main-native';
    f.store.save(main);
    const topic = f.store.create(incoming('', 'alice', 'topic').route, 'opencode', f.dir);
    topic.nativeId = 'topic-native';
    topic.status = 'closed';
    f.store.save(topic);
    const other = f.store.create(incoming('', 'bob', 'topic').route, 'claude', f.dir);
    other.nativeId = 'bob-private';
    f.store.save(other);
    const before = f.store.list();
    for (const text of ['会话关闭了吗？', '/tab status']) {
      await f.manager.receive(incoming(text, 'alice', 'topic'));
      const reply = f.channel.sent.at(-1)!;
      assert.match(reply.text, /tab-ai 系统 · 当前会话状态/);
      assert.match(reply.text, /当前话题/);
      assert.match(reply.text, /已关闭/);
      assert.ok(reply.text.includes(topic.id));
      assert.match(reply.text, /topic-native/);
      assert.doesNotMatch(reply.text, /main-native|bob-private|会话记录共/);
      assert.equal(reply.message.route.thread, 'topic');
    }
    await f.manager.receive(incoming('会话关闭了吗？', 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /当前主对话/);
    assert.match(f.channel.sent.at(-1)!.text, /已打开，空闲/);
    assert.match(f.channel.sent.at(-1)!.text, /main-native/);
    for (const text of ['会话关闭了吗？', '/tab status']) {
      await f.manager.receive(incoming(text, 'alice', 'unbound'));
      assert.match(f.channel.sent.at(-1)!.text, /尚未绑定会话/);
    }
    assert.deepEqual(f.store.list(), before);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.current(topic.route)!.id, topic.id);
    assert.equal(f.store.current(main.route)!.id, main.id);
  } finally {
    await f.cleanup();
  }
});

test('semantic current-status action stays in-topic while explicit count still summarizes this chat', async () => {
  const f = fixture({
    async classify(input) {
      return {
        action: input.text.includes('几个') ? 'session_query' : 'session_status',
        workspace: null,
        task: null,
        agent: null,
        instructions: null,
      };
    },
  });
  try {
    f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const topic = f.store.create(incoming('', 'alice', 'topic').route, 'claude', f.dir);
    topic.status = 'closed';
    f.store.save(topic);
    const before = f.store.list();
    for (const text of ['这里还开着吗', 'Is this session closed?']) {
      await f.manager.receive(incoming(text, 'alice', 'topic'));
      assert.match(f.channel.sent.at(-1)!.text, /当前话题/);
      assert.ok(f.channel.sent.at(-1)!.text.includes(topic.id));
      assert.doesNotMatch(f.channel.sent.at(-1)!.text, /会话记录共/);
    }
    await f.manager.receive(incoming('帮我看看共有几个会话', 'alice', 'topic'));
    assert.match(f.channel.sent.at(-1)!.text, /共 2 个/);
    assert.deepEqual(f.store.list(), before);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
