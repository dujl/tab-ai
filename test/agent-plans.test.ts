import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter, type ClaudeQuery } from '../src/agents/claude.js';
import { ClaudePlans } from '../src/agents/claude-plans.js';
import { OpenCodeAdapter } from '../src/agents/opencode.js';
import { OpenCodeServer } from '../src/agents/opencode-server.js';
import { agentPlans, priorAgentPlan } from '../src/core/agent-plans.js';
import { Store } from '../src/core/store.js';
import { createDashboard } from '../src/web/server.js';
import { fixture, incoming, until } from './helpers.js';
import type { AgentPlan } from '../src/core/types.js';
const plan = (status: 'pending' | 'completed' = 'pending'): AgentPlan => ({
  source: 'codex',
  steps: [
    { text: '核对输入', status: 'completed' },
    { text: '执行回归', status },
  ],
});

test('Codex publishes only the active thread and turn plan, preserving pending steps after turn completion', async () => {
  const f = fixture(),
    file = join(f.dir, 'codex.mjs');
  copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), file);
  chmodSync(file, 0o755);
  const adapter = new CodexAdapter(file),
    updates: AgentPlan[] = [];
  try {
    const session = f.store.create(incoming('').route, 'codex', f.dir);
    await adapter.run({
      session,
      text: 'plans',
      signal: AbortSignal.timeout(3000),
      hooks: {
        nativeId: (id) => {
          session.nativeId = id;
        },
        activity() {},
        text() {},
        ask: async () => ({ allow: false }),
        plan: (p) => updates.push(p),
      },
    });
    assert.equal(updates.length, 2);
    assert.equal(updates[0]!.steps[0]!.status, 'in_progress');
    assert.deepEqual(
      updates[1]!.steps.map((s) => s.status),
      ['completed', 'pending'],
    );
    assert.equal(updates[0]!.nativeTurnId, 'turn-1');
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});

test('plans persist per session and run, deduplicate snapshots, paginate history and never auto-complete unfinished steps', async () => {
  const f = fixture();
  let finish!: () => void;
  Object.assign(f.agent, { supportsPlans: true });
  try {
    f.agent.handler = async (run) => {
      run.hooks.nativeId('same-native');
      run.hooks.plan?.(plan());
      run.hooks.plan?.(plan());
      await new Promise<void>((r) => (finish = r));
    };
    await f.manager.receive(incoming('第一轮'));
    await until(() => !!finish);
    const s = f.store.current(incoming('').route)!;
    let view = agentPlans(f.store, s, { limit: 10 });
    assert.equal(view.currentRun!.status, 'running');
    assert.equal(view.plans[0]!.runStatus, 'running');
    assert.equal(f.store.events(s.id).filter((e) => e.type === 'agent_plan').length, 1);
    assert.equal(priorAgentPlan(f.store, s)!.steps[1]!.status, 'pending');
    finish();
    await f.manager.idle();
    view = agentPlans(f.store, f.store.get(s.id)!, { limit: 10 });
    assert.equal(view.plans[0]!.runStatus, 'completed');
    assert.equal(view.plans[0]!.steps[1]!.status, 'pending');
    f.agent.handler = async (run) => {
      run.hooks.plan?.(plan('completed'));
    };
    await f.manager.receive(incoming('第二轮'));
    await f.manager.idle();
    const first = agentPlans(f.store, f.store.get(s.id)!, { limit: 1 }),
      second = agentPlans(f.store, f.store.get(s.id)!, { limit: 1, before: first.nextBefore });
    assert.equal(first.plans.length, 1);
    assert.equal(second.plans.length, 1);
    assert.notEqual(first.plans[0]!.runId, second.plans[0]!.runId);
    assert.equal(second.plans[0]!.steps[1]!.status, 'pending');
    f.agent.handler = async () => {};
    await f.manager.receive(incoming('无计划轮次'));
    await f.manager.idle();
    view = agentPlans(f.store, f.store.get(s.id)!, { limit: 10 });
    assert.ok(!view.plans.some((p) => p.current));
    assert.equal(view.plans.length, 2);
    const other = f.store.create(incoming('', 'bob', 'elsewhere').route, 'codex', f.dir);
    assert.equal(agentPlans(f.store, other, { limit: 10 }).plans.length, 0);
    f.store.event(s.id, 'context_reset', '{}');
    assert.equal(priorAgentPlan(f.store, f.store.get(s.id)!), undefined);
    view = agentPlans(f.store, f.store.get(s.id)!, { limit: 10 });
    assert.equal(view.currentRun, undefined);
    assert.ok(view.plans.every((p) => p.archived));
  } finally {
    finish?.();
    await f.cleanup();
  }
});

