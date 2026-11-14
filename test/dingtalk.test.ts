import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream';
import { DingTalkChannel } from '../src/channels/dingtalk.js';
import { DingTalkApi } from '../src/channels/dingtalk-api.js';
import { normalizeDingTalk } from '../src/channels/normalize.js';
import { managementView } from '../src/core/management-view.js';
import type { Incoming } from '../src/core/types.js';
import { fixture, until } from './helpers.js';

function raw(overrides: Record<string, unknown> = {}) {
  return {
    msgId: 'message-1',
    msgtype: 'text',
    conversationId: 'conversation-1',
    conversationType: '1',
    senderStaffId: 'alice',
    senderId: 'opaque-id',
    robotCode: 'robot-code',
    text: { content: 'hello' },
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=fixture',
    sessionWebhookExpiredTime: Date.now() + 60_000,
    ...overrides,
  };
}
function transport(t: TestContext, id = 'ding') {
  const channel = new DingTalkChannel(
    {
      id,
      type: 'dingtalk',
      allowedUsers: ['alice'],
      clientIdEnv: 'ID',
      clientSecretEnv: 'SECRET',
    },
    (key) => (key === 'ID' ? 'fixture-client' : 'fixture-secret'),
  );
  const handlers = new Map<string, (event: any) => void>(),
    responses: { id: string; result: unknown }[] = [],
    messages: Incoming[] = [];
  const socket = {
    connected: true,
    registerCallbackListener(topic: string, handler: (event: any) => void) {
      handlers.set(topic, handler);
    },
    async connect() {},
    disconnect() {},
    socketCallBackResponse(id: string, result: unknown) {
      responses.push({ id, result });
    },
  };
  Object.assign(channel, { client: socket });
  t.after(() => channel.stop());
  return {
    channel,
    socket,
    responses,
    messages,
    async start(receive?: (message: Incoming) => Promise<void>) {
      await channel.start(async (message) => {
        messages.push(message);
        await receive?.(message);
      });
    },
    emit(value: unknown = raw(), id = 'event-1', topic = TOPIC_ROBOT) {
      handlers.get(topic)!({ headers: { messageId: id }, data: JSON.stringify(value) });
    },
  };
}
function mockApi(
  t: TestContext,
  send: (url: string, body: any) => Response | Promise<Response> = () =>
    Response.json({ processQueryKey: 'accepted' }),
) {
  const requests: { url: string; body: any; headers: Headers; redirect?: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: any, options: RequestInit) => {
    const request = {
      url: String(url),
      body: JSON.parse(String(options.body)),
      headers: new Headers(options.headers),
      redirect: options.redirect,
    };
    requests.push(request);
    if (request.url.endsWith('/oauth2/accessToken'))
      return Response.json({ accessToken: 'fixture-access-token', expireIn: 7200 });
    return send(request.url, request.body);
  });
  return requests;
}

test('DingTalk acknowledges receipt while business handling is still pending', async (t) => {
  const f = transport(t);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await f.start(() => pending);
  f.emit();
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.responses, [{ id: 'event-1', result: { status: 'SUCCESS' } }]);
  finish();
});

test('DingTalk acknowledges invalid, unsupported and failing callbacks without leaking payloads', async (t) => {
  const f = transport(t),
    logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
  await f.start(async () => {
    throw new Error('fixture-secret signed-webhook');
  });
  f.emit(null, 'null');
  f.emit(raw({ msgtype: 'picture' }), 'picture');
  f.emit(raw({ conversationType: '2', isInAtList: false }), 'unmentioned');
  f.emit(raw({ conversationType: 'unknown' }), 'unknown');
  f.emit(raw(), 'failing');
  f.emit(null, 'card', TOPIC_CARD);
  await setImmediate();
  assert.equal(f.responses.length, 6);
  assert.equal(f.messages.length, 1);
  assert.ok(logs.length);
  assert.doesNotMatch(logs.join('\n'), /fixture-secret|signed-webhook/);
});

test('DingTalk duplicate Stream deliveries run through persistent Manager deduplication', async (t) => {
  const app = fixture(),
    f = transport(t, 'test-lark');
  t.after(() => app.cleanup());
  app.config.channels[0] = {
    id: 'test-lark',
    type: 'dingtalk',
    allowedUsers: ['alice'],
    clientIdEnv: 'ID',
    clientSecretEnv: 'SECRET',
  };
  await f.start((message) => app.manager.receive(message));
  f.emit(raw(), 'first');
  f.emit(raw(), 'redelivery');
  await until(() => app.agent.inputs.length === 1);
  await setImmediate();
  assert.equal(app.agent.inputs.length, 1);
  assert.equal(f.responses.length, 2);
});

