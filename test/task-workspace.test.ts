import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fixture, incoming, until } from './helpers.js';
import { taskCatalog } from '../src/core/task-catalog.js';
import { createDashboard } from '../src/web/server.js';
const structure = await import(
  new URL('../src/web/public/task-structure.js', import.meta.url).href
);
const { buildSessionTree } = await import(
  new URL('../src/web/public/dashboard.js', import.meta.url).href
);

test('unified catalog is a read-only task view of existing histories, preserving unknown goals and unconfirmed reports', async () => {
  const f = fixture();
  try {
    const root = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    root.nativeId = 'keep-root';
    f.store.save(root);
    const a = f.store.create({ ...root.route, thread: 'a' }, 'codex', f.dir);
    a.parentSessionId = root.id;
    a.topicObjective = '目标A';
    a.topicReport = {
      revision: 1,
      at: 1,
      result: {
        kind: 'progress',
        summary: '历史阶段',
        artifacts: [],
        issues: [],
        completionEvidence: '',
      },
    };
    f.store.save(a);
    const foreign = f.store.create(
      { ...root.route, sender: 'bob', thread: 'foreign' },
      'codex',
      f.dir,
    );
    foreign.parentSessionId = root.id;
    f.store.save(foreign);
    const before = f.store.list(),
      jobs = f.store.taskJobs();
    const catalog = f.manager.taskCatalog();
    assert.equal(catalog.length, 3);
    assert.equal(catalog.find((n) => n.id === root.id)!.goalState, 'needs_goal');
    assert.equal(catalog.find((n) => n.id === a.id)!.goalState, 'active');
    assert.equal(catalog.find((n) => n.id === a.id)!.parentKey, `session:${root.id}`);
    assert.equal(catalog.find((n) => n.id === foreign.id)!.parentKey, undefined);
    assert.deepEqual(f.store.list(), before);
    assert.deepEqual(f.store.taskJobs(), jobs);
    assert.equal(f.agent.inputs.length, 0);
    const task = await f.manager.createDashboardTask({ key: 'draft', title: '目标待明确' });
    assert.equal(task.goalState, 'needs_goal');
    assert.equal(f.store.taskJobs().length, 0);
    f.manager.tasks.cancel(task.taskId!);
    assert.equal(f.manager.taskCatalog().find((n) => n.key === task.key)!.goalState, 'cancelled');
  } finally {
    await f.cleanup();
  }
});

test('unified creation starts with no empty source session, persists drafts and consumes the first user objective once', async () => {
  const f = fixture();
  try {
    const a = await f.manager.createDashboardTask({ key: 'fresh', title: '新任务' });
    assert.ok(a.taskId);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.taskJobs().length, 0);
    const again = await f.manager.createDashboardTask({ key: 'fresh', title: '新任务' });
    assert.equal(again.id, a.id);
    assert.equal(f.store.list().length, 1);
    f.manager.submit(a.sessionId!, '研究数据导入');
    await until(() => f.agent.inputs.length === 1);
    await f.manager.idle();
    assert.equal(f.store.taskRecord(a.taskId!)!.objective, '研究数据导入');
    assert.equal(f.store.taskRecord(a.taskId!)!.deferred, undefined);
    assert.match(f.agent.inputs[0]!.text, /研究数据导入/);
    assert.equal(f.manager.taskCatalog().find((n) => n.id === a.id)!.goalState, 'waiting');
  } finally {
    await f.cleanup();
  }
});

