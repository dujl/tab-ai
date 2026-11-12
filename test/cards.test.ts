import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CardRegistry } from '../src/channels/cards.js';
import { larkCard, larkCardAction } from '../src/channels/lark-cards.js';
import { wecomCard, wecomCardAction } from '../src/channels/wecom-cards.js';
import { dingCardAction, dingCardData } from '../src/channels/dingtalk-cards.js';
import { LarkChannel } from '../src/channels/lark.js';
import { WecomChannel } from '../src/channels/wecom.js';
import { DingTalkChannel } from '../src/channels/dingtalk.js';
import { TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream';
import {
  type Answer,
  type Interaction,
  type Channel,
  type InteractionDelivery,
} from '../src/core/types.js';
import { validateAnswer } from '../src/core/interactions.js';
import { fixture, incoming, until } from './helpers.js';

const approval = (): Interaction => ({
  id: randomUUID(),
  sessionId: randomUUID(),
  kind: 'approval',
  title: '执行命令？',
  detail: 'echo ok',
  createdAt: Date.now(),
  expiresAt: Date.now() + 10_000,
});
const questions = (): Interaction => ({
  ...approval(),
  kind: 'question',
  questions: [
    { id: 'db', question: '选择数据库', options: ['SQLite', 'PostgreSQL'], allowOther: false },
    {
      id: 'features',
      question: '选择功能',
      options: ['搜索', '导出'],
      multiSelect: true,
      allowOther: true,
    },
  ],
});
const actor = { sender: 'alice', conversation: 'chat-1' };

test('card registry binds owner and source; aggregates choices once, never runs early', () => {
  const registry = new CardRegistry(),
    answers: Answer[] = [],
    request = questions(),
    batch = registry.open(incoming(''), request, (_sender, answer) => answers.push(answer));
  const [first, second] = batch.cards;
  first!.messageId = 'original-card';
  assert.equal(
    registry.submit(
      first!.id,
      { ...actor, messageId: 'forwarded' },
      { action: 'submit', selection: ['0'] },
    ).ok,
    false,
  );
  assert.equal(
    registry.submit(second!.id, { ...actor, sender: 'bob' }, { action: 'submit', selection: ['0'] })
      .ok,
    false,
  );
  assert.equal(
    registry.submit(
      second!.id,
      { ...actor, conversation: 'other-chat' },
      { action: 'submit', selection: ['0'] },
    ).ok,
    false,
  );
  assert.equal(
    registry.submit(
      first!.id,
      { ...actor, messageId: 'original-card' },
      { action: 'submit', selection: ['0', '1'] },
    ).ok,
    false,
  );
  assert.equal(
    registry.submit(
      first!.id,
      { ...actor, messageId: 'original-card' },
      { action: 'submit', text: 'Oracle' },
    ).ok,
    false,
  );
  assert.equal(
    registry.submit(
      first!.id,
      { ...actor, messageId: 'original-card' },
      { action: 'submit', selection: ['0'] },
    ).ok,
    true,
  );
  assert.equal(answers.length, 0);
  assert.equal(
    registry.submit(
      first!.id,
      { ...actor, messageId: 'original-card' },
      { action: 'submit', selection: ['1'] },
    ).ok,
    false,
  );
  assert.equal(
    registry.submit(second!.id, actor, { action: 'submit', selection: ['0', '0'] }).ok,
    false,
  );
  assert.equal(
    registry.submit(second!.id, actor, { action: 'submit', selection: ['99'] }).ok,
    false,
  );
  assert.equal(
    registry.submit(second!.id, actor, { action: 'submit', selection: ['1', '0'] }).ok,
    true,
  );
  assert.deepEqual(answers, [{ answers: { db: ['SQLite'], features: ['导出', '搜索'] } }]);
  batch.close('已结束');
  assert.equal(
    registry.submit(second!.id, actor, { action: 'submit', selection: ['0'] }).ok,
    false,
  );
  assert.equal(new CardRegistry().submit(first!.id, actor, { action: 'allow' }).ok, false);
});

test('expired cards and conflicting choices cannot authorize; rejection remains retryable', () => {
  const registry = new CardRegistry();
  let calls = 0;
  const expired = registry.open(
    incoming(''),
    { ...approval(), expiresAt: Date.now() - 1 },
    () => calls++,
  );
  assert.equal(registry.submit(expired.cards[0]!.id, actor, { action: 'allow' }).ok, false);
  assert.equal(calls, 0);
  expired.close('expired');
  let revoked = true;
  const batch = registry.open(incoming(''), approval(), () => {
    if (revoked) throw new Error('access revoked');
    calls++;
  });
  const id = batch.cards[0]!.id;
  assert.equal(registry.submit(id, actor, { action: 'allow' }).ok, false);
  revoked = false;
  assert.equal(registry.submit(id, actor, { action: 'deny' }).ok, true);
  assert.equal(registry.submit(id, actor, { action: 'allow' }).ok, false);
  assert.equal(calls, 1);
  batch.close('done');
});

test('Feishu approval colors follow actual decisions without implying that approval means execution succeeded', () => {
  const registry = new CardRegistry();
  let approvals = 0;
  const batch = registry.open(incoming(''), approval(), () => {
      approvals++;
    }),
    prompt = batch.cards[0]!;
  assert.equal(larkCard(prompt).header.template, 'orange');
  registry.submit(prompt.id, actor, { action: 'details' });
  assert.equal(larkCard(prompt).header.template, 'orange');
  assert.equal(approvals, 0);
  registry.submit(prompt.id, actor, { action: 'allow' });
  assert.equal(approvals, 1);
  const accepted = larkCard(prompt);
  assert.equal(accepted.header.template, 'green');
  assert.match(accepted.header.title.content, /待执行结果/);
  assert.match(JSON.stringify(accepted), /不代表工具已执行成功/);
  assert.ok(!accepted.elements.some((e: any) => e.tag === 'action'));
  for (const [status, color] of [
    ['已拒绝本次操作', 'red'],
    ['审批已超时，未批准', 'red'],
    ['已结束，未自动批准', 'grey'],
  ] as const) {
    const next = registry.open(incoming(''), approval(), () => {
      assert.fail('closed card cannot approve');
    });
    next.close(status);
    assert.equal(larkCard(next.cards[0]!).header.template, color);
    assert.equal(registry.submit(next.cards[0]!.id, actor, { action: 'allow' }).ok, false);
  }
});

test('Feishu callback uses trusted operator/context and decodes form values to native labels', () => {
  const registry = new CardRegistry(),
    answers: Answer[] = [],
    request = questions();
  request.questions = request.questions!.slice(1);
  const batch = registry.open(incoming(''), request, (_sender, value) => answers.push(value)),
    prompt = batch.cards[0]!;
  prompt.messageId = 'om-card';
  const card = JSON.stringify(larkCard(prompt));
  assert.match(card, /multi_select_static/);
  assert.match(card, /form_submit/);
  assert.ok(!card.includes('"initial_options"'));
  const payload = {
    operator: { open_id: 'alice' },
    context: { open_chat_id: 'chat-1', open_message_id: 'om-card' },
    action: { value: { id: prompt.id, action: 'submit' }, form_value: { selection: ['0', '1'] } },
  };
  assert.equal(
    larkCardAction(registry, { ...payload, operator: { open_id: 'bob' } }).toast.type,
    'error',
  );
  const result = larkCardAction(registry, payload);
  assert.equal(result.toast.type, 'success');
  assert.ok(result.card);
  assert.equal(result.card.data.header.template, 'green');
  assert.deepEqual(answers, [{ answers: { features: ['搜索', '导出'] } }]);
  assert.equal(larkCardAction(registry, payload).toast.type, 'error');
  batch.close('done');
});

test('WeCom accepts documented nested and SDK flat event formats without losing checkbox values', () => {
  for (const nested of [true, false]) {
    const registry = new CardRegistry(),
      answers: Answer[] = [],
      request = questions();
    request.questions = request.questions!.slice(1);
    const message = incoming('');
    message.route.platform = 'wecom';
    message.route.conversation = 'alice';
    const batch = registry.open(message, request, (_sender, value) => answers.push(value)),
      prompt = batch.cards[0]!;
    assert.equal(wecomCard(prompt).checkbox!.mode, 1);
    assert.ok(wecomCard(prompt).checkbox!.option_list.every((o) => o.is_checked === false));
    const detail = {
      task_id: prompt.id,
      event_key: 'submit',
      selected_items: {
        selected_item: [{ question_key: 'answer', option_ids: { option_id: ['1', '0'] } }],
      },
    };
    const payload = {
      from: { userid: 'alice' },
      chattype: 'single',
      event: {
        eventtype: 'template_card_event',
        ...(nested ? { template_card_event: detail } : detail),
      },
    };
    assert.equal(wecomCardAction(registry, payload)?.ok, true);
    assert.deepEqual(answers, [{ answers: { features: ['导出', '搜索'] } }]);
    batch.close('done');
    assert.equal(wecomCardAction(registry, payload)?.ok, false);
  }
});

test('DingTalk callback enforces card space, staff identity and template action fields', () => {
  const registry = new CardRegistry(),
    answers: Answer[] = [],
    batch = registry.open(incoming(''), approval(), (_sender, value) => answers.push(value)),
    prompt = batch.cards[0]!;
  const targets = new Map([
    [prompt.id, { conversation: 'chat-1', spaceId: 'alice', spaceType: 'IM_ROBOT' }],
  ]);
  const payload = {
    outTrackId: prompt.id,
    userId: 'alice',
    userIdType: 1,
    spaceId: 'alice',
    spaceType: 'IM_ROBOT',
    content: JSON.stringify({ cardPrivateData: { params: { action: 'allow' } } }),
  };
  assert.deepEqual(dingCardAction(registry, { ...payload, spaceId: 'other' }, targets), {});
  assert.deepEqual(dingCardAction(registry, { ...payload, userIdType: 2 }, targets), {});
  assert.ok('userPrivateData' in dingCardAction(registry, { ...payload, userId: 'bob' }, targets));
  assert.equal(answers.length, 0);
  const result = dingCardAction(registry, payload, targets);
  assert.ok('cardData' in result);
  assert.deepEqual(answers, [{ allow: true }]);
  assert.ok('userPrivateData' in dingCardAction(registry, payload, targets));
  batch.close('done');
  assert.equal(dingCardData(prompt).status, 'done');
});

test('manager cards resume the original waiting run, reject revoked access, and expose text fallback', async () => {
  const f = fixture();
  let callback!: (sender: string, answer: Answer) => void;
  const statuses: string[] = [];
  Object.assign(f.channel, {
    async sendInteraction(_message: unknown, _request: Interaction, answer: typeof callback) {
      callback = answer;
      return {
        close: async (status: string) => {
          statuses.push(status);
        },
      };
    },
  });
  f.agent.handler = async (run) => {
    const result = await run.hooks.ask(
      { kind: 'approval', title: '批准？', detail: 'echo ok' },
      run.signal,
    );
    run.hooks.text(JSON.stringify(result));
  };
  try {
    await f.manager.receive(incoming('original user text'));
    await until(() => !!callback);
    assert.throws(() => callback('bob', { allow: true }), /无权/);
    await f.manager.receive(incoming('/tab pending'));
    assert.match(f.channel.sent.at(-1)!.text, /\/tab approve/);
    assert.equal(f.agent.inputs.length, 1);
    f.config.channels[0]!.allowedUsers = ['bob'];
    assert.throws(() => callback('alice', { allow: true }), /无权/);
    f.config.channels[0]!.allowedUsers = ['alice', 'bob'];
    callback('alice', { allow: false });
    assert.throws(() => callback('alice', { allow: true }), /已结束/);
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.agent.inputs[0]!.text, 'original user text');
    assert.deepEqual(statuses, ['已拒绝本次操作']);
    assert.equal(f.store.list()[0]!.status, 'idle');
  } finally {
    await f.cleanup();
  }
});

