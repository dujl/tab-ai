import { cardElements, callbackValue } from './card-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming, until } from './helpers.js';
import { managementView, managementText } from '../src/core/management-view.js';
import {
  ManagementCards,
  larkManagementCard,
  wecomManagementCard,
  larkManagementAction,
  wecomManagementAction,
} from '../src/channels/management-cards.js';
import { LarkChannel } from '../src/channels/lark.js';
import { WecomChannel } from '../src/channels/wecom.js';
import { DingTalkChannel } from '../src/channels/dingtalk.js';
import type { ManagementView, ManagementHandler, Incoming } from '../src/core/types.js';
function managed() {
  const f = fixture(),
    views: { message: Incoming; view: ManagementView }[] = [],
    cards = new ManagementCards();
  Object.assign(f.channel, {
    onManagementAction(fn: ManagementHandler) {
      cards.handler = fn;
    },
    async sendManagement(message: Incoming, view: ManagementView) {
      views.push(structuredClone({ message, view }));
    },
  });
  f.manager.registerChannel(f.channel);
  return { ...f, views, cards };
}

test('native management buttons use opaque IDs, bind the original owner/chat/message and never accept client commands', async () => {
  const cards = new ManagementCards(),
    calls: Incoming[] = [],
    m = incoming('old text');
  m.attachments = [{ type: 'file', name: 'old-file', key: 'file-key' }] as any;
  cards.handler = async (message) => {
    calls.push(message);
  };
  const card = cards.open(m, managementView('status', '<at id=all> literal'));
  card.messageId = 'om_menu';
  const actor = { sender: 'alice', conversation: 'chat-1', messageId: 'om_menu' };
  for (const change of [{ sender: 'bob' }, { conversation: 'other' }, { messageId: 'forwarded' }])
    assert.equal(cards.submit(card.id, '0', { ...actor, ...change }).ok, false);
  for (const key of ['/tab close', '-1', '999', '1\n/tab close'])
    assert.equal(cards.submit(card.id, key, actor).ok, false);
  const lark = larkManagementCard(card) as any;
  assert.equal(
    lark.body.elements.find((e: any) => e.text?.content === '<at id=all> literal').text.tag,
    'plain_text',
  );
  assert.equal(
    lark.body.elements.find((e: any) => e.text?.content === '<at id=all> literal').text.content,
    '<at id=all> literal',
  );
  assert.ok(
    !JSON.stringify(
      cardElements(lark).filter((e) => e.tag === 'button' && callbackValue(e)),
    ).includes('/tab'),
  );
  const result = cards.submit(card.id, '0', actor);
  assert.equal(result.ok, true);
  await result.run!();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.text, '/tab status');
  assert.equal(calls[0]!.attachments, undefined);
  assert.deepEqual(calls[0]!.route, m.route);
  assert.notEqual(calls[0]!.id, m.id);
  card.expires = Date.now() - 1;
  assert.equal(cards.submit(card.id, '0', actor).ok, false);
});

test('management commands, natural queries and virtual child menus never call the work Agent or alter another binding', async () => {
  const f = managed();
  f.config.channels[0]!.manager = true;
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      other = f.store.create({ ...main.route, conversation: 'other' }, 'codex', f.dir);
    const snapshot = structuredClone(other);
    for (const text of [
      '/tab menu',
      '/tab status',
      '你有几个会话',
      '/tab history',
      '/tab workspace',
      '/tab bots',
      '/tab tasks',
      '/tab help',
    ])
      await f.manager.receive({ ...incoming(text, 'alice', ''), direct: true });
    assert.equal(f.views.length, 8);
    assert.deepEqual(
      f.views[0]!.view.buttons.filter((b) => !b.group).map((b) => b.command),
      ['/tab compact', '/tab reset', '/tab settings', '/tab workspace'],
    );
    assert.ok(f.views.some((v) => v.view.title.includes('会话概览')));
    assert.equal(f.agent.inputs.length, 0);
    assert.deepEqual(f.store.get(other.id), snapshot);
    assert.equal(f.store.list().length, 2);
    const card = f.cards.open(f.views[0]!.message, f.views[0]!.view),
      result = f.cards.submit(
        card.id,
        String(card.view.buttons.findIndex((b) => b.command === '/tab workspace')),
        { sender: 'alice', conversation: 'chat-1' },
      );
    await result.run!();
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.views.at(-1)!.view.session!.id, main.id);
  } finally {
    await f.cleanup();
  }
});

