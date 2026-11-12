import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';

test('completed agent messages reach the original topic before the agent finishes waiting', async () => {
  const f = fixture();
  let finish!: () => void;
  f.agent.handler = async (run) => {
    run.hooks.text('请扫描登录二维码');
    await new Promise<void>((r) => {
      finish = r;
    });
    run.hooks.text('登录成功');
  };
  try {
    const message = incoming('登录');
    await f.manager.receive(message);
    await until(() => f.channel.sent.length === 1);
    assert.equal(f.channel.sent[0]!.text, '请扫描登录二维码');
    assert.equal(f.channel.sent[0]!.message.route.thread, message.route.thread);
    assert.equal(f.store.list()[0]!.status, 'running');
    finish();
    await f.manager.idle();
    assert.deepEqual(
      f.channel.sent.map((s) => s.text),
      ['请扫描登录二维码', '登录成功'],
    );
    assert.equal(
      f.store
        .events(f.store.list()[0]!.id)
        .filter((e) => e.type === 'response')
        .at(-1)!.text,
      '请扫描登录二维码\n\n登录成功',
    );
    await f.manager.receive(incoming('/tab last'));
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.channel.sent.at(-1)!.text, '请扫描登录二维码\n\n登录成功');
  } finally {
    finish?.();
    await f.cleanup();
  }
});

test('slow message delivery stays ordered before approval and failure sends only the new error', async () => {
  const f = fixture();
  let release!: () => void;
  const order: string[] = [];
  f.channel.send = async (_message, text) => {
    if (text === '说明')
      await new Promise<void>((r) => {
        release = r;
      });
    order.push(text);
  };
  Object.assign(f.channel, {
    sendInteraction: async (_m: any, _r: any, answer: any) => {
      order.push('审批');
      answer('alice', { allow: false });
      return { close: async () => {} };
    },
  });
  f.agent.handler = async (run) => {
    run.hooks.text('说明');
    await run.hooks.ask({ kind: 'approval', title: '执行', detail: 'echo ok' }, run.signal);
    throw new Error('任务停止');
  };
  try {
    await f.manager.receive(incoming('任务'));
    await until(() => !!release);
    assert.deepEqual(order, []);
    assert.equal(f.manager.interactions().length, 1); // Web sees the request immediately; IM card still waits for preceding text.
    release();
    await f.manager.idle();
    assert.deepEqual(order, ['说明', '审批', 'tab-ai：任务停止']);
  } finally {
    release?.();
    await f.cleanup();
  }
});

test('uncertain intermediate delivery is not retried at completion; transcript remains recoverable', async () => {
  const f = fixture();
  const attempted: string[] = [];
  f.channel.send = async (_m, text) => {
    attempted.push(text);
    if (text === 'first') throw new Error('unknown result');
  };
  f.agent.handler = async (run) => {
    run.hooks.text('first');
    run.hooks.text('second');
  };
  try {
    await f.manager.receive(incoming('task'));
    await f.manager.idle();
    assert.deepEqual(attempted, ['first', 'second']);
    const events = f.store.events(f.store.list()[0]!.id);
    assert.equal(events.filter((e) => e.type === 'delivery_error').length, 1);
    assert.equal(events.filter((e) => e.type === 'response').at(-1)!.text, 'first\n\nsecond');
  } finally {
    await f.cleanup();
  }
});