test('one child creation API binds both historical and scheduled task parents without changing their contexts', async () => {
  const f = fixture();
  try {
    const p = f.store.create(
      {
        platform: 'local',
        account: 'dashboard',
        conversation: 'legacy',
        thread: '',
        sender: 'local-owner',
      },
      'codex',
      f.dir,
    );
    p.nativeId = 'old';
    f.store.save(p);
    const child = await f.manager.createDashboardTask(
      { key: 'child', title: '子任务', objective: '独立目标', criteria: '验收标准' },
      `session:${p.id}`,
    );
    assert.equal(child.parentKey, `session:${p.id}`);
    assert.equal(child.criteria, '验收标准');
    assert.equal(f.store.get(p.id)!.nativeId, 'old');
    assert.equal(f.agent.inputs.length, 0);
    const root = await f.manager.createDashboardTask({
      key: 'scheduled',
      title: '有调度能力的任务',
      objective: '完整目标',
    });
    const sub = await f.manager.createDashboardTask(
      { key: 'sub', title: '下级', objective: '子目标' },
      root.key,
    );
    assert.equal(sub.parentKey, root.key);
    assert.equal(sub.workspace, root.workspace);
    assert.equal(f.store.taskJobs().length, 0);
    assert.equal(
      (
        await f.manager.createDashboardTask(
          { key: 'sub', title: '下级', objective: '子目标' },
          root.key,
        )
      ).id,
      sub.id,
    );
    await assert.rejects(
      f.manager.createDashboardTask({ key: 'invalid', title: '任务', start: true }),
      /填写任务目标/,
    );
    await assert.rejects(
      f.manager.createDashboardTask(
        { key: 'foreign', title: '任务', sourceSessionId: p.id },
        root.key,
      ),
      /不能更换/,
    );
  } finally {
    await f.cleanup();
  }
});

