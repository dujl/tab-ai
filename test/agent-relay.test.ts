import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { rmSync, readdirSync, statSync } from 'node:fs';
import { fixture, incoming, until } from './helpers.js';
import { Store } from '../src/core/store.js';
import { createDashboard } from '../src/web/server.js';
import { relayKey } from '../src/web/public/agent-relay.js';
import { agentPlans } from '../src/core/agent-plans.js';

const draft = (summary = '已完成接口，测试待续。') => ({
  summary,
  deliverables: [],
  specifications: [],
  validation: [],
  risks: [],
  remainingWork: ['验证接口'],
  nextSteps: ['先读取规格，再核对产物'],
  lessons: [],
});
function setup() {
  const f = fixture();
  let sequence = 0;
  f.agent.handler = async (r) => {
    r.hooks.nativeId(r.session.nativeId ?? `native-${++sequence}`);
    r.hooks.input?.({ text: r.text, nativeId: r.session.nativeId });
    r.hooks.usage?.({
      source: r.session.agent,
      total: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      totalScope: 'session',
      complete: true,
    });
    r.hooks.text(`已处理 ${r.session.agent}`);
  };
  (f.manager.reports as any).writer = {
    async generate() {
      return draft();
    },
  };
  return f;
}
async function ready(f: ReturnType<typeof setup>, stageId: string) {
  await until(() => {
    const s = f.store.stages.get(stageId);
    return !!s?.inputReportId && f.store.reports.get(s.inputReportId)?.state === 'ready';
  });
}

test('relay archives verified native-history usage from legacy sessions without requiring a new turn', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'legacy-native';
    f.store.save(s);
    (f.agent as any).historicalUsage = (session: typeof s) =>
      session.nativeId === 'legacy-native'
        ? {
            nativeId: session.nativeId,
            at: Date.now(),
            origin: 'native-history',
            value: {
              source: 'codex',
              totalScope: 'session',
              total: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
            },
          }
        : undefined;
    const stage = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'legacy-usage' });
    await ready(f, stage.id);
    await f.manager.relay.confirm(s.id, stage.id);
    assert.equal(f.store.get(s.id)!.archivedTokenUsage!.aggregate!.total, 350);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('relay barriers, same logical identity, new contexts and report submission through Codex → Claude → Codex', async () => {
  const f = setup();
  try {
    const m = incoming('开发接口');
    await f.manager.receive(m);
    await f.manager.idle();
    const original = f.store.current(m.route)!;
    let release!: () => void;
    (f.manager.reports as any).writer = {
      async generate() {
        await new Promise<void>((r) => (release = r));
        return draft();
      },
    };
    const b = await f.manager.relay.prepare(original.id, { agent: 'claude', key: 'relay-b' });
    assert.equal(f.agent.inputs.length, 1);
    await assert.rejects(f.manager.relay.confirm(original.id, b.id), /尚未就绪/);
    assert.equal(f.store.get(original.id)!.nativeId, original.nativeId);
    await until(() => !!release);
    release();
    await ready(f, b.id);
    const unrelated = f.store.create(incoming('', 'bob').route, 'codex', f.dir);
    f.store.event(unrelated.id, 'user', '另一会话的并行记录');
    const before = f.agent.inputs.length;
    await f.manager.relay.confirm(original.id, b.id);
    const current = f.store.get(original.id)!;
    assert.equal(current.id, original.id);
    assert.equal(current.agent, 'claude');
    assert.equal(current.nativeId, undefined);
    assert.equal(current.workspace, original.workspace);
    assert.equal(
      f.store.stages.get(b.id)!.startEventId,
      f.store.latestEvent(current.id, 'stage_changed')!.id,
    );
    assert.equal(f.agent.inputs.length, before);
    assert.equal(f.store.stages.get(original.currentStageId!)!.nativeId, original.nativeId);
    f.manager.submit(current.id, '继续测试');
    await f.manager.idle();
    assert.match(f.agent.inputs.at(-1)!.text, /task_report_read/);
    assert.match(f.agent.inputs.at(-1)!.text, new RegExp(b.inputReportId!));
    assert.notEqual(f.store.get(current.id)!.nativeId, original.nativeId);
    assert.equal(f.store.stages.get(b.id)!.transition!.phase, 'submitted');
    assert.ok(
      f.store
        .events(current.id)
        .some(
          (e) =>
            e.type === 'agent_input' &&
            e.stageId === b.id &&
            JSON.parse(e.text).status === 'submitted',
        ),
    );
    (f.manager.reports as any).writer = {
      async generate() {
        return draft('阶段 B 已核对接口，待完善测试。');
      },
    };
    const c = await f.manager.relay.prepare(current.id, { agent: 'codex', key: 'relay-c' });
    await ready(f, c.id);
    await f.manager.relay.confirm(current.id, c.id);
    f.manager.submit(current.id, '完成剩余工作');
    await f.manager.idle();
    const stages = f.store.stages.list(current.id);
    assert.equal(stages.length, 3);
    assert.equal(stages[0].state, 'ended');
    assert.equal(stages[1].state, 'ended');
    assert.equal(stages[2].state, 'active');
    assert.equal(stages[2].sourceStageId, b.id);
    assert.notEqual(stages[2].nativeId, stages[0].nativeId);
    assert.match(f.agent.inputs.at(-1)!.text, new RegExp(c.inputReportId!));
    assert.equal(f.store.get(current.id)!.archivedTokenUsage!.relays, 2);
    assert.equal(f.store.get(current.id)!.archivedTokenUsage!.resets, 0);
    assert.equal(f.manager.usageInformation(current.id)!.taskCumulative.total, '360');
    assert.equal(f.store.usage.list(current.id).runs.length, 3);
    assert.equal(f.store.reports.list(current.id).length, 2);
  } finally {
    await f.cleanup();
  }
});