test('DingTalk uses valid webhooks and splits Unicode replies without acquiring a token', async (t) => {
  const f = transport(t),
    requests = mockApi(t, () => Response.json({ errcode: 0 }));
  await f.start();
  f.emit();
  const text = '🙂中文\n'.repeat(1000);
  await f.channel.send(f.messages[0]!, text);
  assert.equal(requests.map((r) => r.body.text.content).join(''), text);
  assert.ok(
    requests.every(
      (r) =>
        r.url.startsWith('https://oapi.dingtalk.com/robot/') &&
        Buffer.byteLength(r.body.text.content) <= 3000 &&
        r.redirect === 'error',
    ),
  );
  assert.doesNotMatch(JSON.stringify(f.messages), /session=|sessionWebhook|robot-code/);
});

for (const group of [false, true])
  test(`DingTalk proactively replies to the original ${group ? 'group' : 'staff ID'} after webhook expiry`, async (t) => {
    const f = transport(t),
      requests = mockApi(t);
    await f.start();
    f.emit(
      raw({
        conversationType: group ? '2' : '1',
        isInAtList: true,
        sessionWebhookExpiredTime: Date.now() - 1,
      }),
    );
    const message = {
      ...f.messages[0]!,
      route: { ...f.messages[0]!.route, thread: 'virtual-child' },
    };
    await f.channel.send(message, 'long task result');
    const sent = requests[1]!;
    assert.equal(
      sent.url,
      `https://api.dingtalk.com/v1.0/robot/${group ? 'groupMessages/send' : 'oToMessages/batchSend'}`,
    );
    assert.equal(sent.headers.get('x-acs-dingtalk-access-token'), 'fixture-access-token');
    assert.deepEqual(sent.body, {
      robotCode: 'robot-code',
      ...(group ? { openConversationId: 'conversation-1' } : { userIds: ['alice'] }),
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: 'long task result' }),
    });
    assert.equal(requests.length, 2);
  });

test('DingTalk preserves valid text with missing or invalid webhooks and uses proactive Markdown menus', async (t) => {
  const f = transport(t),
    requests = mockApi(t);
  t.mock.method(console, 'error', () => {});
  await f.start();
  f.emit(raw({ sessionWebhook: undefined }));
  f.emit(raw({ sessionWebhook: 'https://evil.example/robot/send' }), 'invalid-webhook');
  f.emit(raw({ sessionWebhook: null }), 'null-webhook');
  assert.equal(f.messages.length, 3);
  await f.channel.sendManagement(f.messages[0]!, managementView('menu', 'body <at id=all>'));
  const sent = requests[1]!;
  assert.equal(sent.body.msgKey, 'sampleMarkdown');
  assert.match(JSON.parse(sent.body.msgParam).text, /\/tab status/);
  assert.doesNotMatch(sent.body.msgParam, /<at/);
  assert.ok(requests.every((r) => r.url.startsWith('https://api.dingtalk.com/')));
});

