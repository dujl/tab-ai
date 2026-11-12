import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WecomChannel, wecomDiagnostic } from '../src/channels/wecom.js';
import { incoming, until } from './helpers.js';
import type { Answer, Interaction } from '../src/core/types.js';

class Socket extends EventEmitter {
  sent: any[] = [];
  updated: any[] = [];
  failUpdate = false;
  connect() {
    this.emit('authenticated');
  }
  disconnect() {}
  async sendMessage(...args: any[]) {
    this.sent.push(args);
    return { errcode: 0 };
  }
  async updateTemplateCard(...args: any[]) {
    this.updated.push(args);
    return { errcode: this.failUpdate ? 40001 : 0 };
  }
}
const request = (): Interaction => ({
  id: randomUUID(),
  sessionId: randomUUID(),
  kind: 'approval',
  title: '执行确认',
  detail: 'echo ok',
  createdAt: Date.now(),
  expiresAt: Date.now() + 10000,
});
async function setup() {
  const channel = new WecomChannel(
      {
        type: 'wecom',
        id: 'wecom-test',
        allowedUsers: ['alice'],
        botIdEnv: 'ID',
        secretEnv: 'SECRET',
      },
      () => 'fixture',
    ),
    socket = new Socket();
  Object.assign(channel, { client: socket });
  await channel.start(async () => {});
  const message = incoming('');
  message.route.platform = 'wecom';
  message.route.conversation = 'group-original';
  const answers: Answer[] = [];
  const delivery = await channel.sendInteraction(message, request(), (_sender, a) =>
    answers.push(a),
  );
  const task = socket.sent[0][1].template_card.task_id;
  const click = (user = 'alice', group = 'group-original') =>
    socket.emit('event.template_card_event', {
      headers: { req_id: randomUUID() },
      body: {
        from: { userid: user },
        chatid: group,
        chattype: 'group',
        event: { eventtype: 'template_card_event', task_id: task, event_key: 'allow' },
      },
    });
  return { channel, socket, answers, delivery: delivery!, click };
}

test('expired WeCom approval feedback stays in the source group and never grants approval', async () => {
  const f = await setup();
  try {
    await f.delivery.close('超时');
    f.click();
    await until(() => f.socket.sent.length === 2);
    assert.equal(f.socket.sent[1][0], 'group-original');
    assert.match(f.socket.sent[1][1].markdown.content, /本次点击未生效/);
    assert.match(f.socket.sent[1][1].markdown.content, /tab pending/);
    assert.equal(f.socket.updated[0][1].main_title.title, '本次点击未生效');
    assert.deepEqual(f.socket.updated[0][2], ['alice']);
    assert.deepEqual(f.answers, []);
  } finally {
    await f.channel.stop();
  }
});

test('wrong user and forwarded-group WeCom callbacks receive local feedback but cannot approve', async () => {
  const f = await setup();
  try {
    f.click('bob');
    await until(() => f.socket.sent.length === 2);
    assert.equal(f.socket.sent[1][0], 'group-original');
    assert.deepEqual(f.answers, []);
    f.click('alice', 'group-other');
    await until(() => f.socket.sent.length === 3);
    assert.equal(f.socket.sent[2][0], 'group-other');
    assert.deepEqual(f.answers, []);
    f.click();
    await until(() => f.answers.length === 1);
    assert.deepEqual(f.answers, [{ allow: true }]);
  } finally {
    await f.delivery.close('done');
    await f.channel.stop();
  }
});

test('WeCom update rejection reports the accepted decision in the group without replaying approval', async () => {
  const f = await setup();
  try {
    f.socket.failUpdate = true;
    f.click();
    await until(() => f.socket.sent.length === 2);
    assert.deepEqual(f.answers, [{ allow: true }]);
    assert.equal(f.socket.sent[1][0], 'group-original');
    assert.match(f.socket.sent[1][1].markdown.content, /已允许本次操作/);
    assert.match(f.socket.sent[1][1].markdown.content, /卡片状态未能更新/);
    f.click();
    await until(() => f.socket.sent.length === 3);
    assert.equal(f.answers.length, 1);
    assert.match(f.socket.sent[2][1].markdown.content, /未生效/);
  } finally {
    await f.delivery.close('done');
    await f.channel.stop();
  }
});

test('WeCom callback rejection remains visible even if updating the expired card fails', async () => {
  const f = await setup();
  try {
    await f.delivery.close('超时');
    f.socket.failUpdate = true;
    f.click();
    await until(() => f.socket.sent.length === 2);
    assert.equal(f.socket.sent[1][0], 'group-original');
    assert.match(f.socket.sent[1][1].markdown.content, /已结束/);
    assert.deepEqual(f.answers, []);
  } finally {
    await f.channel.stop();
  }
});

test('WeCom transport diagnostics classify errors without exposing SDK data or URLs', () => {
  const samples = [
    [
      'Reply ack error: reqId=private, errcode=40003, errmsg=https://secret/token',
      'reply-rejected code=40003',
    ],
    ['Received disconnected_event: secret', 'replaced-connection'],
    ['Received unknown frame (ignored): {"secret":"value"}', 'invalid-frame'],
    ['arbitrary token=secret https://private', 'other'],
  ];
  for (const [message, expected] of samples) assert.equal(wecomDiagnostic(message), expected);
});