test('failed card send falls back to text; late delivery is invalidated after cancellation', async () => {
  const f = fixture();
  const statuses: string[] = [];
  let release!: (value: InteractionDelivery) => void;
  const channel = f.channel as Channel;
  channel.sendInteraction = async () => {
    throw new Error('secret upstream error');
  };
  f.agent.handler = async (run) => {
    await run.hooks.ask({ kind: 'approval', title: '批准？', detail: 'echo ok' }, run.signal);
  };
  try {
    await f.manager.receive(incoming('first'));
    await until(() => f.channel.sent.length > 0);
    assert.match(f.channel.sent[0]!.text, /\/tab approve/);
    assert.ok(!JSON.stringify(f.store.events(f.store.list()[0]!.id)).includes('secret upstream'));
    f.manager.stop(f.store.list()[0]!.id);
    await f.manager.idle();
    channel.sendInteraction = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await f.manager.receive(incoming('second'));
    await until(() => !!release);
    f.manager.stop(f.store.list()[0]!.id);
    await f.manager.idle();
    release({
      close: async (status) => {
        statuses.push(status);
      },
    });
    await until(() => statuses.length === 1);
    assert.match(statuses[0]!, /未自动批准/);
  } finally {
    await f.cleanup();
  }
});

test('answer validation preserves native single/multiple/other constraints', () => {
  const request = questions();
  assert.throws(
    () =>
      validateAnswer(request, { answers: { db: ['SQLite', 'PostgreSQL'], features: ['搜索'] } }),
    /一个答案/,
  );
  assert.throws(
    () =>
      validateAnswer(request, {
        answers: { db: ['SQLite'], features: ['搜索'], invented: ['oops'] },
      }),
    /未知/,
  );
  assert.throws(
    () => validateAnswer(request, { answers: { db: ['Oracle'], features: ['搜索'] } }),
    /选项/,
  );
  assert.doesNotThrow(() =>
    validateAnswer(request, { answers: { db: ['SQLite'], features: ['我的自定义功能'] } }),
  );
});

