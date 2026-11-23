import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentKind } from '../src/core/types.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { agentEnvironment } from '../src/agents/environment.js';
import { fixture, incoming } from './helpers.js';

test('TRAE CLI aliases create the requested Agent kind', () => {
  for (const name of ['traecli', 'traexcli', 'traex', 'TRAE CLI'])
    assert.equal(agentKind(name), 'traecli');
});

test('TRAE CLI configuration preserves its executable and default classifier selection', async () => {
  const f = fixture();
  try {
    const file = join(f.dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        defaultAgent: 'traecli',
        topicRouterAgent: 'traecli',
        workspaces: { default: f.dir },
        agents: { traecli: { command: '/native/traex' } },
      }),
    );
    const config = loadConfig(file);
    assert.equal(config.defaultAgent, 'traecli');
    assert.equal(config.agents.traecli.command, '/native/traex');
    for (const name of ['traexcli', 'traex', 'TRAE CLI']) {
      writeFileSync(
        file,
        JSON.stringify({ ...config, defaultAgent: name, topicRouterAgent: name }),
      );
      assert.equal(loadConfig(file).topicRouterAgent, 'traecli');
    }
  } finally {
    await f.cleanup();
  }
});

test('TRAE CLI tasks use actual manager creation, catalog and persistent Store state', async () => {
  const f = fixture();
  try {
    for (const alias of ['traecli', 'traexcli', 'traex', 'TRAE CLI']) {
      const node = await f.manager.createDashboardTask({
        key: `trae-${alias.replace(/\s/g, '')}`,
        title: 'Native task',
        agent: alias,
      });
      assert.equal(f.store.get(node.sessionId!)!.agent, 'traecli');
      const reopened = new Store(f.config.dataDir);
      try {
        assert.equal(reopened.get(node.sessionId!)!.agent, 'traecli');
      } finally {
        reopened.close();
      }
    }
    assert.equal(f.manager.agentCatalog().find((a) => a.id === 'traecli')?.name, 'TRAE CLI');
  } finally {
    await f.cleanup();
  }
});

test('TRAE child environment isolates routing while preserving login homes', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      BOTMUX: 'parent',
      TRAECLI_THREAD_ID: 'parent',
      TRAECLI_SESSION_INBOX: 'parent',
      TRAECLI_HOME: '/native/cli',
      TRAE_HOME: '/native',
    });
    const env = agentEnvironment();
    assert.equal(env.BOTMUX, undefined);
    assert.equal(env.TRAECLI_THREAD_ID, undefined);
    assert.equal(env.TRAECLI_SESSION_INBOX, undefined);
    assert.equal(env.TRAECLI_HOME, '/native/cli');
    assert.equal(env.TRAE_HOME, '/native');
  } finally {
    process.env = saved;
  }
});

