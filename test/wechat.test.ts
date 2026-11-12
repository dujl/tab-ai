import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WechatApi, loginWechat, wechatBase, wechatQrUrl } from '../src/channels/wechat-api.js';
import { WechatChannel, normalizeWechat } from '../src/channels/wechat.js';
import { type Incoming, type Session } from '../src/core/types.js';
import { fixture, until } from './helpers.js';

const config = {
  type: 'wechat' as const,
  id: 'wx-test',
  allowedUsers: ['alice'],
  botIdEnv: 'BOT',
  tokenEnv: 'TOKEN',
  baseUrl: 'https://ilinkai.weixin.qq.com',
};
const resolve = (key: string) => (key === 'BOT' ? 'bot' : 'secret-token');
const message = (id: string, text = 'hello', extra = {}) => ({
  message_id: id,
  from_user_id: 'alice',
  to_user_id: 'bot',
  message_type: 1,
  message_state: 2,
  item_list: [{ type: 1, text_item: { text } }],
  context_token: 'context-private',
  ...extra,
});

test('WeChat API preserves uint64 IDs and authenticates only bot POSTs; errors redact token data', async () => {
  const requests: any[] = [];
  const request = (async (url: any, init: any) => {
    requests.push({ url, init });
    return new Response(
      '{"ret":0,"message_id":18446744073709551615,"item":{"svr_id":18446744073709551614},"text":"message_id: 123"}',
    );
  }) as typeof fetch;
  const result = (await new WechatApi(config.baseUrl, 'private', request).call(
    'sendmessage',
    { msg: {} },
    AbortSignal.timeout(1000),
  )) as any;
  assert.equal(result.message_id, '18446744073709551615');
  assert.equal(result.item.svr_id, '18446744073709551614');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer private');
  assert.equal(JSON.parse(requests[0].init.body).base_info.bot_agent, 'tab-ai/0.3.0');
  await new WechatApi(config.baseUrl, undefined, request).call(
    'get_qrcode_status?qrcode=abc',
    undefined,
    AbortSignal.timeout(1000),
  );
  assert.equal(requests[1].init.headers.Authorization, undefined);
  assert.equal(requests[1].init.headers.AuthorizationType, undefined);
  const bad = new WechatApi(config.baseUrl, 'private', (async () => {
    throw new Error('secret-token private body');
  }) as typeof fetch);
  await assert.rejects(
    bad.call('sendmessage', {}, AbortSignal.timeout(1000)),
    (error) => !String(error).includes('private'),
  );
  const expired = new WechatApi(config.baseUrl, 'private', (async () =>
    Response.json({ ret: -14, errmsg: 'secret-token' })) as typeof fetch);
  await assert.rejects(expired.call('getupdates', {}, AbortSignal.timeout(1000)), /登录已失效/);
});

test('WeChat validates API and QR hosts, and QR login handles verification and trusted redirects', async () => {
  for (const url of [
    'https://ilinkai.weixin.qq.com.evil.test',
    'http://ilinkai.weixin.qq.com',
    'https://u:p@ilinkai.weixin.qq.com',
    'https://ilinkai.weixin.qq.com:123',
    'https://ilinkai.weixin.qq.com/path',
  ])
    assert.throws(() => wechatBase(url));
  assert.equal(
    wechatQrUrl('https://liteapp.weixin.qq.com/q/abc'),
    'https://liteapp.weixin.qq.com/q/abc',
  );
  assert.throws(() => wechatQrUrl('https://evil.test/q'));
  const requests: string[] = [];
  let polls = 0,
    verifies = 0,
    qr = '';
  const request = (async (url: any) => {
    requests.push(String(url));
    if (String(url).includes('get_bot_qrcode'))
      return Response.json({
        qrcode: 'a&b',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc',
      });
    polls++;
    return Response.json(
      polls === 1
        ? { status: 'need_verifycode' }
        : {
            status: 'confirmed',
            ilink_bot_id: 'bot',
            bot_token: 'token',
            ilink_user_id: 'alice',
            baseurl: config.baseUrl,
          },
    );
  }) as typeof fetch;
  const result = await loginWechat(
    AbortSignal.timeout(5000),
    (url) => {
      qr = url;
    },
    async () => {
      verifies++;
      return '123456';
    },
    request,
  );
  assert.equal(qr, 'https://liteapp.weixin.qq.com/q/abc');
  assert.equal(verifies, 1);
  assert.match(requests.at(-1)!, /qrcode=a%26b&verify_code=123456/);
  assert.equal(result.userId, 'alice');
});

