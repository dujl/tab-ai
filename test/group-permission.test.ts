import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming } from './helpers.js';
import { checkLarkGroupPermission } from '../src/channels/lark-group-permission.js';
import { larkPermissionUrl } from '../src/core/group-mode.js';
import { LarkChannel } from '../src/channels/lark.js';
import { ManagementCards, larkManagementCard } from '../src/channels/management-cards.js';
import { LARK_SCOPES, GUIDES } from '../src/setup/providers.js';
import type { Incoming, ManagementView } from '../src/core/types.js';

const permission = () => ({
  status: 'missing' as const,
  scope: 'im:message.group_msg',
  message: '请申请并发布审核',
  url: larkPermissionUrl('cli_current', 'feishu')!,
  checkedAt: Date.now(),
});
const group = (text: string) => ({
  ...incoming(text, 'alice', ''),
  direct: false,
  groupMessage: { mentioned: true },
  route: { ...incoming('').route, conversation: 'oc_group' },
});

test('permission checks distinguish effective access, missing scope, and unconfirmed transport/membership errors without copying payloads', async () => {
  for (const response of [
    { code: 0 },
    { code: 230027 },
    { code: 99991672 },
    { code: 234009 },
    { code: 230002 },
  ]) {
    const p = await checkLarkGroupPermission('cli_current', 'feishu', async () => response);
    assert.equal(
      p.status,
      response.code === 0 ? 'ready' : response.code === 230002 ? 'unknown' : 'missing',
    );
    assert.ok(p.url!.includes('/app/cli_current/auth?'));
    assert.equal(new URL(p.url!).searchParams.get('q'), 'im:message.group_msg');
  }
  for (const error of [
    Error('secret network detail'),
    { response: { data: { code: 230027, msg: 'secret-token' } } },
  ]) {
    const p = await checkLarkGroupPermission('cli_current', 'lark', async () => {
      throw error;
    });
    assert.ok(!JSON.stringify(p).includes('secret'));
    assert.equal(new URL(p.url!).hostname, 'open.larksuite.com');
  }
  for (const appId of ['https://evil', '../other', 'cli_x/path'])
    assert.equal(larkPermissionUrl(appId, 'feishu'), undefined);
});

