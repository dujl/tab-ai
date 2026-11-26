import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentKind,
  type AgentPlan,
  type AgentUsage,
  type ToolActivity,
} from '../src/core/types.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { agentEnvironment } from '../src/agents/environment.js';
import { AgyAdapter } from '../src/agents/agy.js';
import { NativeTopicRouter } from '../src/agents/topic-router.js';
import { creationOptions } from '../src/core/session-instructions.js';
import { sessionIdentity } from '../src/core/session-identity.js';
import { approvalModes } from '../src/core/approval-policy.js';
import { fixture, incoming } from './helpers.js';

function installFakeAgy(dir: string): string {
  const executable = join(dir, 'fake-agy.mjs');
  copyFileSync(new URL('./fixtures/fake-agy.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  return executable;
}

function readTrace(dir: string): any[] {
  return readFileSync(join(dir, 'acp-trace.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('Antigravity CLI aliases resolve to agy and parse two-word command forms', () => {
  for (const name of [
    'agy',
    'agycli',
    'AGY CLI',
    'antigravity',
    'antigravity-cli',
    'Antigravity CLI',
  ])
    assert.equal(agentKind(name), 'agy');
  assert.deepEqual(creationOptions('/tab new agy cli default').args, ['agy CLI', 'default']);
  assert.deepEqual(creationOptions('/tab new Antigravity CLI default').args, [
    'Antigravity CLI',
    'default',
  ]);
});

test('Antigravity CLI configuration preserves executable and classifier selection', async () => {
  const f = fixture();
  try {
    const file = join(f.dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        defaultAgent: 'agy',
        topicRouterAgent: 'agy',
        workspaces: { default: f.dir },
        agents: { agy: { command: '/usr/local/bin/agy' } },
      }),
    );
    const config = loadConfig(file);
    assert.equal(config.defaultAgent, 'agy');
    assert.equal(config.topicRouterAgent, 'agy');
    assert.equal(config.agents.agy.command, '/usr/local/bin/agy');
    for (const alias of ['agycli', 'antigravity', 'Antigravity CLI']) {
      writeFileSync(
        file,
        JSON.stringify({ ...config, defaultAgent: alias, topicRouterAgent: alias }),
      );
      const loaded = loadConfig(file);
      assert.equal(loaded.defaultAgent, 'agy');
      assert.equal(loaded.topicRouterAgent, 'agy');
    }
  } finally {
    await f.cleanup();
  }
});

test('Antigravity CLI tasks persist in Store and appear in agentCatalog', async () => {
  const f = fixture();
  try {
    for (const alias of ['agy', 'agycli', 'Antigravity CLI']) {
      const node = await f.manager.createDashboardTask({
        key: `agy-${alias.replace(/\s/g, '')}`,
        title: 'AGY task',
        agent: alias,
      });
      assert.equal(f.store.get(node.sessionId!)!.agent, 'agy');
      const reopened = new Store(f.config.dataDir);
      try {
        assert.equal(reopened.get(node.sessionId!)!.agent, 'agy');
      } finally {
        reopened.close();
      }
    }
    const entry = f.manager.agentCatalog().find((a) => a.id === 'agy');
    assert.equal(entry?.name, 'Antigravity CLI');
    assert.deepEqual(
      approvalModes('agy').map((m) => m.id),
      ['native', 'default', 'accept-edits', 'auto', 'auto-allow', 'plan'],
    );
  } finally {
    await f.cleanup();
  }
});

test('Antigravity child environment strips parent session IPC vars while keeping user env', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      ANTIGRAVITY_CONVERSATION_ID: 'parent-conv',
      ANTIGRAVITY_TRAJECTORY_ID: 'parent-traj',
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9999',
      ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf',
      ANTIGRAVITY_SOURCE_METADATA: 'meta',
      ANTIGRAVITY_AGENTAPI_EXE: '/bin/agentapi',
      ANTIGRAVITY_AGENT: '1',
      ANTIGRAVITY_LS_VERSION: '1.0.0',
      ANTIGRAVITY_PROJECT_ID: 'proj-1',
      GEMINI_API_KEY: 'user-api-key',
    });
    const env = agentEnvironment();
    for (const key of [
      'ANTIGRAVITY_CONVERSATION_ID',
      'ANTIGRAVITY_TRAJECTORY_ID',
      'ANTIGRAVITY_LS_ADDRESS',
      'ANTIGRAVITY_CSRF_TOKEN',
      'ANTIGRAVITY_SOURCE_METADATA',
      'ANTIGRAVITY_AGENTAPI_EXE',
      'ANTIGRAVITY_AGENT',
      'ANTIGRAVITY_LS_VERSION',
      'ANTIGRAVITY_PROJECT_ID',
    ])
      assert.equal(env[key], undefined, `${key} should be stripped`);
    assert.equal(env.GEMINI_API_KEY, 'user-api-key');
  } finally {
    process.env = saved;
  }
});