test('Feishu transport sends reply cards and its SDK dispatcher round-trips real callback envelopes', async () => {
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
  let dispatcher: any;
  const sent: any[] = [],
    patched: any[] = [],
    answers: Answer[] = [];
  Object.assign(channel, {
    socket: {
      start: async (options: any) => {
        dispatcher = options.eventDispatcher;
      },
      getConnectionStatus: () => ({ state: 'connected' }),
      close() {},
    },
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            sent.push(args);
            return { code: 0, data: { message_id: 'om-card' } };
          },
          patch: async (args: any) => {
            patched.push(args);
            return { code: 0 };
          },
        },
      },
    },
  });
  await channel.start(async () => {});
  const message = incoming('');
  message.replyTo = 'om-original';
  const delivery = await channel.sendInteraction(message, approval(), (_sender, value) =>
    answers.push(value),
  );
  assert.ok(delivery);
  assert.equal(sent[0].path.message_id, 'om-original');
  assert.equal(sent[0].data.reply_in_thread, true);
  const card = JSON.parse(sent[0].data.content),
    value = card.elements.find((e: any) => e.tag === 'action').actions[0].value;
  const result = await dispatcher.invoke(
    {
      schema: '2.0',
      header: { event_type: 'card.action.trigger', event_id: 'event-1' },
      event: {
        operator: { open_id: 'alice' },
        context: { open_chat_id: 'chat-1', open_message_id: 'om-card' },
        action: { value },
      },
    },
    { needCheck: false },
  );
  assert.equal(result.toast.type, 'success');
  assert.deepEqual(answers, [{ allow: true }]);
  await delivery.close('已允许');
  assert.equal(patched[0].path.message_id, 'om-card');
  await channel.stop();
});

