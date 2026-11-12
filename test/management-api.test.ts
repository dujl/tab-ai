import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SetupService } from '../src/setup/service.js';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { Manager } from '../src/core/manager.js';
import {
  executeManagementApi,
  recognizeManagement,
  type ManagementPolicy,
  type ManagementIntent,
} from '../src/core/management-api.js';
import {
  validateTopicDecision,
  type TopicRouter,
  type TopicDecision,
} from '../src/core/topic-router.js';
import { createDashboard } from '../src/web/server.js';

const group = (text: string, mentioned = true, sender = 'alice') => ({
  ...incoming(text, sender, ''),
  groupMessage: { mentioned },
  route: { ...incoming('', sender, '').route, conversation: 'oc_group' },
});
const decision = (intent: ManagementIntent): TopicDecision => ({
  action: 'management',
  management: intent,
  task: null,
  agent: null,
  instructions: null,
  workspace: null,
});
const setting = (mode: 'mention' | 'context' | 'auto'): ManagementIntent => ({
  intent: 'group_mode.set',
  parameters: { mode },
});
function setup(router?: TopicRouter, policy?: ManagementPolicy, persist?: () => void) {
  const f = fixture();
  let writes = 0;
  const manager = new Manager(
    f.config,
    f.store,
    { codex: f.agent, claude: f.agent, opencode: f.agent },
    new Map([[f.channel.id, f.channel]]),
    router,
    undefined,
    () => {
      persist?.();
      writes++;
    },
    policy,
  );
  return {
    ...f,
    manager,
    writes: () => writes,
    async cleanup() {
      await manager.close();
      await f.cleanup();
    },
  };
}

test('fast paths match complete requests, never quoted examples, cancellations or compounds', () => {
  assert.deepEqual(recognizeManagement('请把本群改成 context。'), setting('context'));
  assert.deepEqual(recognizeManagement('本群设置为 AUTO'), setting('auto'));
  assert.equal(recognizeManagement('这个群现在是什么模式？')?.intent, 'group_mode.get');
  assert.equal(recognizeManagement('不要自动回复')?.intent, 'group_mode.clarify');
  for (const text of [
    '例如“把本群改成 auto”',
    '如何把本群改成 auto',
    '把本群改成 auto，不用了',
    '把本群改成 auto 然后删除文件',
    'toString',
    'constructor',
  ])
    assert.equal(recognizeManagement(text), undefined);
});

test('schema rejects model targets, privileges, missing mode and task/management mixtures', () => {
  const input = {
    text: '本群自动响应',
    recentUserMessages: [],
    groupControl: { mode: 'mention' as const },
  };
  assert.equal(
    validateTopicDecision(decision(setting('auto')), input).management?.parameters.mode,
    'auto',
  );
  const bad = [
    decision({ intent: 'group_mode.get', parameters: { mode: 'auto' } }),
    decision({ intent: 'group_mode.set', parameters: { mode: null } }),
    { ...decision(setting('auto')), task: '本群自动响应' },
    { ...decision(setting('auto')), action: 'continue' },
    {
      ...decision(setting('auto')),
      management: { ...setting('auto'), parameters: { mode: 'auto', chatId: 'oc_other' } },
    },
  ];
  for (const value of bad) assert.throws(() => validateTopicDecision(value, input));
  assert.throws(() =>
    validateTopicDecision(decision(setting('auto')), { text: input.text, recentUserMessages: [] }),
  );
});

test('slash and natural rules share policy/API; closed main and native ID are untouched', async () => {
  const seen: string[] = [];
  let classifications = 0;
  const f = setup(
    {
      async classify() {
        classifications++;
        throw new Error('should not run');
      },
    },
    (actor, req) => {
      seen.push(`${actor.kind}:${req.intent}`);
    },
  );
  try {
    const main = f.store.create(group('').route, 'codex', f.dir);
    main.nativeId = 'existing-native';
    main.status = 'closed';
    f.store.save(main);
    await f.manager.receive(group('请把本群改成 context。'));
    await f.manager.receive(group('/tab group-mode auto'));
    await f.manager.receive(group('这个群现在是什么模式？'));
    assert.equal(f.writes(), 2);
    assert.equal(classifications, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.deepEqual(seen, ['chat:group_mode.set', 'chat:group_mode.set', 'chat:group_mode.get']);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.get(main.id)?.status, 'closed');
    assert.equal(f.store.get(main.id)?.nativeId, 'existing-native');
    assert.equal(f.store.events(main.id).filter((e) => e.type === 'user').length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /tab-ai 系统/);
    assert.match(f.channel.sent.at(-1)!.text, /auto/);
  } finally {
    await f.cleanup();
  }
});