test('DingTalk renders formatted answers as Markdown without quoting the whole message and falls back only on a definite rejection', async (t) => {
  const f = transport(t);
  const requests = mockApi(t, (_url, body) =>
    Response.json({ errcode: body.msgtype === 'markdown' ? 400 : 0 }),
  );
  await f.start();
  f.emit();
  const answer = '## 测试结果\n\n**成功**\n\n- 项目一\n<at id=all>';
  await f.channel.send(f.messages[0]!, answer);
  assert.deepEqual(
    requests.map((r) => r.body.msgtype),
    ['markdown', 'text'],
  );
  assert.match(requests[0]!.body.markdown.text, /^## 测试结果/);
  assert.doesNotMatch(requests[0]!.body.markdown.text, /<at|^> /m);
  assert.equal(requests[1]!.body.text.content, answer);
});

test('DingTalk never replays a rich answer after an uncertain Markdown send', async (t) => {
  const f = transport(t);
  const requests = mockApi(t, () => {
    throw new Error('unknown result');
  });
  await f.start();
  f.emit();
  await assert.rejects(f.channel.send(f.messages[0]!, '**formatted answer**'), /结果未知/);
  assert.equal(requests.length, 1);
});

test('DingTalk does not replace a newer webhook with an older redelivery', async (t) => {
  const f = transport(t),
    requests = mockApi(t, () => Response.json({ errcode: 0 }));
  await f.start();
  f.emit(
    raw({
      sessionWebhook: 'https://oapi.dingtalk.com/robot/send?new',
      sessionWebhookExpiredTime: Date.now() + 120_000,
    }),
  );
  f.emit(raw({ sessionWebhook: 'https://oapi.dingtalk.com/robot/send?old' }), 'redelivery');
  await f.channel.send(f.messages[0]!, 'result');
  assert.equal(requests[0]!.url, 'https://oapi.dingtalk.com/robot/send?new');
});

test('DingTalk never guesses a proactive recipient or sends across bots', async (t) => {
  const f = transport(t),
    requests = mockApi(t);
  await f.start();
  f.emit(raw({ sessionWebhook: undefined, senderStaffId: undefined }));
  await assert.rejects(f.channel.send(f.messages[0]!, 'result'), /缺少主动发送目标/);
  f.emit(raw({ sessionWebhook: undefined }));
  const original = f.messages[1]!;
  for (const route of [
    { ...original.route, sender: 'bob' },
    { ...original.route, conversation: 'other-conversation' },
    { ...original.route, account: 'other-bot' },
    { ...original.route, platform: 'lark' as const },
  ])
    await assert.rejects(f.channel.send({ ...original, route }, 'result'));
  assert.equal(requests.length, 0);
});

for (const response of [
  {},
  { processQueryKey: '' },
  { code: 'Forbidden' },
  { processQueryKey: 'accepted', invalidStaffIdList: ['alice'] },
  { processQueryKey: 'accepted', flowControlledStaffIdList: ['alice'] },
])
  test(`DingTalk rejects unconfirmed proactive delivery: ${JSON.stringify(response)}`, async (t) => {
    const f = transport(t),
      requests = mockApi(t, () => Response.json(response));
    await f.start();
    f.emit(raw({ sessionWebhook: undefined }));
    await assert.rejects(f.channel.send(f.messages[0]!, 'result'), /未确认消息受理/);
    assert.equal(requests.length, 2);
  });

test('DingTalk does not retry or switch transports after ambiguous webhook results', async (t) => {
  const f = transport(t);
  await f.start();
  f.emit();
  for (const outcome of ['timeout', 'http-error', 'bad-json', 'empty-result']) {
    const requests = mockApi(t, () => {
      if (outcome === 'timeout') throw new Error('fixture-secret session=fixture');
      if (outcome === 'http-error') return new Response('error', { status: 503 });
      if (outcome === 'bad-json') return new Response('invalid JSON');
      return Response.json({});
    });
    await assert.rejects(
      f.channel.sendManagement(f.messages[0]!, managementView('menu', 'body')),
      (error: Error) => !/fixture-secret|session=/.test(error.message),
    );
    assert.equal(requests.length, 1);
  }
});

test('DingTalk falls back to text only after a definite Markdown webhook rejection', async (t) => {
  const f = transport(t),
    requests = mockApi(t, (_url, body) =>
      Response.json({ errcode: body.msgtype === 'markdown' ? 400 : 0 }),
    );
  await f.start();
  f.emit();
  await f.channel.sendManagement(f.messages[0]!, managementView('menu', 'body'));
  assert.deepEqual(
    requests.map((r) => r.body.msgtype),
    ['markdown', 'text'],
  );
});

test('DingTalk shares one application-token refresh across simultaneous requests', async (t) => {
  const f = transport(t),
    requests = mockApi(t);
  await f.start();
  f.emit(raw({ sessionWebhook: undefined }));
  await Promise.all([
    f.channel.send(f.messages[0]!, 'first'),
    f.channel.sendManagement(f.messages[0]!, managementView('menu', 'body')),
  ]);
  assert.equal(requests.filter((r) => r.url.endsWith('/oauth2/accessToken')).length, 1);
  assert.equal(requests.length, 3);
});

test('DingTalk token failures release concurrent waiters, sanitize errors and allow a later refresh', async (t) => {
  const api = new DingTalkApi('fixture-client', 'fixture-secret');
  let calls = 0,
    fail = true;
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    calls++;
    if (fail) throw new Error('fixture-secret');
    return Response.json(
      String(url).endsWith('/oauth2/accessToken')
        ? { accessToken: 'token', expireIn: 7200 }
        : { processQueryKey: 'accepted' },
    );
  });
  const results = await Promise.allSettled([
    api.request('POST', '/v1.0/robot/oToMessages/batchSend', {}),
    api.request('POST', '/v1.0/robot/oToMessages/batchSend', {}),
  ]);
  assert.ok(
    results.every((r) => r.status === 'rejected' && !/fixture-secret/.test(r.reason.message)),
  );
  assert.equal(calls, 1);
  fail = false;
  await api.request('POST', '/v1.0/robot/oToMessages/batchSend', {});
  assert.equal(calls, 3);
});