test('interruption and restart keep reported plan statuses without showing a stale step as currently executing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-plan-restart-'));
  let store = new Store(dir);
  try {
    const s = store.create(incoming('').route, 'codex', dir);
    s.status = 'running';
    store.save(s);
    store.event(
      s.id,
      'agent_run',
      JSON.stringify({
        runId: 'r',
        agent: 'codex',
        title: 'work',
        status: 'running',
        startedAt: 0,
      }),
    );
    store.event(
      s.id,
      'agent_plan',
      JSON.stringify({ ...plan(), steps: [{ text: '工作', status: 'in_progress' }], runId: 'r' }),
    );
    store.close();
    store = new Store(dir);
    const view = agentPlans(store, store.get(s.id)!, { limit: 10 });
    assert.equal(view.currentRun!.status, 'interrupted');
    assert.equal(view.plans[0]!.runStatus, 'interrupted');
    assert.equal(view.plans[0]!.steps[0]!.status, 'in_progress');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude tracks confirmed Task tool results and legacy TodoWrite, including resumed state, failures and removals', () => {
  let tracker = new ClaudePlans();
  tracker.use('create', 'TaskCreate', { subject: '实现功能' });
  assert.equal(
    tracker.result('create', true, { task: { id: '1', subject: '实现功能' } }),
    undefined,
  );
  tracker.use('create2', 'TaskCreate', { subject: '实现功能' });
  let p = tracker.result('create2', false, { task: { id: '1', subject: '实现功能' } })!;
  assert.equal(p.steps[0]!.status, 'pending');
  tracker = new ClaudePlans(p);
  tracker.use('update', 'TaskUpdate', { taskId: '1', status: 'completed' });
  p = tracker.result('update', false, { success: true, taskId: '1', updatedFields: ['status'] })!;
  assert.equal(p.steps[0]!.status, 'completed');
  tracker.use('bad', 'TaskUpdate', { taskId: '1', status: 'pending' });
  assert.equal(tracker.result('bad', false, { success: false, taskId: '1' }), undefined);
  tracker.use('list', 'TaskList', {});
  p = tracker.result('list', false, {
    tasks: [{ id: '2', subject: '原生已有任务', status: 'in_progress' }],
  })!;
  assert.deepEqual(p.steps, [{ id: '2', text: '原生已有任务', status: 'in_progress' }]);
  tracker.use('delete', 'TaskUpdate', { taskId: '2', status: 'deleted' });
  assert.deepEqual(
    tracker.result('delete', false, { success: true, taskId: '2', updatedFields: ['status'] })!
      .steps,
    [],
  );
  tracker.use('legacy', 'TodoWrite', { todos: [{ content: '旧版待办', status: 'completed' }] });
  assert.equal(tracker.result('legacy', false, {})!.steps[0]!.status, 'completed');
  tracker.use('clear', 'TodoWrite', { todos: [] });
  assert.deepEqual(tracker.result('clear', false, {})!.steps, []);
});

test('Claude exposes capability from actual init tools and ignores subagent task lists', async () => {
  for (const supported of [false, true]) {
    const f = fixture(),
      updates: AgentPlan[] = [],
      capabilities: boolean[] = [];
    const runtime: ClaudeQuery = () => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'native',
          tools: supported ? ['TaskCreate', 'TaskUpdate'] : ['Read', 'Bash'],
        } as any;
        if (supported) {
          yield {
            type: 'assistant',
            session_id: 'native',
            parent_tool_use_id: 'child',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'child-create',
                  name: 'TaskCreate',
                  input: { subject: 'foreign' },
                },
              ],
            },
          } as any;
          yield {
            type: 'user',
            session_id: 'native',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'child-create', content: 'done' }],
            },
            tool_use_result: { task: { id: 'other', subject: 'foreign' } },
          } as any;
          yield {
            type: 'assistant',
            session_id: 'native',
            message: {
              content: [
                { type: 'tool_use', id: 'own', name: 'TaskCreate', input: { subject: '当前会话' } },
              ],
            },
          } as any;
          yield {
            type: 'user',
            session_id: 'native',
            message: { content: [{ type: 'tool_result', tool_use_id: 'own', content: 'done' }] },
            tool_use_result: { task: { id: '1', subject: '当前会话' } },
          } as any;
        }
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'native',
          is_error: false,
          result: 'done',
        } as any;
      },
    });
    try {
      const session = f.store.create(incoming('').route, 'claude', f.dir);
      await new ClaudeAdapter(undefined, [], runtime).run({
        session,
        text: 'work',
        signal: AbortSignal.timeout(3000),
        hooks: {
          nativeId: (id) => {
            session.nativeId = id;
          },
          text() {},
          activity() {},
          ask: async () => ({ allow: false }),
          plan: (p) => updates.push(p),
          capabilities: (v) => capabilities.push(v.plans),
        },
      });
      assert.equal(capabilities[0], supported);
      assert.equal(updates.length, supported ? 1 : 0);
      if (supported) assert.equal(updates[0]!.steps[0]!.text, '当前会话');
    } finally {
      await f.cleanup();
    }
  }
});

