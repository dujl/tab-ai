import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { executionRecords } from '../src/core/execution-records.js';
import { createDashboard } from '../src/web/server.js';
const query = { kind: 'approvals' as const, limit: 30, q: '' };
test('durable approval history reconstructs old decisions past transcript limits, keeps pending distinct and never fabricates an outcome', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir),
      id = s.id;
    for (const requestId of ['approved', 'refused', 'expired', 'orphan', 'live'])
      f.store.event(
        id,
        'interaction',
        JSON.stringify({
          id: requestId,
          sessionId: id,
          kind: 'approval',
          title: '执行命令',
          detail: 'python3 example.py',
          createdAt: 10,
        }),
      );
    for (let n = 0; n < 250; n++) f.store.event(id, 'activity', 'filler');
    f.store.event(id, 'decision', JSON.stringify({ id: 'approved', answer: { allow: true } }));
    f.store.event(id, 'decision', JSON.stringify({ id: 'refused', answer: { allow: false } }));
    f.store.event(id, 'interaction_timeout', JSON.stringify({ id: 'expired' }));
    f.store.event(
      id,
      'interaction',
      JSON.stringify({ id: 'question', kind: 'question', title: '选择对象' }),
    );
    const before = f.store.events(id, 10000).length;
    const pending = {
      id: 'live',
      sessionId: id,
      kind: 'approval' as const,
      title: '执行命令',
      detail: 'python3',
      createdAt: 10,
    };
    const records = executionRecords(f.store, id, query, [pending]),
      byId = new Map(records.items.map((r: any) => [r.request.id, r]));
    assert.equal(records.items.length, 5);
    assert.equal(byId.get('approved')!.status, 'allowed');
    assert.equal(byId.get('refused')!.status, 'denied');
    assert.equal(byId.get('expired')!.status, 'timed_out');
    assert.equal(byId.get('orphan')!.status, 'ended_unknown');
    assert.equal(byId.get('live')!.status, 'pending');
    assert.equal(f.store.events(id, 10000).length, before);
    assert.equal(executionRecords(f.store, id, { ...query, q: 'approved' }, []).items.length, 1);
  } finally {
    await f.cleanup();
  }
});
test('tool records paginate latest snapshots across all runs, preserving reused IDs, output and session isolation', async () => {
  const f = fixture();
  try {
    const a = f.store.create(incoming('').route, 'codex', f.dir),
      b = f.store.create(incoming('', 'bob').route, 'codex', f.dir);
    for (let n = 0; n < 35; n++) {
      f.store.event(
        a.id,
        'tool',
        JSON.stringify({
          runId: 'run-' + n,
          id: 'reused',
          name: 'shell',
          status: 'running',
          input: 'pwd',
        }),
      );
      f.store.event(
        a.id,
        'tool',
        JSON.stringify({
          runId: 'run-' + n,
          id: 'reused',
          name: 'shell',
          status: 'completed',
          input: 'pwd',
          output: 'output-' + n,
          exitCode: 0,
        }),
      );
    }
    f.store.event(
      b.id,
      'tool',
      JSON.stringify({
        runId: 'other',
        id: 'reused',
        name: 'shell',
        status: 'failed',
        output: 'private-other',
      }),
    );
    f.store.event(a.id, 'tool', 'invalid-json');
    f.store.event(a.id, 'tool', '{}');
    const first = executionRecords(f.store, a.id, { kind: 'tools', limit: 30, q: '' }, []),
      second = executionRecords(
        f.store,
        a.id,
        { kind: 'tools', limit: 30, q: '', before: first.nextBefore },
        [],
      );
    assert.equal(first.items.length, 30);
    assert.equal(second.items.length, 5);
    assert.equal(second.nextBefore, undefined);
    assert.ok(first.items.every((x: any) => x.status === 'completed' && x.exitCode === 0));
    assert.equal(new Set([...first.items, ...second.items].map((x: any) => x.runId)).size, 35);
    f.store.event(
      a.id,
      'tool',
      JSON.stringify({
        runId: 'nonzero',
        id: 'last',
        name: 'shell',
        status: 'completed',
        exitCode: 1,
      }),
    );
    assert.equal(
      executionRecords(f.store, a.id, { kind: 'tools', limit: 30, q: 'nonzero' }, []).items[0]!
        .status,
      'failed',
    );
    assert.ok(!JSON.stringify(first).includes('private-other'));
    assert.equal(
      executionRecords(f.store, a.id, { kind: 'tools', limit: 30, q: 'output-34' }, []).items
        .length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test('approval settlement writes terminal outcomes for allow, reject, interruption and timeout without claiming tool execution', async () => {
  const f = fixture();
  try {
    for (const outcome of ['allow', 'deny', 'cancel', 'timeout']) {
      f.config.interactionTimeoutMs = outcome === 'timeout' ? 30 : 1000;
      f.agent.handler = async (run) => {
        await run.hooks.ask({ kind: 'approval', title: 'Run', detail: 'pwd' }, run.signal);
      };
      await f.manager.receive(incoming(outcome, 'alice', 'thread-' + outcome));
      await until(() => f.manager.interactions().length === 1);
      const request = f.manager.interactions()[0]!;
      if (outcome === 'cancel') f.manager.stop(request.sessionId);
      else if (outcome !== 'timeout')
        f.manager.answer(request.sessionId, request.id, { allow: outcome === 'allow' });
      await f.manager.idle();
      const record = executionRecords(f.store, request.sessionId, query, []).items[0] as any;
      assert.equal(
        record.status,
        { allow: 'allowed', deny: 'denied', cancel: 'cancelled', timeout: 'timed_out' }[outcome],
      );
      assert.ok(record.settledAt);
      assert.equal(
        f.store.events(request.sessionId).filter((e) => e.type === 'interaction_closed').length,
        1,
      );
      assert.equal(
        executionRecords(f.store, request.sessionId, { ...query, kind: 'tools' }, []).items.length,
        0,
      );
    }
  } finally {
    await f.cleanup();
  }
});
test('record API is authenticated, validates paging and serves the records UI module', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'secret');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`,
    s = f.store.create(incoming('').route, 'codex', f.dir),
    url = base + `/api/sessions/${s.id}/records`,
    headers = { Authorization: 'Bearer secret' };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url + '?kind=tools&limit=51', { headers })).status, 400);
    assert.equal((await fetch(url + '?before=-1', { headers })).status, 400);
    assert.equal((await fetch(url + '?kind=invalid', { headers })).status, 400);
    assert.equal((await fetch(base + '/api/sessions/missing/records', { headers })).status, 404);
    assert.equal(
      ((await fetch(base + '/api/state', { headers }).then((r) => r.json())) as any)
        .executionRecords,
      true,
    );
    const records = await fetch(url, { headers }).then((r) => r.json());
    assert.deepEqual(records.items, []);
    assert.equal(records.kind, 'approvals');
    assert.equal(records.tokenInformation.context, '未上报');
    assert.equal(records.tokenInformation.total, '未上报累计值');
    assert.match(
      await fetch(base + '/dashboard.js').then((r) => r.text()),
      /export function createExecutionRecords/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