test('relay previews are idempotent, reject stale evidence and stay within their Session', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir),
      other = f.store.create(incoming('', 'bob').route, 'codex', f.dir);
    const b = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'same' });
    assert.equal((await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'same' })).id, b.id);
    await assert.rejects(f.manager.relay.prepare(s.id, { agent: 'opencode', key: 'same' }), /不同/);
    await ready(f, b.id);
    await assert.rejects(f.manager.relay.confirm(other.id, b.id), /本会话/);
    f.store.event(s.id, 'user', '新增约束');
    await assert.rejects(f.manager.relay.confirm(s.id, b.id), /过期/);
    assert.equal(f.store.get(s.id)!.agent, 'codex');
    f.manager.relay.cancel(s.id, b.id);
    await assert.rejects(f.manager.relay.confirm(s.id, b.id), /预览已结束/);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('facts-only reports need explicit acceptance and relay does not wake parents or mark tasks complete', async () => {
  const f = setup();
  try {
    (f.manager.reports as any).writer = {
      async generate() {
        throw Error('provider unavailable');
      },
    };
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    f.manager.tasks.adoptSession(s.id);
    const before = f.store.get(s.id)!,
      task = f.store.taskRecord(before.taskId!)!;
    const b = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'facts' });
    await ready(f, b.id);
    await assert.rejects(f.manager.relay.confirm(s.id, b.id), /事实版/);
    await f.manager.relay.confirm(s.id, b.id, true);
    assert.equal(f.store.taskRecord(task.id)!.agent, 'claude');
    assert.notEqual(f.store.taskRecord(task.id)!.state, 'completed');
    assert.equal(f.store.get(s.id)!.taskId, task.id);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.topicUpdates().length, 0);
    assert.ok(f.store.reports.get(b.inputReportId!)!.uses!.some((u) => u.targetStageId === b.id));
  } finally {
    await f.cleanup();
  }
});

test('failed submission becomes unconfirmed, blocks automatic retry and requires a recorded user decision', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const b = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'unconfirmed' });
    await ready(f, b.id);
    await f.manager.relay.confirm(s.id, b.id);
    f.agent.handler = async () => {
      throw Error('connection ended before acknowledgement');
    };
    f.manager.submit(s.id, '继续');
    await f.manager.idle();
    assert.equal(f.store.stages.get(b.id)!.transition!.phase, 'unconfirmed');
    assert.throws(() => f.manager.submit(s.id, '继续'), /未确认/);
    f.manager.relay.resolveInput(s.id, b.id, 'retry');
    assert.equal(f.store.stages.get(b.id)!.transition!.phase, 'awaiting_input');
    assert.ok(f.store.events(s.id).some((e) => e.type === 'relay_resolution'));
  } finally {
    await f.cleanup();
  }
});

