import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming as baseIncoming } from './helpers.js';
const incoming = (...args: Parameters<typeof baseIncoming>) => ({
  ...baseIncoming(...args),
  direct: true,
});
import { SetupService } from '../src/setup/service.js';
import { createDashboard } from '../src/web/server.js';

test('only manager DMs list/manage global sessions without rebinding; ordinary bots cannot access the center', async () => {
  const f = fixture();
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      child = f.store.create(incoming('', 'alice', 'child').route, 'codex', f.dir);
    const otherUser = f.store.create(incoming('', 'bob', '').route, 'codex', f.dir);
    const otherBot = f.store.create({ ...main.route, account: 'other-bot' }, 'claude', f.dir);
    const otherChat = f.store.create({ ...main.route, conversation: 'other-chat' }, 'codex', f.dir);
    const local = f.store.create(
      {
        platform: 'local',
        account: 'dashboard',
        sender: 'local-owner',
        conversation: 'local',
        thread: '',
      },
      'codex',
      f.dir,
    );
    f.store.event(otherBot.id, 'response', 'private history');
    for (const command of ['/tab list', '/tab sessions']) {
      await f.manager.receive(incoming(command, 'alice', ''));
      const text = f.channel.sent.at(-1)!.text;
      assert.match(text, /只有 Manager/);
      assert.ok(!text.includes(main.id));
      assert.ok(!text.includes(child.id));
      for (const s of [otherUser, otherBot, otherChat, local]) assert.ok(!text.includes(s.id));
    }
    for (const op of ['status', 'history', 'tools', 'open', 'close', 'stop']) {
      await f.manager.receive(incoming(`/tab manage ${otherBot.id} ${op}`, 'alice', ''));
      assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
    }
    assert.equal(f.store.get(otherBot.id)!.status, 'idle');
    f.config.channels[0]!.manager = true;
    await f.manager.receive(incoming('/tab list', 'alice', ''));
    for (const s of [main, child, otherUser, otherBot, otherChat, local])
      assert.ok(f.channel.sent.at(-1)!.text.includes(s.id));
    await f.manager.receive(incoming('当前有几个会话', 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /Manager 全局视图[\s\S]*共 6 个/);
    await f.manager.receive(incoming(`/tab manage ${otherBot.id} history`, 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /private history/);
    await f.manager.receive(incoming(`/tab manage ${otherBot.id} close`, 'alice', ''));
    assert.equal(f.store.get(otherBot.id)!.status, 'closed');
    assert.equal(f.store.current(main.route)!.id, main.id);
    assert.equal(f.store.current(otherBot.route)!.id, otherBot.id);
    assert.equal(f.agent.inputs.length, 0);
    f.config.channels[0]!.manager = false;
    await f.manager.receive(incoming(`/tab manage ${otherBot.id} open`, 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
    assert.equal(f.store.get(otherBot.id)!.status, 'closed');
    await f.manager.receive(incoming(`/tab manage ${child.id} close`, 'alice', ''));
    assert.equal(f.store.get(child.id)!.status, 'idle');
  } finally {
    await f.cleanup();
  }
});
test('role update requires local authorization, persists, and takes effect without restarting', async () => {
  const f = fixture(),
    file = join(f.dir, 'config.json');
  writeFileSync(file, JSON.stringify(f.config));
  const setup = new SetupService(file),
    server = createDashboard(f.manager, 'token', setup);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/channels/test-lark/role`;
  try {
    assert.equal(
      (await fetch(url, { method: 'POST', body: JSON.stringify({ manager: true }) })).status,
      401,
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: JSON.stringify({ manager: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(f.config.channels[0]!.manager, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).channels[0].manager, true);
    const bad = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: JSON.stringify({ manager: 'true' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await setup.close();
    await f.cleanup();
  }
});
for (const platform of ['wechat', 'wecom', 'dingtalk'] as const)
  test(`${platform} ordinary bot children never replace main and stay in their own context`, async () => {
    const f = fixture();
    const channel = {
      id: 'bot',
      platform,
      async start() {},
      async stop() {},
      sent: [] as string[],
      async send(_m: any, t: string) {
        this.sent.push(t);
      },
    };
    f.config.channels.push(
      platform === 'dingtalk'
        ? {
            type: platform,
            id: 'bot',
            allowedUsers: ['alice'],
            clientIdEnv: 'ID',
            clientSecretEnv: 'SECRET',
          }
        : platform === 'wechat'
          ? {
              type: platform,
              id: 'bot',
              allowedUsers: ['alice'],
              botIdEnv: 'ID',
              tokenEnv: 'SECRET',
              baseUrl: 'https://ilinkai.weixin.qq.com',
            }
          : {
              type: platform,
              id: 'bot',
              allowedUsers: ['alice'],
              botIdEnv: 'ID',
              secretEnv: 'SECRET',
            },
    );
    f.manager.channels.set('bot', channel);
    const message = (text: string) => ({
      ...incoming(text, 'alice', ''),
      route: { platform, account: 'bot', conversation: 'chat', sender: 'alice', thread: '' },
    });
    try {
      await f.manager.receive(message('主任务'));
      await f.manager.idle();
      const main = f.store.current(message('').route)!;
      await f.manager.receive(message('/tab new codex default'));
      const child = f.store.list().find((s) => s.id !== main.id)!;
      assert.ok(child.route.thread);
      assert.equal(f.store.current(main.route)!.id, main.id);
      await f.manager.receive(message(`/tab to ${child.id} 子任务`));
      await f.manager.idle();
      assert.equal(f.agent.inputs.at(-1)!.session.id, child.id);
      await f.manager.receive(message('继续主任务'));
      await f.manager.idle();
      assert.equal(f.agent.inputs.at(-1)!.session.id, main.id);
      await f.manager.receive(message('/tab bots'));
      assert.match(channel.sent.at(-1)!, /只有 Manager/);
      assert.doesNotMatch(channel.sent.at(-1)!, /test-lark/);
    } finally {
      await f.cleanup();
    }
  });
