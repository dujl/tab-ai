import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fixture, FakeAgent, FakeChannel, until } from './helpers.js';
import { Manager } from '../src/core/manager.js';
import { Store } from '../src/core/store.js';
import { normalizeLark } from '../src/channels/normalize.js';
import { newTopicIntent } from './fixtures/topic-intent.js';
import { LarkChannel } from '../src/channels/lark.js';
import { type Incoming, type SessionCardView, type Interaction } from '../src/core/types.js';

const message = (text: string, root?: string): Incoming =>
  normalizeLark(
    {
      sender: { sender_type: 'user', sender_id: { open_id: 'alice' } },
      message: {
        message_id: `om_${crypto.randomUUID()}`,
        chat_id: 'chat-1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
        ...(root ? { root_id: root, thread_id: `omt_${root}` } : {}),
      },
    },
    'test-lark',
    'bot',
  )!;

test('main chat preserves native context across topics and full service restart', async () => {
  const f = fixture();
  let next: Manager | undefined, store: Store | undefined;
  f.agent.handler = async (run) => {
    if (!run.session.nativeId) run.hooks.nativeId(`native-${run.session.id}`);
    run.hooks.text('ok');
  };
  try {
    await f.manager.receive(message('main one'));
    await f.manager.idle();
    const main = f.store.current(message('').route)!;
    const create = message('/tab new claude');
    await f.manager.receive(create);
    const topic = f.store.current(message('', create.id).route)!;
    assert.notEqual(main.id, topic.id);
    assert.equal(topic.agent, 'claude');
    assert.equal(f.store.current(message('').route)!.id, main.id);
    for (const input of [
      message('main two'),
      message('topic one', create.id),
      message('main three'),
      message('topic two', create.id),
    ]) {
      await f.manager.receive(input);
      await f.manager.idle();
    }
    assert.equal(f.store.list().length, 2);
    assert.deepEqual(
      f.agent.inputs.map((i) => i.session.id),
      [main.id, main.id, topic.id, main.id, topic.id],
    );
    assert.deepEqual(
      f.agent.inputs.map((i) => i.text.split('\n\n【话题索引')[0]),
      ['main one', 'main two', 'topic one', 'main three', 'topic two'],
    );
    assert.ok(f.agent.inputs[1]!.text.includes(topic.id));
    assert.deepEqual(
      f.store
        .events(main.id)
        .filter((e) => e.type === 'user')
        .map((e) => e.text),
      ['main one', 'main two', 'main three'],
    );
    assert.ok(
      f.channel.sent.filter((s) => !s.message.route.thread).every((s) => !s.message.replyTo),
    );
    const native = f.store.get(main.id)!.nativeId;
    await f.manager.close();
    f.store.close();
    store = new Store(f.config.dataDir);
    const agent = new FakeAgent(),
      channel = new FakeChannel();
    agent.handler = async (run) => {
      assert.equal(run.session.nativeId, native);
      run.hooks.text('resumed');
    };
    next = new Manager(
      f.config,
      store,
      { codex: agent, claude: agent, opencode: agent },
      new Map([[channel.id, channel]]),
    );
    await next.receive(message('after restart'));
    await next.idle();
    assert.equal(agent.inputs[0]!.session.id, main.id);
    assert.equal(store.list().length, 2);
  } finally {
    if (next) {
      await next.close();
      store!.close();
      rmSync(f.dir, { recursive: true, force: true });
    } else await f.cleanup();
  }
});

