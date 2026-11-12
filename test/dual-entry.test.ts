import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { createDashboard } from '../src/web/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startChannel } from '../src/channels/lifecycle.js';
import { serve } from '../src/runtime.js';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
async function tool(run: any, name: string, args: any = {}) {
  const client = new Client({ name: 'dual-entry-test', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(run.taskBridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${run.taskBridge.token}` } },
      }),
    );
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}
const result = {
  summary: '整体目标已完成并验证',
  artifacts: ['result.txt'],
  checks: ['已验证'],
  issues: [],
};

test('IM and Web drive the same native sessions through nested mixed-Agent tasks, approval, progress and parent acceptance', async () => {
  const f = fixture(),
    cards: any[] = [],
    closed: string[] = [];
  let approved = 0;
  Object.assign(f.channel, {
    async sendInteraction(message: any, request: any, answer: any) {
      cards.push({ message, request, answer });
      return {
        async close(status: string) {
          closed.push(status);
        },
      };
    },
  });
  f.agent.handler = async (run) => {
    run.hooks.nativeId(run.session.nativeId ?? 'native-' + run.session.id);
    if (run.text.includes('CHILD-APPROVE')) {
      const answer = await run.hooks.ask(
        { kind: 'approval', title: '开发确认', detail: '测试操作' },
        run.signal,
      );
      assert.deepEqual(answer, { allow: true });
      approved++;
    }
    if (run.text.includes('SAVE-PROGRESS')) {
      const response: any = await tool(run, 'task_progress', { summary: '仅完成阶段准备' });
      assert.ok(!response.isError);
    }
    if (run.text.includes('REPORT-FINAL')) {
      const response: any = await tool(run, 'task_report', result);
      assert.ok(!response.isError);
    }
    if (run.text.startsWith('【tab-ai 子任务结果')) {
      const list: any = await tool(run, 'task_list');
      const records = JSON.parse(list.content[0].text);
      for (const child of records.slice(1).filter((t: any) => t.state === 'review')) {
        const review: any = await tool(run, 'task_review', {
          taskId: child.id,
          revision: child.revision,
          accept: true,
          feedback: '验收通过',
        });
        assert.ok(!review.isError);
      }
    }
    run.hooks.text('已处理');
  };
  const server = createDashboard(f.manager, 'test-token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`,
    headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    post = async (path: string, data: unknown) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    };
  try {
    const mainMessage = incoming('IM-START', 'alice', 'om_root');
    await f.manager.receive(mainMessage);
    await f.manager.idle();
    const main = f.store.current(mainMessage.route)!,
      native = main.nativeId,
      history = f.store.events(main.id);
    await post(`/sessions/${main.id}/messages`, { text: 'WEB-CONTINUE' });
    await f.manager.idle();
    assert.equal(f.store.get(main.id)!.nativeId, native);
    const child = await post(`/task-nodes/session:${main.id}/children`, {
      key: 'child',
      title: '研究子任务',
      objective: '独立目标',
      agent: 'claude',
      start: false,
    });
    const grand = await post(`/task-nodes/${child.key}/children`, {
      key: 'grand',
      title: '验证子任务',
      objective: '验证目标',
      agent: 'opencode',
      start: false,
    });
    assert.equal(child.parentKey, `session:${main.id}`);
    assert.equal(grand.parentKey, child.key);
    assert.equal(f.store.get(main.id)!.nativeId, native);
    assert.deepEqual(f.store.events(main.id).slice(0, history.length), history);
    assert.equal(f.store.taskJobs().length, 0);
    await post(`/sessions/${child.sessionId}/messages`, { text: 'CHILD-APPROVE' });
    await until(() => f.manager.interactions().length === 1);
    const pending = f.manager.interactions()[0]!;
    await until(() => cards.length === 1);
    assert.equal(cards[0].message.route.thread, main.route.thread);
    await post(`/sessions/${child.sessionId}/answer`, { id: pending.id, answer: { allow: true } });
    await f.manager.receive({
      ...mainMessage,
      id: crypto.randomUUID(),
      text: `/tab approve ${pending.id} allow`,
    });
    await f.manager.idle();
    await until(() => closed.length === 1);
    assert.equal(approved, 1);
    assert.match(closed[0]!, /已允许/);
    await post(`/sessions/${grand.sessionId}/messages`, { text: 'SAVE-PROGRESS' });
    await until(() => !!f.store.taskRecord(grand.taskId)?.progress);
    await f.manager.idle();
    assert.notEqual(f.store.taskRecord(grand.taskId)!.state, 'completed');
    assert.equal(f.store.taskRecord(grand.taskId)!.revision, 0);
    await post(`/sessions/${grand.sessionId}/messages`, { text: 'REPORT-FINAL' });
    await until(() => f.store.taskRecord(grand.taskId)?.state === 'completed');
    await f.manager.idle();
    await post(`/sessions/${child.sessionId}/messages`, { text: 'REPORT-FINAL' });
    await until(() => f.store.taskRecord(child.taskId)?.state === 'completed');
    await f.manager.idle();
    await f.manager.receive({
      ...mainMessage,
      id: crypto.randomUUID(),
      text: '当前主会话和子会话总共有多少个 session？',
    });
    assert.match(f.channel.sent.at(-1)!.text, /合计 3 个 session/);
    assert.ok(!f.channel.sent.at(-1)!.text.includes('只有 Manager'));
    await f.manager.receive({ ...mainMessage, id: crypto.randomUUID(), text: 'REPORT-FINAL' });
    await until(() => f.store.taskRecord(main.id)?.state === 'completed');
    await f.manager.idle();
    assert.equal(f.store.get(main.id)!.nativeId, native);
    assert.equal(f.store.get(child.sessionId)!.agent, 'claude');
    assert.equal(f.store.get(grand.sessionId)!.agent, 'opencode');
    assert.ok(
      f.agent.inputs
        .filter((r) => r.session.id === main.id)
        .every((r) => r.session.nativeId === native),
    );
    assert.equal(
      new Set([
        native,
        f.store.get(child.sessionId)!.nativeId,
        f.store.get(grand.sessionId)!.nativeId,
      ]).size,
      3,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('task tools adopt a legacy tree in place, preserve stable links, reject idle/cross-task mutation and clear no history', async () => {
  const f = fixture();
  let bridge: any, created: any;
  f.agent.handler = async (run) => {
    run.hooks.nativeId('preserved');
    bridge = run.taskBridge;
    const response: any = await tool(run, 'task_create', {
      key: 'one',
      title: '子任务',
      objective: '目标',
      criteria: '验证',
      start: false,
    });
    assert.ok(!response.isError);
    created = JSON.parse(response.content[0].text);
  };
  try {
    const m = incoming('拆分任务', 'alice', '');
    const session = f.store.create(m.route, 'codex', f.dir);
    session.nativeId = 'preserved';
    f.store.save(session);
    await f.manager.receive(m);
    await f.manager.idle();
    assert.equal(f.store.get(session.id)!.nativeId, 'preserved');
    assert.equal(created.parentId, session.id);
    assert.equal(
      f.manager.taskCatalog().find((n) => n.id === session.id)!.key,
      `session:${session.id}`,
    );
    const fakeRun = { taskBridge: bridge };
    const rejected: any = await tool(fakeRun, 'task_cancel', { taskId: created.id });
    assert.equal(rejected.isError, true);
    for (const [name, args] of [
      ['task_experience', { query: '' }],
      ['task_report_read', { reportId: created.id }],
    ] as const) {
      const read: any = await tool(fakeRun, name, args);
      assert.equal(read.isError, true);
      assert.match(read.content[0].text, /有效执行轮/);
    }
    assert.equal(f.store.taskRecord(created.id)!.state, 'waiting');
    assert.equal(f.store.taskJobs().length, 0);
  } finally {
    await f.cleanup();
  }
});

test('reset API protects revisions and resets task context without replacing task/session or replaying jobs', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'old-native';
    f.store.save(s);
    f.manager.tasks.adoptSession(s.id);
    const info = f.manager.resetInfo(s.id);
    await assert.rejects(f.manager.resetSession(s.id, 'stale'), /变化/);
    const fresh = await f.manager.resetSession(s.id, info.revision);
    assert.equal(fresh.id, s.id);
    assert.equal(fresh.taskId, s.id);
    assert.equal(fresh.nativeId, undefined);
    assert.equal(f.store.taskRecord(s.id)!.sessionId, s.id);
    assert.equal(f.store.taskJobs().length, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(
      JSON.parse(f.store.latestEvent(s.id, 'context_reset')!.text).previousNativeId,
      'old-native',
    );
  } finally {
    await f.cleanup();
  }
});

test('connector startup rejection or timeout is isolated, and late startup cannot restore a failed connector', async () => {
  const states: any[] = [],
    good: any = { async start() {}, async stop() {} },
    bad: any = {
      async start() {
        throw Error('Bearer hidden');
      },
      async stop() {},
    };
  await Promise.all([
    startChannel(
      good,
      async () => {},
      (s) => states.push(s),
    ),
    startChannel(
      bad,
      async () => {},
      (s) => states.push(s),
    ),
  ]);
  assert.equal(states.filter((s) => s.state === 'ready').length, 1);
  assert.equal(states.filter((s) => s.state === 'error').length, 1);
  assert.ok(!JSON.stringify(states).includes('hidden'));
  let release!: () => void,
    stops = 0;
  const stalled: any = {
    async start() {
      await new Promise<void>((r) => {
        release = r;
      });
    },
    async stop() {
      stops++;
    },
  };
  await startChannel(
    stalled,
    async () => {},
    (s) => states.push(s),
    10,
  );
  release();
  await until(() => stops === 2);
  assert.equal(states.at(-1).state, 'error');
});

test('real runtime keeps authenticated Dashboard available when connector construction fails', async () => {
  const f = fixture(),
    config = structuredClone(f.config);
  await f.cleanup();
  const dir = mkdtempSync(join(tmpdir(), 'genesis-dual-runtime-'));
  config.dataDir = join(dir, 'data');
  config.workspaces = { default: dir };
  config.channels = [
    {
      type: 'lark',
      id: 'broken',
      allowedUsers: ['alice'],
      appIdEnv: 'GENESIS_TEST_MISSING_APP_ID_915',
      appSecretEnv: 'GENESIS_TEST_MISSING_SECRET_915',
      domain: 'feishu',
    },
  ];
  const reserve = createServer();
  await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
  config.port = (reserve.address() as any).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  let close: (() => Promise<void>) | undefined;
  try {
    close = await serve(config);
    const response = await fetch(`http://127.0.0.1:${config.port}/api/state`, {
      headers: {
        Authorization: 'Bearer ' + readFileSync(join(config.dataDir, 'token'), 'utf8').trim(),
      },
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.channels[0].connection.state, 'error');
    assert.equal(state.agentCatalog.length, 3);
  } finally {
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('IM topic failure does not block Web task execution, and explicit same-Bot publication preserves session/native/tree', async () => {
  const f = fixture();
  let calls = 0;
  const ids: string[] = [];
  const create = f.channel.createTopic.bind(f.channel);
  f.channel.createTopic = async (m) => {
    calls++;
    ids.push(m.id);
    if (calls === 1) throw Error('ambiguous secret');
    return create(m);
  };
  try {
    const main = f.store.create(incoming('', 'alice', 'om_root').route, 'codex', f.dir);
    main.nativeId = 'parent-native';
    f.store.save(main);
    const child = await f.manager.createDashboardTask(
      { key: 'offline', title: '离线子任务', objective: '继续开发', start: false },
      `session:${main.id}`,
    );
    const session = f.store.get(child.sessionId!)!;
    assert.equal(session.imEntry!.state, 'unknown');
    assert.equal(calls, 1);
    f.manager.submit(session.id, '继续开发');
    await until(() => f.agent.inputs.length === 1);
    await f.manager.idle();
    const native = f.store.get(session.id)!.nativeId,
      revision = f.manager.maintenanceInfo(session.id).revision;
    await assert.rejects(f.manager.publishTaskEntry(session.id, revision), /核对/);
    assert.equal(calls, 1);
    const attached = await f.manager.publishTaskEntry(session.id, revision, true);
    assert.equal(attached.id, session.id);
    assert.equal(attached.nativeId, native);
    assert.equal(attached.imEntry, undefined);
    assert.ok(attached.route.thread.startsWith('om_'));
    assert.equal(f.store.current(attached.route)!.id, session.id);
    assert.equal(f.store.current(session.route), undefined);
    assert.equal(f.store.taskRecord(child.taskId!)!.route.thread, attached.route.thread);
    assert.equal(
      f.manager.taskCatalog().find((t) => t.taskId === child.taskId)!.parentKey,
      `session:${main.id}`,
    );
    await f.manager.publishTaskEntry(session.id, revision, true);
    assert.equal(calls, 2);
    assert.equal(new Set(ids).size, 1);
    assert.equal(f.store.get(main.id)!.nativeId, 'parent-native');
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('each task can change its supported workspace without changing existing children, and new children inherit that parent', async () => {
  const f = fixture();
  const fs = await import('node:fs');
  const next = join(f.dir, 'next');
  fs.mkdirSync(next);
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    main.nativeId = 'keep';
    f.store.save(main);
    const child = await f.manager.createDashboardTask(
      { key: 'one', title: '子任务', objective: '目标' },
      `session:${main.id}`,
    );
    const updated = f.manager.replaceMainWorkspace(child.sessionId!, next);
    assert.equal(updated.workspace, next);
    assert.equal(f.store.taskRecord(child.taskId!)!.workspace, next);
    const grand = await f.manager.createDashboardTask(
      { key: 'two', title: '下级', objective: '目标' },
      child.key,
    );
    assert.equal(grand.workspace, next);
    assert.equal(f.store.get(main.id)!.workspace, f.dir);
    assert.equal(f.store.get(main.id)!.nativeId, 'keep');
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Codex adapter resumes an old thread with a scoped MCP bridge and never creates a replacement context', async () => {
  const f = fixture();
  const fs = await import('node:fs'),
    { CodexAdapter } = await import('../src/agents/codex.js');
  const executable = join(f.dir, 'codex.mjs');
  fs.copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
  fs.chmodSync(executable, 0o755);
  const adapter = new CodexAdapter(executable);
  f.agent.handler = (r) => adapter.run(r);
  try {
    const m = incoming('continue'),
      s = f.store.create(m.route, 'codex', f.dir);
    s.nativeId = 'native-test-1';
    f.store.save(s);
    await f.manager.receive(m);
    await f.manager.idle();
    const trace = fs
        .readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
      resume = trace.find((m) => m.method === 'thread/resume');
    assert.equal(resume.params.threadId, 'native-test-1');
    assert.ok(resume.params.config['mcp_servers.tab_ai_tasks'].url.startsWith('http://127.0.0.1:'));
    assert.ok(
      resume.params.config['mcp_servers.tab_ai_tasks'].http_headers.Authorization.startsWith(
        'Bearer ',
      ),
    );
    assert.equal(trace.filter((m) => m.method === 'thread/start').length, 0);
    assert.equal(f.store.get(s.id)!.nativeId, 'native-test-1');
    assert.equal(f.store.get(s.id)!.codexTaskTools, 'mcp');
    assert.equal(f.store.get(s.id)!.taskId, undefined); // Tool discovery alone does not adopt or schedule old work.
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});

test('a blocked IM text does not hide a pending question from Web or turn delivery timeout into native task failure', async () => {
  const f = fixture();
  f.config.turnTimeoutMs = 200;
  f.channel.send = async () => new Promise<void>(() => {});
  let answered = 0;
  f.agent.handler = async (run) => {
    run.hooks.nativeId('keep');
    run.hooks.text('IM transport is stalled');
    await run.hooks.ask({ kind: 'approval', title: '网页应立即可见', detail: '测试' }, run.signal);
    answered++;
  };
  try {
    await f.manager.receive(incoming('run'));
    await until(() => f.manager.interactions().length === 1);
    const pending = f.manager.interactions()[0]!;
    f.manager.answer(pending.sessionId, pending.id, { allow: true });
    await f.manager.idle();
    assert.equal(answered, 1);
    assert.equal(f.store.get(pending.sessionId)!.status, 'idle');
    assert.equal(f.store.get(pending.sessionId)!.nativeId, 'keep');
    assert.equal(f.agent.inputs.length, 1);
    assert.ok(f.store.events(pending.sessionId).some((e) => e.type === 'delivery_error'));
  } finally {
    await f.cleanup();
  }
});

test('a legacy report staged before task adoption is retained as progress without waking the parent', async () => {
  const f = fixture();
  f.agent.handler = async (run) => {
    run.hooks.nativeId('legacy-child');
    const staged: any = await tool(run, 'topic_report', {
      kind: 'progress',
      summary: '保留已暂存的阶段成果',
      artifacts: [],
      issues: [],
      completionEvidence: '',
    });
    assert.ok(!staged.isError);
    assert.ok(!((await tool(run, 'task_list')) as any).isError);
  };
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir, undefined, {
        conversationType: 'group',
      }),
      m = incoming('保存阶段进度', 'alice', 'om_child'),
      child = f.store.create(m.route, 'codex', f.dir, undefined, { conversationType: 'group' });
    child.parentSessionId = main.id;
    f.store.save(child);
    await f.manager.receive(m);
    await f.manager.idle();
    assert.equal(f.store.taskRecord(child.id)!.progress!.summary, '保留已暂存的阶段成果');
    assert.equal(f.store.taskRecord(child.id)!.state, 'waiting');
    assert.equal(f.store.get(child.id)!.nativeId, 'legacy-child');
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.taskJobs().length, 0);
  } finally {
    await f.cleanup();
  }
});