test('AgyAdapter discovers models, runs ACP turn, streams buffered text/tools/plan/usage, and resumes saved ID', async () => {
  const f = fixture();
  try {
    const executable = installFakeAgy(f.dir);
    const adapter = new AgyAdapter(executable);
    const s = f.store.create(
      { ...incoming('').route, platform: 'local' },
      'agy',
      f.dir,
      'Always answer concisely.',
    );

    const models = await adapter.models(s, AbortSignal.timeout(5000));
    assert.deepEqual(
      models.map((m) => m.id),
      ['agy-model-a', 'agy-model-b', 'agy-model-fixed'],
    );
    assert.deepEqual(
      models[0]!.efforts.map((e) => e.id),
      ['low', 'medium', 'high'],
    );
    assert.equal(models[0]!.defaultEffort, 'medium');
    assert.deepEqual(
      models[1]!.efforts.map((e) => e.id),
      ['low', 'high'],
    );
    assert.equal(models[1]!.defaultEffort, undefined);
    assert.deepEqual(models[2]!.efforts, []);

    s.settings = { model: 'agy-model-b', effort: 'high' };
    s.approvalPolicy = 'accept-edits';

    const texts: string[] = [];
    const tools: ToolActivity[] = [];
    const plans: AgentPlan[] = [];
    const usages: AgentUsage[] = [];
    const inputs: any[] = [];
    const hooks = {
      input(v: any) {
        inputs.push(v);
      },
      nativeId(id: string) {
        s.nativeId = id;
        f.store.save(s);
      },
      text(t: string) {
        texts.push(t);
      },
      activity() {},
      tool(t: ToolActivity) {
        tools.push(t);
      },
      plan(p: AgentPlan) {
        plans.push(p);
      },
      usage(u: AgentUsage) {
        usages.push(u);
      },
      async ask() {
        throw new Error('unexpected ask');
      },
    };

    await adapter.run({
      session: s,
      text: '第一次检查',
      hooks,
      signal: AbortSignal.timeout(5000),
      taskBridge: { url: 'http://127.0.0.1:4317/mcp', token: 'bridge-secret' },
    });

    assert.equal(s.nativeId, 'agy-native-1');
    // Chunks before tool_call are buffered into one message; post-tool text is second message.
    assert.deepEqual(texts, ['正在检查代码', '完成：第一次检查']);
    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.status, 'running');
    assert.equal(tools[0]!.name, 'Run tests');
    assert.equal(tools[1]!.status, 'completed');
    assert.equal(tools[1]!.exitCode, 0);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.source, 'agy');
    assert.equal(plans[0]!.steps.length, 2);
    assert.equal(usages.at(-1)!.source, 'agy');
    assert.equal(usages.at(-1)!.contextTokens, 4200);
    assert.equal(usages.at(-1)!.modelContextWindow, 200000);
    assert.equal(usages.at(-1)!.last?.inputTokens, 3500);
    assert.equal(usages.at(-1)!.last?.cachedInputTokens, 1200);
    assert.equal(usages.at(-1)!.last?.outputTokens, 700);
    assert.equal(inputs[0]!.instructionMode, 'agy-append');
    assert.equal(inputs[0]!.instructions, 'Always answer concisely.');

    // Verify ACP wire payloads (jsonrpc 2.0, mcpServers, _meta.antigravity.systemPrompt, configOptions).
    const trace = readTrace(f.dir);
    assert.ok(trace.every((m) => m.jsonrpc === '2.0'));
    const sessionNew = trace.find(
      (m) => m.method === 'session/new' && m.params.mcpServers?.length === 1,
    );
    assert.ok(sessionNew);
    assert.equal(sessionNew.params.mcpServers[0].type, 'http');
    assert.equal(sessionNew.params.mcpServers[0].name, 'tab_ai_tasks');
    assert.deepEqual(sessionNew.params.mcpServers[0].headers, [
      { name: 'Authorization', value: 'Bearer bridge-secret' },
    ]);
    assert.equal(
      sessionNew.params._meta?.antigravity?.systemPrompt?.append,
      'Always answer concisely.',
    );
    const setConfigs = trace.filter((m) => m.method === 'session/set_config_option');
    assert.deepEqual(
      setConfigs.map((m) => [m.params.configId, m.params.value]),
      [
        ['mode', 'accept-edits'],
        ['model', 'agy-model-b'],
        ['thought_level', 'high'],
      ],
    );

    // Second turn must use session/resume with the saved nativeId.
    texts.length = 0;
    await adapter.run({
      session: s,
      text: '第二次检查',
      hooks,
      signal: AbortSignal.timeout(5000),
    });
    assert.deepEqual(texts, ['正在检查代码', '完成：第二次检查']);
    const resumed = readTrace(f.dir).find((m) => m.method === 'session/resume');
    assert.equal(resumed?.params.sessionId, 'agy-native-1');
  } finally {
    await f.cleanup();
  }
});

