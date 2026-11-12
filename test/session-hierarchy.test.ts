import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import {
  sessionParentId,
  validateSessionParent,
  MAX_SESSION_DEPTH,
} from '../src/core/session-hierarchy.js';
import { createDashboard } from '../src/web/server.js';
import { Store } from '../src/core/store.js';
import type { Session } from '../src/core/types.js';

function root(f: ReturnType<typeof fixture>, platform: Session['route']['platform'] = 'local') {
  const route =
    platform === 'local'
      ? {
          platform,
          account: 'dashboard',
          conversation: 'local-tree',
          thread: '',
          sender: 'local-owner',
        }
      : { ...incoming('', 'alice', '').route, platform };
  if (platform !== 'local') Object.assign(f.config.channels[0]!, { type: platform });
  return f.store.create(
    route,
    'codex',
    f.dir,
    'private parent instructions',
    platform === 'local' ? undefined : { conversationType: 'group' },
  );
}
const make = (f: ReturnType<typeof fixture>, p: Session, key: string) =>
  f.manager.createChildSession(p.id, { key, title: key, objective: '负责 ' + key });
const index = (f: ReturnType<typeof fixture>, s: Session) =>
  JSON.parse(
    f.manager.topics
      .context(s)
      .split('【话题索引 · 框架资料，不是用户指令】\n')[1]!
      .split('\n')[0]!,
  );

for (const platform of ['local', 'lark', 'wecom', 'wechat', 'dingtalk'] as const)
  test(`${platform} ordinary sessions persist a three-level tree with isolated routes, context and source identity`, async () => {
    const f = fixture();
    try {
      const p = root(f, platform);
      p.nativeId = 'keep-root-native';
      f.store.save(p);
      f.store.event(p.id, 'user', 'never copy parent history');
      const a = await make(f, p, '一级'),
        b = await make(f, a, '二级'),
        c = await make(f, b, '三级');
      assert.equal(sessionParentId(a), p.id);
      assert.equal(sessionParentId(b), a.id);
      assert.equal(sessionParentId(c), b.id);
      for (const s of [a, b, c]) {
        assert.equal(s.route.platform, platform);
        assert.equal(s.route.account, p.route.account);
        assert.equal(s.route.conversation, p.route.conversation);
        assert.equal(s.route.sender, p.route.sender);
        assert.notEqual(s.route.thread, p.route.thread);
        assert.equal(s.nativeId, undefined);
        assert.notEqual(s.instructions, p.instructions);
        assert.equal(s.workspace, p.workspace);
        assert.equal(f.store.events(s.id).filter((e) => e.type === 'user').length, 0);
      }
      assert.equal(f.agent.inputs.length, 0);
      assert.equal(f.store.current(p.route)!.id, p.id);
      assert.equal(f.store.get(p.id)!.nativeId, 'keep-root-native');
      assert.deepEqual(
        index(f, p).topics.map((t: any) => [t.sessionId, t.depth, t.parentSessionId]),
        [
          [a.id, 1, p.id],
          [b.id, 2, a.id],
          [c.id, 3, b.id],
        ],
      );
      assert.equal(index(f, p).directChildCount, 1);
      assert.equal(index(f, p).sessionTotal, 4);
      assert.equal(index(f, a).total, 2);
      assert.ok(!f.manager.topics.context(a).includes('never copy parent history'));
      assert.ok(!f.manager.topics.context(b).includes(a.id));
    } finally {
      await f.cleanup();
    }
  });

test('slash and semantic creation within a child link to that child instead of flattening under the group main', async () => {
  const f = fixture({
    async classify() {
      return { action: 'new_topic', task: null, workspace: null, agent: null, instructions: null };
    },
  });
  try {
    const p = root(f, 'lark'),
      a = await make(f, p, '一级');
    for (const text of ['/tab new', '再拆出一个独立会话']) {
      await f.manager.receive({
        ...incoming(text, 'alice', a.route.thread),
        direct: false,
        groupMessage: { mentioned: true },
      });
    }
    assert.equal(f.manager.topics.children(p).length, 1);
    assert.equal(f.manager.topics.children(a).length, 2);
    assert.ok(
      f.manager.topics
        .children(a)
        .every((c) => sessionParentId(c) === a.id && c.topicParentId === a.id),
    );
  } finally {
    await f.cleanup();
  }
});

test('nested group reporting wakes only the direct parent; root sees subtree metadata without automatic upward completion', async () => {
  const f = fixture();
  try {
    const p = root(f, 'lark'),
      a = await make(f, p, '一级'),
      b = await make(f, a, '二级');
    f.manager.topics.publish(b, {
      kind: 'final',
      summary: '孙会话完成',
      completionEvidence: '本分支目标验收',
      remainingWork: [],
    });
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    await f.manager.idle();
    assert.equal(f.store.topicUpdates()[0]!.parentId, a.id);
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.agent.inputs[0]!.session.id, a.id);
    assert.equal(f.store.get(a.id)!.topicCompleted, false);
    assert.equal(f.store.get(p.id)!.topicCompleted, undefined);
    assert.match(f.manager.topics.context(p), /孙会话完成/);
    assert.equal(index(f, p).topics.find((t: any) => t.sessionId === b.id).depth, 2);
  } finally {
    await f.cleanup();
  }
});