test('WeCom transport registers callbacks and safely falls back for free text', async () => {
  class FakeSocket extends EventEmitter {
    sent: any[] = [];
    updated: any[] = [];
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
      return { errcode: 0 };
    }
  }
  const socket = new FakeSocket(),
    channel = new WecomChannel(
      { type: 'wecom', id: 'wecom', allowedUsers: ['alice'], botIdEnv: 'ID', secretEnv: 'SECRET' },
      () => 'fixture',
    );
  Object.assign(channel, { client: socket });
  await channel.start(async () => {});
  const message = incoming('');
  message.route.conversation = 'alice';
  message.route.platform = 'wecom';
  const answers: Answer[] = [];
  const delivery = await channel.sendInteraction(message, approval(), (_sender, value) =>
    answers.push(value),
  );
  assert.ok(delivery);
  assert.equal(socket.sent[0][1].msgtype, 'template_card');
  const task = socket.sent[0][1].template_card.task_id;
  socket.emit('event.template_card_event', {
    headers: { req_id: 'callback' },
    body: {
      from: { userid: 'alice' },
      chattype: 'single',
      event: {
        eventtype: 'template_card_event',
        template_card_event: { task_id: task, event_key: 'deny' },
      },
    },
  });
  await until(() => socket.updated.length === 1);
  assert.deepEqual(answers, [{ allow: false }]);
  assert.equal(socket.updated[0][1].card_type, 'text_notice');
  assert.deepEqual(socket.updated[0][2], ['alice']);
  await delivery.close('done');
  const question = {
    ...approval(),
    kind: 'question' as const,
    questions: [{ id: 'free', question: '输入说明' }],
  };
  assert.equal(await channel.sendInteraction(message, question, () => {}), undefined);
  assert.equal(socket.sent.length, 1);
  await channel.stop();
});

