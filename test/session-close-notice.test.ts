import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { LarkChannel } from '../src/channels/lark.js';
import { larkClosedCard } from '../src/channels/lark-system-card.js';
import { type Session } from '../src/core/types.js';

test('close notice is sent once after the active agent output and stays on the same route', async () => {
  const f = fixture();
  const order: string[] = [],
    notices: Session[] = [];
  const send = f.channel.send.bind(f.channel);
  f.channel.send = async (message, text) => {
    order.push('output');
    await send(message, text);
  };
  Object.assign(f.channel, {
    sendSessionClosed: async (session: Session) => {
      order.push('closed');
      notices.push(session);
    },
  });
  f.agent.handler = async (run) => {
    await new Promise<void>((resolve) =>
      run.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    run.hooks.text('最后一条 Agent 输出');
  };
  try {
    const message = incoming('长任务');
    await f.manager.receive(message);
    const s = f.store.current(message.route)!;
    f.manager.closeSession(s.id);
    f.manager.closeSession(s.id);
    await f.manager.idle();
    await until(() => notices.length === 1);
    assert.deepEqual(order, ['output', 'closed']);
    assert.deepEqual(notices[0]!.route, message.route);
    assert.equal(f.store.get(s.id)!.status, 'closed');
    await f.manager.receive(incoming('/tab close'));
    assert.equal(notices.length, 1);
    assert.match(f.channel.sent.at(-1)!.text, /tab-ai 系统通知/);
  } finally {
    await f.cleanup();
  }
});

test('reopening cancels an unsent close notice; a later close creates a new notice', async () => {
  const f = fixture();
  const notices: string[] = [];
  Object.assign(f.channel, {
    sendSessionClosed: async (_s: Session, notice: { id: string }) => {
      notices.push(notice.id);
    },
  });
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    f.manager.closeSession(s.id);
    f.manager.openSession(s.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(notices.length, 0);
    f.manager.closeSession(s.id);
    await until(() => notices.length === 1);
    f.manager.openSession(s.id);
    f.manager.closeSession(s.id);
    await until(() => notices.length === 2);
    assert.notEqual(notices[0], notices[1]);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('non-card channels receive a labeled system notice; uncertain failures are not retried', async () => {
  const f = fixture();
  Object.assign(f.channel, { sendSessionClosed: undefined });
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    f.manager.closeSession(s.id);
    await until(() => f.channel.sent.length === 1);
    assert.match(f.channel.sent[0]!.text, /^【tab-ai 系统通知】/);
    f.manager.openSession(s.id);
    let attempts = 0;
    Object.assign(f.channel, {
      sendSessionClosed: async () => {
        attempts++;
        throw new Error('unknown delivery');
      },
    });
    f.manager.closeSession(s.id);
    await until(() => f.store.events(s.id).some((e) => e.type === 'delivery_error'));
    assert.equal(attempts, 1);
    assert.equal(f.store.get(s.id)!.status, 'closed');
  } finally {
    await f.cleanup();
  }
});

test('Lark close card has system branding and replies in-topic, while main-chat notices remain at top level', async () => {
  const f = fixture();
  const channel = new LarkChannel(
    f.config.channels[0] as any,
    () => 'credential',
    f.config.dataDir,
  );
  const sent: any[] = [];
  (channel as any).client = {
    im: {
      message: {
        reply: async (r: any) => {
          sent.push({ kind: 'reply', ...r });
          return { code: 0, data: { message_id: 'om_notice' } };
        },
        create: async (r: any) => {
          sent.push({ kind: 'create', ...r });
          return { code: 0, data: { message_id: 'om_notice2' } };
        },
      },
    },
  };
  try {
    const s = f.store.create(incoming('', 'alice', 'om_topic').route, 'codex', f.dir);
    s.title = '<at id=all>测试</at>';
    s.status = 'closed';
    const notice = { id: crypto.randomUUID(), at: Date.now(), recovery: '发送 /tab open' };
    const card = larkClosedCard(s, notice);
    assert.equal(card.schema, '2.0');
    assert.equal(card.header.title.content, 'tab-ai · 会话已关闭');
    assert.equal(card.header.subtitle.content, '系统状态通知');
    assert.ok(!JSON.stringify(card).includes('<at id=all>'));
    assert.match(JSON.stringify(card), /tab open/);
    await channel.sendSessionClosed(s, notice);
    assert.equal(sent[0].kind, 'reply');
    assert.equal(sent[0].path.message_id, 'om_topic');
    assert.equal(sent[0].data.reply_in_thread, true);
    await channel.sendSessionClosed(
      { ...s, route: { ...s.route, thread: '' } },
      { ...notice, id: crypto.randomUUID() },
    );
    assert.equal(sent[1].kind, 'create');
    assert.equal(sent[1].data.receive_id, s.route.conversation);
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});
