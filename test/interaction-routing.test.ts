import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import type { Answer, InteractionDelivery, Session } from '../src/core/types.js';
import { LarkChannel } from '../src/channels/lark.js';

function sessions(f: ReturnType<typeof fixture>, grandchild = false) {
  const parent = f.store.create(incoming('', 'alice', 'om_parent').route, 'traecli', f.dir);
  parent.title = '主会话';
  f.store.save(parent);
  const child = f.store.create(incoming('', 'alice', 'om_child').route, 'traecli', f.dir);
  child.title = '子会话';
  child.parentSessionId = parent.id;
  f.store.save(child);
  let selected: Session = child;
  if (grandchild) {
    selected = f.store.create(incoming('', 'alice', 'om_grandchild').route, 'traecli', f.dir);
    selected.parentSessionId = child.id;
    selected.title = '孙会话';
    f.store.save(selected);
  }
  f.manager.tasks.adoptSession(parent.id);
  return { parent, child, selected };
}

const question = {
  kind: 'question' as const,
  title: 'TRAE CLI 需要你的回答',
  detail: '',
  questions: [{ id: 'choice', question: '选择？', options: ['继续', '停止'], allowOther: false }],
};

test('cancelling a non-task child question sends the interruption notice to its own Lark topic', async () => {
  const f = fixture();
  const parent = f.store.create(incoming('', 'alice', 'om_parent').route, 'traecli', f.dir);
  const selected = f.store.create(incoming('', 'alice', 'om_child').route, 'traecli', f.dir);
  selected.parentSessionId = parent.id;
  f.store.save(selected);
  const lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture');
  const replies: any[] = [];
  Object.assign(lark, {
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            replies.push(args);
            return { code: 0, data: { message_id: 'om_reply' } };
          },
          patch: async () => ({ code: 0 }),
        },
      },
    },
  });
  Object.assign(f.channel, {
    sendInteraction: lark.sendInteraction.bind(lark),
    send: lark.send.bind(lark),
  });
  f.agent.handler = async (run) => {
    await run.hooks.ask(question, run.signal);
  };
  try {
    await f.manager.receive({ ...incoming('选择测试', 'alice', 'om_child'), replyTo: 'om_parent' });
    await until(() => replies.some((r) => r.data.msg_type === 'interactive'));
    assert.equal(selected.taskId, undefined);
    f.manager.stop(selected.id);
    await f.manager.idle();
    const notice = replies.find(
      (r) => r.data.msg_type === 'text' && r.data.content.includes('用户已中断任务'),
    );
    assert.ok(notice);
    assert.equal(notice.path.message_id, 'om_child');
  } finally {
    await f.cleanup();
  }
});

test('a child question uses its own Lark reply target even if the origin carries a parent reply', async () => {
  const f = fixture(),
    { selected } = sessions(f);
  const lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture');
  const replies: any[] = [],
    creates: any[] = [];
  Object.assign(lark, {
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            replies.push(args);
            return { code: 0, data: { message_id: 'om_card' } };
          },
          create: async (args: any) => {
            creates.push(args);
            return { code: 0, data: { message_id: 'om_wrong_main_card' } };
          },
          patch: async () => ({ code: 0 }),
        },
      },
    },
  });
  Object.assign(f.channel, { sendInteraction: lark.sendInteraction.bind(lark) });
  f.agent.handler = async (run) => {
    await run.hooks.ask(question, run.signal);
  };
  try {
    await f.manager.receive({ ...incoming('选择测试', 'alice', 'om_child'), replyTo: 'om_parent' });
    await until(() => replies.length > 0 || creates.length > 0);
    assert.equal(creates.length, 0);
    assert.equal(replies[0].path.message_id, 'om_child');
    assert.equal(replies[0].data.reply_in_thread, true);
    const pending = f.manager.interactions()[0]!;
    f.manager.answer(selected.id, pending.id, { answers: { choice: ['继续'] } });
    await f.manager.idle();
  } finally {
    await f.cleanup();
  }
});

