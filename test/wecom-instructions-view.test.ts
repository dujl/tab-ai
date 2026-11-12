import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fixture, incoming, until } from './helpers.js';
import { managementView, managementText } from '../src/core/management-view.js';
import { instructionsText } from '../src/core/instructions-view.js';
import {
  ManagementCards,
  wecomManagementCard,
  wecomManagementAction,
} from '../src/channels/management-cards.js';
import { WecomChannel } from '../src/channels/wecom.js';
import { splitText } from '../src/channels/common.js';

test('WeCom instructions card always exposes associated platform, bot and session independently of long custom instructions', async () => {
  const f = fixture();
  try {
    const m = {
      ...incoming(''),
      route: { ...incoming('').route, platform: 'wecom' as const, conversation: 'group' },
    };
    const s = f.store.create(m.route, 'codex', f.dir, '长角色🙂\n'.repeat(1000));
    s.title = '文档转换';
    s.channelContext = { conversationType: 'group', botName: '企微助手' };
    s.codexDeveloperInstructions = 'PRIVATE_NATIVE_SETTINGS';
    const text = instructionsText(s),
      view = managementView('instructions', text, s),
      card = new ManagementCards().open(m, view),
      native = wecomManagementCard(card);
    const facts = native.horizontal_content_list!;
    assert.equal(facts.length, 6);
    assert.match(facts[0]!.value!, /企业微信.*群聊/);
    assert.equal(facts[1]!.value, '企微助手');
    assert.ok(facts[2]!.value!.includes(s.id.slice(0, 8)));
    assert.equal(facts[3]!.value, 'Codex');
    assert.equal(facts[4]!.value, '企微在线文档');
    assert.match(facts[5]!.value!, /已设置/);
    assert.ok(native.sub_title_text!.includes('原生指令 + 通道背景 + 会话附加指令'));
    assert.ok(Array.from(native.sub_title_text!).length <= 112);
    assert.equal(native.quote_area, undefined);
    assert.ok(!JSON.stringify(native).includes(s.instructions!));
    assert.ok(native.button_list!.length <= 6);
    assert.ok(native.button_list!.some((b) => b.text === '查看全文' && b.key === 'details'));
    assert.ok(view.text.includes(s.instructions!));
    assert.ok(view.text.includes(s.id));
    assert.ok(view.text.includes(s.route.account));
    assert.ok(!view.text.includes('PRIVATE_NATIVE_SETTINGS'));
    for (const fact of facts) {
      assert.ok(Array.from(fact.keyname).length <= 5);
      assert.ok(Array.from(fact.value!).length <= 26);
    }
  } finally {
    await f.cleanup();
  }
});

test('empty additions still show active platform defaults, and long names remain bounded while full IDs and names remain in details', async () => {
  const f = fixture();
  try {
    const s = f.store.create(
      { ...incoming('').route, platform: 'wecom', conversation: 'alice' },
      'claude',
      f.dir,
    );
    s.channelContext = { conversationType: 'direct', botName: '很长🙂'.repeat(30) };
    s.title = '任务标题'.repeat(40);
    const card = new ManagementCards().open(
        { ...incoming(''), route: s.route },
        managementView('instructions', instructionsText(s), s),
      ),
      native = wecomManagementCard(card);
    assert.match(native.horizontal_content_list![0]!.value!, /单聊/);
    assert.match(native.horizontal_content_list![5]!.value!, /通道背景仍生效/);
    assert.ok(native.horizontal_content_list![1]!.value!.endsWith('…'));
    assert.ok(card.view.text.includes(s.channelContext.botName));
    assert.ok(card.view.text.includes(s.title));
    assert.match(card.view.text, /未设置用户附加指令，通道背景仍正常生效/);
    const other = wecomManagementCard(
      new ManagementCards().open(incoming(''), managementView('status', '普通状态')),
    );
    assert.equal(other.horizontal_content_list, undefined);
    assert.equal(other.quote_area!.quote_text, '普通状态');
  } finally {
    await f.cleanup();
  }
});

