import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, incoming, until } from './helpers.js';
import { Store } from '../src/core/store.js';
import { taskBridge } from '../src/core/task-bridge.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateTopicDecision } from '../src/core/topic-router.js';
const result = (summary: string) => ({ summary, artifacts: [], checks: ['核对完成'], issues: [] });
const child = (key: string) => ({
  key,
  title: key,
  objective: `完成 ${key}`,
  criteria: '给出结论',
  context: '只给必要资料',
  workspaceMode: 'shared' as const,
  dependencies: [],
});
const root = async (f: ReturnType<typeof fixture>, objective = '主目标') => {
  const source = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
  source.nativeId = 'old-main';
  f.store.save(source);
  f.store.event(source.id, 'user', '私密主聊天历史');
  return f.manager.createTask({
    sourceSessionId: source.id,
    key: randomUUID(),
    title: '主任务',
    objective,
    workspace: 'default',
  });
};

test('root/children auto scheduling keeps native sessions and task inputs independent, returns only result packets', async () => {
  const f = fixture();
  let parents = 0;
  f.agent.handler = async (run) => {
    run.hooks.nativeId(`native-${run.session.id}`);
    const task = f.manager.tasks.forSession(run.session.id)!;
    if (!task.parentId) {
      parents++;
      if (parents === 1) {
        await f.manager.tasks.createChild(run.session.id, child('A'));
        await f.manager.tasks.createChild(run.session.id, child('B'));
      } else {
        for (const t of f.manager.tasks.listForSession(run.session.id).slice(1))
          if (t.state === 'review')
            f.manager.tasks.review(run.session.id, t.id, t.revision, true, '验收通过');
        if (
          f.manager.tasks
            .listForSession(run.session.id)
            .slice(1)
            .every((t) => t.state === 'completed') &&
          !f.store.taskJobs().some((j) => j.taskId === task.id && j.state === 'pending')
        )
          f.manager.tasks.report(run.session.id, result('汇总 A 和 B'));
      }
    } else {
      run.hooks.text('只在子话题出现的原始推演');
      f.manager.tasks.report(run.session.id, result(task.title + '成果'));
    }
  };
  try {
    const t = await root(f);
    await until(() => f.store.taskRecord(t.id)?.state === 'completed');
    await f.manager.idle();
    const tree = f.manager.tasks.tree(t);
    assert.equal(tree.length, 3);
    assert.equal(new Set(tree.map((t) => t.sessionId)).size, 3);
    assert.ok(tree.every((t) => t.state === 'completed'));
    const inputs = f.agent.inputs.map((r) => r.text);
    assert.ok(inputs.every((t) => !t.includes('私密主聊天历史')));
    assert.ok(
      f.agent.inputs
        .filter((r) => r.session.id === t.sessionId)
        .every((r) => !r.text.includes('只在子话题出现的原始推演')),
    );
    assert.ok(
      f.agent.inputs
        .filter((r) => r.session.id === t.sessionId)
        .some((r) => r.text.includes('A成果')),
    );
    assert.equal(f.store.current(incoming('', 'alice', '').route)?.nativeId, 'old-main');
    assert.ok(tree.slice(1).every((t) => t.workspace === f.dir));
  } finally {
    await f.cleanup();
  }
});