test('semantic intent binds only trusted current target and does not leak management into task context', async () => {
  const seen: unknown[] = [];
  const f = setup({
    async classify(input) {
      seen.push(input);
      return input.text === '从现在起，请留意大家的聊天，叫到你再作答'
        ? decision(setting('context'))
        : input.text === '此处的接收策略如何配置着'
          ? decision({ intent: 'group_mode.get', parameters: { mode: null } })
          : { action: 'continue', task: null, agent: null, workspace: null, instructions: null };
    },
  });
  try {
    await f.manager.receive(group('从现在起，请留意大家的聊天，叫到你再作答'));
    await f.manager.receive(group('此处的接收策略如何配置着'));
    assert.equal(f.store.list().length, 0);
    assert.equal(f.writes(), 1);
    assert.equal(f.agent.inputs.length, 0);
    await f.manager.receive(group('写一篇文章'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]?.text, '写一篇文章');
    assert.equal((seen[0] as any).groupControl.mode, 'mention');
    assert.equal((seen[0] as any).groupControl.botId, undefined);
  } finally {
    await f.cleanup();
  }
});

test('ambiguous management clarifies without mutation or task creation; auto requires mention to change naturally', async () => {
  const f = setup();
  try {
    await f.manager.receive(group('不要自动回复'));
    assert.equal(f.writes(), 0);
    assert.match(f.channel.sent.at(-1)!.text, /尚未修改/);
    await f.manager.receive(group('本群改成 auto'));
    await f.manager.receive(group('本群改成 context', false));
    assert.equal(f.writes(), 1);
    assert.match(f.channel.sent.at(-1)!.text, /请 @BOT/);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.agent.inputs.length, 0);
    await f.manager.receive(group('本群改成 context', true, 'outsider'));
    assert.equal(f.writes(), 1);
  } finally {
    await f.cleanup();
  }
});

test('policy denies slash, natural and both HTTP entry points equally; unknown operations and forged actors rejected', async () => {
  let deny = false;
  const calls: string[] = [];
  const f = setup(undefined, (_actor, req) => {
    calls.push(req.intent);
    if (deny) throw new Error('组织策略不允许修改');
  });
  const file = join(f.dir, 'config.json');
  writeFileSync(file, JSON.stringify(f.config));
  const storage = new SetupService(file);
  const server = createDashboard(f.manager, 'secret', storage);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = {
    intent: 'group_mode.set',
    parameters: { botId: 'test-lark', chatId: 'oc_group', mode: 'auto' },
  };
  const send = (data: unknown, auth = true) =>
    fetch(base + '/api/management', {
      method: 'POST',
      headers: auth ? { Authorization: 'Bearer secret' } : {},
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await send(request, false)).status, 401);
    assert.equal((await send(request)).status, 200);
    assert.equal(f.writes(), 0);
    const result = (await (
      await send({
        intent: 'group_mode.get',
        parameters: { botId: 'test-lark', chatId: 'oc_group' },
      })
    ).json()) as any;
    assert.equal(result.mode, 'auto');
    assert.equal(result.changed, false);
    for (const invalid of [
      { ...request, actor: { kind: 'local' } },
      { ...request, intent: 'shell.exec' },
      { ...request, parameters: { ...request.parameters, manager: true } },
    ])
      assert.equal((await send(invalid)).status, 400);
    deny = true;
    await f.manager.receive(group('/tab group-mode mention'));
    assert.match(f.channel.sent.at(-1)!.text, /组织策略/);
    await f.manager.receive(group('本群改成 context'));
    assert.match(f.channel.sent.at(-1)!.text, /组织策略/);
    assert.equal((await send(request)).status, 400);
    assert.equal(f.writes(), 0);
    const legacy = await fetch(base + '/api/channels/test-lark/group-mode', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({ chatId: 'oc_group', mode: 'mention' }),
    });
    assert.equal(legacy.status, 400);
    assert.match(await legacy.text(), /组织策略/);
    await assert.rejects(
      f.manager.executeManagement(request, {
        kind: 'chat',
        source: 'slash',
        message: { ...group(''), route: { ...group('').route, conversation: 'oc_foreign' } },
      }),
      /当前 BOT 的当前群/,
    );
    assert.ok(calls.length >= 5);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await storage.close();
    await f.cleanup();
  }
});

