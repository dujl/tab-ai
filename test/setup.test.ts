import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SetupService, type SetupView } from '../src/setup/service.js';
import { loadConfig, type ChannelConfig } from '../src/config.js';
import { type Channel, type Incoming } from '../src/core/types.js';
import { credentialResolver, readCredentials, SetupStorage } from '../src/setup/storage.js';
import { type SetupProviders, SetupError } from '../src/setup/providers.js';
import { fixture, until } from './helpers.js';
import { createDashboard } from '../src/web/server.js';

class PairChannel implements Channel {
  id: string;
  platform: ChannelConfig['type'];
  stopped = false;
  sent: string[] = [];
  fail = false;
  callback?: (message: Incoming) => Promise<void>;
  constructor(readonly config: ChannelConfig) {
    this.id = config.id;
    this.platform = config.type;
  }
  async start(callback: (message: Incoming) => Promise<void>) {
    this.callback = callback;
  }
  async stop() {
    this.stopped = true;
  }
  async send(_message: Incoming, text: string) {
    if (this.fail) throw new Error('private-secret-and-webhook');
    this.sent.push(text);
  }
  async emit(text: string, sender = 'alice', direct = true) {
    await this.callback!({
      id: randomUUID(),
      text,
      direct,
      route: {
        platform: this.platform,
        account: this.id,
        conversation: 'dm-1',
        thread: '',
        sender,
      },
    });
  }
}
function setupFixture(
  overrides: { providers?: Partial<SetupProviders>; timeoutMs?: number; live?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-setup-')),
    file = join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({ dataDir: '.tab-ai', workspaces: { default: '.' }, channels: [] }),
  );
  const channels: PairChannel[] = [],
    received: Incoming[] = [],
    adopted: ChannelConfig[] = [];
  const fakeProviders: SetupProviders = {
    register: async (_domain, _signal, onUrl) => {
      onUrl('https://accounts.feishu.cn/authorize?code=test', 600);
      return {
        client_id: 'cli-created',
        client_secret: 'registered-secret',
        user_info: { open_id: 'alice', tenant_brand: 'feishu' },
      };
    },
    identify: async () => ({ name: 'Test bot', botOpenId: 'bot-open-id' }),
    ...overrides.providers,
  };
  const service = new SetupService(file, {
    providers: fakeProviders,
    timeoutMs: overrides.timeoutMs ?? 5000,
    channel: (config, resolver) => {
      assert.ok(
        resolver(
          Object.entries(config).find(
            ([key]) => key.endsWith('SecretEnv') || key === 'secretEnv' || key === 'tokenEnv',
          )![1] as string,
        ),
      );
      const channel = new PairChannel(config);
      channels.push(channel);
      return channel;
    },
    ...(overrides.live
      ? {
          receive: async (message: Incoming) => {
            received.push(message);
          },
          adopt: (config: ChannelConfig) => {
            adopted.push(config);
          },
        }
      : {}),
  });
  return {
    dir,
    file,
    service,
    channels,
    received,
    adopted,
    async cleanup() {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function pairing(service: SetupService, id: string): Promise<SetupView> {
  await until(() => ['pairing', 'error'].includes(service.status(id).phase));
  const state = service.status(id);
  assert.equal(state.phase, 'pairing', state.message);
  return state;
}

test('QR accepts official launcher URLs and rejects lookalikes, other paths and embedded credentials', async () => {
  for (const [url, accepted] of [
    ['https://open.feishu.cn/page/launcher?user_code=test', true],
    ['https://open.larksuite.com/page/launcher?user_code=test', true],
    ['https://accounts.feishu.cn/authorize?code=test', true],
    ['https://open.feishu.cn.evil.example/page/launcher', false],
    ['https://open.feishu.cn/other', false],
    ['http://open.feishu.cn/page/launcher', false],
    ['https://user:password@open.feishu.cn/page/launcher', false],
    ['https://open.feishu.cn:8443/page/launcher', false],
  ] as const) {
    const f = setupFixture({
      providers: {
        register: async (_domain, _signal, onUrl) => {
          onUrl(url, 600);
          return { client_id: 'cli-created', client_secret: 'registered-secret' };
        },
      },
    });
    try {
      const start = f.service.start({ type: 'lark', mode: 'qr' });
      await until(() => ['pairing', 'error'].includes(f.service.status(start.id).phase));
      assert.equal(f.service.status(start.id).phase, accepted ? 'pairing' : 'error', url);
      if (!accepted) {
        assert.equal(f.channels.length, 0);
        assert.equal(f.service.storage.drafts().length, 0);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test('web onboarding requires local authentication and persists only a paired confirmation', async () => {
  const f = setupFixture(),
    runtime = fixture(),
    server = createDashboard(runtime.manager, 'setup-token', f.service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, data?: unknown) =>
    fetch(`${base}/api/setup${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer setup-token', 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  try {
    const page = await fetch(`${base}/setup`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /接入机器人/);
    assert.equal((await fetch(`${base}/setup.js`)).status, 200);
    assert.equal(
      (await fetch(`${base}/api/setup/start`, { method: 'POST', body: '{}' })).status,
      401,
    );
    assert.equal(f.service.current(), undefined);
    const startResponse = await request('/start', {
      type: 'wecom',
      mode: 'manual',
      credentialId: 'http-bot',
      credentialSecret: 'private-http-secret',
    });
    assert.equal(startResponse.status, 202);
    const start = (await startResponse.json()) as SetupView;
    const ready = await pairing(f.service, start.id);
    assert.equal((await request(`/${start.id}/confirm`, {})).status, 400);
    const listed = await (await request('')).text();
    assert.ok(!listed.includes('private-http-secret'));
    const status = (await (await request(`/${start.id}`)).json()) as SetupView;
    assert.equal(status.pairCommand, ready.pairCommand);
    await f.channels[0]!.emit(ready.pairCommand!);
    const completed = await request(`/${start.id}/confirm`, {});
    assert.equal(completed.status, 200);
    assert.equal(((await completed.json()) as SetupView).phase, 'complete');
    assert.equal(loadConfig(f.file).channels.length, 1);
    assert.equal(runtime.agent.inputs.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
    await runtime.cleanup();
  }
});

for (const type of ['lark', 'dingtalk', 'wecom'] as const)
  test(`${type}: private pairing and explicit confirmation are required before persistence`, async () => {
    const f = setupFixture();
    try {
      const start = f.service.start({
        type,
        mode: 'manual',
        credentialId: 'application-id',
        credentialSecret: 'sensitive-value',
      });
      const ready = await pairing(f.service, start.id),
        channel = f.channels[0]!;
      assert.equal(loadConfig(f.file).channels.length, 0);
      await assert.rejects(f.service.confirm(start.id), /双向配对/);
      await channel.emit('hello');
      await channel.emit('/tab pair wrong');
      await channel.emit(ready.pairCommand!, 'alice', false);
      assert.equal(channel.sent.length, 0);
      assert.equal(f.service.status(start.id).phase, 'pairing');
      assert.match(ready.pairCommand!, /^\/tab pair /);
      await channel.emit(ready.pairCommand!);
      await channel.emit(ready.pairCommand!, 'eve');
      assert.equal(f.service.status(start.id).phase, 'paired');
      assert.equal(channel.sent.length, 1);
      assert.equal(loadConfig(f.file).channels.length, 0);
      const completed = await f.service.confirm(start.id);
      assert.equal(completed.phase, 'complete');
      const config = loadConfig(f.file),
        saved = config.channels[0]!;
      assert.deepEqual(saved.allowedUsers, ['alice']);
      assert.ok(!readFileSync(f.file, 'utf8').includes('sensitive-value'));
      if (saved.type === 'lark') assert.equal(saved.botOpenId, 'bot-open-id');
      const secrets = readCredentials(config.dataDir);
      assert.ok(Object.values(secrets).includes('sensitive-value'));
      assert.equal(statSync(join(config.dataDir, 'credentials.json')).mode & 0o777, 0o600);
      const key = Object.keys(secrets).find((k) => k.endsWith('_SECRET'))!;
      assert.equal(credentialResolver(loadConfig(f.file))(key), 'sensitive-value');
      assert.equal(channel.stopped, true);
      assert.equal(f.service.storage.drafts().length, 0);
      assert.equal((await f.service.confirm(start.id)).phase, 'complete');
      assert.equal(loadConfig(f.file).channels.length, 1);
      assert.ok(!JSON.stringify(f.service.current()).includes('sensitive-value'));
    } finally {
      await f.cleanup();
    }
  });
test('QR registration credentials are private, drafts survive cancellation, only authorizing user may pair', async () => {
  const f = setupFixture();
  try {
    const start = f.service.start({ type: 'lark', mode: 'qr' }),
      ready = await pairing(f.service, start.id);
    await f.channels[0]!.emit(ready.pairCommand!, 'eve');
    assert.equal(f.service.status(start.id).phase, 'pairing');
    const drafts = f.service.storage.drafts();
    assert.equal(drafts.length, 1);
    assert.ok(!JSON.stringify(drafts).includes('registered-secret'));
    await f.service.cancel(start.id);
    assert.equal(f.channels[0]!.stopped, true);
    assert.equal(loadConfig(f.file).channels.length, 0);
    const resumed = f.service.start({ type: 'lark', mode: 'draft', draftId: drafts[0]!.id });
    const again = await pairing(f.service, resumed.id);
    assert.notEqual(ready.pairCommand, again.pairCommand);
    await f.channels[1]!.emit(again.pairCommand!);
    await f.service.confirm(resumed.id);
    assert.equal(loadConfig(f.file).channels[0]!.allowedUsers[0], 'alice');
    assert.equal(f.service.storage.drafts().length, 0);
  } finally {
    await f.cleanup();
  }
});
test('QR names increase across cancellation and restart; actual platform names survive activation', async () => {
  const names: string[] = [];
  const f = setupFixture({
    providers: {
      register: async (_domain, _signal, onUrl, name) => {
        names.push(name);
        onUrl('https://open.feishu.cn/page/launcher?user_code=test', 600);
        return { client_id: `cli-${name}`, client_secret: 'secret' };
      },
      identify: async () => ({ name: 'tab-ai-bot7', botOpenId: 'bot' }),
    },
  });
  try {
    const first = f.service.start({ type: 'lark', mode: 'qr' });
    await pairing(f.service, first.id);
    assert.deepEqual(names, ['tab-ai-bot1']);
    assert.equal(f.service.storage.drafts()[0]!.displayName, 'tab-ai-bot7');
    await f.service.cancel(first.id);
    const second = f.service.start({ type: 'lark', mode: 'qr' });
    const ready = await pairing(f.service, second.id);
    assert.deepEqual(names, ['tab-ai-bot1', 'tab-ai-bot8']);
    await f.channels[1]!.emit(ready.pairCommand!);
    await f.service.confirm(second.id);
    assert.equal(loadConfig(f.file).channels[0]!.displayName, 'tab-ai-bot7');
    assert.equal(new SetupStorage(f.file).reserveBotName(), 'tab-ai-bot9');
    assert.equal(new SetupStorage(f.file).reserveBotName(), 'tab-ai-bot10');
  } finally {
    await f.cleanup();
  }
});
test('name migration counts legacy bots and deduplicates leftover drafts for committed accounts', async () => {
  const f = setupFixture();
  try {
    const start = f.service.start({
      type: 'wecom',
      mode: 'manual',
      credentialId: 'legacy-bot',
      credentialSecret: 'secret',
    });
    const ready = await pairing(f.service, start.id),
      draft = f.service.storage.draft(start.id);
    await f.channels[0]!.emit(ready.pairCommand!);
    await f.service.confirm(start.id);
    f.service.storage.saveDraft(draft); // A crash after commit may leave this duplicate.
    assert.equal(f.service.storage.reserveBotName(), 'tab-ai-bot2');
    const raw = JSON.parse(readFileSync(f.file, 'utf8'));
    raw.channels = [];
    writeFileSync(f.file, JSON.stringify(raw)); // Removing an account must not reset the counter.
    assert.equal(new SetupStorage(f.file).reserveBotName(), 'tab-ai-bot3');
  } finally {
    await f.cleanup();
  }
});
test('successful live setup reuses the tested connection and only routes tasks after activation', async () => {
  const f = setupFixture({ live: true });
  try {
    const start = f.service.start({
        type: 'wecom',
        mode: 'manual',
        credentialId: 'bot',
        credentialSecret: 'secret',
      }),
      ready = await pairing(f.service, start.id);
    const channel = f.channels[0]!;
    await channel.emit('untrusted task');
    assert.equal(f.received.length, 0);
    await channel.emit(ready.pairCommand!);
    await channel.emit('still unauthorized');
    assert.equal(f.received.length, 0);
    await f.service.confirm(start.id);
    assert.equal(f.adopted.length, 1);
    assert.equal(channel.stopped, false);
    await channel.emit('real task');
    assert.equal(f.received[0]!.text, 'real task');
    assert.equal(f.channels.length, 1);
  } finally {
    await f.cleanup();
  }
});
test('reply failure never activates a bot or leaks raw SDK errors', async () => {
  const f = setupFixture();
  try {
    const start = f.service.start({
        type: 'dingtalk',
        mode: 'manual',
        credentialId: 'bot',
        credentialSecret: 'secret',
      }),
      ready = await pairing(f.service, start.id);
    f.channels[0]!.fail = true;
    await f.channels[0]!.emit(ready.pairCommand!);
    assert.equal(f.service.status(start.id).phase, 'error');
    assert.ok(!JSON.stringify(f.service.status(start.id)).includes('private-secret'));
    await assert.rejects(f.service.confirm(start.id));
    assert.equal(loadConfig(f.file).channels.length, 0);
    assert.equal(f.channels[0]!.stopped, true);
  } finally {
    await f.cleanup();
  }
});
test('expiry destroys the pairing code and cannot be confirmed later', async () => {
  const f = setupFixture({ timeoutMs: 100 });
  try {
    const start = f.service.start({
      type: 'wecom',
      mode: 'manual',
      credentialId: 'bot',
      credentialSecret: 'secret',
    });
    await pairing(f.service, start.id);
    await until(() => f.service.status(start.id).phase === 'expired');
    assert.equal(f.service.status(start.id).pairCommand, undefined);
    await assert.rejects(f.service.confirm(start.id));
    assert.equal(f.channels[0]!.stopped, true);
    assert.equal(loadConfig(f.file).channels.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('cancellation during a slow preflight cannot leave a newly started socket or save activation', async () => {
  let release!: (value: { name: string; botOpenId: string }) => void;
  const f = setupFixture({
    providers: {
      identify: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  try {
    const start = f.service.start({
      type: 'lark',
      mode: 'manual',
      credentialId: 'bot',
      credentialSecret: 'secret',
    });
    await f.service.cancel(start.id);
    release({ name: 'late', botOpenId: 'bot' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.channels.length, 0);
    assert.equal(loadConfig(f.file).channels.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('registered credentials survive a subsequent identity error for later recovery', async () => {
  const f = setupFixture({
    providers: {
      identify: async () => {
        throw new SetupError('机器人未发布');
      },
    },
  });
  try {
    const start = f.service.start({ type: 'lark', mode: 'qr' });
    await until(() => f.service.status(start.id).phase === 'error');
    assert.equal(f.service.storage.drafts().length, 1);
    assert.equal(loadConfig(f.file).channels.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('duplicate platform accounts and overlapping setup attempts are rejected', async () => {
  const f = setupFixture();
  try {
    const params = {
      type: 'wecom',
      mode: 'manual',
      credentialId: 'bot',
      credentialSecret: 'secret',
    } as const;
    const start = f.service.start(params),
      ready = await pairing(f.service, start.id);
    assert.throws(() => f.service.start(params), /进行中/);
    await f.channels[0]!.emit(ready.pairCommand!);
    await f.service.confirm(start.id);
    const duplicate = f.service.start(params);
    await until(() => f.service.status(duplicate.id).phase === 'error');
    assert.match(f.service.status(duplicate.id).message, /已经接入/);
    assert.equal(f.channels.length, 1);
    assert.throws(() => f.service.start({ type: 'lark', mode: 'manual', credentialId: 'bot' }));
  } finally {
    await f.cleanup();
  }
});

test('WeChat QR verification binds only the scanner and needs a successful private reply before activation', async () => {
  const f = setupFixture({
    live: true,
    providers: {
      wechatLogin: async (_signal, onQr, verify) => {
        onQr('https://liteapp.weixin.qq.com/q/test', 300);
        assert.equal(await verify(), '123456');
        return {
          botId: 'wx-bot',
          token: 'wx-private-token',
          baseUrl: 'https://ilinkai.weixin.qq.com',
          userId: 'alice',
        };
      },
    },
  });
  try {
    const start = f.service.start({ type: 'wechat', mode: 'qr' });
    await until(() => !!f.service.status(start.id).needsVerifyCode);
    assert.throws(() => f.service.verify(start.id, { code: '' }));
    f.service.verify(start.id, { code: '123456' });
    const ready = await pairing(f.service, start.id);
    assert.equal(ready.pairCommand, undefined);
    assert.deepEqual(f.channels[0]!.config.allowedUsers, ['alice']);
    await f.channels[0]!.emit('hi', 'eve');
    await f.channels[0]!.emit('hi', 'alice', false);
    assert.equal(f.service.status(start.id).phase, 'pairing');
    assert.equal(f.received.length, 0);
    await f.channels[0]!.emit('hello', 'alice');
    assert.equal(f.service.status(start.id).phase, 'paired');
    assert.equal(loadConfig(f.file).channels.length, 0);
    await f.service.confirm(start.id);
    const channel = loadConfig(f.file).channels[0]!;
    assert.equal(channel.type, 'wechat');
    assert.deepEqual(channel.allowedUsers, ['alice']);
    assert.ok(!readFileSync(f.file, 'utf8').includes('wx-private-token'));
    assert.ok(!JSON.stringify(f.service.current()).includes('wx-private-token'));
    await f.channels[0]!.emit('real task');
    assert.equal(f.received.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('WeChat cancelled verification cannot accept late answers or create credentials', async () => {
  const f = setupFixture({
    providers: {
      wechatLogin: async (_signal, onQr, verify) => {
        onQr('https://liteapp.weixin.qq.com/q/test', 300);
        await verify();
        throw new Error('must not proceed');
      },
    },
  });
  try {
    const start = f.service.start({ type: 'wechat', mode: 'qr' });
    await until(() => !!f.service.status(start.id).needsVerifyCode);
    await f.service.cancel(start.id);
    assert.throws(() => f.service.verify(start.id, { code: '123456' }));
    assert.equal(f.channels.length, 0);
    assert.equal(f.service.storage.drafts().length, 0);
    assert.throws(() =>
      f.service.start({
        type: 'wechat',
        mode: 'manual',
        credentialId: 'id',
        credentialSecret: 'secret',
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test('WeChat startup errors retain safe actionable diagnostics', async () => {
  const { WechatApiError } = await import('../src/channels/wechat-api.js');
  const { safeSetupError } = await import('../src/setup/providers.js');
  assert.match(safeSetupError(new WechatApiError(503)), /503.*继续未完成配置/);
  assert.match(safeSetupError(new WechatApiError(-14)), /登录已失效/);
  assert.ok(!safeSetupError(new Error('private-token')).includes('private-token'));
});

for (const type of ['wecom', 'dingtalk'] as const)
  test(`${type} QR binds with ordinary private text and requires local confirmation, including after resume`, async () => {
    const f = setupFixture({
      live: true,
      providers: {
        dingtalkRegister: async (_signal, onQr) => {
          onQr('https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=test', 300);
          return { clientId: 'auto-wecom-bot', clientSecret: 'auto-wecom-private-secret' };
        },
        wecomRegister: async (_signal, onQr) => {
          onQr('https://work.weixin.qq.com/ai/qc/c?key=test', 300);
          return { botId: 'auto-wecom-bot', secret: 'auto-wecom-private-secret' };
        },
      },
    });
    try {
      const start = f.service.start({ type, mode: 'qr' }),
        ready = await pairing(f.service, start.id);
      assert.equal(ready.pairCommand, undefined);
      assert.equal(ready.url, undefined);
      assert.equal(f.service.storage.draft(start.id).pairingMode, 'message');
      assert.equal(f.service.storage.drafts().length, 1);
      assert.ok(!JSON.stringify(f.service.current()).includes('auto-wecom-private-secret'));
      assert.ok(!JSON.stringify(f.service.storage.drafts()).includes('auto-wecom-private-secret'));
      assert.equal(loadConfig(f.file).channels.length, 0);
      await f.channels[0]!.emit('   ');
      await f.channels[0]!.emit('hello', 'alice', false);
      assert.equal(f.service.status(start.id).phase, 'pairing');
      assert.equal(f.received.length, 0);
      await f.service.cancel(start.id);
      const resumed = f.service.start({ type, mode: 'draft', draftId: start.id }),
        again = await pairing(f.service, resumed.id);
      assert.equal(again.pairCommand, undefined);
      await f.channels[1]!.emit('hello');
      assert.equal(f.service.status(resumed.id).phase, 'paired');
      assert.equal(f.service.status(resumed.id).candidate?.sender, 'alice');
      assert.equal(loadConfig(f.file).channels.length, 0);
      await f.channels[1]!.emit('another user', 'eve');
      assert.equal(f.service.status(resumed.id).candidate?.sender, 'alice');
      assert.equal(f.received.length, 0);
      await f.service.confirm(resumed.id);
      const config = loadConfig(f.file);
      assert.equal(config.channels[0]!.type, type);
      assert.deepEqual(config.channels[0]!.allowedUsers, ['alice']);
      assert.ok(!readFileSync(f.file, 'utf8').includes('auto-wecom-private-secret'));
      assert.equal(statSync(join(config.dataDir, 'credentials.json')).mode & 0o777, 0o600);
      await f.channels[1]!.emit('real task');
      assert.equal(f.received.length, 1);
    } finally {
      await f.cleanup();
    }
  });

test('DingTalk QR names include the project, survive resume, and do not reuse cancelled reservations', async () => {
  let sequence = 0;
  const f = setupFixture({
    providers: {
      dingtalkRegister: async (_signal, onQr) => {
        onQr('https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=test', 300);
        return { clientId: `ding-${++sequence}`, clientSecret: 'secret' };
      },
    },
  });
  try {
    const first = f.service.start({ type: 'dingtalk', mode: 'qr' });
    assert.equal(first.name, 'tab-ai-bot1');
    assert.match(first.message, /建议名称：tab-ai-bot1/);
    assert.equal((await pairing(f.service, first.id)).name, 'tab-ai-bot1');
    assert.equal(f.service.storage.draft(first.id).displayName, 'tab-ai-bot1');
    await f.service.cancel(first.id);
    const resumed = f.service.start({ type: 'dingtalk', mode: 'draft', draftId: first.id });
    assert.equal((await pairing(f.service, resumed.id)).name, 'tab-ai-bot1');
    await f.channels[1]!.emit('hello');
    await f.service.confirm(resumed.id);
    assert.equal(loadConfig(f.file).channels[0]!.displayName, 'tab-ai-bot1');
    const second = f.service.start({ type: 'dingtalk', mode: 'qr' });
    assert.equal(second.name, 'tab-ai-bot2');
    await pairing(f.service, second.id);
    await f.service.cancel(second.id);
    const third = f.service.start({ type: 'dingtalk', mode: 'qr' });
    assert.equal(third.name, 'tab-ai-bot3');
    await pairing(f.service, third.id);
  } finally {
    await f.cleanup();
  }
});

test('WeCom credentials issued during cancellation survive as a draft without activating the bot', async () => {
  let release!: (value: { botId: string; secret: string }) => void;
  const f = setupFixture({
    providers: {
      wecomRegister: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  try {
    const start = f.service.start({ type: 'wecom', mode: 'qr' });
    await f.service.cancel(start.id);
    release({ botId: 'late-bot', secret: 'late-secret' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.service.storage.drafts().length, 1);
    assert.equal(f.channels.length, 0);
    assert.equal(f.service.status(start.id).phase, 'cancelled');
    assert.equal(loadConfig(f.file).channels.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('DingTalk credentials issued during cancellation survive as a draft without activating the bot', async () => {
  let release!: (value: { clientId: string; clientSecret: string }) => void;
  const f = setupFixture({
    providers: {
      dingtalkRegister: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  try {
    const start = f.service.start({ type: 'dingtalk', mode: 'qr' });
    await f.service.cancel(start.id);
    release({ clientId: 'late-bot', clientSecret: 'late-secret' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.service.storage.drafts().length, 1);
    assert.equal(f.channels.length, 0);
    assert.equal(f.service.status(start.id).phase, 'cancelled');
    assert.equal(loadConfig(f.file).channels.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('DingTalk QR capability errors and untrusted URLs never fall through to Lark registration', async () => {
  for (const enabled of [false, true]) {
    const f = setupFixture({
      providers: {
        register: async () => {
          assert.fail('DingTalk must not register a Lark bot');
        },
        ...(enabled
          ? {
              dingtalkRegister: async (
                _signal: AbortSignal,
                onQr: (url: string, seconds: number) => void,
              ) => {
                onQr('https://evil.example/registration?user_code=test', 300);
                return { clientId: 'untrusted', clientSecret: 'secret' };
              },
            }
          : {}),
      },
    });
    try {
      const start = f.service.start({ type: 'dingtalk', mode: 'qr' });
      await until(() => f.service.status(start.id).phase === 'error');
      assert.equal(f.service.status(start.id).url, undefined);
      assert.equal(f.channels.length, 0);
      assert.equal(f.service.storage.drafts().length, 0);
    } finally {
      await f.cleanup();
    }
  }
});
test('setup persists the explicitly chosen manager role; omitted role never grants global access', async () => {
  for (const manager of [undefined, false, true]) {
    const f = setupFixture();
    try {
      const start = f.service.start({
        type: 'wecom',
        mode: 'manual',
        credentialId: 'role-bot',
        credentialSecret: 'secret',
        ...(manager === undefined ? {} : { manager }),
      });
      const ready = await pairing(f.service, start.id);
      await f.channels[0]!.emit(ready.pairCommand!);
      await f.service.confirm(start.id);
      assert.equal(loadConfig(f.file).channels[0]!.manager, manager === true);
    } finally {
      await f.cleanup();
    }
  }
});

test('manual Lark creation includes the current app permission link and QR before enabling without enabling group auto', async () => {
  const f = setupFixture();
  try {
    const start = f.service.start({
      type: 'lark',
      mode: 'manual',
      credentialId: 'cli_current',
      credentialSecret: 'private-secret',
    });
    const ready = await pairing(f.service, start.id);
    assert.ok(ready.permission);
    const url = new URL(ready.permission!.url);
    assert.equal(url.hostname, 'open.feishu.cn');
    assert.equal(url.pathname, '/app/cli_current/auth');
    assert.ok(url.searchParams.get('q')!.split(',').includes('im:message.group_msg'));
    assert.match(ready.permission!.qrDataUrl, /^data:image\/png;base64,/);
    assert.ok(!JSON.stringify(ready).includes('private-secret'));
    await f.channels[0]!.emit(ready.pairCommand!);
    await f.service.confirm(start.id);
    const config = loadConfig(f.file);
    assert.equal(config.channels.length, 1);
    assert.equal(config.channels[0]!.type === 'lark' && config.channels[0]!.groupModes, undefined);
  } finally {
    await f.cleanup();
  }
});