test('immediate execution is explicit and capacity queues the canonical child without replaying history', async () => {
  const f = fixture();
  try {
    const p = f.store.create(
      {
        platform: 'local',
        account: 'dashboard',
        conversation: 'legacy',
        thread: '',
        sender: 'local-owner',
      },
      'codex',
      f.dir,
    );
    p.nativeId = 'legacy-native';
    f.store.save(p);
    f.config.maxConcurrentRuns = 0;
    const input = { key: 'start', title: '立即执行', objective: '保留初始要求', start: true };
    const node = await f.manager.createDashboardTask(input, `session:${p.id}`);
    const child = f.store.get(node.sessionId!)!;
    assert.ok(child.taskId);
    assert.equal(f.store.taskRecord(child.taskId!)!.parentId, p.id);
    assert.equal(f.store.get(p.id)!.nativeId, 'legacy-native');
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(
      f.store.taskJobs().filter((j) => j.taskId === child.taskId && j.state === 'pending').length,
      1,
    );
    f.config.maxConcurrentRuns = 2;
    f.manager.tasks.kick();
    await until(() => f.agent.inputs.length === 1);
    await f.manager.idle();
    await f.manager.createDashboardTask(input, `session:${p.id}`);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('main-area structures slide deep branches and keep scopes, cycles and filtered ancestry finite', () => {
  const route = { platform: 'local', account: 'dashboard', conversation: 'g', sender: 'owner' },
    sessions = Array.from({ length: 9 }, (_, i) => ({
      id: 's' + i,
      route: { ...route, thread: i ? 't' + i : '' },
      parentSessionId: i ? 's' + (i - 1) : undefined,
      agent: 'codex',
      title: '任务' + i,
      status: 'idle',
    }));
  const tree = buildSessionTree({ sessions, tasks: [] }),
    columns = structure.taskColumns(tree, 'session:s0', 'session:s8');
  assert.equal(columns.length, 3);
  assert.equal(columns[0].parent.key, 'session:s5');
  assert.equal(columns[2].children[0].key, 'session:s8');
  assert.equal(structure.taskPath(tree, 'session:s8').length, 9);
  assert.equal(structure.taskRoot(tree, 'session:s8').key, 'session:s0');
  assert.equal(structure.isInBranch(tree, 'session:s1', 'session:s5'), false);
  assert.equal(structure.outlineRows(tree, 'session:s0', new Set(['session:s3'])).length, 4);
  assert.equal(structure.outlineRows(tree, 'session:s5').length, 4);
});

test('a deferred parent is not woken by a child report before its first explicit user input', async () => {
  const f = fixture();
  try {
    const parent = await f.manager.createDashboardTask({
      key: 'waiting-parent',
      title: '等待输入的父任务',
      objective: '父目标',
    });
    const child = await f.manager.createDashboardTask(
      { key: 'waiting-child', title: '子任务', objective: '子目标' },
      parent.key,
    );
    f.manager.tasks.report(child.sessionId!, {
      summary: '子任务成果',
      artifacts: [],
      checks: ['验证通过'],
      issues: [],
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(f.agent.inputs.length, 0);
    assert.ok(f.store.taskJobs().some((j) => j.taskId === parent.taskId && j.state === 'pending'));
    f.manager.submit(parent.sessionId!, '请验收子任务并继续');
    await until(() => f.agent.inputs.some((r) => r.session.id === parent.sessionId));
    await f.manager.idle();
    assert.equal(f.store.taskRecord(parent.taskId!)!.deferred, undefined);
  } finally {
    await f.cleanup();
  }
});

test('scheduled tasks support eight child levels and reject the ninth before provisioning, preserving direct report ancestry', async () => {
  const f = fixture();
  try {
    const root = await f.manager.createDashboardTask({
      key: 'deep-root',
      title: '根任务',
      objective: '完整目标',
    });
    let last = root;
    for (let depth = 1; depth <= 8; depth++)
      last = await f.manager.createDashboardTask(
        { key: 'depth-' + depth, title: '第' + depth + '层', objective: '独立目标' },
        last.key,
      );
    const before = f.store.list().length;
    await assert.rejects(
      f.manager.createDashboardTask(
        { key: 'depth-9', title: '不应创建', objective: '越界' },
        last.key,
      ),
      /最多 8 层/,
    );
    assert.equal(f.store.list().length, before);
    const leaf = f.store.taskRecord(last.taskId!)!;
    f.manager.tasks.report(last.sessionId!, {
      summary: '最深层成果',
      artifacts: [],
      checks: ['测试通过'],
      issues: [],
    });
    assert.equal(f.store.taskJobs()[0]!.taskId, leaf.parentId);
    assert.equal(f.store.taskJobs().length, 1);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('task catalog and native Agent capabilities require authentication, preserve Bot details and keep LAN host checks exact', async () => {
  const f = fixture();
  f.config.dashboardLanHost = '192.168.1.100';
  const server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + '/api/task-nodes')).status, 401);
    const state = (await fetch(base + '/api/state', {
      headers: { Authorization: 'Bearer token' },
    }).then((r) => r.json())) as any;
    assert.equal(state.agentCatalog.length, 3);
    assert.equal(state.channels[0].id, 'test-lark');
    assert.ok(!JSON.stringify(state.agentCatalog).includes('TEST_APP_SECRET'));
    assert.equal((await fetch(base + '/task-structure.js')).status, 200);
    const raw = async (host: string) => {
      const { request } = await import('node:http');
      return new Promise<number | undefined>((resolve) => {
        const q = request(
          base + '/api/state',
          { headers: { Host: host, Authorization: 'Bearer token', Origin: `http://${host}` } },
          (r) => {
            r.resume();
            resolve(r.statusCode);
          },
        );
        q.end();
      });
    };
    assert.equal(await raw(`192.168.1.100:${port}`), 200);
    assert.equal(await raw(`192.168.2.101:${port}`), 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('session child API cannot silently ignore a different workspace under an orchestrated parent', async () => {
  const f = fixture();
  try {
    const parent = f.store.create(incoming('').route, 'codex', f.dir);
    f.manager.tasks.adoptSession(parent.id);
    const other = join(f.dir, 'other-child-dir');
    mkdirSync(other);
    const before = f.store.taskRecords().length;
    await assert.rejects(
      f.manager.createChildSession(parent.id, {
        key: 'wrong-directory',
        title: '子任务',
        workspace: other,
      }),
      /继承直接父级目录/,
    );
    assert.equal(f.store.taskRecords().length, before);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