test('setting full modes returns an actionable authorization card; checking again is read-only and never runs an Agent', async () => {
  const f = fixture(),
    views: ManagementView[] = [];
  let probes = 0,
    writes = 0,
    ready = false;
  Object.assign(f.channel, {
    async checkGroupPermission(chat: string) {
      assert.equal(chat, 'oc_group');
      probes++;
      return ready ? { ...permission(), status: 'ready' } : permission();
    },
    async sendManagement(_m: Incoming, v: ManagementView) {
      views.push(v);
    },
  });
  // Only the persistence hook writes config; test uses the same public API as slash/natural.
  try {
    const before = f.store.list();
    for (const mode of ['context', 'auto'] as const) {
      const result = await f.manager.executeManagement(
        { intent: 'group_mode.set', parameters: { botId: 'test-lark', chatId: 'oc_group', mode } },
        { kind: 'local' },
        () => {
          writes++;
        },
      );
      assert.equal(result.mode, mode);
      assert.equal(result.permission!.status, 'missing');
      assert.match(result.permission!.qrDataUrl!, /^data:image\/png;base64,/);
    }
    await f.manager.receive(group('/tab group-mode'));
    const v = views.at(-1)!;
    assert.match(v.text, /等待申请／审核生效/);
    assert.match(v.text, /cli_current/);
    assert.doesNotMatch(v.text, /立即应用/);
    assert.ok(v.buttons.some((b) => b.command === '/tab group-mode'));
    const cards = new ManagementCards(),
      card = cards.open(group(''), v),
      json = JSON.stringify(larkManagementCard(card, v.text, true, 'img_qr'));
    assert.match(json, /申请群消息权限/);
    assert.match(json, /img_qr/);
    assert.ok(json.includes(permission().url));
    ready = true;
    await f.manager.receive(group('/tab group-mode'));
    assert.match(views.at(-1)!.text, /已验证/);
    assert.ok(
      !JSON.stringify(larkManagementCard(cards.open(group(''), views.at(-1)!))).includes(
        '申请群消息权限',
      ),
    );
    const result = await f.manager.executeManagement(
      {
        intent: 'group_mode.set',
        parameters: { botId: 'test-lark', chatId: 'oc_group', mode: 'mention' },
      },
      { kind: 'local' },
      () => {
        writes++;
      },
    );
    assert.equal(result.permission, undefined);
    assert.equal(probes, 4);
    assert.equal(writes, 3);
    assert.deepEqual(f.store.list(), before);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('permission request is bound to the actual Lark channel/app and reads only one message; QR upload failure preserves the link and original topic', async () => {
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
    (k) => (k === 'ID' ? 'cli_current' : 'secret'),
  );
  const reads: any[] = [],
    sends: any[] = [];
  Object.assign(channel, {
    client: {
      im: {
        image: {
          create: async () => {
            throw Error('upload missing scope');
          },
        },
        message: {
          list: async (p: any) => {
            reads.push(p);
            throw { response: { data: { code: 230027 } } };
          },
          reply: async (p: any) => {
            sends.push(p);
            return { code: 0, data: { message_id: 'om_card' } };
          },
        },
      },
    },
  });
  const p = await channel.checkGroupPermission('oc_group');
  assert.equal(p.status, 'missing');
  assert.equal(reads[0].params.page_size, 1);
  assert.equal(reads[0].params.container_id, 'oc_group');
  const m = {
    ...group(''),
    route: { ...group('').route, thread: 'om_topic' },
    replyTo: 'om_topic',
  };
  await channel.sendManagement(m, {
    title: '群接收模式',
    text: 'waiting',
    buttons: [],
    scope: 'session',
    authorization: p,
  });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].path.message_id, 'om_topic');
  assert.ok(sends[0].data.content.includes('申请群消息权限'));
  assert.ok(!sends[0].data.content.includes('secret'));
  Object.assign((channel as any).client.im.image, {
    create: async () => ({ image_key: 'img_qr_ok' }),
  });
  await channel.sendManagement(m, {
    title: '群接收模式',
    text: 'waiting',
    buttons: [],
    scope: 'session',
    authorization: p,
  });
  assert.ok(sends.at(-1).data.content.includes('img_qr_ok'));
});

test('failed checks remain unknown, saved mode remains intact, and denied actors cannot probe or apply permissions', async () => {
  const f = fixture();
  let probes = 0;
  Object.assign(f.channel, {
    async checkGroupPermission() {
      probes++;
      throw Error('secret');
    },
  });
  try {
    const result = await f.manager.executeManagement(
      {
        intent: 'group_mode.set',
        parameters: { botId: 'test-lark', chatId: 'oc_group', mode: 'auto' },
      },
      { kind: 'local' },
      () => {},
    );
    assert.equal(result.mode, 'auto');
    assert.equal(result.permission!.status, 'unknown');
    assert.equal(probes, 1);
    await assert.rejects(
      f.manager.executeManagement(
        {
          intent: 'group_mode.set',
          parameters: { botId: 'test-lark', chatId: 'oc_group', mode: 'context' },
        },
        {
          kind: 'chat',
          source: 'slash',
          message: { ...group(''), route: { ...group('').route, sender: 'outsider' } },
        },
        () => {},
      ),
    );
    assert.equal(probes, 1);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('new Lark app registration requests group-wide messages from the start and keeps default group mode unchanged', () => {
  assert.ok(LARK_SCOPES.includes('im:message.group_msg'));
  assert.ok(GUIDES.lark.steps.some((s) => s.includes('群模式仍默认仅 @')));
});