test('OpenCode todo events and successful clear operations remain scoped to the current native session', async () => {
  const f = fixture(),
    adapter = new OpenCodeAdapter('opencode', [], (cwd, signal) =>
      OpenCodeServer.start(
        process.execPath,
        cwd,
        {
          ...process.env,
          TEST_OPENCODE_MODE: 'todos',
          TEST_OPENCODE_LOG: join(f.dir, 'opencode.log'),
        },
        signal,
        [resolve('test/fixtures/fake-opencode.mjs')],
      ),
    ),
    updates: AgentPlan[] = [];
  try {
    const session = f.store.create(incoming('').route, 'opencode', f.dir);
    await adapter.run({
      session,
      text: 'work',
      signal: AbortSignal.timeout(3000),
      hooks: {
        nativeId: (id) => {
          session.nativeId = id;
        },
        text() {},
        activity() {},
        ask: async () => ({ allow: false }),
        plan: (p) => updates.push(p),
      },
    });
    assert.equal(updates.length, 2);
    assert.equal(updates[0]!.steps.length, 2);
    assert.deepEqual(updates[1]!.steps, []);
  } finally {
    await f.cleanup();
  }
});

test('Dashboard and IM hide unavailable capabilities, bind discovery to model and context, and require authenticated plan reads', async () => {
  const f = fixture(),
    views: any[] = [];
  Object.assign(f.agent, { supportsPlans: true, requiresPlanDiscovery: true });
  Object.assign(f.channel, { sendManagement: async (_m: unknown, v: unknown) => views.push(v) });
  f.manager.registerChannel(f.channel);
  const server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`,
    headers = { Authorization: 'Bearer token' };
  try {
    const s = f.store.create(incoming('').route, 'claude', f.dir);
    s.nativeId = 'claude-native';
    f.store.save(s);
    const endpoint = base + `/api/sessions/${s.id}/todos`;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal(
      ((await fetch(endpoint, { headers }).then((r) => r.json())) as any).supported,
      false,
    );
    await f.manager.receive(incoming('/tab menu tools'));
    assert.ok(!views.at(-1).buttons.some((b: any) => b.command === '/tab todos'));
    f.agent.handler = async (run) => {
      run.hooks.capabilities?.({ plans: true });
      run.hooks.plan?.({ source: 'claude', steps: [{ id: '1', text: '任务', status: 'pending' }] });
    };
    await f.manager.receive(incoming('work'));
    await f.manager.idle();
    const data = (await fetch(endpoint, { headers }).then((r) => r.json())) as any;
    assert.equal(data.supported, true);
    assert.equal(data.plans.length, 1);
    assert.equal((await fetch(endpoint + '?before=-1', { headers })).status, 400);
    await f.manager.receive(incoming('/tab menu tools'));
    assert.ok(views.at(-1).buttons.some((b: any) => b.command === '/tab todos'));
    await f.manager.receive(incoming('/tab todos'));
    assert.match(views.at(-1).text, /任务/);
    assert.equal(f.agent.inputs.length, 1);
    const state = (await fetch(base + '/api/state', { headers }).then((r) => r.json())) as any;
    assert.equal(state.sessionCapabilities[s.id].plans, true);
    const changed = f.store.get(s.id)!;
    changed.settings = { model: 'another', effort: 'high' };
    f.store.save(changed);
    assert.equal(f.manager.agentPlansSupported(s.id), false);
    delete changed.settings;
    f.store.save(changed);
    f.store.event(s.id, 'context_reset', '{}');
    assert.equal(f.manager.agentPlansSupported(s.id), false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