test('DingTalk refreshes expiring tokens and invalidates unauthorized tokens without replaying a send', async (t) => {
  const api = new DingTalkApi('fixture-client', 'fixture-secret');
  let now = 100_000,
    tokens = 0,
    sends = 0,
    unauthorized = false;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    if (String(url).endsWith('/oauth2/accessToken')) {
      tokens++;
      return Response.json({ accessToken: `token-${tokens}`, expireIn: 120 });
    }
    sends++;
    return unauthorized
      ? new Response('', { status: 401 })
      : Response.json({ processQueryKey: 'ok' });
  });
  await api.request('POST', '/v1.0/robot/oToMessages/batchSend', {});
  now += 61_000;
  await api.request('POST', '/v1.0/robot/oToMessages/batchSend', {});
  assert.equal(tokens, 2);
  unauthorized = true;
  await assert.rejects(api.request('POST', '/v1.0/robot/oToMessages/batchSend', {}));
  assert.equal(sends, 3);
  assert.equal(tokens, 2);
  unauthorized = false;
  await api.request('POST', '/v1.0/robot/oToMessages/batchSend', {});
  assert.equal(tokens, 3);
});

test('DingTalk startup failures disconnect and never expose SDK credentials', async (t) => {
  const f = transport(t);
  let disconnects = 0;
  f.socket.disconnect = () => {
    disconnects++;
  };
  f.socket.connect = async () => {
    throw new Error('fixture-secret');
  };
  await assert.rejects(
    f.start(),
    (error: Error) => /连接失败/.test(error.message) && !error.message.includes('fixture-secret'),
  );
  assert.equal(disconnects, 1);
});

test('DingTalk startup rejects an SDK connect that resolves without a live connection', async (t) => {
  const f = transport(t);
  let disconnects = 0;
  f.socket.connected = false;
  f.socket.disconnect = () => {
    disconnects++;
  };
  await assert.rejects(f.start(), /连接失败/);
  assert.equal(disconnects, 1);
});

test('DingTalk discards reply capabilities when the channel is stopped', async (t) => {
  const f = transport(t),
    requests = mockApi(t);
  await f.start();
  f.emit(raw());
  await f.channel.stop();
  await assert.rejects(f.channel.send(f.messages[0]!, 'late result'), /缺少主动发送目标/);
  assert.equal(requests.length, 0);
});

test('DingTalk bots own separate callback subscriptions without subscribing to unrelated events', async (t) => {
  const config = {
    id: 'ding',
    type: 'dingtalk' as const,
    allowedUsers: [],
    clientIdEnv: 'ID',
    clientSecretEnv: 'SECRET',
  };
  const a = new DingTalkChannel(config, () => 'fixture'),
    b = new DingTalkChannel({ ...config, id: 'ding-2' }, () => 'fixture');
  t.after(() => a.stop());
  t.after(() => b.stop());
  const first = (a as any).client,
    second = (b as any).client;
  assert.deepEqual(first.config.subscriptions, []);
  first.registerCallbackListener(TOPIC_ROBOT, () => {});
  assert.deepEqual(first.config.subscriptions, [{ type: 'CALLBACK', topic: TOPIC_ROBOT }]);
  assert.deepEqual(second.config.subscriptions, []);
});

test('DingTalk normalization rejects unknown conversation types and empty routing identities', () => {
  for (const overrides of [
    { conversationType: '3' },
    { conversationId: '' },
    { senderId: '' },
    { msgId: '' },
  ])
    assert.equal(normalizeDingTalk(raw(overrides), 'ding'), undefined);
});
