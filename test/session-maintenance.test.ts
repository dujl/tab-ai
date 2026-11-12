import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, incoming, until } from './helpers.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter, type ClaudeQuery } from '../src/agents/claude.js';
import { OpenCodeAdapter } from '../src/agents/opencode.js';
import { createDashboard } from '../src/web/server.js';
import { Store } from '../src/core/store.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
const signal = () => AbortSignal.timeout(3000);
function codex(f: ReturnType<typeof fixture>) {
  const executable = join(f.dir, 'codex.mjs');
  copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  return new CodexAdapter(executable);
}
const trace = (dir: string) =>
  readFileSync(join(dir, 'rpc-trace.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));

test('Codex compaction waits for native contextCompaction completion, reuses the exact thread and starts no work turn', async () => {
  const f = fixture();
  try {
    const adapter = codex(f),
      s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'native-test-1';
    assert.deepEqual(await adapter.compact(s, signal()), { compacted: true });
    const calls = trace(f.dir);
    assert.ok(calls.some((c) => c.method === 'thread/resume' && c.params.threadId === s.nativeId));
    assert.ok(calls.some((c) => c.method === 'thread/compact/start'));
    assert.equal(
      calls.some((c) => c.method === 'turn/start' || c.method === 'thread/start'),
      false,
    );
    assert.equal(s.nativeId, 'native-test-1');
  } finally {
    await f.cleanup();
  }
});
test('Codex compaction rejects missing/failed completion and aborts a hung request rather than reporting acceptance as completion', async () => {
  for (const mode of ['missing', 'failed', 'hang']) {
    const f = fixture();
    try {
      const adapter = codex(f),
        s = f.store.create(incoming('').route, 'codex', f.dir);
      s.nativeId = 'native-test-1';
      writeFileSync(join(f.dir, 'compact-mode'), mode);
      await assert.rejects(
        adapter.compact(s, AbortSignal.timeout(mode === 'hang' ? 250 : 3000)),
        mode === 'hang' ? /中断|closed|退出/ : /压缩|compact/,
      );
    } finally {
      await f.cleanup();
    }
  }
});
test('Codex native goal cancellation verifies identity and origin, then confirms cleared state', async () => {
  const f = fixture();
  try {
    const adapter = codex(f),
      s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'native-test-1';
    writeFileSync(
      join(f.dir, 'goal.json'),
      JSON.stringify({
        threadId: s.nativeId,
        objective: 'finish scoped work',
        createdAt: 1,
        status: 'active',
      }),
    );
    const loops = await adapter.loops(s, signal());
    assert.equal(loops.length, 1);
    await assert.rejects(adapter.stopLoop(s, 'goal:stale', signal()), /更换/);
    assert.deepEqual(await adapter.stopLoop(s, loops[0]!.id, signal()), { wasActive: true });
    assert.deepEqual(await adapter.loops(s, signal()), []);
    assert.deepEqual(trace(f.dir).find((c) => c.method === 'thread/goal/clear').params, {
      threadId: s.nativeId,
      origin: 'user',
    });
  } finally {
    await f.cleanup();
  }
});
test('Claude compaction uses the resume ID and accepts only an actual compact_boundary; no-op and auth failures stay distinct', async () => {
  for (const mode of ['complete', 'empty', 'error', 'foreign']) {
    const f = fixture();
    let options: any,
      closed = false;
    const runtime: ClaudeQuery = (input) => {
      options = input.options;
      assert.equal(input.prompt, '/compact');
      return {
        close() {
          closed = true;
        },
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: mode === 'foreign' ? 'different' : 'claude-native',
          } as SDKMessage;
          if (mode === 'complete')
            yield {
              type: 'system',
              subtype: 'compact_boundary',
              session_id: 'claude-native',
              compact_metadata: { trigger: 'manual', pre_tokens: 1000 },
            } as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'claude-native',
            is_error: mode === 'error',
            result: 'Not enough messages to compact.',
          } as SDKMessage;
        },
      };
    };
    try {
      const s = f.store.create(incoming('').route, 'claude', f.dir);
      s.nativeId = 'claude-native';
      const promise = new ClaudeAdapter(undefined, [], runtime).compact(s, signal());
      if (mode === 'error' || mode === 'foreign') await assert.rejects(promise, /Claude/);
      else assert.equal((await promise).compacted, mode === 'complete');
      assert.equal(options.resume, s.nativeId);
      assert.deepEqual(options.tools, []);
      assert.equal(closed, true);
    } finally {
      await f.cleanup();
    }
  }
});
test('OpenCode compaction uses the existing session model and requires a fresh completed native summary', async () => {
  for (const mode of ['complete', 'missing', 'wrong-id']) {
    const f = fixture(),
      calls: { path: string; body?: unknown }[] = [];
    let after = false,
      closed = false;
    const model = { providerID: 'native', modelID: 'model' };
    const before = [
      {
        info: { id: 'answer-old', sessionID: 'ses_saved', role: 'assistant', ...model },
        parts: [{ type: 'text' }],
      },
    ];
    const mock = {
      async request(path: string, _s: AbortSignal, body?: unknown) {
        calls.push({ path, body });
        if (path === '/path') return { directory: f.dir };
        if (path === '/session/ses_saved')
          return {
            id: mode === 'wrong-id' ? 'ses_other' : 'ses_saved',
            directory: '/original-creation-directory',
          };
        if (path.endsWith('/summarize')) {
          after = true;
          return true;
        }
        if (path.endsWith('/abort')) return true;
        if (path.includes('/message?'))
          return after && mode === 'complete'
            ? [
                ...before,
                {
                  info: { id: 'compact-user', sessionID: 'ses_saved', role: 'user' },
                  parts: [{ type: 'compaction' }],
                },
                {
                  info: {
                    id: 'compact-summary',
                    sessionID: 'ses_saved',
                    role: 'assistant',
                    parentID: 'compact-user',
                    summary: true,
                    time: { completed: 1 },
                  },
                  parts: [{ type: 'text' }],
                },
              ]
            : before;
        throw Error('unexpected ' + path);
      },
      async fetch() {
        throw Error('no event channel needed');
      },
      async close() {
        closed = true;
      },
    };
    try {
      const s = f.store.create(incoming('').route, 'opencode', f.dir);
      s.nativeId = 'ses_saved';
      const p = new OpenCodeAdapter('opencode', [], async () => mock as any).compact(s, signal());
      if (mode === 'complete') {
        assert.deepEqual(await p, { compacted: true });
        assert.deepEqual(calls.find((c) => c.path.endsWith('/summarize'))!.body, model);
      } else await assert.rejects(p, /原生|摘要/);
      assert.equal(
        calls.some((c) => c.path === '/session'),
        false,
      );
      assert.equal(closed, true);
      assert.equal(s.nativeId, 'ses_saved');
    } finally {
      await f.cleanup();
    }
  }
});
test('framework compaction is exclusive, preserves native history/settings/closed state and never runs the work Agent', async () => {
  const f = fixture();
  let release!: (v: { compacted: boolean }) => void;
  Object.assign(f.agent, {
    async compact() {
      return new Promise((r) => {
        release = r;
      });
    },
  });
  try {
    const s = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    s.nativeId = 'keep';
    s.settings = { model: 'selected' };
    s.status = 'closed';
    f.store.save(s);
    f.store.event(s.id, 'user', 'original');
    const other = f.store.create({ ...s.route, conversation: 'other' }, 'codex', f.dir),
      snapshot = structuredClone(other);
    f.manager.startCompaction(s.id);
    await until(() => !!release);
    assert.equal(f.store.get(s.id)!.operation, 'compact');
    assert.equal(f.store.get(s.id)!.status, 'closed');
    assert.throws(() => f.manager.startCompaction(s.id), /等待/);
    assert.throws(() => f.manager.openSession(s.id), /等待/);
    release({ compacted: true });
    await f.manager.idle();
    const final = f.store.get(s.id)!;
    assert.equal(final.status, 'closed');
    assert.equal(final.operation, undefined);
    assert.equal(final.nativeId, 'keep');
    assert.deepEqual(final.settings, { model: 'selected' });
    assert.ok(f.store.events(s.id).some((e) => e.type === 'user' && e.text === 'original'));
    assert.ok(f.store.events(s.id).some((e) => e.text.includes('压缩已完成')));
    assert.equal(f.agent.inputs.length, 0);
    assert.deepEqual(f.store.get(other.id), snapshot);
  } finally {
    await f.cleanup();
  }
});
test('stopping or closing compaction does not reopen the session or claim completion, and uses the original chat', async () => {
  for (const action of ['stop', 'close']) {
    const f = fixture();
    Object.assign(f.agent, {
      async compact(_s: any, signal: AbortSignal) {
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }),
        );
        return { compacted: true };
      },
    });
    try {
      const m = incoming('/tab compact start', 'alice', ''),
        s = f.store.create(m.route, 'codex', f.dir);
      s.nativeId = 'keep';
      f.store.save(s);
      await f.manager.receive(m);
      await until(() => f.store.get(s.id)!.operation === 'compact');
      if (action === 'close') f.manager.closeSession(s.id);
      else f.manager.stop(s.id);
      await f.manager.idle();
      assert.equal(f.store.get(s.id)!.status, action === 'close' ? 'closed' : 'idle');
      assert.equal(f.store.get(s.id)!.operation, undefined);
      assert.ok(f.channel.sent.every((v) => v.message.route.conversation === m.route.conversation));
      assert.ok(f.store.events(s.id).some((e) => e.text.includes('未确认完成')));
      assert.ok(!f.store.events(s.id).some((e) => e.text.includes('压缩已完成')));
    } finally {
      await f.cleanup();
    }
  }
});
test('native goal cancellation failure leaves the current turn running; confirmed cancellation interrupts only this session', async () => {
  const f = fixture();
  let fail = true,
    stopped = 0;
  f.agent.handler = async (run) => {
    run.hooks.nativeId('keep');
    await new Promise<void>((resolve) =>
      run.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    run.signal.throwIfAborted();
  };
  Object.assign(f.agent, {
    async loops() {
      return [{ id: 'goal:one', label: 'goal', status: 'active', detail: 'test' }];
    },
    async stopLoop() {
      stopped++;
      if (fail) throw Error('not confirmed');
      return { wasActive: true };
    },
  });
  try {
    const m = incoming('run', 'alice', '');
    await f.manager.receive(m);
    await until(() => f.agent.inputs.length === 1);
    const s = f.store.current(m.route)!;
    s.nativeId = 'keep';
    f.store.save(s);
    await assert.rejects(f.manager.stopLoop(s.id, 'goal:one'), /未确认/);
    assert.equal(f.manager.maintenanceInfo(s.id).busy, true);
    fail = false;
    await f.manager.stopLoop(s.id, 'goal:one');
    assert.equal(f.manager.maintenanceInfo(s.id).busy, false);
    assert.equal(f.store.get(s.id)!.status, 'interrupted');
    assert.equal(f.store.get(s.id)!.nativeId, 'keep');
    assert.equal(stopped, 2);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});
test('stopping a task loop persists pause and prevents pending auto turns after interrupt', async () => {
  const f = fixture();
  try {
    const task = await f.manager.createTask({
      sourceSessionId: f.store.create(incoming('', 'alice', '').route, 'codex', f.dir).id,
      key: 'maintenance',
      title: 'test',
      objective: 'test',
    });
    await until(() => f.store.taskRecord(task.id)?.state === 'waiting');
    const session = f.store.get(f.store.taskRecord(task.id)!.sessionId!)!;
    f.agent.handler = async (run) => {
      await new Promise<void>((r) =>
        run.signal.addEventListener('abort', () => r(), { once: true }),
      );
      run.signal.throwIfAborted();
    };
    f.manager.tasks.enqueueUser(session.id, 'loop step', 'step-one');
    await until(() => f.agent.inputs.length === 2);
    f.manager.tasks.enqueueUser(session.id, 'must remain pending', 'step-two');
    await f.manager.stopLoop(session.id, 'task:' + task.id);
    f.manager.tasks.kick();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.store.taskRecord(task.id)!.state, 'paused');
    assert.equal(f.agent.inputs.length, 2);
    assert.ok(
      f.store.taskJobs().some((j) => j.text === 'must remain pending' && j.state === 'pending'),
    );
    assert.equal(f.store.get(session.id)!.nativeId, session.nativeId);
  } finally {
    await f.cleanup();
  }
});
test('maintenance API requires authentication and fresh revision, returns accepted before compaction completes', async () => {
  const f = fixture();
  let release!: (v: { compacted: boolean }) => void;
  Object.assign(f.agent, {
    async compact() {
      return new Promise((r) => {
        release = r;
      });
    },
  });
  const server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const s = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    s.nativeId = 'keep';
    f.store.save(s);
    const url = base + '/api/sessions/' + s.id;
    const get = (action: string, auth = true) =>
      fetch(url + '/' + action, { headers: auth ? { Authorization: 'Bearer token' } : {} });
    const post = (data: unknown) =>
      fetch(url + '/compact', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    assert.equal((await get('maintenance', false)).status, 401);
    const caps = await (await get('maintenance')).json();
    assert.equal((await post({ revision: 'stale' })).status, 400);
    assert.equal((await post({ revision: caps.revision })).status, 202);
    await until(() => !!release);
    assert.equal(f.store.get(s.id)!.operation, 'compact');
    release({ compacted: true });
    await f.manager.idle();
    assert.equal(f.store.get(s.id)!.nativeId, 'keep');
    assert.equal(f.agent.inputs.length, 0);
    const loops = await (await get('loops')).json();
    assert.equal(loops.nativeSupported, false);
    assert.match(loops.note, /中断当前轮不等于/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
test('restart clears interrupted compaction markers without reopening closed sessions or retrying model work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-compact-recover-'));
  let store = new Store(dir);
  try {
    for (const status of ['running', 'closed'] as const) {
      const s = store.create({ ...incoming('').route, thread: status }, 'codex', dir);
      s.nativeId = 'native-' + status;
      s.status = status;
      s.operation = 'compact';
      store.save(s);
    }
    store.close();
    store = new Store(dir);
    for (const s of store.list()) {
      assert.equal(s.operation, undefined);
      assert.equal(s.status, s.route.thread === 'closed' ? 'closed' : 'interrupted');
      assert.equal(s.nativeId, 'native-' + s.route.thread);
      assert.ok(store.events(s.id).some((e) => e.text.includes('未自动重试')));
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex native loop controls use the already running RPC and never start a second model turn', async () => {
  const f = fixture(),
    controller = new AbortController();
  try {
    const adapter = codex(f),
      s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'native-test-1';
    writeFileSync(
      join(f.dir, 'goal.json'),
      JSON.stringify({
        threadId: s.nativeId,
        objective: 'active owned goal',
        createdAt: 1,
        status: 'active',
      }),
    );
    let ready = false;
    const running = adapter.run({
      session: s,
      text: 'hang',
      signal: controller.signal,
      hooks: {
        nativeId() {
          ready = true;
        },
        text() {},
        activity() {},
        async ask() {
          return { allow: false };
        },
      },
    });
    void running.catch(() => {});
    await until(() => ready);
    const loops = await adapter.loops(s, signal());
    await adapter.stopLoop(s, loops[0]!.id, signal());
    controller.abort();
    await assert.rejects(running, /中断|closed/);
    const calls = trace(f.dir);
    assert.equal(calls.filter((c) => c.method === 'thread/resume').length, 1);
    assert.equal(calls.filter((c) => c.method === 'turn/start').length, 1);
    assert.ok(calls.some((c) => c.method === 'thread/goal/clear'));
  } finally {
    controller.abort();
    await f.cleanup();
  }
});

test('compaction timeout restores state, prevents overlapping work and never retries the model operation', async () => {
  const f = fixture();
  f.config.turnTimeoutMs = 50;
  f.config.maxConcurrentRuns = 1;
  let calls = 0;
  Object.assign(f.agent, {
    async compact(_s: any, signal: AbortSignal) {
      calls++;
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(Error('timeout')), { once: true }),
      );
      return { compacted: true };
    },
  });
  try {
    const s = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    s.nativeId = 'keep';
    f.store.save(s);
    const other = f.store.create({ ...s.route, conversation: 'other' }, 'codex', f.dir);
    f.manager.startCompaction(s.id);
    assert.throws(() => f.manager.submit(s.id, 'must not run'), /仍在运行/);
    assert.throws(() => f.manager.submit(other.id, 'must not run'), /并发上限/);
    await f.manager.idle();
    assert.equal(calls, 1);
    assert.equal(f.store.get(s.id)!.status, 'idle');
    assert.equal(f.store.get(s.id)!.operation, undefined);
    assert.equal(f.store.get(s.id)!.nativeId, 'keep');
    assert.equal(f.agent.inputs.length, 0);
    assert.ok(f.store.events(s.id).some((e) => e.text.includes('超时')));
  } finally {
    await f.cleanup();
  }
});

test('Codex native compaction errors retain numeric RPC codes and safe cause without persisting credentials', async () => {
  const f = fixture();
  try {
    const adapter = codex(f),
      s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'native-test-1';
    f.store.save(s);
    writeFileSync(join(f.dir, 'compact-mode'), 'rpc-error');
    Object.assign(f.agent, { compact: adapter.compact.bind(adapter) });
    f.manager.startCompaction(s.id);
    await f.manager.idle();
    const last = f.manager.maintenanceInfo(s.id).lastCompaction!;
    assert.equal(last.phase, 'failed');
    assert.equal(last.code, 'authentication');
    assert.equal(last.rpcCode, -32001);
    assert.ok(!JSON.stringify(f.store.events(s.id)).includes('private-token'));
    assert.equal(trace(f.dir).filter((c) => c.method === 'thread/compact/start').length, 1);
  } finally {
    await f.cleanup();
  }
});