test('state changing menu clicks are single use and stale state/bindings cannot close a new or changed session', async () => {
  const f = managed();
  try {
    const m = incoming('', 'alice', ''),
      s = f.store.create(m.route, 'codex', f.dir);
    s.nativeId = 'native-kept';
    f.store.save(s);
    await f.manager.receive(incoming('/tab status', 'alice', ''));
    const old = f.views.at(-1)!,
      card = f.cards.open(old.message, old.view),
      index = old.view.buttons.findIndex((b) => b.command === '/tab close');
    // Even same-millisecond updates must invalidate a mutation button.
    const changed = f.store.get(s.id)!;
    changed.title = 'changed';
    f.store.save(changed);
    await f.cards.submit(card.id, String(index), { sender: 'alice', conversation: 'chat-1' })
      .run!();
    assert.equal(f.store.get(s.id)!.status, 'idle');
    assert.match(f.views.at(-1)!.view.text, /状态已变化/);
    assert.equal(
      f.cards.submit(card.id, String(index), { sender: 'alice', conversation: 'chat-1' }).ok,
      false,
    );
    const fresh = f.store.create(m.route, 'codex', f.dir);
    const before = f.views.length;
    await f.cards.handler!(incoming('/tab close', 'alice', ''), old.view.session, true);
    assert.equal(f.store.get(fresh.id)!.status, 'idle');
    assert.equal(f.views.length, before + 1);
    await f.manager.receive(incoming('/tab status', 'alice', ''));
    const latest = f.views.at(-1)!,
      active = f.cards.open(latest.message, latest.view),
      close = latest.view.buttons.findIndex((b) => b.command === '/tab close');
    await f.cards.submit(active.id, String(close), { sender: 'alice', conversation: 'chat-1' })
      .run!();
    assert.equal(f.store.get(fresh.id)!.status, 'closed');
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('non-form channels can choose model, effort and save explicitly; stale settings and busy saves fail without losing native context', async () => {
  const f = managed();
  let queries = 0;
  Object.assign(f.agent, {
    async models() {
      queries++;
      return [
        {
          id: 'provider/model-a',
          label: 'Model A',
          efforts: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' },
          ],
        },
        { id: 'plain', label: 'Plain', efforts: [] },
      ];
    },
  });
  try {
    const m = incoming('', 'alice', ''),
      s = f.store.create(m.route, 'codex', f.dir);
    s.nativeId = 'keep';
    s.status = 'closed';
    f.store.save(s);
    const history = f.store.events(s.id);
    await f.manager.receive(incoming('/tab settings', 'alice', ''));
    assert.equal(queries, 1);
    assert.match(JSON.stringify(f.views.at(-1)!.view.buttons), /provider%2Fmodel-a/);
    assert.equal(f.store.get(s.id)!.settings, undefined);
    await f.manager.receive(incoming('/tab settings choose provider%2Fmodel-a', 'alice', ''));
    const choose = f.views.at(-1)!;
    assert.equal(f.store.get(s.id)!.settings, undefined);
    const high = choose.view.buttons.find((b) => b.command.includes('high'))!;
    await f.manager.receive(incoming(high.command, 'alice', ''));
    assert.deepEqual(f.store.get(s.id)!.settings, { model: 'provider/model-a', effort: 'high' });
    assert.equal(f.store.get(s.id)!.nativeId, 'keep');
    assert.equal(f.store.get(s.id)!.status, 'closed');
    assert.deepEqual(f.store.events(s.id), history);
    await f.manager.receive(incoming(high.command, 'alice', ''));
    assert.match(f.views.at(-1)!.view.text, /设置已被更新/);
    assert.equal(f.agent.inputs.length, 0);
    await f.manager.receive(incoming('/tab settings choose plain', 'alice', ''));
    const plain = f.views.at(-1)!.view.buttons[0]!;
    const current = f.store.get(s.id)!;
    current.status = 'running';
    f.store.save(current);
    await f.manager.receive(incoming(plain.command, 'alice', ''));
    assert.match(f.views.at(-1)!.view.text, /等待当前任务/);
    assert.equal(f.store.get(s.id)!.settings!.model, 'provider/model-a');
  } finally {
    await f.cleanup();
  }
});

test('WeCom management cards bound long content and provide full content on demand without changing settings', async () => {
  const cards = new ManagementCards(),
    message = incoming('');
  message.route.platform = 'wecom';
  let detail = '';
  cards.details = async (m, text) => {
    assert.equal(m.route.conversation, 'chat-1');
    detail = text;
  };
  const view = managementView('help', '中文🙂'.repeat(300)),
    card = cards.open(message, view),
    native = wecomManagementCard(card);
  assert.ok(Array.from(native.quote_area!.quote_text!).length < 330);
  assert.ok(native.button_list!.length <= 6);
  assert.ok(native.button_list!.some((b) => b.key === 'details'));
  const raw = {
    from: { userid: 'alice' },
    chattype: 'group',
    chatid: 'chat-1',
    event: { eventtype: 'template_card_event', task_id: card.id, event_key: 'details' },
  };
  const result = wecomManagementAction(cards, raw)!;
  assert.equal(result.ok, true);
  await result.run!();
  assert.equal(detail, managementText(view));
  assert.equal(wecomManagementAction(cards, { ...raw, chatid: 'other' })!.ok, false);
});

test('Feishu sends management cards in the original topic; slow actions do not delay the authenticated callback', async () => {
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
  const sent: any[] = [];
  let dispatcher: any,
    release!: () => void,
    ran = false;
  Object.assign(channel, {
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
            sent.push(args);
            return { code: 0, data: { message_id: 'om_menu' } };
          },
        },
      },
    },
  });
  channel.onManagementAction(async () => {
    ran = true;
    await new Promise<void>((r) => {
      release = r;
    });
  });
  await channel.start(async () => {});
  try {
    const m = incoming('');
    m.route.thread = 'om_topic';
    await channel.sendManagement(m, managementView('menu', 'menu body'));
    const card = JSON.parse(sent[0].data.content),
      value = callbackValue(cardElements(card).find((e) => e.tag === 'button' && callbackValue(e)));
    const response = await dispatcher.invoke(
      {
        schema: '2.0',
        header: { event_type: 'card.action.trigger', event_id: 'menu' },
        event: {
          operator: { open_id: 'alice' },
          context: { open_chat_id: 'chat-1', open_message_id: 'om_menu' },
          action: { value },
        },
      },
      { needCheck: false },
    );
    assert.equal(response.toast.type, 'success');
    assert.equal(ran, true);
    assert.equal(sent[0].path.message_id, 'om_topic');
    assert.equal(sent[0].data.reply_in_thread, true);
    release();
  } finally {
    await channel.stop();
  }
});

