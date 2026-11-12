import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLark, normalizeDingTalk, normalizeWecom } from '../src/channels/normalize.js';
import { splitText } from '../src/channels/common.js';
import { checkedWebhook } from '../src/channels/dingtalk.js';
import { LarkChannel } from '../src/channels/lark.js';

test('Lark start waits for a connected socket, rejects terminal failure and can be cancelled', async () => {
  const create = () =>
    new LarkChannel(
      {
        type: 'lark',
        id: 'test',
        allowedUsers: ['alice'],
        appIdEnv: 'ID',
        appSecretEnv: 'SECRET',
        botOpenId: 'bot',
        domain: 'feishu',
      },
      () => 'fixture',
    );
  const channel = create();
  let state = 'connecting',
    ready = false,
    closed = false;
  Object.assign(channel, {
    socket: {
      start: async () => {},
      getConnectionStatus: () => ({ state }),
      close() {
        closed = true;
      },
    },
  });
  const started = channel
    .start(async () => {})
    .then(() => {
      ready = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ready, false);
  state = 'connected';
  await started;
  assert.equal(ready, true);
  await channel.stop();
  assert.equal(closed, true);
  const failed = create();
  Object.assign(failed, {
    socket: { start: async () => {}, getConnectionStatus: () => ({ state: 'failed' }), close() {} },
  });
  await assert.rejects(
    failed.start(async () => {}),
    /长连接未建立/,
  );
  const cancelled = create();
  Object.assign(cancelled, {
    socket: {
      start: async () => {},
      getConnectionStatus: () => ({ state: 'connecting' }),
      close() {},
    },
  });
  const pending = assert.rejects(
    cancelled.start(async () => {}),
    /长连接未建立/,
  );
  await cancelled.stop();
  await pending;
});

test('Lark only accepts humans and explicit bot mentions in groups; preserves content', () => {
  const raw = {
    sender: { sender_type: 'user', sender_id: { open_id: 'alice' } },
    message: {
      message_id: '1',
      chat_id: 'chat',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1  keep\nspaces  ' }),
      thread_id: 'topic',
      mentions: [{ key: '@_user_1', id: { open_id: 'bot' } }],
    },
  };
  const message = normalizeLark(raw, 'feishu', 'bot')!;
  assert.equal(message.text, ' keep\nspaces  ');
  assert.equal(message.route.thread, '1');
  assert.equal(normalizeLark(raw, 'feishu', 'other-bot'), undefined);
  assert.equal(
    normalizeLark({ ...raw, sender: { ...raw.sender, sender_type: 'app' } }, 'feishu', 'bot'),
    undefined,
  );
  assert.equal(
    normalizeLark(
      {
        ...raw,
        message: {
          ...raw.message,
          chat_type: 'p2p',
          mentions: [],
          content: JSON.stringify({ text: '  exact  ' }),
        },
      },
      'feishu',
      'bot',
    )!.text,
    '  exact  ',
  );
});
test('Lark main messages share a route; existing topic replies use their stable root', () => {
  const raw = {
    sender: { sender_type: 'user', sender_id: { open_id: 'alice' } },
    message: {
      message_id: 'om-root',
      chat_id: 'dm',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"hello"}',
    },
  };
  const root = normalizeLark(raw, 'feishu', 'bot')!;
  const reply = normalizeLark(
    {
      ...raw,
      message: {
        ...raw.message,
        message_id: 'om-reply',
        root_id: 'om-root',
        thread_id: 'omt-thread',
      },
    },
    'feishu',
    'bot',
  )!;
  const quotedReply = normalizeLark(
    { ...raw, message: { ...raw.message, message_id: 'om-reply-2', root_id: 'om-root' } },
    'feishu',
    'bot',
  )!;
  assert.equal(root.route.thread, '');
  assert.equal(root.replyTo, undefined);
  assert.deepEqual(root.route, quotedReply.route);
  assert.equal(quotedReply.replyTo, undefined);
  assert.equal(reply.replyTo, 'om-root');
  const other = normalizeLark(
    { ...raw, message: { ...raw.message, message_id: 'om-other' } },
    'feishu',
    'bot',
  )!;
  assert.deepEqual(root.route, other.route);
});
test('DingTalk uses staff identity, ignores unmentioned groups and keeps user whitespace', () => {
  const raw = {
    msgId: 'd1',
    msgtype: 'text',
    conversationId: 'chat',
    conversationType: '2',
    senderStaffId: 'staff',
    senderId: 'opaque',
    isInAtList: true,
    text: { content: ' \nhello  ' },
  };
  assert.equal(normalizeDingTalk(raw, 'ding')!.text, ' \nhello  ');
  assert.equal(normalizeDingTalk(raw, 'ding')!.route.sender, 'staff');
  assert.equal(normalizeDingTalk({ ...raw, isInAtList: false }, 'ding'), undefined);
});
test('WeCom routes private replies to userid and group replies to chatid', () => {
  const raw = {
    msgid: 'w1',
    chattype: 'single',
    from: { userid: 'u1' },
    msgtype: 'text',
    text: { content: '原文\n' },
  };
  assert.equal(normalizeWecom(raw, 'wx')!.route.conversation, 'u1');
  assert.equal(
    normalizeWecom({ ...raw, chattype: 'group', chatid: 'group1' }, 'wx')!.route.conversation,
    'group1',
  );
  assert.equal(normalizeWecom({ ...raw, chattype: 'group' }, 'wx'), undefined);
});
test('outbound splitting preserves Unicode exactly and enforces byte limits', () => {
  const text = '🙂中文\n'.repeat(900);
  const parts = splitText(text, 3000);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((p) => Buffer.byteLength(p) <= 3000));
  assert.ok(parts.every((p) => !p.includes('\ufffd')));
});
test('signed DingTalk webhooks cannot be used as arbitrary HTTP proxies', () => {
  assert.ok(checkedWebhook('https://oapi.dingtalk.com/robot/sendBySession?session=x'));
  for (const url of [
    'http://oapi.dingtalk.com/robot/send',
    'https://evil.example/robot/send',
    'https://oapi.dingtalk.com.evil.example/robot/send',
    'https://oapi.dingtalk.com:8443/robot/send',
    'https://user:pw@oapi.dingtalk.com/robot/send',
    'https://oapi.dingtalk.com/token',
  ])
    assert.throws(() => checkedWebhook(url));
});
test('Lark tool cards create in their original topic, update the same message and reject failed delivery', async () => {
  const channel = new LarkChannel(
    {
      type: 'lark',
      id: 'test',
      allowedUsers: ['alice'],
      appIdEnv: 'ID',
      appSecretEnv: 'SECRET',
      botOpenId: 'bot',
      domain: 'feishu',
    },
    () => 'fixture',
  );
  const calls: any[] = [];
  let fail = false;
  Object.assign(channel, {
    client: {
      im: {
        message: {
          reply: async (input: any) => {
            calls.push(input);
            return { code: fail ? 1 : 0, data: { message_id: 'card' } };
          },
          patch: async (input: any) => {
            calls.push(input);
            return { code: 0 };
          },
          create: async () => {
            assert.fail('topic must not go to main');
          },
        },
      },
    },
  });
  const view = {
    id: 'run',
    agent: 'codex' as const,
    status: 'running' as const,
    total: 1,
    tools: [{ id: 't', name: '命令', status: 'running' as const, input: 'pwd' }],
  };
  const message = {
    id: 'm',
    text: 'task',
    route: {
      platform: 'lark' as const,
      account: 'test',
      conversation: 'chat',
      sender: 'alice',
      thread: 'om_root',
    },
  };
  assert.equal(await channel.sendToolProgress(message, view), 'card');
  await channel.updateToolProgress('card', { ...view, status: 'completed' });
  assert.equal(calls[0].path.message_id, 'om_root');
  assert.equal(calls[0].data.reply_in_thread, true);
  assert.equal(calls[1].path.message_id, 'card');
  fail = true;
  await assert.rejects(channel.sendToolProgress(message, view));
});