for (const grandchild of [false, true])
  test(`native question stays in its originating ${grandchild ? 'grandchild' : 'child'} topic`, async () => {
    const f = fixture(),
      { parent, selected } = sessions(f, grandchild);
    let card: any, answered: Answer | undefined;
    Object.assign(f.channel, {
      sendInteraction: async (message: any, request: any, submit: any) => {
        card = { message, request, submit };
        return { close: async () => {} };
      },
    });
    f.agent.handler = async (run) => {
      answered = await run.hooks.ask(question, run.signal);
    };
    try {
      f.manager.submit(selected.id, '选择测试');
      await until(() => !!card);
      assert.equal(card.message.route.thread, grandchild ? 'om_grandchild' : 'om_child');
      assert.equal(card.request.sessionId, selected.id);
      assert.equal(f.channel.sent.filter((m) => m.message.route.thread === 'om_parent').length, 0);
      assert.throws(
        () => f.manager.answer(parent.id, card.request.id, { answers: { choice: ['继续'] } }),
        /不属于/,
      );
      card.submit('alice', { answers: { choice: ['继续'] } });
      await until(() => !!answered);
      assert.deepEqual(answered, { answers: { choice: ['继续'] } });
      assert.equal(f.store.events(parent.id).filter((e) => e.type === 'decision').length, 0);
    } finally {
      await f.cleanup();
    }
  });

test('child approval text fallback stays in the child topic', async () => {
  const f = fixture(),
    { selected } = sessions(f);
  Object.assign(f.channel, { sendInteraction: async () => undefined });
  f.agent.handler = async (run) => {
    await run.hooks.ask({ kind: 'approval', title: '执行确认', detail: 'test' }, run.signal);
  };
  try {
    f.manager.submit(selected.id, '审批测试');
    await until(() => f.channel.sent.some((m) => m.text.includes('执行确认')));
    const message = f.channel.sent.find((m) => m.text.includes('执行确认'))!;
    assert.equal(message.message.route.thread, 'om_child');
    const pending = f.manager.interactions()[0]!;
    f.manager.answer(selected.id, pending.id, { allow: true });
    await f.manager.idle();
  } finally {
    await f.cleanup();
  }
});

test('child question card update failure is reported only in the child topic', async () => {
  const f = fixture(),
    { selected } = sessions(f);
  let request: any;
  Object.assign(f.channel, {
    sendInteraction: async (_message: any, value: any): Promise<InteractionDelivery> => {
      request = value;
      return {
        close: async () => {
          throw Error('fixture card patch failed');
        },
      };
    },
  });
  f.agent.handler = async (run) => {
    await run.hooks.ask(question, run.signal);
  };
  try {
    f.manager.submit(selected.id, '选择测试');
    await until(() => !!request);
    f.manager.answer(selected.id, request.id, { answers: { choice: ['继续'] } });
    await until(() => f.channel.sent.some((m) => m.text.includes('卡片状态同步提示')));
    const notice = f.channel.sent.find((m) => m.text.includes('卡片状态同步提示'))!;
    assert.equal(notice.message.route.thread, 'om_child');
    await f.manager.idle();
  } finally {
    await f.cleanup();
  }
});

test('asynchronous child question and answer remain in the child native session', async () => {
  const f = fixture(),
    { parent, selected } = sessions(f);
  let card: any, release!: () => void, steered: string | undefined;
  Object.assign(f.channel, {
    sendInteraction: async (message: any, request: any, submit: any) => {
      card = { message, request, submit };
      return { close: async () => {} };
    },
  });
  Object.assign(f.agent, {
    steer: async (session: Session) => {
      steered = session.id;
      return true;
    },
  });
  f.agent.handler = async (run) => {
    run.hooks.nativeId('native-child');
    run.hooks.askAsync!(question);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    f.manager.submit(selected.id, '异步选择测试');
    await until(() => !!card && !!release);
    assert.equal(card.message.route.thread, 'om_child');
    card.submit('alice', { answers: { choice: ['继续'] } });
    await until(() => !!steered);
    assert.equal(steered, selected.id);
    assert.equal(f.store.events(parent.id).filter((e) => e.type === 'decision').length, 0);
    release();
    await f.manager.idle();
  } finally {
    release?.();
    await f.cleanup();
  }
});