test('creation is idempotent while concurrent, invalid dependencies denied and plain turn end is not completion', async () => {
  const f = fixture();
  f.agent.handler = async () => {};
  try {
    const t = await root(f);
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    const [a, b] = await Promise.all([
      f.manager.tasks.createChild(t.sessionId!, child('same')),
      f.manager.tasks.createChild(t.sessionId!, child('same')),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(f.manager.tasks.tree(t).length, 2);
    await assert.rejects(
      f.manager.tasks.createChild(t.sessionId!, { ...child('invalid'), dependencies: [t.id] }),
      /同级/,
    );
    assert.throws(() => f.manager.tasks.report(t.sessionId!, result('提前结束')), /先验收/);
    await until(() => f.store.taskRecord(a.id)?.state === 'waiting');
    assert.notEqual(f.store.taskRecord(a.id)?.state, 'completed');
  } finally {
    await f.cleanup();
  }
});

test('dependency starts only after reviewed success, rework reuses child native session', async () => {
  const f = fixture();
  f.config.maxConcurrentRuns = 1;
  let aRuns = 0,
    childA = '';
  f.agent.handler = async (run) => {
    const t = f.manager.tasks.forSession(run.session.id)!;
    run.hooks.nativeId('native-' + run.session.id);
    if (t.title === 'A') {
      aRuns++;
      f.manager.tasks.report(run.session.id, result('A v' + aRuns));
    } else if (t.title === 'B') {
      assert.match(run.text, /A v2/);
      f.manager.tasks.report(run.session.id, result('B'));
    }
  };
  try {
    const t = await root(f);
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    const a = await f.manager.tasks.createChild(t.sessionId!, child('A'));
    childA = a.sessionId!;
    const b = await f.manager.tasks.createChild(t.sessionId!, {
      ...child('B'),
      dependencies: [a.id],
    });
    await until(() => f.store.taskRecord(a.id)?.state === 'review');
    await f.manager.idle();
    assert.equal(f.store.taskRecord(b.id)?.state, 'queued');
    f.manager.tasks.review(t.sessionId!, a.id, 1, false, '补充验证');
    await until(() => f.store.taskRecord(a.id)?.revision === 2);
    await f.manager.idle();
    assert.throws(() => f.manager.tasks.review(t.sessionId!, a.id, 1, true, ''), /已变化/);
    f.manager.tasks.review(t.sessionId!, a.id, 2, true, '已核验');
    await until(() => f.store.taskRecord(b.id)?.state === 'review');
    assert.equal(f.store.get(childA)?.nativeId, 'native-' + childA);
    assert.equal(aRuns, 2);
  } finally {
    await f.cleanup();
  }
});

test('native questions are delivered at root and answers settle original child only', async () => {
  const f = fixture();
  let delivered: any;
  let answer: any;
  Object.assign(f.channel, {
    sendInteraction: async (message: any, request: any, submit: any) => {
      delivered = { message, request, submit };
      return { close: async () => {} };
    },
  });
  f.agent.handler = async (run) => {
    const t = f.manager.tasks.forSession(run.session.id)!;
    if (t.parentId)
      answer = await run.hooks.ask(
        {
          kind: 'question',
          title: '选择风格',
          detail: '',
          questions: [
            { id: 'style', question: '风格？', options: ['简洁', '活泼'], allowOther: false },
          ],
        },
        run.signal,
      );
  };
  try {
    const t = await root(f);
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    const c = await f.manager.tasks.createChild(t.sessionId!, {
      ...child('question'),
      title: '提问',
    });
    await until(() => !!delivered);
    assert.equal(delivered.message.route.thread, t.route.thread);
    assert.equal(delivered.request.sessionId, c.sessionId);
    assert.throws(() => delivered.submit('bob', { answers: { style: ['简洁'] } }), /无权/);
    await f.manager.receive({
      ...incoming(`/tab answer ${delivered.request.id} {"style":["简洁"]}`),
      route: t.route,
    });
    await until(() => !!answer);
    assert.deepEqual(answer, { answers: { style: ['简洁'] } });
  } finally {
    await f.cleanup();
  }
});

test('user task inputs queue during a turn and target exact task; unrelated user cannot redirect', async () => {
  const f = fixture();
  let release!: () => void,
    seen = 0;
  f.agent.handler = async () => {
    if (++seen === 1)
      await new Promise<void>((r) => {
        release = r;
      });
  };
  try {
    const t = await root(f);
    await until(() => !!release);
    await f.manager.receive({ ...incoming('新要求'), route: t.route });
    assert.equal(f.agent.inputs.length, 1);
    await f.manager.receive({
      ...incoming(`/tab task-to ${t.id.slice(0, 8)} 越权`, 'bob', ''),
      route: { ...t.route, sender: 'bob', thread: '' },
    });
    assert.match(f.channel.sent.at(-1)!.text, /属于你的/);
    release();
    await until(() => seen === 2);
    assert.equal(f.agent.inputs[1]?.text.split('\n\n【任务分支索引')[0], '新要求');
    assert.equal(f.agent.inputs[1]?.session.id, t.sessionId);
  } finally {
    release?.();
    await f.cleanup();
  }
});

test('pause/cancel prevent dispatch; restart never replays in-flight side effects', async () => {
  const f = fixture();
  let started = false;
  f.agent.handler = async (run) => {
    started = true;
    await new Promise<void>((_, reject) =>
      run.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }),
    );
  };
  let reopened: Store | undefined;
  try {
    const t = await root(f);
    await until(() => started);
    f.manager.tasks.pause(t.id);
    await f.manager.idle();
    assert.equal(f.store.taskRecord(t.id)?.state, 'paused');
    assert.ok(f.store.taskJobs().some((j) => j.state === 'interrupted'));
    f.manager.tasks.cancel(t.id);
    assert.equal(f.store.taskRecord(t.id)?.state, 'cancelled');
    assert.throws(() => f.manager.tasks.resume(t.id), /已取消/);
    const task = f.store.taskRecord(t.id)!;
    task.state = 'running';
    f.store.saveTask(task);
    const job = f.store.enqueueTask(t.id, 'crash', 'dangerous original input');
    job.state = 'running';
    f.store.saveTaskJob(job);
    await f.manager.close();
    reopened = new Store(f.config.dataDir);
    assert.equal(reopened.taskJobs().find((j) => j.key === 'crash')?.state, 'interrupted');
    assert.equal(reopened.taskRecord(t.id)?.state, 'blocked');
  } finally {
    reopened?.close();
    await f.cleanup();
  }
});

