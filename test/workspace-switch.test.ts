import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { normalizeWecom } from '../src/channels/normalize.js';
import { validateTopicDecision, type TopicDecision } from '../src/core/topic-router.js';
import type { Incoming, Platform } from '../src/core/types.js';
import { sameWorkspace } from '../src/core/session-workspace.js';
const decision = (workspace: string): TopicDecision => ({
  action: 'switch_workspace',
  workspace,
  agent: null,
  task: null,
  instructions: null,
});
const message = (
  text: string,
  platform: Platform = 'wecom',
  conversation = 'wr_group',
): Incoming => ({
  id: crypto.randomUUID(),
  text,
  route: { platform, account: 'test-lark', conversation, thread: '', sender: 'alice' },
});
const configure = (f: ReturnType<typeof fixture>, platform: Platform) => {
  if (platform === 'wecom')
    f.config.channels[0] = {
      id: 'test-lark',
      type: 'wecom',
      botIdEnv: 'BOT',
      secretEnv: 'SECRET',
      allowedUsers: ['alice'],
    };
  if (platform === 'wechat')
    f.config.channels[0] = {
      id: 'test-lark',
      type: 'wechat',
      botIdEnv: 'BOT',
      tokenEnv: 'TOKEN',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      allowedUsers: ['alice'],
    };
};

