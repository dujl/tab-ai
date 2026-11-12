import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming } from './helpers.js';
import { cardElements, callbackValue } from './card-helpers.js';
import { managementView, managementText, sessionHomeButtons } from '../src/core/management-view.js';
import {
  ManagementCards,
  larkManagementCard,
  larkManagementAction,
} from '../src/channels/management-cards.js';
import { LarkChannel } from '../src/channels/lark.js';
import { PROJECT_URL } from '../src/brand.js';
import type { ManagementHandler, ManagementView, Incoming } from '../src/core/types.js';
function managed() {
  const f = fixture(),
    cards = new ManagementCards(),
    views: { message: Incoming; view: ManagementView }[] = [];
  Object.assign(f.channel, {
    onManagementAction(handler: ManagementHandler) {
      cards.handler = handler;
    },
    async sendManagement(message: Incoming, view: ManagementView) {
      views.push(structuredClone({ message, view }));
    },
  });
  f.manager.registerChannel(f.channel);
  return { ...f, cards, views };
}
function raw(card: ReturnType<ManagementCards['open']>, action: any, sender = 'alice') {
  return {
    operator: { open_id: sender },
    context: { open_chat_id: card.message.route.conversation, open_message_id: 'om_menu' },
    action,
  };
}
test('both menu entry commands share read-only information, scoped operations and a non-callback GitHub link', async () => {
  const f = managed();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir),
      before = f.store.get(s.id);
    for (const command of ['/tab menu', '/tab card']) {
      await f.manager.receive(incoming(command));
      const v = f.views.at(-1)!;
      assert.equal(
        v.view.information!.fields.find((x) => x.label === '模型')!.value,
        '沿用原生，实际值未上报',
      );
      assert.deepEqual(
        v.view.buttons.filter((b) => !b.group).map((b) => b.command),
        ['/tab compact', '/tab reset', '/tab settings', '/tab workspace'],
      );
      const card = larkManagementCard(f.cards.open(v.message, v.view));
      assert.equal(card.schema, '2.0');
      const es = cardElements(card);
      assert.ok(es.some((e) => e.tag === 'collapsible_panel'));
      assert.ok(es.some((e) => e.text?.content === '会话信息'));
      assert.ok(es.some((e) => e.text?.content === '会话管理'));
      const link = es.find((e) => e.tag === 'markdown' && e.content.includes(PROJECT_URL));
      assert.ok(link);
      assert.match(link.content, /\[tab-ai ↗\]\(https:\/\/github.com\/dujl\/tab-ai\)/);
      assert.equal(link.behaviors, undefined);
      assert.ok(managementText(v.view).includes(PROJECT_URL));
      assert.ok(!es.some((e) => e.tag === 'action'));
    }
    assert.deepEqual(f.store.get(s.id), before);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('urgent controls describe the current state and never masquerade as a task completion action', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    for (const [status, command] of [
      ['waiting', '/tab pending'],
      ['running', '/tab stop'],
      ['closed', '/tab open'],
      ['detached', '/tab menu terminal'],
    ] as const) {
      s.status = status;
      assert.equal(sessionHomeButtons(s, true, 2)[0]!.command, command);
    }
    s.status = 'idle';
    s.operation = 'compact';
    assert.equal(sessionHomeButtons(s, true)[0]!.label, '停止压缩');
  } finally {
    await f.cleanup();
  }
});
test('model and effort choices remain uncommitted until authenticated form submit; invalid/duplicate values cannot grant actions', async () => {
  const f = managed();
  Object.assign(f.agent, {
    async models() {
      return [
        { id: 'provider/model', label: '模型', efforts: [{ id: 'high', label: '高' }] },
        { id: 'plain', label: '无档位模型', efforts: [] },
      ];
    },
  });
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'keep';
    f.store.save(s);
    await f.manager.receive(incoming('/tab settings'));
    let v = f.views.at(-1)!,
      card = f.cards.open(v.message, v.view);
    card.messageId = 'om_menu';
    const select = cardElements(larkManagementCard(card)).find((e) => e.tag === 'select_static');
    assert.ok(select);
    const choose = larkManagementAction(
      f.cards,
      raw(card, { value: callbackValue(select), option: select.options[0].value }),
    );
    assert.equal(choose.ok, true);
    await choose.run!();
    assert.equal(f.store.get(s.id)!.settings, undefined);
    v = f.views.at(-1)!;
    card = f.cards.open(v.message, v.view);
    card.messageId = 'om_menu';
    const form = cardElements(larkManagementCard(card)).find((e) => e.tag === 'form');
    const decision = form.elements.find((e: any) => e.tag === 'select_static').options[0].value;
    const button = form.elements.find((e: any) => e.tag === 'button');
    assert.equal(button.behaviors, undefined);
    assert.equal(button.value, undefined);
    const action = { name: button.name, form_value: { decision } };
    assert.equal(larkManagementAction(f.cards, raw(card, action, 'bob')).ok, false);
    assert.equal(
      larkManagementAction(f.cards, raw(card, { ...action, form_value: { decision: '999' } })).ok,
      false,
    );
    assert.equal(f.store.get(s.id)!.settings, undefined);
    const result = larkManagementAction(f.cards, raw(card, action));
    assert.equal(result.ok, true);
    await result.run!();
    assert.deepEqual(f.store.get(s.id)!.settings, { model: 'provider/model', effort: 'high' });
    assert.equal(f.store.get(s.id)!.nativeId, 'keep');
    assert.equal(larkManagementAction(f.cards, raw(card, action)).ok, false);
    await f.manager.receive(incoming('/tab settings choose plain'));
    const es = cardElements(
      larkManagementCard(f.cards.open(f.views.at(-1)!.message, f.views.at(-1)!.view)),
    );
    assert.ok(!es.some((e) => e.tag === 'select_static'));
    assert.ok(es.some((e) => e.text?.content === '保存设置'));
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('workspace form uses the current path, checks actor and binding, and preserves native history when changing a path with spaces', async () => {
  const f = managed();
  try {
    const target = join(f.dir, '目录 空格');
    mkdirSync(target);
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'keep';
    f.store.save(s);
    await f.manager.receive(incoming('/tab workspace'));
    const v = f.views.at(-1)!,
      card = f.cards.open(v.message, v.view);
    card.messageId = 'om_menu';
    const es = cardElements(larkManagementCard(card));
    const input = es.find((e) => e.tag === 'input');
    assert.equal(input.default_value, s.workspace);
    const button = es.find((e) => e.form_action_type === 'submit');
    const action = { name: button.name, form_value: { workspace: target } };
    assert.equal(larkManagementAction(f.cards, raw(card, action, 'bob')).ok, false);
    const result = larkManagementAction(f.cards, raw(card, action));
    assert.equal(result.ok, true);
    await result.run!();
    assert.equal(f.store.get(s.id)!.workspace, target);
    assert.equal(f.store.get(s.id)!.nativeId, 'keep');
    assert.equal(larkManagementAction(f.cards, raw(card, action)).ok, false);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('Feishu menu navigation replaces the original message and revokes its previous opaque actions', async () => {
  const f = fixture(),
    channel = new LarkChannel(
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
  const sent: any[] = [],
    patches: any[] = [];
  Object.assign(channel, {
    client: {
      im: {
        message: {
          reply: async (data: any) => {
            sent.push(data);
            return { code: 0, data: { message_id: 'om_menu' } };
          },
          patch: async (data: any) => {
            patches.push(data);
            return { code: 0 };
          },
        },
      },
    },
  });
  try {
    const m = incoming('', 'alice', 'om_original');
    const s = f.store.create(m.route, 'codex', f.dir);
    await channel.sendManagement(m, managementView('menu', '首页', s));
    const cards = (channel as any).managementCards as ManagementCards;
    const old = callbackValue(
      cardElements(JSON.parse(sent[0].data.content)).find(
        (e) => e.tag === 'button' && callbackValue(e),
      ),
    );
    await channel.sendManagement(
      { ...m, managementOrigin: old.id },
      managementView('menu:page', '下级菜单', s),
    );
    assert.equal(sent.length, 1);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].path.message_id, 'om_menu');
    assert.equal(cards.has(old.id), false);
    assert.equal(JSON.parse(patches[0].data.content).schema, '2.0');
  } finally {
    await f.cleanup();
  }
});

test('delivery menu explains current-task handoff versus scoped reusable methods without asking to choose a project', async () => {
  const f = managed();
  try {
    f.store.create(incoming('').route, 'codex', f.dir);
    await f.manager.receive(incoming('/tab menu delivery'));
    const view = f.views.at(-1)!.view;
    assert.match(view.text, /当前任务的成果、规格、验证和遗留事项/);
    assert.match(view.text, /适用条件、做法和注意事项/);
    assert.match(view.text, /本聊天授权范围/);
    assert.ok(!view.text.includes('选择要查看或管理的项目'));
    for (const command of ['/tab menu tools', '/tab menu advanced', '/tab menu records']) {
      await f.manager.receive(incoming(command));
      assert.match(f.views.at(-1)!.view.text, /当前会话/);
    }
    const viewCard = larkManagementCard(
      f.cards.open(f.views.at(-1)!.message, f.views.at(-1)!.view),
    );
    const back = cardElements(viewCard).find(
      (e) => e.tag === 'button' && e.text?.content === '返回本会话',
    );
    assert.ok(back);
    assert.equal(back.type, 'default');
    assert.equal(back.width, 'fill');
    assert.equal(back.disabled, undefined);
    assert.equal(callbackValue(back).kind, 'management');
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('rename is a prefilled form: blank/invalid/foreign/duplicate submissions cannot rename; saving updates only this session', async () => {
  const f = managed();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir),
      other = f.store.create({ ...s.route, conversation: 'other' }, 'codex', f.dir);
    s.title = '原名称';
    s.nativeId = 'native-kept';
    f.store.save(s);
    await f.manager.receive(incoming('/tab menu rename'));
    const v = f.views.at(-1)!,
      card = f.cards.open(v.message, v.view);
    card.messageId = 'om_menu';
    const es = cardElements(larkManagementCard(card)),
      field = es.find((e) => e.tag === 'input' && e.name === 'session_name'),
      button = es.find((e) => e.form_action_type === 'submit');
    assert.equal(field.default_value, '原名称');
    assert.equal(field.max_length, 60);
    assert.equal(field.required, true);
    const submit = (name: string, sender = 'alice') =>
      larkManagementAction(
        f.cards,
        raw(card, { name: button.name, form_value: { session_name: name } }, sender),
      );
    assert.equal(submit('   ').ok, false);
    assert.equal(submit('长'.repeat(61)).ok, false);
    assert.equal(submit('bad\nname').ok, false);
    assert.equal(submit('新名称', 'bob').ok, false);
    const result = submit('新名称');
    assert.equal(result.ok, true);
    await result.run!();
    assert.equal(f.store.get(s.id)!.title, '新名称');
    assert.equal(f.store.get(s.id)!.nativeId, 'native-kept');
    assert.equal(f.store.get(other.id)!.title, other.title);
    assert.equal(submit('再次改名').ok, false);
    assert.match(f.views.at(-1)!.view.text, /已命名/);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('rename form rechecks the session snapshot and rejects changed bindings without overwriting the replacement', async () => {
  const f = managed();
  try {
    const m = incoming(''),
      original = f.store.create(m.route, 'codex', f.dir);
    await f.manager.receive(incoming('/tab menu rename'));
    const v = f.views.at(-1)!,
      card = f.cards.open(v.message, v.view);
    card.messageId = 'om_menu';
    const button = cardElements(larkManagementCard(card)).find(
      (e) => e.form_action_type === 'submit',
    );
    const replacement = f.store.create(m.route, 'codex', f.dir);
    const result = larkManagementAction(
      f.cards,
      raw(card, { name: button.name, form_value: { session_name: '不能覆盖' } }),
    );
    assert.equal(result.ok, true);
    await result.run!();
    assert.equal(f.store.get(original.id)!.title, original.title);
    assert.equal(f.store.get(replacement.id)!.title, replacement.title);
    assert.match(f.views.at(-1)!.view.text, /状态已变化/);
  } finally {
    await f.cleanup();
  }
});

test('session information uses compact rows with native token placeholders, preserves full detail and avoids repeating the title in the body', async () => {
  const f = managed();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.title = '紧凑信息测试';
    f.store.save(s);
    await f.manager.receive(incoming('/tab menu'));
    const v = f.views.at(-1)!,
      card = larkManagementCard(f.cards.open(v.message, v.view)),
      es = cardElements(card);
    assert.equal(card.header.subtitle!.content, s.title);
    const info = card.body.elements[0],
      column = info.columns[0];
    assert.equal(column.vertical_spacing, '4px');
    assert.equal(column.elements.length, 8);
    assert.ok(JSON.stringify(column.elements).includes('上下文：未上报'));
    assert.ok(JSON.stringify(column.elements).includes('状态：空闲'));
    assert.ok(JSON.stringify(column.elements).includes('Agent：Codex'));
    assert.ok(JSON.stringify(column.elements).includes('审批：按需审批'));
    assert.ok(!JSON.stringify(column.elements).includes('紧凑信息测试'));
    const detail = es.find((e) => e.tag === 'collapsible_panel');
    assert.ok(JSON.stringify(detail).includes('沿用原生，实际值未上报'));
    assert.ok(es.some((e) => e.text?.content === '目录：' + f.dir));
  } finally {
    await f.cleanup();
  }
});
