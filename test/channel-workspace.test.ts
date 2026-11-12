import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming, FakeChannel } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { createDashboard } from '../src/web/server.js';

test('channel workspace defaults cover ordinary main, init and new topics without changing other bots', async () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'bot workspace'));
  const directory = realpathSync(join(f.dir, 'bot workspace'));
  f.config.channels[0]!.defaultWorkspace = directory;
  const other = new FakeChannel();
  other.id = 'other';
  f.manager.registerChannel(other);
  f.config.channels.push({ ...f.config.channels[0]!, id: 'other', defaultWorkspace: undefined });
  try {
    const main = incoming('hello', 'alice', '');
    await f.manager.receive(main);
    await f.manager.idle();
    assert.equal(f.store.current(main.route)!.workspace, directory);
    assert.equal(f.agent.inputs[0]!.session.workspace, directory);
    const init = incoming('/tab init', 'bob', '');
    await f.manager.receive(init);
    assert.equal(f.store.current(init.route)!.workspace, directory);
    const topic = incoming('/tab new', 'alice', '');
    await f.manager.receive(topic);
    assert.equal(f.store.current({ ...topic.route, thread: topic.id })!.workspace, directory);
    const natural = incoming('新开一个话题', 'alice', '');
    await f.manager.receive(natural);
    assert.equal(f.store.current({ ...natural.route, thread: natural.id })!.workspace, directory);
    const explicit = incoming('/tab new codex default', 'alice', '');
    await f.manager.receive(explicit);
    assert.equal(
      f.store.current({ ...explicit.route, thread: explicit.id })!.workspace,
      f.config.workspaces.default,
    );
    const elsewhere = incoming('other bot', 'alice', '');
    elsewhere.route.account = 'other';
    await f.manager.receive(elsewhere);
    await f.manager.idle();
    assert.equal(f.store.current(elsewhere.route)!.workspace, f.config.workspaces.default);
  } finally {
    await f.cleanup();
  }
});

test('WeChat virtual main creation uses bot directory while explicit child directory stays independent', async () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'wx'));
  const directory = realpathSync(join(f.dir, 'wx'));
  f.config.channels[0] = {
    id: 'test-lark',
    type: 'wechat',
    allowedUsers: ['alice', 'bob'],
    botIdEnv: 'ID',
    tokenEnv: 'TOKEN',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    defaultWorkspace: directory,
  };
  const message = (text: string, sender = 'alice') => {
    const m = incoming(text, sender, '');
    m.route.platform = 'wechat';
    return m;
  };
  try {
    const child = message('/tab new codex default');
    await f.manager.receive(child);
    assert.equal(f.store.current(child.route)!.workspace, directory);
    assert.equal(
      f.store.list().find((s) => s.route.thread)!.workspace,
      f.config.workspaces.default,
    );
    const directed = message('/tab to main hello', 'bob');
    await f.manager.receive(directed);
    await f.manager.idle();
    assert.equal(f.store.current(directed.route)!.workspace, directory);
  } finally {
    await f.cleanup();
  }
});

test('config persists and validates per-bot workspace aliases and absolute paths', async () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'project'));
  const path = join(f.dir, 'config.json');
  try {
    f.config.workspaces.project = realpathSync(join(f.dir, 'project'));
    f.config.channels[0]!.defaultWorkspace = 'project';
    writeFileSync(path, JSON.stringify(f.config));
    const loaded = loadConfig(path);
    assert.equal(loaded.channels[0]!.defaultWorkspace, f.config.workspaces.project);
    assert.equal(loaded.defaultWorkspace, 'default');
    f.config.channels[0]!.defaultWorkspace = join(f.dir, 'missing');
    writeFileSync(path, JSON.stringify(f.config));
    assert.throws(() => loadConfig(path), /工作目录不存在/);
  } finally {
    await f.cleanup();
  }
});

test('authenticated workspace switching preserves native context, settings and history in the same main without running a task', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'token');
  mkdirSync(join(f.dir, 'new'));
  const workspace = realpathSync(join(f.dir, 'new'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const message = incoming('old history', 'alice', '');
    await f.manager.receive(message);
    await f.manager.idle();
    const old = f.store.current(message.route)!,
      native = old.nativeId;
    old.settings = { model: 'chosen', effort: 'high' };
    old.settingsRevision = 3;
    old.codexDeveloperInstructions = 'native + role';
    f.store.save(old);
    const other = f.store.create({ ...message.route, account: 'other' }, 'codex', f.dir);
    const url = `${base}/api/sessions/${old.id}/replace-workspace`;
    const post = (authorized: boolean, value: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorized ? { Authorization: 'Bearer token' } : {}),
        },
        body: JSON.stringify({ workspace: value }),
      });
    assert.equal((await post(false, workspace)).status, 401);
    assert.equal((await post(true, join(f.dir, 'missing'))).status, 400);
    assert.equal(f.store.current(message.route)!.id, old.id);
    const response = await post(true, workspace);
    assert.equal(response.status, 201);
    const fresh = await response.json();
    assert.equal(fresh.id, old.id);
    assert.equal(fresh.nativeId, native);
    assert.equal(fresh.workspace, workspace);
    assert.equal(fresh.status, 'idle');
    assert.equal(fresh.agent, old.agent);
    assert.equal(f.store.current(message.route)!.id, fresh.id);
    assert.equal(f.store.get(old.id)!.nativeId, native);
    assert.equal(f.store.get(old.id)!.workspace, workspace);
    assert.equal(f.store.get(old.id)!.status, 'idle');
    assert.deepEqual(fresh.settings, old.settings);
    assert.equal(fresh.settingsRevision, 3);
    assert.equal(fresh.codexDeveloperInstructions, old.codexDeveloperInstructions);
    assert.ok(f.store.events(old.id).some((e) => e.type === 'user' && e.text === 'old history'));
    assert.deepEqual(f.store.get(other.id), other);
    assert.equal(f.agent.inputs.length, 1);
    const eventCount = f.store.events(old.id).length;
    assert.equal((await post(true, workspace)).status, 201);
    assert.equal(f.store.list().length, 2);
    assert.equal(f.store.events(old.id).length, eventCount);
    await f.manager.receive(incoming('new task', 'alice', ''));
    await f.manager.idle();
    assert.equal(f.agent.inputs[1]!.session.id, fresh.id);
    assert.equal(f.agent.inputs[1]!.session.workspace, workspace);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('workspace replacement refuses active and detached sessions and allows an idle topic', async () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'new'));
  const path = realpathSync(join(f.dir, 'new'));
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    for (const status of ['running', 'waiting', 'detached'] as const) {
      main.status = status;
      f.store.save(main);
      assert.throws(() => f.manager.replaceMainWorkspace(main.id, path), /等待主会话/);
      assert.equal(f.store.current(main.route)!.id, main.id);
    }
    const child = f.store.create(incoming('').route, 'codex', f.dir);
    assert.equal(f.manager.replaceMainWorkspace(child.id, path).workspace, path);
    assert.equal(f.store.list().length, 2);
  } finally {
    await f.cleanup();
  }
});
