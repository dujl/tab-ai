import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { fixture, incoming } from './helpers.js';
import { taskTitle } from '../src/core/session-title.js';

test('legacy names use the first task without changing native IDs, status, timestamps, bindings or manual names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-title-'));
  try {
    let store = new Store(dir);
    const a = store.create(incoming('').route, 'opencode', dir);
    a.nativeId = 'native-original';
    a.status = 'closed';
    store.save(a);
    store.event(a.id, 'user', '进行文学创作');
    store.event(a.id, 'user', '改一下结尾');
    const b = store.create({ ...a.route, thread: 'b' }, 'codex', dir);
    b.title = '手工名称';
    store.save(b);
    store.event(b.id, 'user', '忽略这个新名字');
    const before = store.get(a.id)!;
    store.close();
    store = new Store(dir);
    assert.deepEqual(store.get(a.id), { ...before, title: '进行文学创作' });
    assert.equal(store.current(a.route)!.id, a.id);
    assert.equal(store.get(b.id)!.title, '手工名称');
    assert.equal(store.task(a.id), '改一下结尾');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manager-DM session list includes names/recent tasks, and local rename never reaches agent', async () => {
  const f = fixture();
  try {
    await f.manager.receive(incoming('主聊天任务', 'alice', ''));
    await f.manager.idle();
    await f.manager.receive(incoming('整理示例资料', 'alice', 'fixture-topic'));
    await f.manager.idle();
    await f.manager.receive(incoming('核对示例目录', 'alice', 'fixture-topic'));
    await f.manager.idle();
    await f.manager.receive(incoming('秘密任务', 'bob', 'bob-topic'));
    await f.manager.idle();
    const other = f.store.create(
      { ...incoming('').route, conversation: 'other-chat' },
      'codex',
      f.dir,
    );
    other.title = '其他聊天秘密';
    f.store.save(other);
    const runs = f.agent.inputs.length;
    f.config.channels[0]!.manager = true;
    await f.manager.receive({ ...incoming('/tab list', 'alice', ''), direct: true });
    const list = f.channel.sent.at(-1)!.text;
    assert.match(list, /主会话 · 主聊天任务/);
    assert.match(list, /整理示例资料/);
    assert.match(list, /最近任务：核对示例目录/);
    assert.match(list, /Codex · 空闲/);
    assert.match(list, /秘密/);
    assert.equal(f.agent.inputs.length, runs);
    // List queries use management-center scope even when opened from a topic.
    await f.manager.receive({ ...incoming('/tab list', 'alice', 'fixture-topic'), direct: true });
    assert.match(f.channel.sent.at(-1)!.text, /主聊天任务/);
    assert.match(f.channel.sent.at(-1)!.text, /秘密/);
    await f.manager.receive(incoming('/tab close', 'alice', 'fixture-topic'));
    const before = f.store.current(incoming('', 'alice', 'fixture-topic').route)!;
    await f.manager.receive(incoming('/tab rename 示例资料整理', 'alice', 'fixture-topic'));
    const renamed = f.store.get(before.id)!;
    assert.equal(renamed.title, '示例资料整理');
    assert.equal(renamed.status, 'closed');
    assert.equal(renamed.nativeId, before.nativeId);
    assert.equal(f.agent.inputs.length, runs);
    await f.manager.receive(incoming('/tab rename', 'alice', 'fixture-topic'));
    assert.equal(f.store.get(before.id)!.title, '示例资料整理');
    assert.equal(taskTitle('  a\n\tb  '), 'a b');
    assert.equal([...taskTitle('😀'.repeat(45))!].length, 41);
  } finally {
    await f.cleanup();
  }
});

test('new topic entry uses the extracted task; rename updates only its owned root and never invokes the agent', async () => {
  const f = fixture({
    async classify() {
      return {
        action: 'new_topic',
        workspace: null,
        agent: null,
        instructions: null,
        task: '研究示例应用的使用方式',
      };
    },
  });
  const roots: { title?: string; root: string }[] = [],
    renames: { id: string; root?: string; title: string }[] = [];
  f.channel.createTopic = async (m, title?: string) => {
    const root = 'om_owned_topic';
    roots.push({ title, root });
    return { ...m, ownedTopicRoot: root, replyTo: root, route: { ...m.route, thread: root } };
  };
  Object.assign(f.channel, {
    async renameTopic(s: any, title: string) {
      renames.push({ id: s.id, root: s.ownedTopicRoot, title });
    },
  });
  try {
    await f.manager.receive(incoming('新建一个会话，研究示例应用的使用方式', 'alice', ''));
    await f.manager.idle();
    assert.equal(roots[0]!.title, '研究示例应用的使用方式');
    const s = f.store.current(incoming('', 'alice', 'om_owned_topic').route)!;
    assert.equal(s.ownedTopicRoot, 'om_owned_topic');
    const native = s.nativeId,
      runs = f.agent.inputs.length;
    await f.manager.receive(incoming('/tab rename 社交媒体内容生产', 'alice', s.route.thread));
    assert.equal(renames.at(-1)!.title, '社交媒体内容生产');
    assert.equal(renames.at(-1)!.root, s.route.thread);
    assert.equal(f.store.get(s.id)!.nativeId, native);
    assert.equal(f.agent.inputs.length, runs);
  } finally {
    await f.cleanup();
  }
});

test('empty new topic adopts the first real task as its entry title', async () => {
  const f = fixture(),
    updates: string[] = [];
  f.channel.createTopic = async (m) => ({
    ...m,
    ownedTopicRoot: 'om_owned_empty',
    replyTo: 'om_owned_empty',
    route: { ...m.route, thread: 'om_owned_empty' },
  });
  Object.assign(f.channel, {
    async renameTopic(_s: any, title: string) {
      updates.push(title);
    },
  });
  try {
    await f.manager.receive(incoming('/tab new', 'alice', ''));
    await f.manager.receive(incoming('分析宏观经济趋势', 'alice', 'om_owned_empty'));
    await f.manager.idle();
    assert.deepEqual(updates, ['分析宏观经济趋势']);
  } finally {
    await f.cleanup();
  }
});