test('per-turn MCP capability requires exact token, limits tools to caller and revokes on close', async () => {
  const f = fixture();
  f.agent.handler = async () => {};
  let bridge: Awaited<ReturnType<typeof taskBridge>> | undefined;
  const client = new Client({ name: 'task-test', version: '1' });
  try {
    const t = await root(f);
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    bridge = await taskBridge(f.manager.tasks, t.sessionId!, new AbortController().signal);
    assert.equal((await fetch(bridge.url, { method: 'POST', body: '{}' })).status, 401);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert.ok(tools.tools.some((t) => t.name === 'task_report_read'));
    assert.ok(tools.tools.some((t) => t.name === 'task_experience'));
    const made = await client.callTool({ name: 'task_create', arguments: child('MCP') });
    assert.equal(made.isError, undefined);
    assert.equal(f.manager.tasks.tree(t).length, 2);
    const forged = await client.callTool({
      name: 'task_review',
      arguments: { taskId: t.id, revision: 1, accept: true, feedback: '' },
    });
    assert.equal(forged.isError, true);
    await client.close();
    await bridge.close();
    await assert.rejects(
      fetch(bridge.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bridge.token}` },
        body: '{}',
      }),
    );
  } finally {
    await client.close();
    await bridge?.close();
    await f.cleanup();
  }
});

test('new task semantic extraction requires current explicit goal and does not borrow main history', () => {
  const decision = {
    action: 'new_task',
    task: '写方案并拆分子任务',
    agent: null,
    workspace: null,
    instructions: null,
    management: null,
  };
  assert.equal(
    validateTopicDecision(decision, {
      text: '新建任务：写方案并拆分子任务',
      recentUserMessages: ['secret'],
    }).action,
    'new_task',
  );
  assert.throws(
    () =>
      validateTopicDecision(
        { ...decision, task: 'secret' },
        { text: '新建任务，继续刚才的', recentUserMessages: ['secret'] },
      ),
    /current objective/,
  );
});

test('task tree is rendered in session card and failed creation is never duplicated after ambiguous delivery', async () => {
  const { larkSessionCard } = await import('../src/channels/lark-session-card.js');
  const f = fixture();
  f.agent.handler = async () => {};
  try {
    const task = await root(f);
    await until(() => f.store.taskRecord(task.id)?.state === 'waiting');
    const childTask = await f.manager.tasks.createChild(task.sessionId!, child('visible'));
    const session = f.store.get(task.sessionId!)!;
    const card = larkSessionCard({
      session,
      card: {
        id: randomUUID(),
        sessionId: session.id,
        delivery: 'sent',
        revision: 1,
        view: 'status',
      },
      active: false,
      current: true,
      events: [],
      taskBoard: f.manager.tasks.board(session.id),
    });
    assert.match(JSON.stringify(card), /tab-ai 任务树/);
    assert.match(JSON.stringify(card), /visible/);
    f.channel.createTopic = async () => {
      throw new Error('投递未知');
    };
    const pending = await f.manager.tasks.createChild(task.sessionId!, {
      ...child('ambiguous'),
      start: false,
    });
    const again = await f.manager.tasks.createChild(task.sessionId!, child('ambiguous'));
    assert.equal(again.id, pending.id);
    assert.equal(again.state, 'waiting');
    assert.equal(f.store.get(again.sessionId!)!.imEntry!.state, 'unknown');
    assert.equal(f.manager.tasks.tree(task).length, 3);
    assert.equal(f.store.taskRecord(childTask.id)?.parentId, task.id);
  } finally {
    await f.cleanup();
  }
});

test('cancellation during remote topic creation does not resurrect the task or run its agent', async () => {
  const f = fixture();
  let release!: () => void;
  let parentId = '';
  f.agent.handler = async () => {};
  try {
    const t = await root(f);
    parentId = t.id;
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    const create = f.channel.createTopic.bind(f.channel);
    f.channel.createTopic = async (m, title) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return create(m, title);
    };
    const pending = f.manager.tasks.createChild(t.sessionId!, child('cancel-race'));
    await until(() => !!release);
    f.manager.tasks.cancel(parentId);
    release();
    const c = await pending;
    assert.equal(c.state, 'cancelled');
    assert.equal(f.store.get(c.sessionId!)?.status, 'closed');
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    release?.();
    await f.cleanup();
  }
});

test('task HTTP API authenticates and resumes normal user input without modifying unrelated main session', async () => {
  const { createDashboard } = await import('../src/web/server.js');
  const f = fixture();
  f.agent.handler = async () => {};
  const server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, data: unknown, auth = true) =>
    fetch(base + path, {
      method: 'POST',
      headers: auth ? { Authorization: 'Bearer token' } : {},
      body: JSON.stringify(data),
    });
  try {
    const source = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const input = {
      sourceSessionId: source.id,
      key: 'http',
      title: 'HTTP任务',
      objective: '做一个小任务',
    };
    assert.equal((await request('/api/tasks', input, false)).status, 401);
    const response = await request('/api/tasks', input);
    assert.equal(response.status, 201);
    const t = (await response.json()) as any;
    const duplicate = (await (await request('/api/tasks', input)).json()) as any;
    assert.equal(t.id, duplicate.id);
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    assert.equal(
      (await request(`/api/tasks/${t.id}/message`, { text: '补充目标', key: 'one' })).status,
      200,
    );
    await until(() => f.agent.inputs.length === 2);
    assert.equal(f.store.current(source.route)?.id, source.id);
    assert.equal((await request(`/api/tasks/${t.id}/cancel`, {})).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('resuming a child under a paused parent leaves its persisted state unchanged', async () => {
  const f = fixture();
  f.agent.handler = async () => {};
  try {
    const t = await root(f);
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    const c = await f.manager.tasks.createChild(t.sessionId!, child('paused-child'));
    await until(() => f.store.taskRecord(c.id)?.state === 'waiting');
    await f.manager.idle();
    f.manager.tasks.pause(c.id);
    f.manager.tasks.pause(t.id);
    assert.throws(() => f.manager.tasks.resume(c.id), /不可执行/);
    assert.equal(f.store.taskRecord(c.id)?.state, 'paused');
  } finally {
    await f.cleanup();
  }
});

test('all task depths inherit root workspace and see the same files without sharing native context', async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = fixture();
  f.agent.handler = async (run) => {
    run.hooks.nativeId('native-' + run.session.id);
  };
  try {
    const t = await root(f);
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    const { workspaceMode, ...input } = child('child');
    const c = await f.manager.tasks.createChild(t.sessionId!, input);
    await until(() => f.store.taskRecord(c.id)?.state === 'waiting');
    const g = await f.manager.tasks.createChild(c.sessionId!, { ...input, key: 'grandchild' });
    await until(() => f.store.taskRecord(g.id)?.state === 'waiting');
    await f.manager.idle();
    const tree = f.manager.tasks.tree(t);
    assert.equal(tree.length, 3);
    assert.ok(
      tree.every(
        (x) => x.workspace === t.workspace && f.store.get(x.sessionId!)?.workspace === t.workspace,
      ),
    );
    assert.equal(new Set(tree.map((x) => f.store.get(x.sessionId!)!.nativeId)).size, 3);
    writeFileSync(join(c.workspace, 'shared.txt'), 'shared artifact');
    assert.equal(readFileSync(join(g.workspace, 'shared.txt'), 'utf8'), 'shared artifact');
    for (const mode of ['isolated', 'worktree'])
      await assert.rejects(
        f.manager.tasks.createChild(t.sessionId!, { ...input, key: mode, workspaceMode: mode }),
      );
    assert.equal(f.manager.tasks.tree(t).length, 3);
  } finally {
    await f.cleanup();
  }
});

test('Lark group runs nested tasks in sibling topics, returns results to parents and routes followups to existing task', async () => {
  const contexts: unknown[] = [];
  const f = fixture({
    async classify(input) {
      contexts.push(input.taskContext);
      return { action: 'continue', task: null, agent: null, workspace: null, instructions: null };
    },
  });
  let rootId = '';
  f.agent.handler = async (run) => {
    run.hooks.nativeId('native-' + run.session.id);
    const task = f.manager.tasks.forSession(run.session.id)!;
    if (run.text === '给当前任务补充验收说明') return;
    const own = f.manager.tasks.listForSession(run.session.id);
    const children = own.slice(1);
    if (task.title === 'leaf') {
      f.manager.tasks.report(run.session.id, result('leaf成果'));
      return;
    }
    if (!children.length) {
      await f.manager.tasks.createChild(run.session.id, {
        ...child(task.parentId ? 'leaf' : 'branch'),
        title: task.parentId ? 'leaf' : 'branch',
      });
      return;
    }
    for (const c of children)
      if (c.state === 'review')
        f.manager.tasks.review(run.session.id, c.id, c.revision, true, '核验通过');
    f.manager.tasks.report(run.session.id, result(task.parentId ? 'branch成果' : 'root成果'));
  };
  const group = (text: string, mentioned = true) => ({
    ...incoming(text, 'alice', ''),
    groupMessage: { mentioned },
  });
  try {
    await f.manager.receive(group('/tab task 群聊设计任务', false));
    assert.equal(f.store.taskRecords().length, 0);
    await f.manager.receive(group('/tab task 群聊设计任务'));
    await until(() => f.store.taskRecords().some((t) => !t.parentId && t.state === 'completed'));
    await f.manager.idle();
    const tree = f.store.taskRecords(),
      root = tree.find((t) => !t.parentId)!;
    rootId = root.id;
    assert.equal(tree.length, 3);
    assert.ok(tree.every((t) => t.state === 'completed'));
    assert.equal(new Set(tree.map((t) => t.route.thread)).size, 3);
    assert.ok(
      tree.every(
        (t) =>
          t.route.conversation === 'chat-1' &&
          t.route.sender === 'alice' &&
          t.workspace === root.workspace,
      ),
    );
    assert.ok(f.channel.sent.every((s) => s.message.route.conversation === 'chat-1'));
    const leaf = tree.find((t) => t.title === 'leaf')!,
      branch = tree.find((t) => t.title === 'branch')!;
    assert.ok(
      f.agent.inputs.some((r) => r.session.id === branch.sessionId && r.text.includes('leaf成果')),
    );
    assert.ok(
      f.agent.inputs.some((r) => r.session.id === root.sessionId && r.text.includes('branch成果')),
    );
    assert.ok(
      f.agent.inputs.some((r) => r.session.id === root.sessionId && r.text.includes('leaf成果')),
    ); // The root receives a read-only descendant index; acceptance still goes through the direct parent.
    await f.manager.receive({ ...group('给当前任务补充验收说明'), route: root.route });
    await until(() =>
      f.agent.inputs.some((r) => r.text.startsWith('给当前任务补充验收说明\n\n【任务分支索引')),
    );
    assert.deepEqual(contexts.at(-1), { role: 'root' });
    assert.equal(f.store.taskRecords().length, 3);
    await f.manager.receive({
      ...group(`/tab task-to ${root.id} 越权`),
      route: { ...root.route, sender: 'bob' },
    });
    assert.match(f.channel.sent.at(-1)!.text, /属于你的/);
  } finally {
    await f.cleanup();
  }
});

for (const change of ['input', 'report'] as const)
  test(`new descendant ${change} invalidates every ancestor result and revision`, async () => {
    const f = fixture();
    try {
      const rootSession = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
        branchSession = f.store.create(incoming('', 'alice', 'branch').route, 'codex', f.dir),
        leafSession = f.store.create(incoming('', 'alice', 'leaf').route, 'codex', f.dir);
      branchSession.parentSessionId = rootSession.id;
      f.store.save(branchSession);
      leafSession.parentSessionId = branchSession.id;
      f.store.save(leafSession);
      f.manager.tasks.adoptSession(rootSession.id);
      for (const session of [rootSession, branchSession, leafSession]) {
        const t = f.store.taskRecord(session.id)!;
        t.state = 'completed';
        t.revision = 7;
        t.result = result('已验收的前一版');
        f.store.saveTask(t);
      }
      if (change === 'input') f.manager.tasks.enqueueUser(leafSession.id, '补充核验边界', 'next');
      else f.manager.tasks.report(leafSession.id, result('修订版成果'));
      for (const session of [rootSession, branchSession]) {
        const t = f.store.taskRecord(session.id)!;
        assert.equal(t.state, 'waiting');
        assert.equal(t.revision, 8);
        assert.equal(t.result, undefined);
      }
      assert.throws(
        () => f.manager.tasks.review(rootSession.id, branchSession.id, 7, true, '过时验收'),
        /报告已变化/,
      );
    } finally {
      await f.cleanup();
    }
  });

test('replaying a completed user input key does not reopen a task or invalidate its accepted result', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const t = f.manager.tasks.adoptSession(s.id);
    const job = f.store.enqueueTask(t.id, `${t.id}:user:once`, '原任务');
    job.state = 'done';
    f.store.saveTaskJob(job);
    t.state = 'completed';
    t.revision = 3;
    t.result = result('已验收');
    f.store.saveTask(t);
    const before = f.store.taskRecord(t.id);
    f.manager.tasks.enqueueUser(s.id, '重试原任务', 'once');
    assert.deepEqual(f.store.taskRecord(t.id), before);
    assert.equal(f.store.taskJobs().length, 1);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('cancelled interactive tasks remain cancelled in the product catalog', async () => {
  const f = fixture();
  try {
    f.store.enableEmptyTaskModel();
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    f.store.event(s.id, 'user', '有明确目标');
    const t = f.store.taskRecord(s.id)!;
    t.state = 'cancelled';
    f.store.saveTask(t);
    const node = f.manager.taskCatalog().find((n) => n.sessionId === s.id)!;
    assert.equal(node.goalState, 'cancelled');
    assert.equal(node.capabilities.canCreateChild, false);
  } finally {
    await f.cleanup();
  }
});