test('close and relay share a report version when evidence and task state are unchanged', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const b = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'close-report' });
    await ready(f, b.id);
    const id = b.inputReportId!;
    f.manager.relay.cancel(s.id, b.id);
    f.manager.closeSession(s.id);
    await f.manager.idle();
    assert.equal(f.store.reports.list(s.id).length, 1);
    assert.equal(f.store.reports.list(s.id)[0].id, id);
    assert.ok(f.store.reports.get(id)!.uses!.some((u) => u.kind === 'close'));
  } finally {
    await f.cleanup();
  }
});

test('all-channel messages queue durably during activation and execute after the target report is ready', async () => {
  const f = setup();
  let release!: () => void;
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const b = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'queue' });
    await ready(f, b.id);
    (f.agent as any).release = async () => new Promise<void>((r) => (release = r));
    const confirming = f.manager.relay.confirm(s.id, b.id);
    await until(() => !!release);
    await f.manager.receive({ ...incoming('接力期间的新要求'), route: s.route });
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.stages.get(b.id)!.transition!.queue.length, 1);
    release();
    await confirming;
    await until(() => f.agent.inputs.length === 1);
    await f.manager.idle();
    assert.equal(f.agent.inputs[0].session.agent, 'claude');
    assert.match(f.agent.inputs[0].text, /接力期间的新要求/);
    await until(() => f.store.stages.get(b.id)!.transition!.queue.length === 0);
    delete (f.agent as any).release;
  } finally {
    delete (f.agent as any).release;
    await f.cleanup();
  }
});

test('stage migration backs up legacy state and preserves original native IDs, timestamps and unlabelled events', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'old-native';
    f.store.save(s);
    f.store.event(s.id, 'user', 'legacy');
    await f.manager.close();
    f.store.close();
    const db = new DatabaseSync(join(f.config.dataDir, 'state.sqlite'));
    db.exec('DROP TABLE agent_stages');
    const value = JSON.parse(
      String(db.prepare('SELECT data FROM sessions WHERE id=?').get(s.id)!.data),
    );
    delete value.currentStageId;
    delete value.executionRevision;
    db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(value), s.id);
    db.exec('UPDATE events SET stage_id=NULL');
    db.close();
    const reopened = new Store(f.config.dataDir);
    try {
      const current = reopened.get(s.id)!;
      assert.equal(current.nativeId, 'old-native');
      assert.equal(current.updatedAt, value.updatedAt);
      assert.equal(reopened.stages.list(s.id).length, 1);
      assert.equal(reopened.events(s.id)[0].stageId, null);
      const backups = readdirSync(join(f.config.dataDir, 'backups'));
      assert.equal(backups.length, 1);
      assert.equal(statSync(join(f.config.dataDir, 'backups', backups[0])).mode & 0o777, 0o600);
    } finally {
      reopened.close();
    }
  } finally {
    await f.manager.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('Web APIs validate relay targets, expose isolated previews and serve the LAN-compatible UI module', async () => {
  const f = setup(),
    server = createDashboard(f.manager, 'test-token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`,
    headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const unauth = await fetch(`${base}/api/sessions/${s.id}/relay`);
    assert.equal(unauth.status, 401);
    const response = await fetch(`${base}/api/sessions/${s.id}/relay`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'prepare', agent: 'claude', key: randomUUID() }),
    });
    assert.equal(response.status, 202);
    const { stage } = await response.json();
    await ready(f, stage.id);
    const state = await fetch(`${base}/api/sessions/${s.id}/relay`, { headers }).then((r) =>
      r.json(),
    );
    assert.equal(state.currentStageId, s.currentStageId);
    assert.equal(state.stages.at(-1).report.state, 'ready');
    f.store.event(s.id, 'user', 'stage-scoped input');
    const transcript = await fetch(
      `${base}/api/sessions/${s.id}/transcript?stage=${s.currentStageId}`,
      { headers },
    ).then((r) => r.json());
    assert.equal(transcript.events.length, 1);
    assert.equal(transcript.events[0].stageId, s.currentStageId);
    assert.equal(
      (await fetch(`${base}/api/sessions/${s.id}/transcript?stage=${randomUUID()}`, { headers }))
        .status,
      404,
    );
    const staticFile = await fetch(base + '/agent-relay.js');
    assert.equal(staticFile.status, 200);
    assert.match(await staticFile.text(), /relayKey/);
    const bytes = new Uint8Array(16).fill(1);
    assert.match(
      relayKey({
        getRandomValues(a: Uint8Array) {
          a.set(bytes);
          return a;
        },
      } as any),
      /^[a-f0-9-]{36}$/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('IM relay commands use the same barrier and an immediate continuation is submitted once', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    await f.manager.receive({ ...incoming('/tab relay prepare claude continue'), route: s.route });
    const stage = f.store.stages.list(s.id).at(-1)!;
    assert.equal(stage.state, 'preparing');
    assert.equal(f.agent.inputs.length, 0);
    await ready(f, stage.id);
    await f.manager.receive({ ...incoming(`/tab relay confirm ${stage.id}`), route: s.route });
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.agent.inputs[0].session.agent, 'claude');
    await f.manager.receive({ ...incoming(`/tab relay confirm ${stage.id}`), route: s.route });
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('old plans and late adapter callbacks cannot appear in the new execution stage', async () => {
  const f = setup();
  try {
    let oldHooks: (typeof f.agent.inputs)[number]['hooks'];
    const original = f.agent.handler;
    f.agent.handler = async (r) => {
      oldHooks = r.hooks;
      await original(r);
      r.hooks.plan?.({ source: 'codex', steps: [{ text: '原阶段待办', status: 'pending' }] });
    };
    const m = incoming('开始');
    await f.manager.receive(m);
    await f.manager.idle();
    const s = f.store.current(m.route)!;
    const stage = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'late' });
    await ready(f, stage.id);
    await f.manager.relay.confirm(s.id, stage.id);
    const before = f.store.lastEventId(s.id);
    oldHooks!.nativeId('late-native');
    oldHooks!.text('late text');
    oldHooks!.usage?.({ source: 'codex', total: { inputTokens: 9999, outputTokens: 9999 } });
    oldHooks!.plan?.({ source: 'codex', steps: [{ text: '迟到待办', status: 'in_progress' }] });
    assert.equal(f.store.lastEventId(s.id), before);
    assert.equal(f.store.get(s.id)!.nativeId, undefined);
    const plans = agentPlans(f.store, f.store.get(s.id)!, { limit: 10 });
    assert.equal(plans.currentRun, undefined);
    assert.equal(plans.plans.length, 1);
    assert.equal(plans.plans[0].archived, true);
    assert.equal(plans.plans[0].current, false);
  } finally {
    await f.cleanup();
  }
});