test('AgyAdapter falls back to session/load and suppresses replayed history events', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'no-resume'), '1');
    const executable = installFakeAgy(f.dir);
    const adapter = new AgyAdapter(executable);
    const s = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
    s.nativeId = 'agy-existing-99';

    const texts: string[] = [];
    const tools: ToolActivity[] = [];
    await adapter.run({
      session: s,
      text: '新任务',
      hooks: {
        nativeId() {},
        text(t) {
          texts.push(t);
        },
        activity() {},
        tool(t) {
          tools.push(t);
        },
        async ask() {
          throw new Error('unexpected');
        },
      },
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(!texts.some((t) => t.includes('REPLAYED OLD MESSAGE')));
    assert.ok(!tools.some((t) => t.id === 'old-tool'));
    assert.deepEqual(texts, ['正在检查代码', '完成：新任务']);
    assert.ok(readTrace(f.dir).some((m) => m.method === 'session/load'));
  } finally {
    await f.cleanup();
  }
});

test('AgyAdapter supports legacy models/modes responses and set_model/set_mode fallback', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'legacy-models'), '1');
    const executable = installFakeAgy(f.dir);
    const adapter = new AgyAdapter(executable);
    const s = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);

    const models = await adapter.models(s, AbortSignal.timeout(5000));
    assert.deepEqual(models, [{ id: 'gemini-legacy', label: 'Gemini Legacy', efforts: [] }]);

    s.settings = { model: 'gemini-legacy' };
    s.approvalPolicy = 'accept-edits';
    const texts: string[] = [];
    await adapter.run({
      session: s,
      text: 'legacy',
      hooks: {
        nativeId(id) {
          s.nativeId = id;
        },
        text(t) {
          texts.push(t);
        },
        activity() {},
        async ask() {
          throw new Error('unexpected');
        },
      },
      signal: AbortSignal.timeout(5000),
    });
    const trace = readTrace(f.dir);
    assert.ok(
      trace.some((m) => m.method === 'session/set_mode' && m.params.modeId === 'accept-edits'),
    );
    assert.ok(
      trace.some((m) => m.method === 'session/set_model' && m.params.modelId === 'gemini-legacy'),
    );
  } finally {
    await f.cleanup();
  }
});

