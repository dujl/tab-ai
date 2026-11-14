import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import type { Incoming } from '../src/core/types.js';

function dingMessage(text: string, sender = 'alice'): Incoming {
  const message = incoming(text, sender, '');
  return { ...message, direct: true, route: { ...message.route, platform: 'dingtalk' } };
}
function dingFixture() {
  const f = fixture();
  f.config.channels[0] = {
    id: f.channel.id,
    type: 'dingtalk',
    allowedUsers: ['alice'],
    clientIdEnv: 'ID',
    clientSecretEnv: 'SECRET',
  };
  return f;
}
const receipt = (text: string) => text.includes('已收到，正在处理');

test('DingTalk acknowledges an accepted task before a slow agent replies, without acknowledging commands, unauthorized input or redelivery as new work', async () => {
  const f = dingFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.agent.handler = async (run) => {
    await gate;
    run.hooks.text('任务测试成功');
  };
  try {
    await f.manager.receive(dingMessage('private task', 'eve'));
    assert.equal(f.channel.sent.length, 0);
    const message = dingMessage('task');
    await f.manager.receive(message);
    await until(() => f.agent.inputs.length === 1 && f.channel.sent.some((s) => receipt(s.text)));
    const session = f.store.current(message.route)!;
    assert.equal(session.status, 'running');
    assert.ok(!f.channel.sent.some((s) => s.text.includes('任务测试成功')));
    await f.manager.receive(message);
    await f.manager.receive(dingMessage('/tab status'));
    await f.manager.receive(dingMessage('another task'));
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.channel.sent.filter((s) => receipt(s.text)).length, 1);
    release();
    await until(() => f.store.get(session.id)?.status === 'idle');
    const texts = f.channel.sent.map((s) => s.text);
    assert.equal(texts.filter((t) => t.includes('任务测试成功')).length, 1);
    assert.ok(texts.findIndex(receipt) < texts.findIndex((t) => t.includes('任务测试成功')));
  } finally {
    release();
    await f.cleanup();
  }
});

test('a slow or failed DingTalk task receipt does not block execution or replay the task and final output remains ordered', async () => {
  const f = dingFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const send = f.channel.send.bind(f.channel);
  f.channel.send = async (message, text) => {
    if (receipt(text)) {
      attempts++;
      await gate;
      throw new Error('uncertain receipt');
    }
    await send(message, text);
  };
  try {
    const message = dingMessage('task');
    await f.manager.receive(message);
    await until(() => f.agent.inputs.length === 1 && attempts === 1);
    assert.equal(f.channel.sent.length, 0);
    release();
    const session = f.store.current(message.route)!;
    await until(() => f.store.get(session.id)?.status === 'idle');
    assert.equal(attempts, 1);
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.channel.sent.filter((s) => s.text.includes('Answer:')).length, 1);
    assert.ok(f.store.events(session.id).some((e) => e.type === 'delivery_error'));
  } finally {
    release();
    await f.cleanup();
  }
});