test('known WeCom card rejection falls back to Markdown while uncertain sends are not repeated', async () => {
  class Socket extends EventEmitter {
    sent: any[] = [];
    uncertain = false;
    connect() {
      this.emit('authenticated');
    }
    disconnect() {}
    async sendMessage(chat: string, body: any) {
      this.sent.push({ chat, body });
      if (this.uncertain) throw Error('unknown');
      return { errcode: body.msgtype === 'template_card' ? 40001 : 0 };
    }
  }
  const socket = new Socket(),
    channel = new WecomChannel(
      { type: 'wecom', id: 'test', allowedUsers: ['alice'], botIdEnv: 'ID', secretEnv: 'SECRET' },
      () => 'fixture',
    );
  Object.assign(channel, { client: socket });
  await channel.start(async () => {});
  try {
    const m = incoming('');
    m.route.platform = 'wecom';
    await channel.sendManagement(m, managementView('status', 'full body'));
    assert.deepEqual(
      socket.sent.map((s) => s.body.msgtype),
      ['template_card', 'markdown'],
    );
    assert.match(socket.sent[1].body.markdown.content, /full body/);
    socket.sent = [];
    socket.uncertain = true;
    await assert.rejects(channel.sendManagement(m, managementView('status', 'body')), /unknown/);
    assert.equal(socket.sent.length, 1);
  } finally {
    await channel.stop();
  }
});

