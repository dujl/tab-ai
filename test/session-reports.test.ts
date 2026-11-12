import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { createDashboard } from '../src/web/server.js';
import { NativeTopicRouter } from '../src/agents/topic-router.js';
import { reportDraftJsonSchema, REPORT_INSTRUCTIONS } from '../src/core/report-model.js';
import { randomUUID } from 'node:crypto';
const draft = (name = '调研成果') => ({
  summary: name,
  deliverables: [
    { name: '交付资料', kind: '报告', location: 'report.md', description: '已记录的成果' },
  ],
  specifications: [{ name: '接续口径', content: '采用相同样本与边界；输入CSV，输出已校验结论。' }],
  validation: [{ name: '核对', result: '通过', evidence: 'task-result' }],
  risks: [],
  remainingWork: [],
  nextSteps: ['按规格继续核验'],
  lessons: [
    {
      summary: '保持统计口径一致',
      appliesWhen: '复核同一研究',
      practice: '先核对样本再复算',
      cautions: '样本变化需重新核验',
      evidence: ['task-result'],
    },
  ],
});
const wait = async (check: () => boolean) => {
  const end = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > end) throw Error('report wait timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};
test('closing is idempotent and produces incomplete reports; reopen freezes old evidence and creates a new report version', async () => {
  const f = fixture();
  let captured: any;
  try {
    (f.manager.reports as any).writer = {
      async generate(input: any) {
        captured = input;
        return { ...draft('结束记录'), lessons: [] };
      },
    };
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'native-history';
    f.store.save(s);
    f.store.event(s.id, 'user', '第一阶段资料');
    f.store.event(s.id, 'response', '第一阶段已完成准备，仍需核验');
    f.manager.closeSession(s.id);
    f.manager.closeSession(s.id);
    f.manager.openSession(s.id);
    f.store.event(s.id, 'user', '重新打开后的新资料');
    await wait(() => f.store.reports.list(s.id)[0]?.state === 'ready');
    const first = f.store.reports.list(s.id)[0]!;
    assert.equal(first.outcome, 'incomplete');
    assert.equal(first.version, 1);
    assert.ok(first.body!.remainingWork.length);
    assert.ok(!JSON.stringify(captured).includes('重新打开后的新资料'));
    assert.equal(f.store.get(s.id)!.nativeId, 'native-history');
    f.manager.closeSession(s.id);
    await wait(
      () =>
        f.store.reports.list(s.id)[0]?.version === 2 &&
        f.store.reports.list(s.id)[0]?.state === 'ready',
    );
    assert.equal(f.store.reports.list(s.id).length, 2);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('a valid completed goal remains completed when its session closes', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    f.manager.tasks.adoptSession(s.id);
    f.manager.tasks.report(s.id, {
      summary: '目标完成',
      artifacts: ['spec.md'],
      checks: ['核对通过'],
      issues: [],
      handoff: draft('可接续交付'),
    });
    f.manager.closeSession(s.id);
    await wait(() => f.store.reports.list(s.id).filter((r) => r.state === 'ready').length === 2);
    assert.equal(f.store.taskRecord(s.id)!.state, 'completed');
    assert.equal(f.store.reports.list(s.id)[0]!.outcome, 'completed');
    assert.equal(f.store.reports.list(s.id)[0]!.body!.specifications[0]!.name, '接续口径');
  } finally {
    await f.cleanup();
  }
});
test('provider failure leaves honest recorded facts and no fabricated experience; unsupported evidence is removed', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    f.store.event(s.id, 'response', '仅有公开记录');
    (f.manager.reports as any).writer = {
      async generate() {
        throw Error('secret-provider-detail');
      },
    };
    const report = f.manager.reports.request(s.id);
    await wait(() => f.store.reports.get(report.id)?.state === 'ready');
    const fallback = f.store.reports.get(report.id)!;
    assert.equal(fallback.quality, 'recorded_facts');
    assert.deepEqual(fallback.body!.lessons, []);
    assert.match(fallback.warning!, /暂不可用/);
    assert.ok(!JSON.stringify(fallback).includes('secret-provider-detail'));
    (f.manager.reports as any).writer = {
      async generate() {
        return draft('依据不足');
      },
    };
    const another = f.manager.reports.request(s.id);
    await wait(() => f.store.reports.get(another.id)?.state === 'ready');
    assert.deepEqual(f.store.reports.get(another.id)!.body!.lessons, []);
  } finally {
    await f.cleanup();
  }
});
test('report reads and reusable experience stay within caller ancestry/dependencies and sender scope', async () => {
  const f = fixture();
  try {
    f.store.enableEmptyTaskModel();
    const root = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      child = f.store.create(incoming('', 'alice', 'child').route, 'codex', f.dir),
      sibling = f.store.create(incoming('', 'alice', 'sibling').route, 'codex', f.dir),
      foreign = f.store.create(incoming('', 'bob', 'other').route, 'codex', f.dir);
    child.parentSessionId = root.id;
    f.store.save(child);
    sibling.parentSessionId = root.id;
    f.store.save(sibling);
    f.manager.tasks.adoptSession(root.id);
    f.manager.tasks.report(child.id, {
      summary: '研究完成',
      artifacts: [],
      checks: ['复核'],
      issues: [],
      handoff: draft(),
    });
    await wait(() => f.store.reports.list(child.id)[0]?.state === 'ready');
    const report = f.store.reports.list(child.id)[0]!;
    assert.equal(f.manager.reports.readForTask(root.id, report.id).id, report.id);
    assert.throws(() => f.manager.reports.readForTask(sibling.id, report.id), /只能读取/);
    assert.throws(() => f.manager.reports.readForTask(foreign.id, report.id), /无权/);
    assert.equal(f.manager.reports.experiences(foreign).length, 0);
    assert.equal(f.manager.reports.experiences(root)[0]!.lesson.summary, '保持统计口径一致');
    assert.equal(f.store.events(root.id).filter((e) => e.type === 'handoff_received').length, 1);
  } finally {
    await f.cleanup();
  }
});
test('coding, testing and deployment run in dependency order with exact accepted report specs and durable version references', async () => {
  const f = fixture();
  let created = false;
  const stages: string[] = [];
  let testId = '',
    codeId = '';
  f.agent.handler = async (run) => {
    run.hooks.nativeId('native-' + run.session.id);
    const task = f.manager.tasks.forSession(run.session.id)!;
    if (!task.parentId) {
      if (!created) {
        created = true;
        const a = await f.manager.tasks.createChild(run.session.id, {
          key: 'code',
          title: '编码',
          objective: 'code',
          criteria: '交付接口',
          start: true,
        });
        codeId = a.id;
        const b = await f.manager.tasks.createChild(run.session.id, {
          key: 'test',
          title: '测试',
          objective: 'test',
          criteria: '按spec核验',
          dependencies: [a.id],
          start: true,
        });
        testId = b.id;
        await f.manager.tasks.createChild(run.session.id, {
          key: 'deploy',
          title: '上线',
          objective: 'deploy',
          criteria: '验收上线',
          dependencies: [b.id],
          start: true,
        });
      } else
        for (const child of f.manager.tasks.listForSession(run.session.id).slice(1))
          if (child.state === 'review')
            f.manager.tasks.review(run.session.id, child.id, child.revision, true, '已核验');
    } else {
      stages.push(task.title);
      if (task.title === '测试') {
        assert.match(run.text, /接续口径/);
        assert.match(run.text, /保持统计口径一致/);
        assert.match(run.text, /"accepted":true/);
      }
      f.manager.tasks.report(run.session.id, {
        summary: task.title + '完成',
        artifacts: ['spec.md'],
        checks: ['已核验'],
        issues: [],
        handoff: draft(task.title + '交付'),
      });
    }
    run.hooks.text('完成本轮');
  };
  try {
    const source = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const root = await f.manager.createTask({
      sourceSessionId: source.id,
      key: randomUUID(),
      title: '通用流水线',
      objective: '按阶段交付',
      workspace: 'default',
    });
    await wait(() => stages.length === 3);
    await f.manager.idle();
    assert.deepEqual(stages, ['编码', '测试', '上线']);
    const job = f.store.taskJobs().find((j) => j.taskId === testId && j.key.endsWith(':initial'))!;
    assert.equal(job.inputReports![0]!.taskId, codeId);
    assert.equal(job.inputReports![0]!.taskRevision, 1);
    const report = f.store.reports.get(job.inputReports![0]!.reportId)!;
    assert.equal(report.version, job.inputReports![0]!.version);
    assert.equal(report.outcome, 'completed');
    assert.equal(report.body!.specifications[0]!.name, '接续口径');
    assert.ok(f.store.events(root.sessionId!).some((e) => e.type === 'handoff_received'));
  } finally {
    await f.cleanup();
  }
});
test('authenticated report APIs paginate, deduplicate explicit generation and support conditional state polling', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`,
    headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir),
      initial = await fetch(base + '/state', { headers }),
      etag = initial.headers.get('etag')!;
    assert.ok(etag);
    assert.equal(
      (await fetch(base + '/state', { headers: { ...headers, 'If-None-Match': etag } })).status,
      304,
    );
    const key = randomUUID(),
      post = () =>
        fetch(base + `/sessions/${s.id}/reports`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key }),
        });
    const a = await (await post()).json(),
      b = await (await post()).json();
    assert.equal(a.report.id, b.report.id);
    assert.equal((await fetch(base + `/sessions/${s.id}/reports`)).status, 401);
    await wait(() => f.store.reports.get(a.report.id)?.state === 'ready');
    assert.equal(
      (await fetch(base + '/state', { headers: { ...headers, 'If-None-Match': etag } })).status,
      200,
    );
    for (let i = 0; i < 21; i++)
      f.store.reports.request(s, undefined, 'manual', 'manual-test:' + i, 0);
    const page = await (await fetch(base + `/sessions/${s.id}/reports`, { headers })).json();
    assert.equal(page.reports.length, 20);
    const older = await (
      await fetch(base + `/sessions/${s.id}/reports?before=${page.reports.at(-1).version}`, {
        headers,
      })
    ).json();
    assert.equal(older.reports.length, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
test('native report generation uses a new ephemeral tools-disabled structured thread', async () => {
  const calls: any[] = [],
    rpc = {
      onMessage: (_: any) => {},
      onFailure: (_: Error) => {},
      write(_: object) {},
      async close() {},
      async request(method: string, params: any): Promise<any> {
        calls.push({ method, params });
        if (method === 'config/read') return { config: {} };
        if (method === 'thread/start') return { thread: { id: 'report-thread' } };
        if (method === 'turn/start') {
          rpc.onMessage({
            method: 'item/completed',
            params: { item: { type: 'agentMessage', text: JSON.stringify(draft()) } },
          });
          rpc.onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
        }
        return {};
      },
    };
  const writer = new NativeTopicRouter('codex', undefined, [], { rpc: () => rpc });
  try {
    const out: any = await writer.generate(
      { publicHistory: [] },
      REPORT_INSTRUCTIONS,
      reportDraftJsonSchema,
      new AbortController().signal,
    );
    assert.equal(out.specifications[0].name, '接续口径');
    const start = calls.find((c) => c.method === 'thread/start').params;
    assert.equal(start.ephemeral, true);
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.config['features.shell_tool'], false);
    assert.equal(start.baseInstructions, REPORT_INSTRUCTIONS);
    assert.ok(!calls.some((c) => c.method === 'thread/resume'));
    assert.ok(calls.find((c) => c.method === 'turn/start').params.outputSchema.properties.lessons);
  } finally {
    await writer.close();
  }
});

test('closing a running native turn waits for cancellation before freezing its public output', async () => {
  const f = fixture();
  f.agent.handler = async (run) => {
    run.hooks.nativeId('keep-native');
    run.hooks.text('已经记录部分交付，仍未完成验证');
    await new Promise<void>((r) => run.signal.addEventListener('abort', () => r(), { once: true }));
  };
  try {
    const m = incoming('开始长任务');
    await f.manager.receive(m);
    await until(() => f.agent.inputs.length === 1);
    const s = f.store.current(m.route)!;
    f.manager.closeSession(s.id);
    await wait(() => f.store.reports.list(s.id)[0]?.state === 'ready');
    assert.equal(f.store.get(s.id)!.status, 'closed');
    assert.equal(f.store.get(s.id)!.nativeId, 'keep-native');
    const report = f.store.reports.list(s.id)[0]!;
    assert.equal(report.outcome, 'incomplete');
    assert.match(report.body!.summary, /部分交付/);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('interrupted report generation recovers the same version after service restart without resuming native work', async () => {
  const { Store } = await import('../src/core/store.js'),
    { SessionReports } = await import('../src/core/session-reports.js'),
    fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-ai-report-recover-'));
  let store = new Store(dir);
  const host = { active: () => false, capacity: () => true, refresh: () => {} };
  let service = new SessionReports(store, host, {
    async generate(_i, _p, _s, signal) {
      return new Promise((_r, reject) =>
        signal.addEventListener('abort', () => reject(Error('shutdown')), { once: true }),
      );
    },
  });
  try {
    const session = store.create(
      {
        platform: 'local',
        account: 'dashboard',
        conversation: 'one',
        thread: '',
        sender: 'local-owner',
      },
      'codex',
      dir,
    );
    session.nativeId = 'native-kept';
    store.save(session);
    store.event(session.id, 'response', '已有资料');
    const request = service.request(session.id);
    await wait(() => store.reports.get(request.id)?.state === 'running');
    await service.close();
    assert.equal(store.reports.get(request.id)!.state, 'pending');
    store.close();
    store = new Store(dir);
    service = new SessionReports(store, host);
    service.start();
    await wait(() => store.reports.get(request.id)?.state === 'ready');
    assert.equal(store.reports.list(session.id).length, 1);
    assert.equal(store.reports.get(request.id)!.version, 1);
    assert.equal(store.get(session.id)!.nativeId, 'native-kept');
  } finally {
    await service.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parent acceptance during asynchronous summarization cannot revert report completion', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  try {
    (f.manager.reports as any).writer = {
      async generate() {
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    };
    const root = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      child = f.store.create(incoming('', 'alice', 'child').route, 'codex', f.dir);
    child.parentSessionId = root.id;
    f.store.save(child);
    f.manager.tasks.adoptSession(root.id);
    const task = f.manager.tasks.report(child.id, {
      summary: '编码完成',
      artifacts: ['spec.md'],
      checks: ['验证完成'],
      issues: [],
    });
    await wait(() => !!finish);
    f.manager.tasks.review(root.id, task.id, task.revision, true, '已验收');
    finish({ ...draft('交付规格'), lessons: [] });
    await wait(() => f.store.reports.list(child.id)[0]?.state === 'ready');
    assert.equal(f.store.reports.list(child.id)[0]!.outcome, 'completed');
  } finally {
    await f.cleanup();
  }
});

test('cancelling a task subtree records idempotent cancelled handoffs without marking work complete', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const root = f.manager.tasks.adoptSession(s.id);
    const child = await f.manager.tasks.createChild(s.id, {
      key: 'cancel-child',
      title: '待研究',
      objective: '待核验',
      criteria: '核对资料',
      start: false,
    });
    f.manager.tasks.cancel(root.id);
    f.manager.tasks.cancel(root.id);
    await wait(
      () =>
        f.store.reports.list(s.id)[0]?.state === 'ready' &&
        f.store.reports.list(child.sessionId!)[0]?.state === 'ready',
    );
    for (const id of [s.id, child.sessionId!]) {
      assert.equal(f.store.reports.list(id).length, 1);
      assert.equal(f.store.reports.list(id)[0]!.outcome, 'cancelled');
    }
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
