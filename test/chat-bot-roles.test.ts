import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming as baseIncoming } from './helpers.js';
const incoming = (...args: Parameters<typeof baseIncoming>) => ({
  ...baseIncoming(...args),
  direct: true,
});
import { Manager } from '../src/core/manager.js';
import { SetupStorage } from '../src/setup/storage.js';
import { loadConfig } from '../src/config.js';

for (const platform of ['lark', 'wechat', 'wecom', 'dingtalk'] as const)
  test(`${platform}: manager chat can promote/demote bots, persists and cannot bypass revocation or allowedUsers`, async () => {
    const f = fixture(),
      file = join(f.dir, 'roles.json');
    const source = {
      id: 'admin',
      manager: true,
      allowedUsers: ['alice'],
      type: platform,
      ...(platform === 'lark'
        ? { appIdEnv: 'ID', appSecretEnv: 'SECRET', botOpenId: 'bot', domain: 'feishu' as const }
        : platform === 'wechat'
          ? { botIdEnv: 'ID', tokenEnv: 'TOKEN', baseUrl: 'https://ilinkai.weixin.qq.com' }
          : platform === 'wecom'
            ? { botIdEnv: 'ID', secretEnv: 'SECRET' }
            : { clientIdEnv: 'ID', clientSecretEnv: 'SECRET' }),
    } as any;
    f.config.channels.push(source);
    writeFileSync(file, JSON.stringify(f.config));
    const storage = new SetupStorage(file),
      manager = new Manager(
        f.config,
        f.store,
        { codex: f.agent, claude: f.agent, opencode: f.agent },
        new Map([
          ['admin', f.channel],
          ['test-lark', f.channel],
        ]),
        undefined,
        (id, role) => storage.setManager(id, role),
      );
    const message = (text: string, sender = 'alice') => ({
      ...incoming(text, sender, ''),
      route: { platform, account: 'admin', conversation: 'chat', sender, thread: '' },
    });
    try {
      await manager.receive(message('/tab bot-role test-lark manager', 'eve'));
      assert.equal(f.channel.sent.length, 0);
      assert.equal(f.config.channels[0]!.manager, undefined);
      await manager.receive(message('/tab bot-role test-lark manager'));
      assert.equal(f.config.channels[0]!.manager, true);
      assert.equal(loadConfig(file).channels[0]!.manager, true);
      assert.match(f.channel.sent.at(-1)!.text, /已保存并立即生效/);
      await manager.receive(message('/tab bot-role test-lark scoped'));
      assert.equal(loadConfig(file).channels[0]!.manager, false);
      await manager.receive(message('/tab bot-role test-lark unknown'));
      assert.match(f.channel.sent.at(-1)!.text, /用法/);
      await manager.receive(message('/tab bot-role unknown manager'));
      assert.match(f.channel.sent.at(-1)!.text, /不存在/);
      await manager.receive(message('/tab bot-role admin scoped'));
      assert.equal(source.manager, false);
      await manager.receive(message('/tab bot-role admin manager'));
      assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
      assert.equal(loadConfig(file).channels.find((c) => c.id === 'admin')!.manager, false);
      assert.equal(f.store.list().length, 0);
      assert.equal(f.agent.inputs.length, 0);
    } finally {
      await manager.close();
      await f.cleanup();
    }
  });
test('ordinary bot cannot promote itself and persistence failure does not change runtime permissions', async () => {
  const f = fixture(),
    manager = new Manager(
      f.config,
      f.store,
      { codex: f.agent, claude: f.agent, opencode: f.agent },
      new Map([[f.channel.id, f.channel]]),
      undefined,
      () => {
        throw Error('保存失败');
      },
    );
  try {
    await manager.receive(incoming('/tab bot-role test-lark manager'));
    assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
    assert.equal(f.config.channels[0]!.manager, undefined);
    f.config.channels[0]!.manager = true;
    await manager.receive(incoming('/tab bot-role test-lark scoped'));
    assert.match(f.channel.sent.at(-1)!.text, /保存失败/);
    assert.equal(f.config.channels[0]!.manager, true);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await manager.close();
    await f.cleanup();
  }
});