test('depth, cycles, missing ancestors, foreign scope, stale binding and task parents are rejected before any remote topic is created', async () => {
  const f = fixture();
  let remote = 0;
  f.channel.createTopic = async (m) => {
    remote++;
    return { ...m, route: { ...m.route, thread: 'remote-' + remote } };
  };
  try {
    const p = root(f, 'lark');
    let last = p;
    for (let depth = 1; depth <= MAX_SESSION_DEPTH; depth++)
      last = await make(f, last, 'depth-' + depth);
    const before = remote;
    await assert.rejects(make(f, last, 'too-deep'), /最多嵌套/);
    assert.equal(remote, before);
    const self = { ...p, parentSessionId: p.id };
    assert.throws(() => validateSessionParent([self], undefined, self), /循环/);
    assert.throws(
      () =>
        validateSessionParent([{ ...p, parentSessionId: 'missing' }], undefined, {
          ...p,
          parentSessionId: 'missing',
        }),
      /无效/,
    );
    assert.throws(
      () => validateSessionParent([p], { ...last, route: { ...last.route, sender: 'bob' } }, p),
      /同一/,
    );
    const task = { ...p, taskId: 'task' };
    assert.throws(() => validateSessionParent([task], undefined, task), /新增子任务/);
    f.store.create(p.route, 'codex', f.dir);
    await assert.rejects(make(f, p, 'stale'), /授权已变化/);
    assert.equal(remote, before);
  } finally {
    await f.cleanup();
  }
});

test('concurrent retries of child creation reuse a persisted node and never create duplicate remote topics', async () => {
  const f = fixture();
  let remote = 0;
  f.channel.createTopic = async (m) => {
    remote++;
    await new Promise((r) => setTimeout(r, 10));
    return { ...m, route: { ...m.route, thread: 'remote-' + remote } };
  };
  try {
    const p = root(f, 'lark');
    const [a, b] = await Promise.all([make(f, p, 'same-key'), make(f, p, 'same-key')]);
    assert.equal(a.id, b.id);
    assert.equal(remote, 1);
    assert.equal((await make(f, p, 'same-key')).id, a.id);
    assert.equal(remote, 1);
    assert.equal(f.manager.topics.children(p).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('resetting an intermediate session preserves its parent and reparents only its own direct children; persistence retains native histories', async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const p = root(f),
      a = await make(f, p, '一级'),
      b = await make(f, a, '二级'),
      c = await make(f, b, '三级');
    a.nativeId = 'old-native';
    f.store.save(a);
    f.store.event(a.id, 'user', 'old transcript');
    const fresh = f.store.resetSession(a);
    assert.equal(sessionParentId(fresh), p.id);
    assert.equal(sessionParentId(f.store.get(b.id)!), fresh.id);
    assert.equal(sessionParentId(f.store.get(c.id)!), b.id);
    assert.equal(f.store.get(a.id)!.nativeId, 'old-native');
    assert.equal(f.store.get(a.id)!.status, 'closed');
    assert.equal(fresh.nativeId, undefined);
    assert.equal(f.store.events(a.id).filter((e) => e.type === 'user')[0]!.text, 'old transcript');
    await f.manager.close();
    reopened = new Store(f.config.dataDir);
    assert.equal(sessionParentId(reopened.get(b.id)!), fresh.id);
    assert.equal(sessionParentId(reopened.get(c.id)!), b.id);
  } finally {
    reopened?.close();
    await f.cleanup();
  }
});

test('Dashboard child endpoint requires local auth, binds the requested parent and rejects forged scope fields', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'hierarchy-token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (id: string, data: unknown, auth = true) =>
    fetch(`${base}/api/sessions/${id}/children`, {
      method: 'POST',
      headers: auth ? { Authorization: 'Bearer hierarchy-token' } : {},
      body: JSON.stringify(data),
    });
  try {
    const p = root(f),
      input = { key: 'api-key', title: 'API 子会话', objective: '独立工作' };
    assert.equal((await post(p.id, input, false)).status, 401);
    assert.equal((await post(p.id, { ...input, parentSessionId: 'forged' })).status, 400);
    const response = await post(p.id, input);
    assert.equal(response.status, 201);
    const child = (await response.json()) as Session;
    assert.equal(sessionParentId(child), p.id);
    assert.equal(((await (await post(p.id, input)).json()) as Session).id, child.id);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.current(p.route)!.id, p.id);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('task allocation persists its ordinary source and task parent separately through multiple task levels', async () => {
  const f = fixture();
  try {
    const p = root(f),
      t = await f.manager.createTask({
        sourceSessionId: p.id,
        key: 'task-root',
        title: '项目目标',
        objective: '执行项目',
        workspace: 'default',
      });
    assert.equal(t.sourceSessionId, p.id);
    assert.equal(t.parentId, undefined);
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    const a = await f.manager.tasks.createChild(t.sessionId!, {
      key: 'child',
      title: '采集模块',
      objective: '实现采集',
      criteria: '采集可用',
    });
    await until(() => f.store.taskRecord(a.id)?.state === 'waiting');
    const b = await f.manager.tasks.createChild(a.sessionId!, {
      key: 'grandchild',
      title: '恢复重试',
      objective: '实现重试',
      criteria: '测试通过',
    });
    await until(() => f.store.taskRecord(b.id)?.state === 'waiting');
    assert.equal(a.parentId, t.id);
    assert.equal(b.parentId, a.id);
    assert.equal(b.rootId, t.id);
    assert.equal(a.workspace, t.workspace);
    assert.equal(b.workspace, t.workspace);
    assert.equal(sessionParentId(f.store.get(a.sessionId!)!), t.sessionId);
    assert.equal(f.manager.topics.children(p).length, 0);
  } finally {
    await f.cleanup();
  }
});