test('AgyAdapter handles permissions (allow/deny/cancel), session-scoped grants, taskBridge auto-allow, and fail-closed unknown requests', async () => {
  const f = fixture();
  try {
    const executable = installFakeAgy(f.dir);
    const adapter = new AgyAdapter(executable);
    const s = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);

    // 1. Flush text before asking, then allow once.
    const order: string[] = [];
    await adapter.run({
      session: s,
      text: 'need-approval',
      hooks: {
        nativeId(id) {
          s.nativeId = id;
        },
        text(t) {
          order.push(`text:${t}`);
        },
        activity() {},
        async ask(req) {
          order.push(`ask:${req.title}`);
          assert.equal(req.kind, 'approval');
          assert.ok(req.detail.includes('npm test'));
          return { allow: true, scope: 'once' };
        },
      },
      signal: AbortSignal.timeout(5000),
    });
    assert.deepEqual(order, [
      'text:即将执行测试命令',
      'ask:Antigravity CLI 请求：Run npm test',
      'text:approval=selected:allow_once',
    ]);

    // 2. Cancel decision maps to ACP cancelled outcome.
    const cancelTexts: string[] = [];
    await adapter.run({
      session: s,
      text: 'need-approval',
      hooks: {
        nativeId() {},
        text(t) {
          cancelTexts.push(t);
        },
        activity() {},
        async ask() {
          return { allow: false, cancel: true };
        },
      },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(cancelTexts.at(-1), 'approval=cancelled');

    // 3. Session-scoped grant reuses approval within session without re-asking, sends allow_once.
    let askCount = 0;
    const repeatTexts: string[] = [];
    await adapter.run({
      session: s,
      text: 'repeat-approval',
      hooks: {
        nativeId() {},
        text(t) {
          repeatTexts.push(t);
        },
        activity() {},
        async ask() {
          askCount++;
          return { allow: true, scope: 'session' };
        },
      },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(askCount, 1);
    assert.deepEqual(repeatTexts, ['allow_once,allow_once']);

    // Release clears session-scoped grants.
    await adapter.release(s.id);
    askCount = 0;
    await adapter.run({
      session: s,
      text: 'repeat-approval',
      hooks: {
        nativeId() {},
        text() {},
        activity() {},
        async ask() {
          askCount++;
          return { allow: true, scope: 'once' };
        },
      },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(askCount, 2);

    // 4. Task bridge MCP tool is auto-allowed only when taskBridge is active.
    const taskTexts: string[] = [];
    await adapter.run({
      session: s,
      text: 'task-tool-approval',
      taskBridge: { url: 'http://127.0.0.1:4317/mcp', token: 'tok' },
      hooks: {
        nativeId() {},
        text(t) {
          taskTexts.push(t);
        },
        activity() {},
        async ask() {
          throw new Error('task bridge tool should auto-allow');
        },
      },
      signal: AbortSignal.timeout(5000),
    });
    assert.deepEqual(taskTexts, ['task=allow_once,allow_once']);

    // 5. Wrong sessionId notifications are ignored and wrong sessionId permission requests get -32602.
    const wrongTexts: string[] = [];
    await adapter.run({
      session: s,
      text: 'wrong-session-id',
      hooks: {
        nativeId() {},
        text(t) {
          wrongTexts.push(t);
        },
        activity() {},
        async ask() {
          throw new Error('wrong sessionId must not prompt');
        },
      },
      signal: AbortSignal.timeout(5000),
    });
    assert.deepEqual(wrongTexts, ['wrong-session-error:-32602']);

    // 6. Unknown client method fails closed.
    await assert.rejects(
      adapter.run({
        session: s,
        text: 'unknown-request',
        hooks: {
          nativeId() {},
          text() {},
          activity() {},
          async ask() {
            throw new Error('unexpected');
          },
        },
        signal: AbortSignal.timeout(5000),
      }),
      /需要原生终端处理的请求: fs\/read_text_file/,
    );

    // 7. Non-end_turn refusal surfaces an error.
    await assert.rejects(
      adapter.run({
        session: s,
        text: 'refusal',
        hooks: {
          nativeId() {},
          text() {},
          activity() {},
          async ask() {
            throw new Error('unexpected');
          },
        },
        signal: AbortSignal.timeout(5000),
      }),
      /Antigravity CLI 拒绝了本次请求/,
    );
  } finally {
    await f.cleanup();
  }
});

test('AgyAdapter sends session/cancel on abort and formats resumeCommand / detach safely', async () => {
  const f = fixture();
  try {
    const executable = installFakeAgy(f.dir);
    const adapter = new AgyAdapter(executable);
    const s = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(
      adapter.run({
        session: s,
        text: 'slow-cancel',
        hooks: {
          nativeId(id) {
            s.nativeId = id;
          },
          text() {},
          activity() {},
          async ask() {
            throw new Error('unexpected');
          },
        },
        signal: ac.signal,
      }),
      /任务已中断/,
    );

    s.nativeId = 'agy-native-1';
    s.settings = { model: 'agy-model-a', effort: 'high' };
    s.approvalPolicy = 'accept-edits';
    assert.deepEqual(adapter.resumeCommand(s), [
      executable,
      '--resume',
      'agy-native-1',
      '--model',
      'agy-model-a',
      '--effort',
      'high',
      '--mode',
      'accept-edits',
    ]);
    assert.ok(sessionIdentity(s).includes('agy --resume agy-native-1'));
    assert.ok(sessionIdentity(s).includes('--mode accept-edits'));

    // With custom instructions, detach refuses so instructions are not silently dropped.
    s.instructions = 'Only use TypeScript.';
    f.store.save(s);
    assert.throws(() => f.manager.detach(s.id), /附加系统提示参数/);
    assert.ok(sessionIdentity(s).includes('ACP 附加系统提示'));
  } finally {
    await f.cleanup();
  }
});

test('NativeTopicRouter classifies with agy --print --output-format json --json-schema', async () => {
  const f = fixture();
  try {
    const executable = installFakeAgy(f.dir);
    const router = new NativeTopicRouter('agy', executable);
    try {
      const decision = await router.classify(
        {
          text: '新开话题用 agy 分析代码',
          workspaces: ['default'],
          currentWorkspace: 'default',
          hasSession: true,
          recentUserMessages: [],
        },
        AbortSignal.timeout(5000),
      );
      assert.equal(decision.action, 'new_topic');
      assert.equal(decision.agent, 'agy');
      assert.equal(decision.task, '分析代码');
      const printArgs = JSON.parse(readFileSync(join(f.dir, 'print-args.jsonl'), 'utf8').trim());
      assert.ok(printArgs.includes('--print'));
      assert.ok(printArgs.includes('--output-format'));
      assert.ok(printArgs.includes('json'));
      assert.ok(printArgs.includes('--json-schema'));
      assert.ok(printArgs.includes('--disable-slash-commands'));
      assert.ok(printArgs.includes('--sandbox'));

      await assert.rejects(
        router.classify(
          {
            text: 'trigger-router-error',
            workspaces: ['default'],
            currentWorkspace: 'default',
            hasSession: true,
            recentUserMessages: [],
          },
          AbortSignal.timeout(5000),
        ),
        /Antigravity CLI 分类退出/,
      );
    } finally {
      await router.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('AGY native auto and framework auto-allow use valid ACP modes and narrowly scoped approval choices', async () => {
  const f = fixture();
  try {
    const executable = installFakeAgy(f.dir),
      adapter = new AgyAdapter(executable);
    const s = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
    for (const policy of ['auto', 'auto-allow']) {
      s.approvalPolicy = policy;
      const accepted: any[] = [];
      await adapter.run({
        session: s,
        text: 'need-approval',
        signal: AbortSignal.timeout(5000),
        hooks: {
          nativeId(id) {
            s.nativeId = id;
          },
          text() {},
          activity() {},
          inputAccepted(value) {
            accepted.push(value);
          },
          async ask(request) {
            assert.equal(request.approvalAutomation, 'agy-command-file');
            assert.equal(
              request.approvalOptions?.find((o) => o.id === 'session')?.label,
              '允许本会话重复此操作',
            );
            assert.match(
              request.approvalOptions!.find((o) => o.id === 'session')!.description!,
              /完全一致|相同|均相同/,
            );
            return { allow: true };
          },
        },
      });
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].nativeId, 'agy-native-1');
    }
    const trace = readFileSync(join(f.dir, 'acp-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    const modes = trace
      .filter((x) => x.method === 'session/set_config_option' && x.params.configId === 'mode')
      .map((x) => x.params.value);
    assert.deepEqual(modes, ['auto', 'default']);
    assert.ok(!trace.some((x) => x.params?.value === 'auto-allow'));
  } finally {
    await f.cleanup();
  }
});

test('AGY clears its first-acceptance deadline after a valid prompt event while the turn continues', async () => {
  const f = fixture();
  try {
    const adapter = new AgyAdapter(installFakeAgy(f.dir), [], 60);
    const session = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
    const controller = new AbortController();
    let accepted = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(
        adapter.run({
          session,
          text: 'slow-cancel',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          hooks: {
            nativeId(id) {
              session.nativeId = id;
            },
            text() {},
            activity() {},
            inputAccepted() {
              accepted++;
              timer = setTimeout(() => controller.abort(), 150);
            },
            async ask() {
              throw Error('unexpected approval');
            },
          },
        }),
        /任务已中断/,
      );
      assert.equal(accepted, 1);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await f.cleanup();
  }
});

test('AGY does not disguise persistent native permissions as single-use or session-local grants', async () => {
  const f = fixture();
  try {
    const adapter = new AgyAdapter(installFakeAgy(f.dir));
    const session = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
    const texts: string[] = [];
    await adapter.run({
      session,
      text: 'persistent-approval',
      signal: AbortSignal.timeout(5000),
      hooks: {
        nativeId(id) {
          session.nativeId = id;
        },
        text(value) {
          texts.push(value);
        },
        activity() {},
        async ask(request) {
          assert.deepEqual(
            request.approvalOptions?.map((o) => o.id),
            ['cancel'],
          );
          assert.equal(request.approvalAutomation, undefined);
          assert.match(request.detail, /持久允许/);
          return { allow: false, cancel: true };
        },
      },
    });
    assert.deepEqual(texts, ['cancelled']);
  } finally {
    await f.cleanup();
  }
});

test('AGY rejects missing model catalogues and invalid native defaults before sending a prompt', async () => {
  for (const flag of ['empty-model-catalogue', 'invalid-default-model']) {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, flag), '1');
      const adapter = new AgyAdapter(installFakeAgy(f.dir));
      const session = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
      let inputs = 0;
      await assert.rejects(
        adapter.run({
          session,
          text: 'continue',
          signal: AbortSignal.timeout(5000),
          hooks: {
            nativeId(id) {
              session.nativeId = id;
            },
            input() {
              inputs++;
            },
            text() {},
            activity() {},
            async ask() {
              throw Error('unexpected approval');
            },
          },
        }),
        /本轮未发送/,
      );
      assert.equal(inputs, 0);
      assert.ok(!readTrace(f.dir).some((event) => event.method === 'session/prompt'));
    } finally {
      await f.cleanup();
    }
  }
});

test('AGY records a native executor failure even if ACP returns it as text with end_turn or stalls after acceptance', async () => {
  for (const flag of ['prompt-error-as-success', 'prompt-error-after-acceptance']) {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, flag), '1');
      const adapter = new AgyAdapter(installFakeAgy(f.dir));
      const session = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
      const texts: string[] = [];
      await assert.rejects(
        adapter.run({
          session,
          text: 'continue',
          signal: AbortSignal.timeout(5000),
          hooks: {
            nativeId(id) {
              session.nativeId = id;
            },
            text(value) {
              texts.push(value);
            },
            activity() {},
            async ask() {
              throw Error('unexpected approval');
            },
          },
        }),
        /原生模型初始化失败/,
      );
      assert.ok(!texts.some((value) => value.includes('MODEL_PLACEHOLDER')));
      assert.equal(readTrace(f.dir).filter((event) => event.method === 'session/prompt').length, 1);
    } finally {
      await f.cleanup();
    }
  }
});

test('AGY keeps model-error quotations in normal replies when no native failure occurred', async () => {
  const f = fixture();
  try {
    const adapter = new AgyAdapter(installFakeAgy(f.dir));
    const session = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
    const texts: string[] = [];
    await adapter.run({
      session,
      text: 'Explain failed to construct executor: model not found',
      signal: AbortSignal.timeout(5000),
      hooks: {
        nativeId(id) {
          session.nativeId = id;
        },
        text(value) {
          texts.push(value);
        },
        activity() {},
        async ask() {
          throw Error('unexpected approval');
        },
      },
    });
    assert.ok(texts.join('').includes('failed to construct executor'));
  } finally {
    await f.cleanup();
  }
});

test('AGY explains keychain authentication failures and never sends or replays the user prompt', async () => {
  const f = fixture();
  try {
    const adapter = new AgyAdapter(installFakeAgy(f.dir));
    const session = f.store.create({ ...incoming('').route, platform: 'local' }, 'agy', f.dir);
    session.nativeId = 'agy-saved-native';
    writeFileSync(join(f.dir, 'keychain-auth-failure'), '1');
    let accepted = 0;
    await assert.rejects(
      adapter.run({
        session,
        text: '继续',
        signal: AbortSignal.timeout(5000),
        hooks: {
          nativeId() {},
          text() {},
          activity() {},
          inputAccepted() {
            accepted++;
          },
          async ask() {
            throw Error('unexpected approval');
          },
        },
      }),
      /macOS 登录钥匙串.*静默登录失败/,
    );
    const trace = readTrace(f.dir);
    assert.equal(accepted, 0);
    assert.equal(session.nativeId, 'agy-saved-native');
    assert.ok(
      !trace.some((x) => ['session/prompt', 'session/new', 'authenticate'].includes(x.method)),
    );
    await assert.rejects(adapter.models(session, AbortSignal.timeout(5000)), /macOS 登录钥匙串/);
    assert.ok(!readTrace(f.dir).some((x) => ['session/prompt', 'authenticate'].includes(x.method)));
  } finally {
    await f.cleanup();
  }
});