test('Feishu text and cards stay at the root, including dashboard turns; failures never fall back to chat', async () => {
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
  const replies: any[] = [];
  let creates = 0,
    fail = false;
  Object.assign(channel, {
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            replies.push(args);
            return fail
              ? { code: 230019 }
              : { code: 0, data: { message_id: `om-result-${replies.length}` } };
          },
          create: async () => {
            creates++;
            return { code: 0 };
          },
          patch: async () => ({ code: 0 }),
        },
      },
    },
  });
  const message = incoming('');
  message.route.thread = 'om_root'; // No replyTo on dashboard submissions.
  await channel.send(message, 'text');
  const delivery = await channel.sendInteraction(message, approval(), () => {});
  assert.ok(delivery);
  await delivery.close('done');
  assert.equal(replies.length, 2);
  assert.ok(
    replies.every((r) => r.path.message_id === 'om_root' && r.data.reply_in_thread === true),
  );
  fail = true;
  await assert.rejects(channel.send(message, 'failed'));
  await assert.rejects(channel.sendInteraction(message, approval(), () => {}));
  assert.equal(creates, 0);
  message.route.thread = 'omt-legacy';
  await assert.rejects(channel.send(message, 'ambiguous'), /根消息/);
  assert.equal(creates, 0);
  await channel.stop();
});