test('policy is rechecked against current authorization after asynchronous decisions', async () => {
  let release!: () => void;
  const f = setup(
    undefined,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  try {
    const request = f.manager.receive(group('本群改成 auto'));
    await until(() => !!release);
    f.config.channels[0]!.allowedUsers = ['bob'];
    release();
    await request;
    assert.equal(f.writes(), 0);
    assert.match(f.channel.sent.at(-1)!.text, /无权/);
  } finally {
    release?.();
    await f.cleanup();
  }
});

test('write failures propagate accurately; malformed classifier results and consultation do not mutate', async () => {
  const f = setup(
    {
      async classify(input) {
        return input.text === '意图格式错误'
          ? decision({ intent: 'group_mode.set', parameters: { mode: null } })
          : { action: 'continue', task: null, agent: null, workspace: null, instructions: null };
      },
    },
    undefined,
    () => {
      throw new Error('保存失败');
    },
  );
  try {
    await f.manager.receive(group('本群改成 auto'));
    assert.match(f.channel.sent.at(-1)!.text, /保存失败/);
    assert.doesNotMatch(f.channel.sent.at(-1)!.text, /已保存/);
    await f.manager.receive(group('意图格式错误'));
    assert.match(f.channel.sent.at(-1)!.text, /暂时无法判断/);
    assert.equal(f.store.list().length, 0);
    const text = '如何让这个群自动回复？';
    await f.manager.receive(group(text));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]?.text, text);
    assert.equal(f.writes(), 0);
  } finally {
    await f.cleanup();
  }
});

test('standalone dispatcher invokes policy before mutation and returns actual persisted result', async () => {
  const events: string[] = [];
  const result = await executeManagementApi(
    { intent: 'group_mode.set', parameters: { botId: 'bot', chatId: 'oc_group', mode: 'context' } },
    { kind: 'local' },
    {
      authorize: () => {
        events.push('authorize');
      },
      get: () => 'mention',
      set: () => {
        events.push('set');
      },
    },
    () => {
      events.push('policy');
    },
  );
  assert.deepEqual(events, ['authorize', 'policy', 'authorize', 'set']);
  assert.equal(result.previousMode, 'mention');
  assert.equal(result.mode, 'context');
});

test('in-flight management is not exposed as group reference to another concurrently active sender', async () => {
  let release!: (value: TopicDecision) => void;
  const f = setup({
    async classify(input) {
      if (input.text === '这是一个尚待分类的管理请求')
        return new Promise<TopicDecision>((resolve) => {
          release = resolve;
        });
      return { action: 'continue', task: null, agent: null, workspace: null, instructions: null };
    },
  });
  try {
    const channel = f.config.channels[0]!;
    if (channel.type === 'lark') channel.groupModes = { oc_group: 'context' };
    const pending = f.manager.receive(group('这是一个尚待分类的管理请求'));
    await until(() => !!release);
    await f.manager.receive(group('写一首诗', true, 'bob'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]?.text, '写一首诗');
    release(decision({ intent: 'group_mode.get', parameters: { mode: null } }));
    await pending;
    assert.equal(f.store.list().length, 1);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    release?.(decision({ intent: 'group_mode.get', parameters: { mode: null } }));
    await f.cleanup();
  }
});
