import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../src/agents/codex.js';
import { LarkChannel } from '../src/channels/lark.js';
import type { Session } from '../src/core/types.js';
import { fixture, incoming as baseIncoming, until } from './helpers.js';

const incoming = (text: string) => baseIncoming(text, 'alice', 'om_topic-root');

async function setup() {
  const f = fixture(),
    executable = join(f.dir, 'fake-codex.mjs');
  copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  const adapter = new CodexAdapter(executable);
  f.agent.handler = (run) => adapter.run(run);
  Object.assign(f.agent, {
    steer: (s: Session, t: string, a: AbortSignal) => adapter.steer(s, t, a),
  });
  const lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture');
  let dispatcher: any;
  const cards: any[] = [],
    patches: any[] = [];
  Object.assign(lark, {
    socket: {
      start: async (o: any) => {
        dispatcher = o.eventDispatcher;
      },
      getConnectionStatus: () => ({ state: 'connected' }),
      close() {},
    },
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            cards.push(args);
            return { code: 0, data: { message_id: `om-card-${cards.length}` } };
          },
          patch: async (args: any) => {
            patches.push(args);
            return { code: 0 };
          },
        },
      },
    },
  });
  await lark.start(async () => {});
  Object.assign(f.channel, { sendInteraction: lark.sendInteraction.bind(lark) });
  const choose = async (index = '0', sender = 'alice', other?: string) => {
    const card = JSON.parse(cards[0].data.content),
      form = card.elements.find((e: any) => e.tag === 'form');
    return dispatcher.invoke(
      {
        schema: '2.0',
        header: { event_type: 'card.action.trigger', event_id: crypto.randomUUID() },
        event: {
          operator: { open_id: sender },
          context: { open_chat_id: 'chat-1', open_message_id: 'om-card-1' },
          action: {
            value: form.elements.find((e: any) => e.tag === 'button').value,
            form_value: other ? { other } : { selection: index },
          },
        },
      },
      { needCheck: false },
    );
  };
  const trace = () =>
    readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  return {
    ...f,
    adapter,
    cards,
    patches,
    choose,
    trace,
    async cleanup() {
      await f.cleanup();
      await lark.stop();
    },
  };
}

test('Feishu async questions render once, keep analysis running and deliver selections into the original turn', async () => {
  const f = await setup();
  try {
    await f.manager.receive(incoming('async-question'));
    await until(() => f.cards.length === 1);
    const session = f.store.list()[0]!,
      card = JSON.parse(f.cards[0].data.content);
    assert.equal(session.status, 'running');
    assert.equal(f.manager.interactions()[0]!.mode, 'async');
    assert.match(JSON.stringify(card), /select_static/);
    assert.match(JSON.stringify(card), /Agent 会继续分析/);
    assert.ok(!JSON.stringify(card).includes('initial_option'));
    assert.equal(f.channel.sent.length, 0);
    assert.equal(f.cards[0].data.reply_in_thread, true);
    assert.equal(f.cards[0].path.message_id, 'om_topic-root');
    assert.equal((await f.choose('0', 'bob')).toast.type, 'error');
    assert.equal((await f.choose('1')).toast.type, 'success');
    await until(() => f.channel.sent.some((m) => m.text.includes('收到补充')));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.get(session.id)!.nativeId, 'native-test-1');
    const steer = f.trace().filter((m) => m.method === 'turn/steer');
    assert.equal(steer.length, 1);
    assert.deepEqual(steer[0].params, {
      threadId: 'native-test-1',
      expectedTurnId: 'turn-1',
      input: [
        {
          type: 'text',
          text: '你指的是示例项目甲吗？\n用户回答：指示例项目乙',
          text_elements: [],
        },
      ],
    });
    assert.equal((await f.choose()).toast.type, 'error');
    assert.equal(f.manager.interactions().length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Feishu late custom answers resume the same native conversation after the original turn completes', async () => {
  const f = await setup();
  try {
    await f.manager.receive(incoming('async-complete'));
    await until(() => f.cards.length === 1);
    await f.manager.idle();
    const id = f.store.list()[0]!.id;
    assert.equal(f.manager.interactions().length, 1);
    assert.equal(f.store.get(id)!.status, 'idle');
    assert.equal((await f.choose('', 'alice', '指自定义项目丁')).toast.type, 'success');
    await until(() => f.agent.inputs.length === 2);
    await f.manager.idle();
    const trace = f.trace();
    assert.equal(trace.filter((m) => m.method === 'turn/steer').length, 0);
    assert.equal(trace.filter((m) => m.method === 'thread/start').length, 1);
    assert.equal(trace.find((m) => m.method === 'thread/resume').params.threadId, 'native-test-1');
    assert.equal(f.agent.inputs[1]!.text, '你指的是示例项目甲吗？\n用户回答：指自定义项目丁');
    assert.equal(f.store.list().length, 1);
  } finally {
    await f.cleanup();
  }
});

test('Feishu plain option replies bypass the busy guard and do not start a second run', async () => {
  const f = await setup();
  try {
    await f.manager.receive(incoming('async-question'));
    await until(() => f.cards.length === 1);
    await f.manager.receive(incoming('2'));
    await until(() => f.channel.sent.some((m) => m.text.includes('收到补充')));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.trace().filter((m) => m.method === 'turn/steer').length, 1);
    assert.ok(!f.channel.sent.some((m) => m.text.includes('仍在运行')));
  } finally {
    await f.cleanup();
  }
});