test('WeChat normalization uses stable private routes and ignores bot, group and unfinished messages', () => {
  const m = normalizeWechat(message('100', '  原文\n/keep  '), 'wx')!;
  assert.equal(m.text, '  原文\n/keep  ');
  assert.equal(m.route.conversation, 'alice');
  assert.equal(m.route.thread, '');
  for (const extra of [{ message_type: 2 }, { group_id: 'group' }, { message_state: 1 }])
    assert.equal(normalizeWechat(message('100', 'x', extra), 'wx'), undefined);
});

test('WeChat persists cursors and quote routing across restart; missing quotes never silently route to main', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-wechat-')),
    received: Incoming[] = [],
    calls: any[] = [];
  let queued: unknown[] = [message('1'), message('2', 'evil', { from_user_id: 'eve' })],
    cursor = 'cursor-one',
    sends = 0;
  const request = (async (url: any, init: any) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/getconfig')) return Response.json({ ret: 0 });
    if (String(url).endsWith('/sendmessage'))
      return new Response(
        `{"ret":0,"message_id":${sends++ === 0 ? '18446744073709551615' : '18446744073709551614'}}`,
      );
    const msgs = queued;
    queued = [];
    return Response.json({ ret: 0, msgs, get_updates_buf: cursor });
  }) as typeof fetch;
  let channel = new WechatChannel(config, resolve, dir, request);
  try {
    await channel.start(async (m) => {
      received.push(m);
    });
    await until(() => received.length === 1);
    const child = {
      ...received[0]!,
      sessionAnchor: true,
      route: { ...received[0]!.route, thread: 'mux:child' },
    };
    channel.recordSessionMessage(child, { route: child.route } as Session);
    await channel.send(child, 'child result');
    await channel.stop();
    const file = join(dir, 'wechat', readdirSync(join(dir, 'wechat'))[0]!);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, 'utf8').includes('secret-token'));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).cursor, 'cursor-one');
    assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).contexts).length, 1);
    queued = [
      message('3', '', {
        item_list: [
          { type: 1, text_item: { text: '续写' }, ref_msg: { svr_id: '18446744073709551615' } },
        ],
      }),
      message('4', '', {
        item_list: [{ type: 1, text_item: { text: '继续' }, ref_msg: { svr_id: 'not-known' } }],
      }),
      message('5', 'main'),
    ];
    cursor = 'cursor-two';
    channel = new WechatChannel(config, resolve, dir, request);
    await channel.start(async (m) => {
      received.push(m);
    });
    await until(() => received.length === 4);
    assert.equal(received[1]!.route.thread, 'mux:child');
    assert.equal(received[1]!.text, '续写');
    assert.equal(received[2]!.unresolvedQuote, true);
    assert.equal(received[3]!.route.thread, '');
    const polls = calls.filter((c) => c.url.endsWith('/getupdates'));
    assert.ok(polls.some((c) => c.body.get_updates_buf === 'cursor-one'));
    await channel.send(received[1]!, 'reply');
    assert.equal(calls.at(-1).body.msg.context_token, 'context-private');
    await assert.rejects(
      channel.send({ ...child, route: { ...child.route, sender: 'eve' } }, 'leak'),
      /不匹配/,
    );
  } finally {
    await channel.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function wxFixture() {
  const f = fixture({
    async classify({ text }) {
      return text.startsWith('新开')
        ? {
            action: 'new_topic',
            workspace: null,
            instructions: null,
            agent: 'OpenCode',
            task: '写小说',
          }
        : { action: 'continue', workspace: null, instructions: null, agent: null, task: null };
    },
  });
  f.config.channels.push(config);
  const sent: { message: Incoming; text: string }[] = [];
  f.manager.registerChannel({
    id: config.id,
    platform: 'wechat',
    async start() {},
    async stop() {},
    async send(message, text) {
      sent.push({ message, text });
    },
  });
  const receive = async (text: string, thread = '', sender = 'alice', extra = {}) => {
    await f.manager.receive({
      id: randomUUID(),
      text,
      route: { platform: 'wechat', account: config.id, conversation: sender, sender, thread },
      ...extra,
    });
  };
  return { ...f, sent, receive };
}

test('WeChat children isolate context; plain messages stay in main, quotes and one-off commands address children', async () => {
  const f = wxFixture();
  try {
    await f.receive('主任务');
    await f.manager.idle();
    const main = f.store.list()[0]!;
    await f.receive('新开一个话题，使用 OpenCode 写小说');
    await f.manager.idle();
    const child = f.store.list().find((s) => s.id !== main.id)!;
    assert.equal(child.agent, 'opencode');
    assert.match(child.route.thread, /^mux:/);
    assert.equal(child.title, '写小说');
    assert.equal(f.agent.inputs.at(-1)!.text, '写小说');
    assert.equal(f.agent.inputs.at(-1)!.session.id, child.id);
    await f.receive('仍是主任务');
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.session.id, main.id);
    await f.receive('引用继续', child.route.thread);
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.session.id, child.id);
    await f.receive(`/tab to ${child.id.slice(0, 8)}   原样\n续写`);
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.text, '  原样\n续写');
    await f.receive('主任务继续');
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.session.id, main.id);
    await f.receive(`/tab use ${child.id.slice(0, 8)}`);
    assert.equal(f.sent.at(-1)!.message.route.thread, child.route.thread);
    await f.receive('/tab main', child.route.thread);
    assert.equal(f.sent.at(-1)!.message.route.thread, '');
    assert.match(f.sent.at(-1)!.text, /主会话/);
    const count = f.agent.inputs.length;
    await f.receive('继续', '', 'alice', { unresolvedQuote: true });
    assert.equal(f.agent.inputs.length, count);
    assert.match(f.sent.at(-1)!.text, /无法识别引用/);
    await f.receive(`/tab to ${child.id.slice(0, 8)} 偷看`, '', 'bob');
    assert.equal(f.agent.inputs.length, count);
    await f.receive('/tab close', child.route.thread);
    await f.receive('继续', child.route.thread);
    assert.equal(f.agent.inputs.length, count);
    await f.receive('/tab open', child.route.thread);
    await f.receive('恢复', child.route.thread);
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.session.id, child.id);
    assert.ok(f.sent.some((s) => s.text.startsWith(`【写小说 · ${child.id.slice(0, 8)}】`)));
  } finally {
    await f.cleanup();
  }
});