test('activation failure retains queued messages until an explicit recovery decision', async () => {
  const f = setup();
  let reject!: (error: Error) => void;
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const stage = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'release-fail' });
    await ready(f, stage.id);
    (f.agent as any).release = () => new Promise<void>((_, r) => (reject = r));
    const confirming = f.manager.relay.confirm(s.id, stage.id);
    const rejected = assert.rejects(confirming, /release failed/);
    await until(() => !!reject);
    await f.manager.receive({ ...incoming('新的要求'), route: s.route });
    reject(Error('release failed'));
    await rejected;
    delete (f.agent as any).release;
    assert.equal(f.store.get(s.id)!.agent, 'codex');
    assert.equal(f.store.stages.get(stage.id)!.state, 'failed');
    assert.equal(f.agent.inputs.length, 0);
    f.manager.relay.resolveQueue(s.id, stage.id, 'resume');
    await until(() => f.agent.inputs.length === 1);
    await f.manager.idle();
    assert.equal(f.agent.inputs[0].session.agent, 'codex');
    assert.match(f.agent.inputs[0].text, /新的要求/);
  } finally {
    delete (f.agent as any).release;
    await f.cleanup();
  }
});

test('recovery never replays a submission or a processing queue message without a user decision', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const stage = await f.manager.relay.prepare(s.id, { agent: 'claude', key: 'recover-input' });
    await ready(f, stage.id);
    await f.manager.relay.confirm(s.id, stage.id);
    const active = f.store.stages.get(stage.id)!;
    active.transition!.phase = 'submitting';
    active.transition!.queue.push({
      id: randomUUID(),
      message: { ...incoming('未知请求'), route: s.route },
      state: 'processing',
    });
    f.store.stages.save(active);
    f.store.stages.recover();
    const recovered = f.store.stages.get(stage.id)!;
    assert.equal(recovered.transition!.phase, 'unconfirmed');
    assert.equal(recovered.transition!.queue[0].state, 'unconfirmed');
    assert.throws(() => f.manager.submit(s.id, '再次请求'), /未确认/);
    assert.equal(f.agent.inputs.length, 0);
    f.manager.relay.resolveInput(s.id, stage.id, 'acknowledge');
    f.manager.relay.resolveQueue(s.id, stage.id, 'dismiss');
    assert.equal(f.store.stages.get(stage.id)!.transition!.queue.length, 0);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