test('Feishu async answer delivery errors do not retry, start another turn or interrupt background work', async () => {
  const f = await setup();
  try {
    await f.manager.receive(incoming('async-steer-error'));
    await until(() => f.cards.length === 1);
    await f.choose();
    await until(() => f.channel.sent.some((m) => m.text.includes('未确认送达')));
    assert.equal(f.trace().filter((m) => m.method === 'turn/steer').length, 1);
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.list()[0]!.status, 'running');
  } finally {
    await f.cleanup();
  }
});

test('Feishu async cards expire without choosing or stopping analysis, and stop invalidates them', async () => {
  const f = await setup();
  try {
    f.config.interactionTimeoutMs = 40;
    await f.manager.receive(incoming('async-question'));
    await until(() => f.cards.length === 1);
    await until(() => f.manager.interactions().length === 0);
    assert.equal(f.store.list()[0]!.status, 'running');
    assert.equal((await f.choose()).toast.type, 'error');
    assert.equal(f.trace().filter((m) => m.method === 'turn/steer').length, 0);
  } finally {
    await f.cleanup();
  }
  const g = await setup();
  try {
    await g.manager.receive(incoming('async-question'));
    await until(() => g.cards.length === 1);
    g.manager.stop(g.store.list()[0]!.id);
    await g.manager.idle();
    assert.equal((await g.choose()).toast.type, 'error');
    assert.equal(g.manager.interactions().length, 0);
  } finally {
    await g.cleanup();
  }
});

test('Feishu a new task invalidates unanswered older async cards', async () => {
  const f = await setup();
  try {
    await f.manager.receive(incoming('async-complete'));
    await until(() => f.cards.length === 1);
    await f.manager.idle();
    await f.manager.receive(incoming('different task'));
    await f.manager.idle();
    assert.equal((await f.choose()).toast.type, 'error');
    assert.equal(f.manager.interactions().length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Feishu multi-question async cards aggregate all answers and preserve the active turn', async () => {
  const f = await setup();
  try {
    await f.manager.receive(incoming('async-multiple'));
    await until(() => f.cards.length === 2);
    assert.equal((await f.choose('0')).toast.type, 'success');
    assert.equal(f.trace().filter((m) => m.method === 'turn/steer').length, 0);
    assert.equal(f.store.list()[0]!.status, 'running');
    const request = f.manager.interactions()[0]!;
    f.manager.answer(request.sessionId, request.id, {
      answers: { '1': ['是，项目甲'], '2': ['本季度'] },
    });
    await until(() => f.channel.sent.some((m) => m.text.includes('收到补充')));
    await f.manager.idle();
    const steer = f.trace().find((m) => m.method === 'turn/steer');
    assert.match(steer.params.input[0].text, /用户回答：是，项目甲/);
    assert.match(steer.params.input[0].text, /用户回答：本季度/);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('Feishu failed card delivery retains a text answer path into the original running turn', async () => {
  const f = await setup();
  try {
    Object.assign(f.channel, {
      sendInteraction: async () => {
        throw Error('fixture transport unavailable');
      },
    });
    await f.manager.receive(incoming('async-question'));
    await until(() => f.channel.sent.some((m) => m.text.includes('/tab answer')));
    const question = f.manager.interactions()[0]!;
    await f.manager.receive(incoming(`/tab answer ${question.id} {"1":["是，项目甲"]}`));
    await until(() => f.channel.sent.some((m) => m.text.includes('收到补充')));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.list()[0]!.status, 'idle');
  } finally {
    await f.cleanup();
  }
});

test('Feishu late answers cannot run after the original session is closed', async () => {
  const f = await setup();
  try {
    await f.manager.receive(incoming('async-complete'));
    await until(() => f.cards.length === 1);
    await f.manager.idle();
    f.manager.closeSession(f.store.list()[0]!.id);
    assert.equal((await f.choose()).toast.type, 'error');
    assert.equal(f.manager.interactions().length, 0);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('Feishu late task answers use the task queue and retain the original task session', async () => {
  const f = await setup();
  try {
    f.agent.handler = async (run) => {
      run.hooks.nativeId('task-native');
      if (f.agent.inputs.length === 1)
        run.hooks.askAsync!({
          kind: 'question',
          title: '补充信息',
          detail: '',
          questions: [{ id: '1', question: '分析哪个对象？', options: ['项目甲', '项目乙'] }],
        });
      run.hooks.text('本轮分析结束。');
    };
    const source = f.store.create(incoming('').route, 'codex', f.dir);
    const task = await f.manager.createTask({
      sourceSessionId: source.id,
      key: crypto.randomUUID(),
      title: '分析任务',
      objective: '核对数据',
      workspace: 'default',
    });
    await until(() => f.cards.length === 1);
    await f.manager.idle();
    const request = f.manager.interactions()[0]!;
    f.manager.answer(request.sessionId, request.id, { answers: { '1': ['项目甲'] } });
    await until(() => f.agent.inputs.length === 2);
    await f.manager.idle();
    assert.equal(f.agent.inputs[1]!.session.id, task.sessionId);
    assert.equal(f.agent.inputs[1]!.session.nativeId, 'task-native');
    assert.equal(
      f.store.taskJobs().filter((j) => j.taskId === task.id && j.state === 'done').length,
      2,
    );
    assert.equal(f.store.taskRecord(task.id)!.state, 'waiting');
  } finally {
    await f.cleanup();
  }
});
