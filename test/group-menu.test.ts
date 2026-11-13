import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming } from './helpers.js';
import { Manager } from '../src/core/manager.js';
import { loadConfig } from '../src/config.js';
import { SetupStorage } from '../src/setup/storage.js';
import {
  ManagementCards,
  larkManagementCard,
  larkManagementAction,
} from '../src/channels/management-cards.js';
import { cardElements, callbackValue } from './card-helpers.js';
import type { Incoming, ManagementView, ManagementHandler } from '../src/core/types.js';

function group(text: string, thread = '', mentioned = true): Incoming {
  const message = incoming(text, 'alice', thread);
  return {
    ...message,
    direct: false,
    groupMessage: { mentioned },
    route: { ...message.route, conversation: 'oc_group' },
  };
}
async function managedGroup() {
  const f = fixture();
  await f.manager.close();
  const file = join(f.dir, 'config.json');
  const channelConfig = f.config.channels[0]!;
  assert.equal(channelConfig.type, 'lark');
  if (channelConfig.type === 'lark') channelConfig.groupModes = { oc_other: 'mention' };
  writeFileSync(file, JSON.stringify(f.config));
  const storage = new SetupStorage(file),
    cards = new ManagementCards();
  const views: { message: Incoming; view: ManagementView }[] = [];
  let writes = 0;
  Object.assign(f.channel, {
    onManagementAction(
      handler: ManagementHandler,
      authorize: NonNullable<ManagementCards['authorize']>,
    ) {
      cards.handler = handler;
      cards.authorize = authorize;
    },
    async sendManagement(message: Incoming, view: ManagementView) {
      views.push({ message, view });
    },
    async checkGroupPermission() {
      return {
        status: 'missing',
        scope: 'im:message.group_msg',
        message: '需要申请群消息权限',
        url: 'https://open.feishu.cn/app/cli_test/auth?q=im%3Amessage.group_msg',
        checkedAt: Date.now(),
      };
    },
  });
  const manager = new Manager(
    f.config,
    f.store,
    { codex: f.agent, claude: f.agent, opencode: f.agent },
    new Map([[f.channel.id, f.channel]]),
    undefined,
    undefined,
    (id, chat, mode) => {
      writes++;
      storage.setGroupMode(id, chat, mode);
    },
  );
  const click = async (command: string, actor = 'alice') => {
    const latest = views.at(-1)!;
    const card = cards.open(latest.message, latest.view);
    card.messageId = 'om_group_menu';
    const index = latest.view.buttons.findIndex((b) => b.command === command);
    assert.ok(index >= 0, command);
    const button = cardElements(larkManagementCard(card)).find(
      (e) => e.tag === 'button' && e.text?.content === latest.view.buttons[index]!.label,
    );
    assert.ok(button);
    const result = larkManagementAction(cards, {
      operator: { open_id: actor },
      context: { open_chat_id: latest.message.route.conversation, open_message_id: card.messageId },
      action: { value: callbackValue(button) },
    });
    if (result.ok) await result.run!();
    return result;
  };
  return {
    ...f,
    manager,
    views,
    cards,
    click,
    file,
    writes: () => writes,
    async cleanup() {
      await manager.close();
      await f.cleanup();
    },
  };
}

test('group menu exposes the local response-mode entry before a session exists and hides it in direct chats', async () => {
  const f = await managedGroup();
  try {
    for (const thread of ['', 'om_child']) {
      await f.manager.receive(group('/tab menu', thread));
      const view = f.views.at(-1)!.view;
      assert.equal(view.scope, 'session');
      assert.match(view.text, /仅 @ 触发/);
      assert.ok(
        view.buttons.some((b) => b.command === '/tab group-mode' && b.label === '群聊免 @：未开启'),
      );
      assert.ok(!view.buttons.some((b) => /\/tab (admin|list|bots)/.test(b.command)));
    }
    await f.manager.receive({ ...incoming('/tab menu'), direct: true });
    assert.ok(!f.views.at(-1)!.view.buttons.some((b) => b.command === '/tab group-mode'));
    assert.equal(f.writes(), 0);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('group mode card enables no-mention input through the scoped callback and retains the permission request', async () => {
  const f = await managedGroup();
  try {
    await f.manager.receive(group('/tab menu'));
    assert.equal((await f.click('/tab group-mode')).ok, true);
    assert.equal(f.writes(), 0);
    assert.equal((await f.click('/tab group-mode auto', 'bob')).ok, false);
    assert.equal(f.writes(), 0);
    assert.equal((await f.click('/tab group-mode auto')).ok, true);
    const config = loadConfig(f.file).channels[0]!;
    assert.equal(config.type === 'lark' && config.groupModes?.oc_group, 'auto');
    assert.equal(config.type === 'lark' && config.groupModes?.oc_other, 'mention');
    assert.equal(config.manager, undefined);
    assert.equal(f.writes(), 1);
    const view = f.views.at(-1)!.view;
    assert.equal(view.scope, 'session');
    assert.equal(view.authorization?.status, 'missing');
    assert.match(
      JSON.stringify(larkManagementCard(f.cards.open(group(''), view))),
      /申请群消息权限/,
    );
    assert.ok(view.buttons.find((b) => b.command === '/tab group-mode auto')!.disabledReason);
    assert.match(view.text, /主会话和子话题/);
    for (const thread of ['', 'om_child']) {
      await f.manager.receive(group('/tab menu', thread, false));
      assert.ok(f.views.at(-1)!.view.buttons.some((b) => b.label === '群聊免 @：已开启'));
    }
    await f.manager.receive(group('/tab group-mode'));
    assert.equal((await f.click('/tab group-mode context')).ok, true);
    assert.match(f.views.at(-1)!.view.text, /全量接收，仅 @ 回复/);
    const before = f.views.length;
    await f.manager.receive(group('/tab menu', '', false));
    assert.equal(f.views.length, before);
    assert.equal((await f.click('/tab group-mode mention')).ok, true);
    assert.equal(f.writes(), 3);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('existing group sessions keep native context and bindings when the group mode is changed from their menu', async () => {
  const f = await managedGroup();
  try {
    const main = f.store.create(group('').route, 'codex', f.dir);
    const child = f.store.create(group('', 'om_child').route, 'codex', f.dir);
    for (const session of [main, child]) {
      session.nativeId = `keep-${session.id}`;
      f.store.save(session);
    }
    const before = f.store.list();
    await f.manager.receive(group('/tab menu'));
    await f.click('/tab group-mode');
    await f.click('/tab group-mode auto');
    await f.manager.receive(group('/tab card', 'om_child', false));
    assert.ok(f.views.at(-1)!.view.buttons.some((b) => b.label === '群聊免 @：已开启'));
    assert.deepEqual(f.store.list(), before);
    assert.equal(f.store.current(group('').route)?.id, main.id);
    assert.equal(f.store.current(group('', 'om_child').route)?.id, child.id);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.writes(), 1);
  } finally {
    await f.cleanup();
  }
});
