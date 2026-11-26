import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createDashboard } from '../src/web/server.js';
import { fixture, incoming } from './helpers.js';
import { usageInformation } from '../src/core/token-usage.js';

test('session usage API and list summaries agree with chat, paginate runs, reject unauthenticated reads and remain read-only', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'token');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: 'Bearer token' };
  try {
    f.agent.handler = async ({ hooks }) => {
      hooks.nativeId('native-1');
      const input = f.agent.inputs.length * 100;
      const value = {
        source: 'codex' as const,
        totalScope: 'session' as const,
        total: {
          inputTokens: input,
          outputTokens: 20,
          cachedInputTokens: 80,
          cacheWriteInputTokens: 5,
        },
        contextTokens: 50,
        modelContextWindow: 200,
      };
      hooks.usage?.(value);
      hooks.usage?.(value);
      hooks.text('done');
    };
    for (const text of ['第一轮', '第二轮']) {
      await f.manager.receive(incoming(text));
      await f.manager.idle();
    }
    const session = f.store.current(incoming('').route)!;
    const before = JSON.stringify(f.store.get(session.id));
    const path = `/api/sessions/${session.id}/usage?limit=1`;
    assert.equal((await fetch(base + path)).status, 401);
    const page = (await fetch(base + path, { headers }).then((r) => r.json())) as any;
    assert.deepEqual(page.tokenInformation, JSON.parse(JSON.stringify(usageInformation(session))));
    assert.equal(page.tokenInformation.cumulative.input, '205');
    assert.equal(page.tokenInformation.currentRound.input, '100');
    assert.equal(page.runs.length, 1);
    assert.equal(page.runs[0].information.input, '100');
    assert.ok(!('baseline' in page.runs[0]));
    const older = (await fetch(
      base + `/api/sessions/${session.id}/usage?limit=1&before=${page.nextBefore}`,
      { headers },
    ).then((r) => r.json())) as any;
    assert.notEqual(older.runs[0].runId, page.runs[0].runId);
    assert.equal(
      (await fetch(base + `/api/sessions/${session.id}/usage?limit=51`, { headers })).status,
      400,
    );
    const state = (await fetch(base + '/api/state', { headers }).then((r) => r.json())) as any;
    assert.equal(state.sessionUsage[session.id].cumulative.input, '205');
    assert.equal(JSON.stringify(f.store.get(session.id)), before);
    assert.equal(f.agent.inputs.length, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('dashboard requires a token and rejects cross-origin/rebinding requests', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'test-secret');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number },
    base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer invalid' } })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/api/state`, {
          headers: { Authorization: 'Bearer test-secret', Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    // Fetch normalizes Host; use a raw HTTP request to exercise DNS rebinding protection.
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${base}/api/state`,
        { headers: { Authorization: 'Bearer test-secret', Host: 'evil.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(hostStatus, 403);
    const response = await fetch(`${base}/api/state`, {
      headers: { Authorization: 'Bearer test-secret' },
    });
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(await response.json()).includes('TEST_APP_SECRET'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
test('dashboard session creation and message submission execute the selected native session', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'token');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number },
    base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, data: unknown) =>
    fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  try {
    const created = await request('/sessions', { agent: 'claude', workspace: 'default' });
    assert.equal(created.status, 201);
    const session = (await created.json()) as { id: string };
    const text = '  exact\n<xml>&data';
    assert.equal((await request(`/sessions/${session.id}/messages`, { text })).status, 200);
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.text, text);
    assert.equal(f.agent.inputs[0]!.session.agent, 'claude');
    const events = (await fetch(`${base}/api/sessions/${session.id}/events`, {
      headers: { Authorization: 'Bearer token' },
    }).then((r) => r.json())) as { type: string; text: string }[];
    assert.ok(events.some((e) => e.type === 'assistant' && e.text === `Answer: ${text}`));
    assert.equal((await request('/sessions', { agent: 'codex', workspace: '/etc' })).status, 400);
    assert.equal(
      (await request('/sessions', { agent: 'arbitrary-executable', workspace: 'default' })).status,
      400,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('authenticated begin resumes the preserved initial task once without resetting its directory', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const s = f.store.create(
      {
        platform: 'local',
        account: 'dashboard',
        conversation: 'main',
        thread: '',
        sender: 'local-owner',
      },
      'codex',
      f.dir,
    );
    s.pendingInitialTask = 'preserved task';
    f.store.save(s);
    const url = `${base}/api/sessions/${s.id}/begin`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer token' } })).status,
      200,
    );
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.agent.inputs[0]!.text, 'preserved task');
    assert.equal(f.agent.inputs[0]!.session.workspace, f.dir);
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer token' } })).status,
      400,
    );
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('dashboard bot details persist validated local labels and directories without exposing credentials', async () => {
  const { SetupService } = await import('../src/setup/service.js');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = fixture(),
    file = join(f.dir, 'tab-ai.config.json');
  writeFileSync(file, JSON.stringify(f.config));
  const setup = new SetupService(file),
    server = createDashboard(f.manager, 'token', setup);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (data: unknown, auth = true) =>
    fetch(base + '/api/channels/test-lark/details', {
      method: 'POST',
      headers: auth ? { Authorization: 'Bearer token' } : {},
      body: JSON.stringify(data),
    });
  try {
    assert.equal(
      (await post({ displayName: 'tab-ai A', defaultWorkspace: 'default' }, false)).status,
      401,
    );
    assert.equal(
      (await post({ displayName: 'tab-ai A', defaultWorkspace: 'missing-directory' })).status,
      400,
    );
    assert.equal(
      (
        await post({
          displayName: 'tab-ai A',
          defaultWorkspace: 'default',
          allowedUsers: ['mallory'],
        })
      ).status,
      400,
    );
    assert.equal(
      (await post({ displayName: 'tab-ai A', defaultWorkspace: 'default' })).status,
      200,
    );
    assert.equal(f.config.channels[0]!.displayName, 'tab-ai A');
    assert.equal(f.config.channels[0]!.defaultWorkspace, f.dir);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).channels[0].displayName, 'tab-ai A');
    const state = (await (
      await fetch(base + '/api/state', { headers: { Authorization: 'Bearer token' } })
    ).json()) as any;
    assert.equal(state.channels[0].allowedUserCount, 2);
    assert.ok(!JSON.stringify(state).includes('TEST_APP_SECRET'));
    assert.equal(state.channels[0].allowedUsers, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await setup.close();
    await f.cleanup();
  }
});

test('dashboard child creation reopens completed ancestors, inherits workspace and task messages use durable jobs', async () => {
  const { incoming, until } = await import('./helpers.js');
  const f = fixture();
  f.agent.handler = async (run) => {
    run.hooks.nativeId('native-' + run.session.id);
  };
  const server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, data: unknown, auth = true) =>
    fetch(base + '/api' + path, {
      method: 'POST',
      headers: auth ? { Authorization: 'Bearer token' } : {},
      body: JSON.stringify(data),
    });
  try {
    const source = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const t = await f.manager.createTask({
      sourceSessionId: source.id,
      key: 'dashboard',
      title: 'root',
      objective: 'root',
    });
    await until(() => f.store.taskRecord(t.id)?.state === 'waiting');
    await f.manager.idle();
    f.manager.tasks.report(t.sessionId!, {
      summary: 'previously done',
      artifacts: [],
      checks: [],
      issues: [],
    });
    const input = { key: 'child', title: 'child', objective: 'child', criteria: 'done' };
    assert.equal((await post(`/tasks/${t.id}/children`, input, false)).status, 401);
    const response = await post(`/tasks/${t.id}/children`, input);
    assert.equal(response.status, 201);
    const c = (await response.json()) as any;
    assert.equal(c.parentId, t.id);
    assert.equal(c.workspace, t.workspace);
    assert.equal(f.store.taskRecord(t.id)?.state, 'waiting');
    assert.equal(f.store.taskRecord(t.id)?.result, undefined);
    const duplicate = (await (await post(`/tasks/${t.id}/children`, input)).json()) as any;
    assert.equal(duplicate.id, c.id);
    await until(() => f.store.taskRecord(c.id)?.state === 'waiting');
    await post(`/sessions/${c.sessionId}/messages`, { text: 'dashboard followup' });
    await until(() =>
      f.agent.inputs.some((i) => i.text.startsWith('dashboard followup\n\n【任务分支索引')),
    );
    assert.ok(f.store.taskJobs().some((j) => j.taskId === c.id && j.text === 'dashboard followup'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('usage API and state summaries aggregate task resets and descendant subtask totals without mutating state', async () => {
  const { incoming, until } = await import('./helpers.js');
  const f = fixture();
  f.agent.handler = async (run) => {
    run.hooks.nativeId(
      run.session.nativeId ?? 'native-' + run.session.id + '-' + f.agent.inputs.length,
    );
    run.hooks.usage?.({
      source: 'codex',
      totalScope: 'session',
      total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 },
      contextTokens: 500,
      modelContextWindow: 2000,
    });
    run.hooks.text('done');
  };
  const server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: 'Bearer token' };
  try {
    const source = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const root = await f.manager.createTask({
      sourceSessionId: source.id,
      key: 'root-usage',
      title: '父任务',
      objective: 'root',
    });
    await until(() => f.store.taskRecord(root.id)?.state === 'waiting');
    await f.manager.idle();
    await until(() => f.store.get(root.sessionId!)?.tokenLedger?.current.status === 'completed');

    // Reset parent session once and run a second context
    const resetInfo = f.manager.resetInfo(root.sessionId!);
    await f.manager.resetSession(root.sessionId!, resetInfo.revision);
    await fetch(base + `/api/sessions/${root.sessionId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'parent turn 2' }),
    });
    await until(() => f.store.get(root.sessionId!)?.tokenLedger?.current.status === 'completed');
    await f.manager.idle();

    const childRes = await fetch(base + `/api/tasks/${root.id}/children`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: 'child-usage',
        title: '子任务',
        objective: 'child',
        criteria: 'ok',
      }),
    });
    const child = (await childRes.json()) as any;
    await until(() => f.store.taskRecord(child.id)?.state === 'waiting');
    await f.manager.idle();
    await until(() => f.store.get(child.sessionId)?.tokenLedger?.current.status === 'completed');

    const before = JSON.stringify(f.store.get(root.sessionId!));
    const state = (await fetch(base + '/api/state', { headers }).then((r) => r.json())) as any;
    const summary = state.sessionUsage[root.sessionId!];
    assert.equal(summary.resets, 1);
    assert.equal(summary.cumulative.total, '1,200');
    assert.equal(summary.taskCumulative.total, '2,400');
    assert.equal(summary.subtree.descendantCount, 1);
    assert.equal(summary.subtree.total.total, '3,600');
    assert.equal(summary.subtree.children, undefined);

    const usage = (await fetch(base + `/api/sessions/${root.sessionId}/usage`, { headers }).then(
      (r) => r.json(),
    )) as any;
    assert.equal(usage.tokenInformation.taskCumulative.total, '2,400');
    assert.equal(usage.tokenInformation.subtree.total.total, '3,600');
    assert.equal(usage.tokenInformation.subtree.children.length, 1);
    assert.equal(usage.tokenInformation.subtree.children[0].title, '子任务');
    assert.equal(usage.tokenInformation.subtree.children[0].task.total, '1,200');
    assert.equal(JSON.stringify(f.store.get(root.sessionId!)), before);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