test('DingTalk uses native webhook Markdown without requiring a card template or fabricating callback buttons', async () => {
  const saved = globalThis.fetch,
    payloads: any[] = [],
    channel = new DingTalkChannel(
      {
        type: 'dingtalk',
        id: 'test',
        allowedUsers: ['alice'],
        clientIdEnv: 'ID',
        clientSecretEnv: 'SECRET',
      },
      () => 'fixture',
    );
  Object.assign(channel, {
    replies: new Map([
      [
        'chat-1',
        { url: 'https://oapi.dingtalk.com/robot/send?fixture', expires: Date.now() + 10000 },
      ],
    ]),
  });
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ errcode: 0 }));
  };
  try {
    const m = incoming('');
    m.route.platform = 'dingtalk';
    m.route.account = 'test';
    await channel.sendManagement(m, managementView('menu', 'body <at id=all>'));
    assert.equal(payloads[0].msgtype, 'markdown');
    assert.match(payloads[0].markdown.text, /\/tab status/);
    assert.ok(!payloads[0].markdown.text.includes('<at'));
    assert.equal(payloads[0].actionCard, undefined);
  } finally {
    globalThis.fetch = saved;
    await channel.stop();
  }
});

test('WeCom real management callback opens/closes only its original group and acknowledges before execution', async () => {
  const f = fixture();
  f.config.channels[0] = {
    type: 'wecom',
    id: 'test-lark',
    allowedUsers: ['alice'],
    botIdEnv: 'ID',
    secretEnv: 'SECRET',
  };
  class Socket extends EventEmitter {
    sent: any[] = [];
    updates: any[] = [];
    connect() {
      this.emit('authenticated');
    }
    disconnect() {}
    async sendMessage(chat: string, body: any) {
      this.sent.push({ chat, body });
      return { errcode: 0 };
    }
    async updateTemplateCard(...args: any[]) {
      this.updates.push(args);
      return { errcode: 0 };
    }
  }
  const socket = new Socket(),
    channel = new WecomChannel(f.config.channels[0] as any, () => 'fixture');
  Object.assign(channel, { client: socket });
  f.manager.registerChannel(channel);
  await channel.start((m) => f.manager.receive(m));
  const m = (text: string, conversation = 'group') => ({
    ...incoming(text, 'alice', ''),
    route: {
      platform: 'wecom' as const,
      account: 'test-lark',
      conversation,
      sender: 'alice',
      thread: '',
    },
  });
  try {
    const group = f.store.create(m('').route, 'codex', f.dir);
    group.nativeId = 'group-native';
    f.store.save(group);
    const dm = f.store.create(m('', 'alice').route, 'codex', f.dir);
    dm.status = 'closed';
    dm.nativeId = 'dm-native';
    f.store.save(dm);
    const snapshot = structuredClone(dm);
    await f.manager.receive(m('/tab status'));
    let card = socket.sent[0].body.template_card;
    const close = card.button_list.find((b: any) => b.text === '结束会话');
    assert.ok(close);
    const emit = (id: string, key: string) =>
      socket.emit('event.template_card_event', {
        body: {
          from: { userid: 'alice' },
          chattype: 'group',
          chatid: 'group',
          event: { eventtype: 'template_card_event', task_id: id, event_key: key },
        },
      });
    emit(card.task_id, close.key);
    await until(() => f.store.get(group.id)!.status === 'closed' && socket.sent.length >= 2);
    assert.equal(socket.updates.length, 1);
    assert.deepEqual(f.store.get(dm.id), snapshot);
    assert.ok(socket.sent.every((s) => s.chat === 'group'));
    assert.equal(f.store.get(group.id)!.nativeId, 'group-native');
    card = socket.sent.at(-1).body.template_card;
    const open = card.button_list.find((b: any) => b.text === '打开 / 恢复');
    assert.ok(open);
    emit(card.task_id, open.key);
    await until(() => f.store.get(group.id)!.status === 'idle' && socket.sent.length >= 3);
    assert.deepEqual(f.store.get(dm.id), snapshot);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});

test('session and model list pagination keep exact server button indices and scoped target commands', async () => {
  const f = managed();
  f.config.channels[0]!.manager = true;
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    for (let i = 0; i < 7; i++)
      f.store.create(incoming('', 'alice', 'topic-' + i).route, 'codex', f.dir);
    await f.manager.receive({ ...incoming('/tab list', 'alice', ''), direct: true });
    const first = f.views.at(-1)!,
      card = f.cards.open(first.message, first.view),
      native = wecomManagementCard(card),
      next = native.button_list!.find((b) => b.text === '下一页')!;
    assert.ok(next);
    assert.equal(first.view.buttons[Number(next.key)]!.command, '/tab list 2');
    await f.cards.submit(card.id, next.key, { sender: 'alice', conversation: 'chat-1' }).run!();
    const second = f.views.at(-1)!;
    assert.match(second.view.text, /第 2\/2 页/);
    assert.equal(
      second.view.buttons.some((b) => b.command === '/tab list 1'),
      true,
    );
    const target = second.view.buttons.find((b) => b.command.startsWith('/tab manage'))!;
    await f.manager.receive({ ...incoming(target.command, 'alice', ''), direct: true });
    assert.ok(
      f.views
        .at(-1)!
        .view.buttons.every(
          (b) =>
            b.command.startsWith(target.command.replace(/ status$/, '')) ||
            b.command === '/tab list',
        ),
    );
    assert.equal(f.store.current(main.route)!.id, main.id);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('preset directory buttons preserve spaces and literal quotes and migrate the same native session', async () => {
  const f = managed();
  mkdirSync(join(f.dir, 'space "project"'));
  const target = realpathSync(join(f.dir, 'space "project"'));
  f.config.workspaces.project = target;
  try {
    const s = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    s.nativeId = 'keep';
    f.store.save(s);
    await f.manager.receive(incoming('/tab workspace', 'alice', ''));
    const view = f.views.at(-1)!,
      button = view.view.buttons.find((b) => b.label === '切到 project')!,
      card = f.cards.open(view.message, view.view);
    await f.cards.submit(card.id, String(view.view.buttons.indexOf(button)), {
      sender: 'alice',
      conversation: 'chat-1',
    }).run!();
    assert.equal(f.store.get(s.id)!.workspace, target);
    assert.equal(f.store.get(s.id)!.nativeId, 'keep');
    assert.equal(f.store.list().length, 1);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('large model catalogs paginate in the constrained WeCom menu and preserve the original model choice', async () => {
  const f = managed();
  Object.assign(f.agent, {
    async models() {
      return Array.from({ length: 9 }, (_, i) => ({
        id: 'provider/m' + i,
        label: '模型 ' + i,
        efforts: [],
      }));
    },
  });
  try {
    f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    await f.manager.receive(incoming('/tab settings', 'alice', ''));
    const first = f.views.at(-1)!,
      card = f.cards.open(first.message, first.view),
      native = wecomManagementCard(card),
      next = native.button_list!.find((b) => b.text === '下一页')!;
    assert.ok(next);
    await f.cards.submit(card.id, next.key, { sender: 'alice', conversation: 'chat-1' }).run!();
    const second = f.views.at(-1)!;
    assert.match(second.view.text, /第 2\/2 页/);
    assert.match(JSON.stringify(second.view.buttons), /provider%2Fm6/);
    assert.ok(second.view.buttons.some((b) => b.command === '/tab settings page 1'));
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