test('DingTalk transport sends tenant template via official endpoint and acknowledges Stream callbacks', async (t) => {
  const handlers = new Map<string, (event: any) => void>(),
    responses: any[] = [],
    requests: any[] = [],
    answers: Answer[] = [];
  const socket = {
    connected: true,
    registerCallbackListener(topic: string, handler: (event: any) => void) {
      handlers.set(topic, handler);
    },
    async connect() {},
    disconnect() {},
    socketCallBackResponse(id: string, result: any) {
      responses.push({ id, result });
    },
  };
  const channel = new DingTalkChannel(
    {
      type: 'dingtalk',
      id: 'ding',
      allowedUsers: ['alice'],
      clientIdEnv: 'ID',
      clientSecretEnv: 'SECRET',
      cardTemplateId: 'tenant-owned.schema',
    },
    () => 'fixture',
  );
  Object.assign(channel, { client: socket });
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), options, body });
    if (String(url).startsWith('https://oapi.dingtalk.com/robot/'))
      return Response.json({ errcode: 0 });
    if (String(url).endsWith('/oauth2/accessToken'))
      return Response.json({ accessToken: 'not-in-card', expireIn: 7200 });
    if (String(url).endsWith('/createAndDeliver'))
      return Response.json({ success: true, result: { deliverResults: [{ success: true }] } });
    return Response.json({ success: true });
  });
  await channel.start(async () => {});
  handlers.get(TOPIC_ROBOT)!({
    headers: { messageId: 'message-event' },
    data: JSON.stringify({
      conversationId: 'chat-1',
      conversationType: '1',
      senderStaffId: 'alice',
      senderId: 'unused',
      msgId: 'm1',
      msgtype: 'text',
      text: { content: 'hello' },
      robotCode: 'robot-code',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/send?token=fixture',
    }),
  });
  await until(() => responses.length === 1);
  const message = incoming('');
  message.route.platform = 'dingtalk';
  message.route.account = 'ding';
  const delivery = await channel.sendInteraction(message, approval(), (_sender, value) =>
    answers.push(value),
  );
  assert.ok(delivery);
  const sent = requests.find((r) => r.url.endsWith('/createAndDeliver'));
  assert.equal(sent.body.callbackType, 'STREAM');
  assert.equal(sent.body.openSpaceId, 'dtv1.card//IM_ROBOT.alice');
  assert.equal(sent.body.imRobotOpenSpaceModel.supportForward, false);
  assert.equal(sent.body.cardTemplateId, 'tenant-owned.schema');
  assert.ok(!JSON.stringify(sent.body).includes('not-in-card'));
  handlers.get(TOPIC_CARD)!({
    headers: { messageId: 'view' },
    data: JSON.stringify({
      outTrackId: sent.body.outTrackId,
      userId: 'alice',
      userIdType: 1,
      spaceId: 'alice',
      spaceType: 'IM_ROBOT',
      content: JSON.stringify({ cardPrivateData: { params: { action: 'details' } } }),
    }),
  });
  assert.deepEqual(answers, []);
  assert.equal(responses.at(-1).id, 'view');
  assert.equal(responses.at(-1).result.details, undefined);
  await until(() =>
    requests.some(
      (r) =>
        r.url.startsWith('https://oapi.dingtalk.com/robot/') &&
        r.body.text?.content.includes('echo ok'),
    ),
  );
  handlers.get(TOPIC_CARD)!({
    headers: { messageId: 'click' },
    data: JSON.stringify({
      outTrackId: sent.body.outTrackId,
      userId: 'alice',
      userIdType: 1,
      spaceId: 'alice',
      spaceType: 'IM_ROBOT',
      content: JSON.stringify({ cardPrivateData: { params: { action: 'allow' } } }),
    }),
  });
  assert.deepEqual(answers, [{ allow: true }]);
  assert.equal(responses.at(-1).id, 'click');
  assert.ok(responses.at(-1).result.cardData);
  await delivery.close('done');
  assert.equal(requests.at(-1).options.method, 'PUT');
  assert.equal(requests.at(-1).body.cardData.cardParamMap.status, 'done');
  await channel.stop();
});

test('DingTalk falls back to text when native approval choices exceed its tenant template', async () => {
  const { DingTalkChannel } = await import('../src/channels/dingtalk.js');
  const channel = new DingTalkChannel(
    {
      id: 'ding',
      type: 'dingtalk',
      clientIdEnv: 'ID',
      clientSecretEnv: 'SECRET',
      allowedUsers: ['alice'],
      cardTemplateId: 'fixture',
    },
    () => 'fixture',
  );
  const message = incoming('');
  message.route.platform = 'dingtalk';
  message.route.account = 'ding';
  (channel as any).cardRecipients.set(
    JSON.stringify([message.route.conversation, message.route.sender]),
    { spaceId: 'space', spaceType: 'IM_GROUP', robotCode: 'fixture' },
  );
  const request = approval();
  request.approvalOptions = [
    { id: 'allow', label: '允许本次' },
    { id: 'session', label: '本会话允许' },
    { id: 'deny', label: '拒绝' },
  ];
  assert.equal(
    await channel.sendInteraction(message, request, () =>
      assert.fail('Fallback must not submit an answer'),
    ),
    undefined,
  );
  await channel.stop();
});