test('new-topic intent is explicit; only the optional task reaches the agent', async () => {
  for (const text of ['新开一个话题', '请帮我新建一个会话。', '新开一个 session', '创建话题！'])
    assert.deepEqual(newTopicIntent(text), {});
  for (const text of [
    '不要新开一个话题',
    '如何新开一个话题',
    '新开一个话题吗？',
    '“新开一个话题”',
    '`新开一个话题`',
    '解释 /tab new',
    '我想了解新开一个 session 的行为',
  ])
    assert.equal(newTopicIntent(text), undefined);
  const f = fixture();
  try {
    const input = message('新开一个话题：检查 README');
    await f.manager.receive(input);
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.agent.inputs[0]!.text, '检查 README');
    assert.equal(f.agent.inputs[0]!.session.route.thread, input.id);
    assert.equal(f.store.current(message('').route), undefined);
    await f.manager.receive(message('不要新开一个话题'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.text, '不要新开一个话题');
    assert.equal(f.agent.inputs.at(-1)!.session.route.thread, '');
    const count = f.store.list().length;
    await f.manager.receive(input);
    assert.equal(f.store.list().length, count);
    assert.equal(f.agent.inputs.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('new-topic task continuations accept commas, purpose phrases and newlines while preserving task text', () => {
  for (const [text, task] of [
    ['新开一个话题，用于社交媒体视频 生成', '用于社交媒体视频 生成'],
    ['新开一个话题, 用于社交媒体视频生成', '用于社交媒体视频生成'],
    ['请帮我新开一个 session，用来生成短视频', '用来生成短视频'],
    ['新开一个话题用于社交媒体视频生成', '用于社交媒体视频生成'],
    ['新建一个会话 帮我制作视频', '帮我制作视频'],
    ['新开一个话题：检查 README', '检查 README'],
    ['新开一个话题；检查 README', '检查 README'],
    ['新开一个话题\n生成视频\n保留字幕', '生成视频\n保留字幕'],
  ])
    assert.deepEqual(newTopicIntent(text!), { task }, text);
  for (const text of [
    '不要新开一个话题，用于视频生成',
    '如何新开一个话题，用于视频生成？',
    '“新开一个话题，用于视频生成”',
    '`新开一个话题，用于视频生成`',
    '新开一个话题吗？',
    '新开一个 sessionId 字段',
    '新开一个话题，',
  ]) {
    assert.equal(newTopicIntent(text), undefined, text);
  }
});

test('comma task from a closed main or topic creates a separate native session and runs once in the new topic', async () => {
  for (const parentRoot of [undefined, 'om_existing_topic']) {
    const f = fixture();
    f.agent.handler = async (run) => {
      if (!run.session.nativeId) run.hooks.nativeId(`native-${run.session.id}`);
      run.hooks.text('task accepted');
    };
    try {
      await f.manager.receive(message('old context', parentRoot));
      await f.manager.idle();
      const parent = f.store.current(message('', parentRoot).route)!;
      f.manager.closeSession(parent.id);
      const input = message('新开一个话题，用于社交媒体视频 生成', parentRoot);
      await f.manager.receive(input);
      await f.manager.idle();
      const child = f.store.list().find((s) => s.id !== parent.id)!;
      assert.ok(child);
      assert.equal(f.store.list().length, 2);
      assert.notEqual(child.route.thread, parent.route.thread);
      assert.notEqual(child.nativeId, parent.nativeId);
      assert.equal(f.store.current(parent.route)!.id, parent.id);
      assert.equal(f.store.get(parent.id)!.status, 'closed');
      assert.equal(f.agent.inputs.at(-1)!.text, '用于社交媒体视频 生成');
      assert.equal(f.agent.inputs.at(-1)!.session.id, child.id);
      assert.ok(
        f.channel.sent
          .slice(1)
          .every(
            (s) =>
              s.message.route.thread === child.route.thread &&
              s.message.replyTo === child.route.thread,
          ),
      );
      await f.manager.receive(input);
      assert.equal(f.agent.inputs.length, 2);
      assert.equal(f.store.list().length, 2);
      await f.manager.receive(message('继续生成字幕', child.route.thread));
      await f.manager.idle();
      assert.equal(f.agent.inputs.at(-1)!.session.nativeId, child.nativeId);
    } finally {
      await f.cleanup();
    }
  }
});

test('new topic does not replace a running main session or its pending approval', async () => {
  const f = fixture();
  f.agent.handler = async (run) => {
    await run.hooks.ask({ kind: 'approval', title: 'test', detail: 'test' }, run.signal);
  };
  try {
    await f.manager.receive(message('main'));
    await until(() => f.manager.interactions().length === 1);
    const main = f.store.current(message('').route)!,
      approval = f.manager.interactions()[0]!;
    const create = message('/tab topic');
    await f.manager.receive(create);
    assert.equal(f.store.current(message('').route)!.id, main.id);
    assert.equal(f.store.current(message('', create.id).route)!.status, 'idle');
    assert.equal(f.manager.interactions()[0]!.id, approval.id);
    await f.manager.receive(message(`/tab approve ${approval.id} deny`));
    await f.manager.idle();
    assert.equal(f.manager.interactions().length, 0);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('closed main session stays closed; explicit new topic leaves its binding and history alone', async () => {
  const f = fixture();
  try {
    await f.manager.receive(message('main'));
    await f.manager.idle();
    const main = f.store.current(message('').route)!;
    f.manager.closeSession(main.id);
    await f.manager.receive(message('blocked'));
    assert.equal(f.store.list().length, 1);
    assert.equal(f.agent.inputs.length, 1);
    await f.manager.receive(message('新开一个话题'));
    assert.equal(f.store.current(message('').route)!.id, main.id);
    assert.equal(f.store.get(main.id)!.status, 'closed');
    await f.manager.receive(message('/tab open'));
    await f.manager.receive(message('resumed'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.session.id, main.id);
    assert.equal(f.agent.inputs.at(-1)!.session.nativeId, 'native-1');
  } finally {
    await f.cleanup();
  }
});

test('main text, approval and management cards stay top-level; nested new-topic creates a separate root', async () => {
  const f = fixture();
  const channel = new LarkChannel(
    {
      type: 'lark',
      id: 'test-lark',
      allowedUsers: ['alice'],
      appIdEnv: 'ID',
      appSecretEnv: 'SECRET',
      botOpenId: 'bot',
      domain: 'feishu',
    },
    () => 'fixture',
  );
  const creates: any[] = [],
    replies: any[] = [];
  let fail = false;
  Object.assign(channel, {
    client: {
      im: {
        message: {
          create: async (args: any) => {
            creates.push(args);
            if (fail) throw new Error('uncertain');
            return { code: 0, data: { message_id: `om_created_${creates.length}` } };
          },
          reply: async (args: any) => {
            replies.push(args);
            return { code: 0, data: { message_id: 'om_reply' } };
          },
          patch: async () => ({ code: 0 }),
        },
      },
    },
  });
  try {
    const input = message('hello');
    await channel.send(input, 'answer');
    const approval: Interaction = {
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      kind: 'approval',
      title: 'test',
      detail: 'test',
      createdAt: Date.now(),
    };
    const delivery = await channel.sendInteraction(input, approval, () => {});
    assert.ok(delivery);
    await delivery.close('done');
    const session = f.store.create(input.route, 'codex', f.dir);
    const view: SessionCardView = {
      session,
      card: {
        id: crypto.randomUUID(),
        sessionId: session.id,
        delivery: 'new',
        revision: 1,
        view: 'status',
      },
      active: false,
      current: true,
      events: [],
    };
    await channel.sendSessionCard(view);
    assert.equal(creates.length, 3);
    assert.equal(replies.length, 0);
    assert.ok(
      creates.every(
        (c) => c.data.receive_id === input.route.conversation && !c.data.reply_in_thread,
      ),
    );
    const root = await channel.createTopic(input, '宏观策略研究');
    assert.equal(root.route.thread, 'om_created_4');
    assert.equal(creates.length, 4);
    assert.equal(JSON.parse(creates[3].data.content).text, '宏观策略研究');
    assert.equal(root.ownedTopicRoot, root.route.thread);
    await channel.send(root, 'topic');
    assert.equal(replies[0].path.message_id, root.route.thread);
    assert.equal(replies[0].data.reply_in_thread, true);
    const separate = await channel.createTopic(message('/tab new', input.id));
    assert.equal(separate.route.thread, 'om_created_5');
    assert.notEqual(separate.route.thread, input.id);
    fail = true;
    await assert.rejects(channel.createTopic(message('/tab new', input.id)));
    assert.equal(creates.length, 6);
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});

test('main has one persistent card and startup does not backfill closed legacy main records', async () => {
  const f = fixture();
  let sends = 0;
  Object.assign(f.channel, {
    async sendSessionCard() {
      sends++;
      return `om_card_${sends}`;
    },
    async updateSessionCard() {},
  });
  try {
    const legacy = f.store.create(message('').route, 'codex', f.dir);
    legacy.status = 'closed';
    f.store.save(legacy);
    f.manager.refreshSessionCards();
    await f.manager.controls.drain();
    assert.equal(sends, 0);
    f.manager.openSession(legacy.id);
    await f.manager.controls.drain();
    for (const text of ['one', 'two']) {
      await f.manager.receive(message(text));
      await f.manager.idle();
      await f.manager.controls.drain();
    }
    assert.equal(sends, 1);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.card(legacy.id)!.delivery, 'sent');
  } finally {
    await f.cleanup();
  }
});

test('Lark topic rename edits only a recorded bot-owned root and treats failure as unknown without retry', async () => {
  const channel = new LarkChannel(
    {
      type: 'lark',
      id: 'test-lark',
      allowedUsers: ['alice'],
      appIdEnv: 'ID',
      appSecretEnv: 'SECRET',
      botOpenId: 'bot',
      domain: 'feishu',
    },
    () => 'fixture',
  );
  const f = fixture(),
    updates: any[] = [];
  let fail = false;
  Object.assign(channel, {
    client: {
      im: {
        message: {
          update: async (args: any) => {
            updates.push(args);
            return { code: fail ? 1 : 0 };
          },
        },
      },
    },
  });
  try {
    const s = f.store.create(message('', 'om_root').route, 'codex', f.dir);
    await assert.rejects(channel.renameTopic(s, 'title'));
    assert.equal(updates.length, 0);
    s.ownedTopicRoot = 'om_other';
    await assert.rejects(channel.renameTopic(s, 'title'));
    assert.equal(updates.length, 0);
    s.ownedTopicRoot = s.route.thread;
    await channel.renameTopic(s, '<at user_id="all">标题</at>');
    assert.equal(updates[0].path.message_id, s.route.thread);
    assert.ok(!JSON.parse(updates[0].data.content).text.includes('<at'));
    fail = true;
    await assert.rejects(channel.renameTopic(s, 'new'));
    assert.equal(updates.length, 2);
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});