test('TRAE native stdio starts once, resumes saved ID, forwards instructions/output/usage and native selection keys', async () => {
  assert.equal(agentKind('traecli'), 'traecli');
  const { TraecliAdapter } = await import('../src/agents/traecli.js');
  const f = fixture();
  try {
    const executable = join(f.dir, 'native-trae.mjs');
    copyFileSync(new URL('./fixtures/fake-traecli.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new TraecliAdapter(executable);
    const s = f.store.create(
      { ...incoming('').route, platform: 'local' },
      'traecli',
      f.dir,
      'Custom instructions',
    );
    const models = await adapter.models(s, AbortSignal.timeout(3000));
    assert.deepEqual(
      models.map((m) => m.id),
      ['native-config'],
    );
    assert.equal(models[0]!.provider, 'native-provider');
    assert.deepEqual(
      models[0]!.efforts.map((e) => e.id),
      ['none', 'high'],
    );
    s.settings = { model: 'native-config', effort: 'high', provider: 'native-provider' };
    const output: string[] = [],
      usage: any[] = [],
      submitted: any[] = [];
    const hooks = {
      nativeId(id: string) {
        s.nativeId = id;
        f.store.save(s);
      },
      text(t: string) {
        output.push(t);
      },
      activity() {},
      input(v: any) {
        submitted.push(v);
      },
      usage(v: any) {
        usage.push(v);
      },
      async ask() {
        return { allow: true };
      },
    };
    await adapter.run({ session: s, text: 'exact task', hooks, signal: AbortSignal.timeout(3000) });
    const restored = f.store.get(s.id)!;
    await adapter.run({
      session: restored,
      text: 'second task',
      hooks,
      signal: AbortSignal.timeout(3000),
    });
    assert.deepEqual(output, ['exact task', 'second task']);
    assert.equal(
      restored.traecliDeveloperInstructions,
      'Native configured developer instructions\n\nCustom instructions',
    );
    assert.equal(restored.codexDeveloperInstructions, undefined);
    assert.equal(submitted[0].instructionMode, 'traecli-developer');
    assert.equal(usage[0].source, 'traecli');
    assert.equal(usage[0].last.cacheWriteInputTokens, 3);
    assert.equal(usage[0].total.cacheWriteInputTokens, 7);
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(trace.filter((m) => m.method === 'thread/start').length, 1);
    assert.equal(trace.filter((m) => m.method === 'thread/resume').length, 1);
    for (const m of trace.filter((m) => ['thread/start', 'thread/resume'].includes(m.method))) {
      assert.equal(m.params.model, 'native-config');
      assert.equal(m.params.modelProvider, 'native-provider');
      assert.equal(m.params.developerInstructions, restored.traecliDeveloperInstructions);
    }
    assert.ok(adapter.resumeCommand(restored).includes(executable));
    assert.ok(adapter.resumeCommand(restored).includes('native-test-1'));
    assert.ok(adapter.resumeCommand(restored).includes('model_provider="native-provider"'));
    await adapter.close();
  } finally {
    await f.cleanup();
  }
});

test('TRAE unsupported and foreign approvals reject without authorizing; cancelled turns interrupt', async () => {
  assert.equal(agentKind('traecli'), 'traecli');
  const { TraecliAdapter } = await import('../src/agents/traecli.js');
  for (const mode of [
    'unknown',
    'foreign-approval',
    'foreign-question',
    'foreign-turn-question',
    'hang',
  ]) {
    const f = fixture();
    try {
      const executable = join(f.dir, 'native-trae.mjs');
      copyFileSync(new URL('./fixtures/fake-traecli.mjs', import.meta.url), executable);
      chmodSync(executable, 0o755);
      const s = f.store.create({ ...incoming('').route, platform: 'local' }, 'traecli', f.dir);
      let asks = 0;
      await assert.rejects(
        new TraecliAdapter(executable).run({
          session: s,
          text: mode,
          signal: AbortSignal.timeout(mode === 'hang' ? 500 : 3000),
          hooks: {
            nativeId(id) {
              s.nativeId = id;
            },
            text() {},
            activity() {},
            async ask() {
              asks++;
              return { allow: true };
            },
          },
        }),
      );
      assert.equal(asks, 0);
      const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8');
      assert.ok(!trace.includes('"decision":"accept"'));
    } finally {
      await f.cleanup();
    }
  }
});

test('TRAE model settings preserve native provider identity through manager menus and save', async () => {
  const { SessionSettings } = await import('../src/core/session-settings.js');
  const f = fixture();
  const settings = new SessionSettings(
    f.store,
    {
      codex: f.agent,
      claude: f.agent,
      opencode: f.agent,
      traecli: {
        ...f.agent,
        run: f.agent.run.bind(f.agent),
        resumeCommand: f.agent.resumeCommand.bind(f.agent),
        async models() {
          return [
            {
              id: 'native-config',
              label: 'Display',
              provider: 'native-provider',
              efforts: [{ id: 'none', label: 'None' }],
            },
          ];
        },
      },
    },
    () => false,
    () => {},
  );
  try {
    const s = f.store.create(incoming('').route, 'traecli', f.dir);
    await settings.load(s.id);
    assert.equal(settings.snapshot(s.id).models[0]!.provider, 'native-provider');
    settings.save(s.id, { model: 'native-config', effort: 'none' }, 0);
    assert.equal(f.store.get(s.id)!.settings?.provider, 'native-provider');
    assert.throws(() =>
      settings.save(
        s.id,
        { model: 'native-config', effort: 'none', provider: 'foreign-provider' },
        1,
      ),
    );
  } finally {
    await settings.close();
    await f.cleanup();
  }
});

test('TRAE canonical native history uses its CLI root and retains cache creation tokens', async () => {
  const { mkdirSync } = await import('node:fs');
  const { TraecliAdapter } = await import('../src/agents/traecli.js');
  const f = fixture(),
    saved = { ...process.env };
  try {
    process.env.TRAE_HOME = join(f.dir, 'trae-home');
    delete process.env.TRAECLI_HOME;
    process.env.CODEX_HOME = join(f.dir, 'wrong-home');
    const nativeId = '11111111-1111-4111-8111-111111111111';
    const dir = join(process.env.TRAE_HOME, 'cli', 'sessions', '2026', '11', '16');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-example-${nativeId}.jsonl`);
    const counts = {
      input_tokens: 20,
      cached_input_tokens: 3,
      cache_creation_input_tokens: 7,
      output_tokens: 5,
      reasoning_output_tokens: 1,
      total_tokens: 25,
    };
    writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: nativeId, history_format: 'canonical_v1', history_mode: 'paginated' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-11-16T00:00:00Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: counts,
              total_token_usage: counts,
              model_context_window: 1000,
            },
          },
        }) +
        '\n',
    );
    const s = f.store.create(incoming('').route, 'traecli', f.dir);
    s.nativeId = nativeId;
    const adapter = new TraecliAdapter('/executable-must-not-run');
    const value = adapter.historicalUsage(s)!;
    assert.equal(value.value.source, 'traecli');
    assert.equal(value.value.last?.cacheWriteInputTokens, 7);
    assert.equal(value.value.total?.cacheWriteInputTokens, 7);
    writeFileSync(file, readFileSync(file, 'utf8').replace(nativeId, 'foreign-id'));
    assert.equal(adapter.historicalUsage(s), undefined);
  } finally {
    process.env = saved;
    await f.cleanup();
  }
});

test('TRAE CLI spaced alias reaches actual chat initialization without becoming a workspace', async () => {
  const f = fixture();
  try {
    await f.manager.receive(
      incoming('/tab init TRAE CLI default --instructions Exact addition', 'alice', ''),
    );
    const session = f.store.list()[0];
    assert.equal(session?.agent, 'traecli');
    assert.equal(session?.instructions, 'Exact addition');
    assert.equal(session?.workspace, f.dir);
  } finally {
    await f.cleanup();
  }
});

test('TRAE native approvals, questions and event plans keep provider identity and original turn', async () => {
  const { TraecliAdapter } = await import('../src/agents/traecli.js');
  const { supportsAutoApproval } = await import('../src/core/approval-policy.js');
  const f = fixture();
  try {
    const executable = join(f.dir, 'trae.mjs');
    copyFileSync(new URL('./fixtures/fake-traecli.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new TraecliAdapter(executable),
      s = f.store.create(incoming('').route, 'traecli', f.dir);
    const outputs: string[] = [],
      plans: any[] = [],
      tools: any[] = [];
    const hooks = {
      nativeId(id: string) {
        s.nativeId = id;
      },
      text(t: string) {
        outputs.push(t);
      },
      activity() {},
      plan(p: any) {
        plans.push(p);
      },
      tool(t: any) {
        tools.push(t);
      },
      async ask(request: any) {
        if (request.kind === 'approval') {
          assert.equal(request.approvalAutomation, 'traecli-command-file');
          assert.equal(supportsAutoApproval('traecli', request), true);
          assert.equal(supportsAutoApproval('codex', request), false);
          return { allow: true, scope: 'session' as const };
        }
        assert.deepEqual(request.questions[0].descriptions, ['本地文件', '独立服务']);
        return { answers: { database: ['SQLite'] } };
      },
    };
    for (const text of ['approval', 'question', 'plans', 'tools'])
      await adapter.run({ session: s, text, hooks, signal: AbortSignal.timeout(3000) });
    assert.equal(outputs[0], 'acceptForSession');
    assert.deepEqual(JSON.parse(outputs[1]!), { answers: { database: { answers: ['SQLite'] } } });
    assert.equal(plans.length, 2);
    assert.equal(plans[0].source, 'traecli');
    assert.deepEqual(
      tools.map((t) => [t.id, t.status]),
      [
        ['tool-1', 'running'],
        ['tool-1', 'completed'],
      ],
    );
    await adapter.close();
  } finally {
    await f.cleanup();
  }
});

test('TRAE compaction requires completion marker and native goals verify clear before reporting stopped', async () => {
  const { TraecliAdapter } = await import('../src/agents/traecli.js');
  const f = fixture();
  try {
    const executable = join(f.dir, 'trae.mjs');
    copyFileSync(new URL('./fixtures/fake-traecli.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new TraecliAdapter(executable),
      s = f.store.create({ ...incoming('').route, platform: 'local' }, 'traecli', f.dir);
    s.nativeId = 'native-test-1';
    writeFileSync(join(f.dir, 'compact-mode'), 'missing');
    await assert.rejects(adapter.compact(s, AbortSignal.timeout(3000)), /压缩完成标记/);
    writeFileSync(join(f.dir, 'compact-mode'), 'usage');
    const compact = await adapter.compact(s, AbortSignal.timeout(3000));
    assert.equal(compact.compacted, true);
    assert.equal(compact.usage?.source, 'traecli');
    assert.equal(compact.contextBefore, 100000);
    assert.equal(compact.usage?.contextTokens, 20000);
    writeFileSync(
      join(f.dir, 'goal.json'),
      JSON.stringify({
        threadId: 'native-test-1',
        objective: 'Native goal',
        createdAt: 1,
        status: 'active',
      }),
    );
    const loops = await adapter.loops(s, AbortSignal.timeout(3000));
    assert.equal(loops[0]!.label, 'TRAE CLI 原生 goal（持续目标）');
    assert.deepEqual(await adapter.stopLoop(s, loops[0]!.id, AbortSignal.timeout(3000)), {
      wasActive: true,
    });
    assert.deepEqual(await adapter.loops(s, AbortSignal.timeout(3000)), []);
  } finally {
    await f.cleanup();
  }
});

test('TRAE dynamic task bridge invokes only the current Session endpoint and resumes registration', async () => {
  const { TraecliAdapter } = await import('../src/agents/traecli.js');
  const { taskBridge } = await import('../src/core/task-bridge.js');
  const f = fixture();
  let bridge: Awaited<ReturnType<typeof taskBridge>> | undefined;
  try {
    const executable = join(f.dir, 'trae.mjs');
    copyFileSync(new URL('./fixtures/fake-traecli.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new TraecliAdapter(executable),
      s = f.store.create(incoming('').route, 'traecli', f.dir);
    let reports = 0;
    bridge = await taskBridge(
      f.manager.tasks,
      s.id,
      new AbortController().signal,
      undefined,
      (report) => {
        reports++;
        return { sessionId: s.id, report };
      },
    );
    const hooks = {
      nativeId(id: string) {
        s.nativeId = id;
        f.store.save(s);
      },
      text() {},
      activity() {},
      async ask() {
        throw Error('Unexpected question');
      },
    };
    await adapter.run({
      session: s,
      text: 'topic-report-fixture',
      hooks,
      taskBridge: bridge,
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(reports, 1);
    assert.equal(s.traecliTaskTools, 'dynamic');
    assert.equal(s.codexTaskTools, undefined);
    await adapter.run({
      session: s,
      text: 'continue',
      hooks,
      taskBridge: bridge,
      signal: AbortSignal.timeout(3000),
    });
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.ok(
      trace
        .find((m) => m.method === 'thread/start')
        .params.dynamicTools.some((t: any) => t.name === 'task_create'),
    );
    assert.equal(trace.find((m) => m.method === 'thread/resume').params.config, undefined);
    assert.equal(trace.find((m) => m.id === 'topic-report-1').result.success, true);
  } finally {
    await bridge?.close();
    await f.cleanup();
  }
});

test('TRAE authenticated Dashboard API creates requested alias and exposes native models and approval modes', async () => {
  const { TraecliAdapter } = await import('../src/agents/traecli.js');
  const { createDashboard } = await import('../src/web/server.js');
  const f = fixture(),
    server = createDashboard(f.manager, 'test-token');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const executable = join(f.dir, 'trae.mjs');
    copyFileSync(new URL('./fixtures/fake-traecli.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    f.agent.models = new TraecliAdapter(executable).models.bind(new TraecliAdapter(executable));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const denied = await fetch(base + '/api/task-nodes', {
      method: 'POST',
      body: JSON.stringify({ key: 'denied', title: 'Denied', agent: 'traecli' }),
    });
    assert.equal(denied.status, 401);
    const created = await fetch(base + '/api/task-nodes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'native-task', title: 'Native', agent: 'TRAE CLI' }),
    });
    assert.equal(created.status, 201);
    const node = await created.json(),
      s = f.store.get(node.sessionId)!;
    assert.equal(s.agent, 'traecli');
    const catalog = await fetch(base + `/api/sessions/${s.id}/settings`, { headers }).then((r) =>
      r.json(),
    );
    assert.equal(catalog.capabilities.models[0].id, 'native-config');
    assert.equal(catalog.capabilities.models[0].provider, 'native-provider');
    const policy = await fetch(base + `/api/sessions/${s.id}/approval-policy`, { headers }).then(
      (r) => r.json(),
    );
    assert.equal(policy.mode, 'on-request');
    assert.ok(policy.modes.some((m: any) => m.id === 'on-request-auto-review'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

test('TRAE classifier and report writer use the native executable with isolated restricted threads', async () => {
  const { NativeTopicRouter } = await import('../src/agents/topic-router.js');
  const f = fixture();
  let router: InstanceType<typeof NativeTopicRouter> | undefined;
  try {
    const executable = join(f.dir, 'trae.mjs');
    copyFileSync(new URL('./fixtures/fake-traecli.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    router = new NativeTopicRouter('traecli', executable);
    const decision = await router.classify(
      { text: '使用 TRAE CLI 新建会话写报告', recentUserMessages: [] },
      AbortSignal.timeout(3000),
    );
    assert.equal(decision.agent, 'TRAE CLI');
    assert.equal(decision.task, '写报告');
    assert.deepEqual(
      await router.generate(
        { kind: 'report' },
        'Write report',
        { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
        AbortSignal.timeout(3000),
      ),
      { summary: 'Native report' },
    );
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(trace.filter((m) => m.method === 'initialize').length, 1);
    const starts = trace.filter((m) => m.method === 'thread/start');
    assert.equal(starts.length, 2);
    for (const start of starts) {
      assert.equal(start.params.ephemeral, true);
      assert.equal(start.params.sandbox, 'read-only');
      assert.equal(start.params.approvalPolicy, 'never');
      assert.equal(start.params.config['features.shell_tool'], false);
      assert.deepEqual(start.params.dynamicTools, []);
    }
    assert.equal(
      trace.some((m) => m.method === 'thread/resume'),
      false,
    );
  } finally {
    await router?.close();
    await f.cleanup();
  }
});

// Shared protocol regressions exercise both public adapters through a native-shaped stdio fixture.
async function scopedAdapter(kind: 'codex' | 'traecli', dir: string) {
  const executable = join(dir, 'scoped-app-server.mjs');
  copyFileSync(new URL('./fixtures/fake-app-server-turns.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  if (kind === 'codex') {
    const { CodexAdapter } = await import('../src/agents/codex.js');
    return new CodexAdapter(executable);
  }
  const { TraecliAdapter } = await import('../src/agents/traecli.js');
  return new TraecliAdapter(executable);
}

for (const kind of ['codex', 'traecli'] as const) {
  test(`${kind} catalog accepts nullable native config/provider metadata without dropping usable models`, async () => {
    const f = fixture();
    const adapter = await scopedAdapter(kind, f.dir);
    try {
      const model = (name: string, configName: string | null, modelProviderId: string | null) => ({
        model: name,
        configName,
        modelProviderId,
        displayName: name,
        supportedReasoningEfforts: [{ reasoningEffort: 'none', description: 'Native default' }],
      });
      writeFileSync(
        join(f.dir, 'catalog.json'),
        JSON.stringify([
          model('both-null', null, null),
          model('config-null', null, 'native-provider'),
          model('provider-null', 'native-config', null),
          model('exact-model', 'exact-config', 'exact-provider'),
        ]),
      );
      const s = f.store.create({ ...incoming('').route, platform: 'local' }, kind, f.dir);
      const models = await adapter.models(s, AbortSignal.timeout(3000));
      assert.deepEqual(
        models.map((m) => m.id),
        kind === 'traecli'
          ? ['both-null', 'config-null', 'native-config', 'exact-config']
          : ['both-null', 'config-null', 'provider-null', 'exact-model'],
      );
      assert.deepEqual(
        models.map((m) => m.provider),
        kind === 'traecli'
          ? [undefined, 'native-provider', undefined, 'exact-provider']
          : [undefined, undefined, undefined, undefined],
      );
    } finally {
      await adapter.close();
      await f.cleanup();
    }
  });

  for (const mode of ['stale-completion', 'stale-start-first', 'stale-start-last']) {
    test(`${kind} ignores ${mode} and stays steerable until the matching nested turn completes`, async () => {
      const f = fixture(),
        adapter = await scopedAdapter(kind, f.dir);
      const abort = new AbortController();
      let run: Promise<void> | undefined;
      try {
        const s = f.store.create({ ...incoming('').route, platform: 'local' }, kind, f.dir),
          output: string[] = [];
        let settled = false;
        run = adapter.run({
          session: s,
          text: mode,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
          hooks: {
            nativeId(id) {
              s.nativeId = id;
            },
            text(t) {
              output.push(t);
            },
            activity() {},
            async ask() {
              throw Error('Unexpected question');
            },
          },
        });
        void run.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const { until } = await import('./helpers.js');
        await until(() => output.includes('current turn waiting') || settled);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false, 'obsolete lifecycle must not finish the current run');
        assert.equal(await adapter.steer(s, 'finish', AbortSignal.timeout(3000)), true);
        await run;
        assert.deepEqual(output, ['current turn waiting', 'current turn finished']);
        const trace = readFileSync(join(f.dir, 'turn-trace.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        assert.equal(
          trace.find((m) => m.method === 'turn/steer').params.expectedTurnId,
          'current-turn',
        );
      } finally {
        abort.abort();
        await run?.catch(() => {});
        await adapter.close();
        await f.cleanup();
      }
    });
  }

  test(`${kind} retains completion-before-response without requiring a started notification`, async () => {
    const f = fixture(),
      adapter = await scopedAdapter(kind, f.dir);
    try {
      const s = f.store.create({ ...incoming('').route, platform: 'local' }, kind, f.dir),
        output: string[] = [];
      await adapter.run({
        session: s,
        text: 'early-completion',
        signal: AbortSignal.timeout(3000),
        hooks: {
          nativeId(id) {
            s.nativeId = id;
          },
          text(t) {
            output.push(t);
          },
          activity() {},
          async ask() {
            throw Error('Unexpected question');
          },
        },
      });
      assert.deepEqual(output, ['completed before response without started']);
    } finally {
      await adapter.close();
      await f.cleanup();
    }
  });

  for (const mode of ['task-current', 'task-foreign', 'task-absent']) {
    test(`${kind} ${mode} dynamic tool request invokes only an authenticated current-turn bridge`, async () => {
      const { taskBridge } = await import('../src/core/task-bridge.js');
      const f = fixture(),
        adapter = await scopedAdapter(kind, f.dir);
      let bridge: Awaited<ReturnType<typeof taskBridge>> | undefined;
      try {
        const s = f.store.create({ ...incoming('').route, platform: 'local' }, kind, f.dir),
          output: string[] = [];
        let mutations = 0;
        bridge = await taskBridge(
          f.manager.tasks,
          s.id,
          new AbortController().signal,
          undefined,
          () => {
            mutations++;
            return { saved: true };
          },
        );
        const run = adapter.run({
          session: s,
          text: mode,
          taskBridge: bridge,
          signal: AbortSignal.timeout(3000),
          hooks: {
            nativeId(id) {
              s.nativeId = id;
            },
            text(t) {
              output.push(t);
            },
            activity() {},
            async ask() {
              throw Error('Unexpected question');
            },
          },
        });
        let error: unknown;
        await run.catch((value) => {
          error = value;
        });
        assert.equal(mutations, mode === 'task-current' ? 1 : 0);
        if (mode === 'task-current') {
          assert.equal(error, undefined);
          assert.deepEqual(output, ['bridge succeeded']);
        } else {
          assert.ok(error instanceof Error);
          assert.deepEqual(output, []);
        }
        const trace = readFileSync(join(f.dir, 'turn-trace.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        assert.equal(
          trace.some((m) => m.id === 'scoped-tool-request' && m.result?.success),
          mode === 'task-current',
        );
      } finally {
        await bridge?.close();
        await adapter.close();
        await f.cleanup();
      }
    });
  }
}