test('natural workspace switch targets the originating WeCom group and never the same bot/user DM', async () => {
  let path = '';
  const f = fixture({
    async classify(input) {
      return input.text.includes('切换至')
        ? decision(path)
        : { action: 'continue', workspace: null, agent: null, instructions: null, task: null };
    },
  });
  configure(f, 'wecom');
  mkdirSync(join(f.dir, '项目 空格'));
  path = realpathSync(join(f.dir, '项目 空格'));
  try {
    const group = message(`@bot1 把工作目录切换至这个目录 ${path}`);
    const old = f.store.create(group.route, 'claude', f.dir, '保留角色');
    old.nativeId = 'old-group-native';
    f.store.save(old);
    const dm = f.store.create(message('', 'wecom', 'alice').route, 'codex', f.dir);
    dm.nativeId = 'dm-native';
    dm.status = 'closed';
    f.store.save(dm);
    const snapshot = structuredClone(dm);
    await f.manager.receive(group);
    await f.manager.idle();
    const fresh = f.store.current(group.route)!;
    assert.equal(fresh.id, old.id);
    assert.equal(fresh.workspace, path);
    assert.deepEqual(fresh.route, group.route);
    assert.equal(fresh.nativeId, 'old-group-native');
    assert.equal(fresh.agent, 'claude');
    assert.equal(fresh.instructions, '保留角色');
    assert.equal(f.store.list().length, 2);
    assert.equal(f.store.get(old.id)!.status, 'idle');
    assert.equal(f.store.get(old.id)!.nativeId, 'old-group-native');
    assert.deepEqual(f.store.get(dm.id), snapshot);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.channel.sent.length, 1);
    assert.deepEqual(f.channel.sent[0]!.message.route, group.route);
    assert.match(f.channel.sent[0]!.text, /已切换当前聊天/);
    assert.doesNotMatch(f.channel.sent[0]!.text, /会话已关闭/);
    assert.equal(f.channel.closedNotices.length, 0);
    await f.manager.receive(message('新的任务'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.session.id, fresh.id);
    assert.equal(f.agent.inputs[0]!.session.workspace, path);
  } finally {
    await f.cleanup();
  }
});
test('explicit workspace command bypasses the model classifier, supports quoted paths and leaves other groups untouched', async () => {
  const f = fixture({
    async classify() {
      throw Error('must not classify');
    },
  });
  configure(f, 'wechat');
  mkdirSync(join(f.dir, 'new space'));
  const path = realpathSync(join(f.dir, 'new space'));
  try {
    const m = message(`/tab workspace "${path}"`, 'wechat', 'group-a'),
      old = f.store.create(m.route, 'codex', f.dir);
    const other = f.store.create(message('', 'wechat', 'group-b').route, 'codex', f.dir),
      snapshot = structuredClone(other);
    await f.manager.receive(m);
    await f.manager.idle();
    assert.equal(f.store.current(m.route)!.workspace, path);
    assert.deepEqual(f.store.get(other.id), snapshot);
    assert.equal(f.store.get(old.id)!.status, 'idle');
    assert.equal(f.agent.inputs.length, 0);
    assert.ok(f.channel.sent.every((x) => x.message.route.conversation === 'group-a'));
    const count = f.store.list().length;
    await f.manager.receive(message('/tab workspace', 'wechat', 'group-a'));
    assert.equal(f.store.list().length, count);
    assert.match(f.channel.sent.at(-1)!.text, new RegExp(path));
  } finally {
    await f.cleanup();
  }
});
test('invalid directory, busy session, task session and unauthorized user do not change bindings or notify another chat', async () => {
  const f = fixture();
  configure(f, 'wecom');
  mkdirSync(join(f.dir, 'new'));
  const path = realpathSync(join(f.dir, 'new'));
  try {
    const route = message('').route,
      old = f.store.create(route, 'codex', f.dir);
    await f.manager.receive(message('/tab workspace ' + join(f.dir, 'missing')));
    assert.match(f.channel.sent.at(-1)!.text, /工作目录不存在/);
    assert.equal(f.store.current(route)!.id, old.id);
    for (const status of ['running', 'waiting', 'detached'] as const) {
      old.status = status;
      f.store.save(old);
      await f.manager.receive(message('/tab workspace ' + path));
      assert.equal(f.store.current(route)!.id, old.id);
      assert.match(f.channel.sent.at(-1)!.text, /等待主会话/);
    }
    old.status = 'idle';
    old.taskId = 'task';
    f.store.save(old);
    await f.manager.receive(message('/tab workspace ' + path));
    assert.match(f.channel.sent.at(-1)!.text, /任务树会话记录/);
    assert.equal(f.store.current(route)!.id, old.id);
    const count = f.channel.sent.length;
    await f.manager.receive({
      ...message('/tab workspace ' + path),
      route: { ...route, sender: 'outsider' },
    });
    assert.equal(f.channel.sent.length, count);
    assert.equal(f.store.list().length, 1);
    assert.ok(f.channel.sent.every((x) => x.message.route.conversation === 'wr_group'));
  } finally {
    await f.cleanup();
  }
});
test('switching the same directory does not archive or reopen a closed session, and first-use switch creates only the current chat', async () => {
  const f = fixture();
  configure(f, 'wecom');
  try {
    const m = message('/tab workspace ' + f.dir),
      s = f.store.create(m.route, 'codex', f.dir);
    s.status = 'closed';
    f.store.save(s);
    await f.manager.receive(m);
    assert.equal(f.store.current(m.route)!.id, s.id);
    assert.equal(f.store.get(s.id)!.status, 'closed');
    assert.equal(f.store.list().length, 1);
    assert.match(f.channel.sent.at(-1)!.text, /仍为关闭状态/);
    await f.manager.receive(message('/tab workspace ' + f.dir, 'wecom', 'wr_new'));
    assert.equal(f.store.list().length, 2);
    assert.equal(f.store.current(message('', 'wecom', 'wr_new').route)!.workspace, f.dir);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('workspace switching is grounded in current text and cannot smuggle other session settings', () => {
  const input = { text: '请切换工作目录到 /tmp/new', recentUserMessages: ['/tmp/old'] };
  assert.equal(validateTopicDecision(decision('/tmp/new'), input).workspace, '/tmp/new');
  for (const value of [
    decision('/tmp/old'),
    decision('invented'),
    { ...decision('/tmp/new'), workspace: null },
    { ...decision('/tmp/new'), agent: 'codex' },
    { ...decision('/tmp/new'), instructions: 'admin' },
    { ...decision('/tmp/new'), task: 'execute' },
  ])
    assert.throws(() => validateTopicDecision(value, input));
});
test('WeCom group normalization preserves the chat ID for a workspace request instead of substituting the sender', () => {
  const raw = {
    msgid: 'msg',
    msgtype: 'text',
    chattype: 'group',
    chatid: 'wr_group',
    from: { userid: 'alice' },
    text: { content: '@bot1 把工作目录切到 /tmp/new' },
  };
  const m = normalizeWecom(raw, 'test-lark')!;
  assert.equal(m.route.conversation, 'wr_group');
  assert.equal(m.route.sender, 'alice');
  assert.equal(m.direct, false);
});
test('binding changes during classification cancel the switch instead of archiving a different session', async () => {
  let release!: (v: TopicDecision) => void,
    path = '';
  const f = fixture({
    classify() {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  configure(f, 'wecom');
  mkdirSync(join(f.dir, 'new'));
  path = realpathSync(join(f.dir, 'new'));
  try {
    const m = message('请切换至 ' + path),
      old = f.store.create(m.route, 'codex', f.dir),
      pending = f.manager.receive(m);
    while (!release) await new Promise((r) => setTimeout(r, 1));
    const fresh = f.store.create(m.route, 'codex', f.dir);
    release(decision(path));
    await pending;
    assert.equal(f.store.current(m.route)!.id, fresh.id);
    assert.equal(f.store.get(fresh.id)!.workspace, f.dir);
    assert.equal(f.store.get(old.id)!.status, 'idle');
    assert.equal(f.agent.inputs.length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /暂时无法判断/);
  } finally {
    await f.cleanup();
  }
});

test('unverified backends with native context reject a directory switch without changing any state', async () => {
  const f = fixture();
  configure(f, 'wecom');
  mkdirSync(join(f.dir, 'new'));
  const path = realpathSync(join(f.dir, 'new'));
  try {
    f.agent.supportsWorkspaceSwitch = false;
    const m = message('/tab workspace ' + path),
      s = f.store.create(m.route, 'opencode', f.dir);
    s.nativeId = 'ses-preserved';
    f.store.save(s);
    const before = structuredClone(s);
    await f.manager.receive(m);
    assert.deepEqual(f.store.get(s.id), before);
    assert.equal(f.store.current(m.route)!.id, s.id);
    assert.equal(f.store.list().length, 1);
    assert.match(f.channel.sent.at(-1)!.text, /不支持保留原生上下文/);
    assert.equal(f.agent.inputs.length, 0);
    delete s.nativeId;
    f.store.save(s);
    await f.manager.receive(message('/tab workspace ' + path));
    assert.equal(f.store.get(s.id)!.workspace, path);
    assert.equal(f.store.list().length, 1);
  } finally {
    await f.cleanup();
  }
});
test('closed main switches directory without reopening or discarding context and records both directories', async () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'new'));
  const path = realpathSync(join(f.dir, 'new'));
  try {
    const s = f.store.create(message('').route, 'codex', f.dir, 'role');
    s.nativeId = 'keep';
    s.status = 'closed';
    s.settings = { model: 'chosen' };
    f.store.save(s);
    const updated = f.manager.replaceMainWorkspace(s.id, path);
    assert.equal(updated.id, s.id);
    assert.equal(updated.status, 'closed');
    assert.equal(updated.nativeId, 'keep');
    assert.deepEqual(updated.settings, s.settings);
    assert.equal(f.store.list().length, 1);
    const event = f.store.events(s.id).at(-1)!;
    assert.ok(event.text.includes(f.dir) && event.text.includes(path));
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('native cwd verification recognizes legacy workspace symlinks while rejecting different directories', async () => {
  const f = fixture();
  try {
    const alias = join(f.dir, 'legacy-name'),
      other = join(f.dir, 'other');
    symlinkSync(f.dir, alias, 'dir');
    mkdirSync(other);
    assert.equal(sameWorkspace(alias, f.dir), true);
    assert.equal(sameWorkspace(other, f.dir), false);
    assert.equal(sameWorkspace(join(f.dir, 'missing'), f.dir), false);
  } finally {
    await f.cleanup();
  }
});