test('real WeCom instructions request and full-text callback stay in the selected group session, preserve exact role and never invoke Agent', async () => {
  const f = fixture();
  f.config.channels[0] = {
    type: 'wecom',
    id: 'test-lark',
    allowedUsers: ['alice'],
    botIdEnv: 'ID',
    secretEnv: 'SECRET',
    displayName: '群机器人',
  };
  class Socket extends EventEmitter {
    sent: { chat: string; body: any }[] = [];
    updates = 0;
    connect() {
      this.emit('authenticated');
    }
    disconnect() {}
    async sendMessage(chat: string, body: any) {
      this.sent.push({ chat, body });
      return { errcode: 0 };
    }
    async updateTemplateCard() {
      this.updates++;
      return { errcode: 0 };
    }
  }
  const socket = new Socket(),
    channel = new WecomChannel(f.config.channels[0], () => 'fixture');
  Object.assign(channel, { client: socket });
  f.manager.registerChannel(channel);
  await channel.start((m) => f.manager.receive(m));
  const message = {
    ...incoming('/tab instructions', 'alice', ''),
    direct: false,
    route: {
      platform: 'wecom' as const,
      account: 'test-lark',
      conversation: 'group',
      sender: 'alice',
      thread: 'child-session',
    },
  };
  try {
    const s = f.store.create(message.route, 'codex', f.dir, '角色原文\n```\n🙂'.repeat(400));
    s.status = 'closed';
    f.store.save(s);
    const dm = f.store.create(
      { ...message.route, conversation: 'alice', thread: '' },
      'codex',
      f.dir,
      '其他单聊角色',
    );
    const before = structuredClone(f.store.get(s.id)),
      dmBefore = structuredClone(dm);
    await f.manager.receive(message);
    assert.equal(socket.sent.length, 1);
    const native = socket.sent[0]!.body.template_card;
    assert.ok(native.horizontal_content_list.some((r: any) => r.value.includes(s.id.slice(0, 8))));
    assert.ok(native.horizontal_content_list.some((r: any) => r.value === '群机器人'));
    const cards = (channel as any).managementCards as ManagementCards,
      card = cards.get(native.task_id)!;
    const raw = {
      from: { userid: 'bob' },
      chattype: 'group',
      chatid: 'group',
      event: { eventtype: 'template_card_event', task_id: native.task_id, event_key: 'details' },
    };
    assert.equal(wecomManagementAction(cards, raw)!.ok, false);
    assert.equal(
      wecomManagementAction(cards, { ...raw, from: { userid: 'alice' }, chatid: 'other-group' })!
        .ok,
      false,
    );
    const expected = managementText(card.view),
      parts = splitText(expected, 1100);
    socket.emit('event.template_card_event', { body: { ...raw, from: { userid: 'alice' } } });
    await until(() => socket.sent.length === 1 + parts.length);
    const decoded = socket.sent
      .slice(1)
      .map((v) => {
        const m = /^(`{3,})\n([\s\S]*)\n\1$/.exec(v.body.markdown.content);
        assert.ok(m);
        return m[2];
      })
      .join('');
    assert.equal(decoded, expected);
    assert.ok(decoded.includes(s.instructions!));
    assert.ok(decoded.includes(s.id));
    assert.ok(!decoded.includes(dm.instructions!));
    assert.ok(socket.sent.every((v) => v.chat === 'group'));
    assert.equal(socket.updates, 1);
    assert.equal(f.agent.inputs.length, 0);
    assert.deepEqual(f.store.get(s.id), before);
    assert.deepEqual(f.store.get(dm.id), dmBefore);
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});

test('WeCom rejected instruction card falls back to complete readable association and prompt text', async () => {
  const f = fixture();
  class Socket extends EventEmitter {
    sent: any[] = [];
    connect() {
      this.emit('authenticated');
    }
    disconnect() {}
    async sendMessage(chat: string, body: any) {
      this.sent.push({ chat, body });
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
    const s = f.store.create(
        { ...incoming('').route, platform: 'wecom' },
        'codex',
        f.dir,
        '用户角色',
      ),
      view = managementView('instructions', instructionsText(s), s);
    await channel.sendManagement({ ...incoming(''), route: s.route }, view);
    const chunks = socket.sent
      .slice(1)
      .map((v) => /^(`{3,})\n([\s\S]*)\n\1$/.exec(v.body.markdown.content)![2]);
    assert.equal(chunks.join(''), managementText(view));
    assert.ok(chunks.join('').includes(s.id));
    assert.ok(socket.sent.every((v) => v.chat === s.route.conversation));
  } finally {
    await channel.stop();
    await f.cleanup();
  }
});