test('WeChat parallel children do not replace main approvals; answers remain bound to their session', async () => {
  const f = wxFixture();
  f.agent.handler = async (run) => {
    run.hooks.nativeId(`native-${run.session.id}`);
    if (run.text === '需要授权') {
      const answer = await run.hooks.ask(
        { kind: 'approval', title: 'tool', detail: 'test' },
        run.signal,
      );
      run.hooks.text(JSON.stringify(answer));
    } else run.hooks.text(run.text);
  };
  try {
    await f.receive('需要授权');
    await until(() => f.manager.interactions().length === 1);
    const main = f.store.list()[0]!,
      request = f.manager.interactions()[0]!;
    await f.receive('新开一个会话，使用 OpenCode 写小说');
    await until(() => f.store.list().some((s) => s.route.thread && s.status === 'idle'));
    const child = f.store.list().find((s) => s.route.thread)!;
    assert.equal(f.manager.interactions().length, 1);
    assert.equal(f.store.get(main.id)!.status, 'waiting');
    await f.receive(`/tab approve ${request.id} allow`, child.route.thread);
    assert.equal(f.manager.interactions().length, 1);
    await f.receive(`/tab approve ${request.id} deny`);
    await f.manager.idle();
    assert.equal(f.store.get(main.id)!.status, 'idle');
    assert.equal(
      f.store
        .events(main.id)
        .filter((e) => e.type === 'response')
        .at(-1)!.text,
      '{"allow":false}',
    );
    assert.equal(
      f.store
        .events(child.id)
        .filter((e) => e.type === 'response')
        .at(-1)!.text,
      '写小说',
    );
  } finally {
    await f.cleanup();
  }
});

test('WeChat retries transient connection checks, preserves authorization errors and does not retry uncertain sends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-wechat-retry-'));
  let checks = 0,
    sends = 0,
    gotMessage = false;
  const request = (async (url: any, init: any) => {
    if (String(url).endsWith('/getconfig')) {
      checks++;
      if (checks === 1) throw new Error('secret request network failure');
      return Response.json({ ret: 0 });
    }
    if (String(url).endsWith('/sendmessage')) {
      sends++;
      throw new Error('uncertain send');
    }
    return Response.json({ ret: 0, msgs: [message('one')], get_updates_buf: 'cursor' });
  }) as typeof fetch;
  const channel = new WechatChannel(config, resolve, dir, request);
  let received: Incoming | undefined;
  try {
    await channel.start(async (m) => {
      received = m;
      gotMessage = true;
    });
    await until(() => gotMessage);
    assert.equal(checks, 2);
    await assert.rejects(channel.send(received!, 'test'));
    assert.equal(sends, 1);
    let authCalls = 0;
    const denied = new WechatChannel(config, resolve, dir, (async () => {
      authCalls++;
      return Response.json({ ret: -14 });
    }) as typeof fetch);
    await assert.rejects(
      denied.start(async () => {}),
      /登录已失效/,
    );
    assert.equal(authCalls, 1);
    await denied.stop();
  } finally {
    await channel.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
