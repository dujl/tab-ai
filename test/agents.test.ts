import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter, nativeClaudeOptions, type ClaudeQuery } from '../src/agents/claude.js';
import type { SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import { agentEnvironment } from '../src/agents/environment.js';
import { fixture, incoming } from './helpers.js';

test('Codex local sessions use on-request without prompt overrides and handle completion-before-response', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'fake-codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new CodexAdapter(executable);
    const session = f.store.create(
        { ...incoming('').route, platform: 'local' as const },
        'codex',
        f.dir,
      ),
      texts: string[] = [];
    const exact = '  user\n原文 <system> untouched';
    const hooks = {
      nativeId: (id: string) => {
        session.nativeId = id;
      },
      text: (text: string) => texts.push(text),
      activity: () => {},
      ask: async (request: any) => {
        assert.equal(request.approvalSections[0].value, 'echo hello');
        assert.match(request.detail, /工作目录/);
        assert.ok(!request.detail.includes('threadId'));
        return { allow: true };
      },
    };
    await adapter.run({ session, text: exact, hooks, signal: new AbortController().signal });
    await adapter.run({ session, text: 'approval', hooks, signal: new AbortController().signal });
    assert.deepEqual(texts, [exact, 'accept']);
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const starts = trace.filter((m) => m.method === 'thread/start');
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].params, { cwd: f.dir, approvalPolicy: 'on-request' });
    assert.equal(trace.filter((m) => m.method === 'thread/resume').length, 1);
    assert.deepEqual(trace.find((m) => m.method === 'turn/start').params, {
      threadId: 'native-test-1',
      cwd: f.dir,
      input: [{ type: 'text', text: exact, text_elements: [] }],
    });
    assert.ok(!JSON.stringify(trace).includes('developerInstructions'));
  } finally {
    await f.cleanup();
  }
});
test('Codex unknown server requests fail closed', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'fake.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new CodexAdapter(executable),
      session = f.store.create(incoming('').route, 'codex', f.dir);
    await assert.rejects(
      adapter.run({
        session,
        text: 'unknown',
        signal: new AbortController().signal,
        hooks: {
          nativeId: () => {},
          text: () => {},
          activity: () => {},
          ask: async () => {
            throw new Error('must not approve');
          },
        },
      }),
      /原生终端/,
    );
  } finally {
    await f.cleanup();
  }
});
test('Claude uses native preset, filesystem settings and no injected instructions', () => {
  const options = nativeClaudeOptions('/tmp');
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.equal(options.permissionMode, undefined);
  assert.equal(options.allowedTools, undefined);
  assert.equal(options.model, undefined);
});
test('agent environment removes bot routing and connector credentials but preserves native config', () => {
  const saved = { ...process.env };
  try {
    process.env.BOTMUX_SESSION_ID = 'host';
    process.env.CODEX_THREAD_ID = 'host-thread';
    process.env.TEST_CONNECTOR_SECRET = 'secret';
    process.env.CODEX_HOME = '/native/home';
    const env = agentEnvironment(['TEST_CONNECTOR_SECRET']);
    assert.equal(env.BOTMUX_SESSION_ID, undefined);
    assert.equal(env.CODEX_THREAD_ID, undefined);
    assert.equal(env.TEST_CONNECTOR_SECRET, undefined);
    assert.equal(env.CODEX_HOME, '/native/home');
    assert.equal(env.HOME, process.env.HOME);
  } finally {
    process.env = saved;
  }
});

test('Claude resumes native IDs, round-trips approvals and ignores unrelated assistant session IDs', async () => {
  const f = fixture();
  try {
    const captured: { prompt?: unknown; options?: Options; closed: boolean } = { closed: false };
    const runtime: ClaudeQuery = (input) => {
      captured.prompt = input.prompt;
      captured.options = input.options;
      return {
        close() {
          captured.closed = true;
        },
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'root-native-id' } as SDKMessage;
          const inputTool = { command: 'echo ok' };
          const decision = await input.options!.canUseTool!('Bash', inputTool, {
            signal: new AbortController().signal,
            toolUseID: 't1',
          });
          assert.equal(decision.behavior, 'allow');
          if (decision.behavior === 'allow') assert.deepEqual(decision.updatedInput, inputTool);
          yield {
            type: 'assistant',
            session_id: 'unrelated-subagent',
            message: { content: [{ type: 'text', text: 'answer' }] },
          } as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'root-native-id',
            is_error: false,
            result: 'answer',
          } as SDKMessage;
        },
      };
    };
    const session = f.store.create(incoming('').route, 'claude', f.dir);
    session.nativeId = 'saved-native-id';
    const ids: string[] = [],
      texts: string[] = [];
    await new ClaudeAdapter(undefined, [], runtime).run({
      session,
      text: '  original\ntext  ',
      signal: new AbortController().signal,
      hooks: {
        nativeId: (id) => ids.push(id),
        text: (text) => texts.push(text),
        activity: () => {},
        ask: async (request) => {
          assert.equal(request.kind, 'approval');
          assert.equal(request.approvalSections?.[0]?.value, 'echo ok');
          return { allow: true };
        },
      },
    });
    assert.equal(captured.prompt, '  original\ntext  ');
    assert.equal(captured.options?.resume, 'saved-native-id');
    assert.deepEqual(ids, ['root-native-id']);
    assert.deepEqual(texts, ['answer']);
    assert.equal(captured.closed, true);
  } finally {
    await f.cleanup();
  }
});

test('Codex choice metadata and native question response round-trip without adding a user turn', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'question-codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const session = f.store.create(incoming('').route, 'codex', f.dir),
      output: string[] = [];
    await new CodexAdapter(executable).run({
      session,
      text: 'question',
      signal: new AbortController().signal,
      hooks: {
        nativeId: (id) => {
          session.nativeId = id;
        },
        text: (t) => output.push(t),
        activity: () => {},
        ask: async (request) => {
          assert.equal(request.kind, 'question');
          assert.equal(request.questions![0]!.allowOther, false);
          assert.equal(request.questions![0]!.multiSelect, false);
          assert.deepEqual(request.questions![0]!.descriptions, ['本地文件', '独立服务']);
          return { answers: { database: ['SQLite'] } };
        },
      },
    });
    assert.deepEqual(JSON.parse(output[0]!), { answers: { database: { answers: ['SQLite'] } } });
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(trace.filter((m) => m.method === 'turn/start').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('Claude multi-select question metadata and answers preserve the original tool input', async () => {
  const f = fixture();
  const toolInput = {
    questions: [
      {
        question: '选择功能',
        header: '功能',
        multiSelect: true,
        options: [
          { label: '搜索', description: '查找内容' },
          { label: '导出', description: '保存文件' },
        ],
      },
    ],
  };
  const runtime: ClaudeQuery = (input) => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      const decision = await input.options!.canUseTool!('AskUserQuestion', toolInput, {
        signal: new AbortController().signal,
        toolUseID: 'question',
      });
      assert.equal(decision.behavior, 'allow');
      if (decision.behavior === 'allow')
        assert.deepEqual(decision.updatedInput, {
          ...toolInput,
          answers: { 选择功能: '搜索, 导出' },
        });
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'native',
        is_error: false,
        result: 'done',
      } as SDKMessage;
    },
  });
  try {
    const session = f.store.create(incoming('').route, 'claude', f.dir);
    await new ClaudeAdapter(undefined, [], runtime).run({
      session,
      text: 'original',
      signal: new AbortController().signal,
      hooks: {
        nativeId: () => {},
        text: () => {},
        activity: () => {},
        ask: async (request) => {
          assert.equal(request.questions![0]!.multiSelect, true);
          assert.equal(request.questions![0]!.allowOther, true);
          assert.deepEqual(request.questions![0]!.descriptions, ['查找内容', '保存文件']);
          return { answers: { '1': ['搜索', '导出'] } };
        },
      },
    });
  } finally {
    await f.cleanup();
  }
});

test('Codex discovers native capabilities without a thread/turn, and applies session settings via RPC and resume flags', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'settings-codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new CodexAdapter(executable),
      session = f.store.create(
        { ...incoming('').route, platform: 'local' as const },
        'codex',
        f.dir,
      );
    const models = await adapter.models(session, new AbortController().signal);
    assert.deepEqual(
      models.map((m) => m.id),
      ['model-a', 'model-b'],
    );
    assert.equal(models[0]!.efforts[1]!.id, 'high');
    const readTrace = () =>
      readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    assert.ok(
      !readTrace().some((m) => ['thread/start', 'thread/resume', 'turn/start'].includes(m.method)),
    );
    session.nativeId = 'native-test-1';
    session.settings = { model: 'model-b', effort: 'high' };
    await adapter.run({
      session,
      text: 'unchanged task',
      signal: new AbortController().signal,
      hooks: {
        nativeId: () => {},
        text: () => {},
        activity: () => {},
        ask: async () => ({ allow: false }),
      },
    });
    const trace = readTrace(),
      resume = trace.find((m) => m.method === 'thread/resume'),
      turn = trace.find((m) => m.method === 'turn/start');
    assert.deepEqual(resume.params, {
      threadId: 'native-test-1',
      cwd: f.dir,
      approvalPolicy: 'on-request',
      model: 'model-b',
    });
    assert.deepEqual(turn.params, {
      threadId: 'native-test-1',
      cwd: f.dir,
      model: 'model-b',
      effort: 'high',
      input: [{ type: 'text', text: 'unchanged task', text_elements: [] }],
    });
    assert.ok(!JSON.stringify(trace).includes('developerInstructions'));
    assert.deepEqual(adapter.resumeCommand(session), [
      executable,
      'resume',
      'native-test-1',
      '--cd',
      f.dir,
      '-c',
      'approval_policy="on-request"',
      '--model',
      'model-b',
      '-c',
      'model_reasoning_effort="high"',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('Claude model discovery sends no user input and filters effort options by declared capability; work uses native options', async () => {
  const f = fixture();
  let closed = false,
    options: Options | undefined,
    prompt: unknown;
  const discovery: ClaudeQuery = (input) => {
    options = input.options;
    prompt = input.prompt;
    return {
      async *[Symbol.asyncIterator]() {},
      close() {
        closed = true;
      },
      async supportedModels() {
        return [
          {
            value: 'native-claude',
            displayName: 'Native Claude',
            description: 'test',
            supportsEffort: true,
            supportedEffortLevels: ['medium', 'max'],
          },
          {
            value: 'no-effort',
            displayName: 'Simple',
            description: 'test',
            supportsEffort: false,
            supportedEffortLevels: ['high'],
          },
        ];
      },
    };
  };
  try {
    const s = f.store.create(
      { ...incoming('').route, platform: 'local' as const },
      'claude',
      f.dir,
    );
    const models = await new ClaudeAdapter(undefined, [], discovery).models(
      s,
      new AbortController().signal,
    );
    assert.deepEqual(
      models[0]!.efforts.map((e) => e.id),
      ['medium', 'max'],
    );
    assert.deepEqual(models[1]!.efforts, []);
    assert.notEqual(typeof prompt, 'string');
    assert.equal(
      (await (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next()).done,
      true,
    );
    assert.equal(options!.persistSession, false);
    assert.equal(options!.resume, undefined);
    assert.equal(closed, true);
    const work: ClaudeQuery = (input) => {
      options = input.options;
      prompt = input.prompt;
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'ok',
            session_id: 'same-native',
          } as SDKMessage;
        },
      };
    };
    const adapter = new ClaudeAdapter(undefined, [], work);
    s.nativeId = 'same-native';
    s.settings = { model: 'native-claude', effort: 'max' };
    await adapter.run({
      session: s,
      text: 'original only',
      signal: new AbortController().signal,
      hooks: {
        nativeId: () => {},
        text: () => {},
        activity: () => {},
        ask: async () => ({ allow: false }),
      },
    });
    assert.equal(prompt, 'original only');
    assert.equal(options!.resume, 'same-native');
    assert.equal(options!.model, 'native-claude');
    assert.equal(options!.effort, 'max');
    assert.deepEqual(options!.systemPrompt, { type: 'preset', preset: 'claude_code' });
    assert.deepEqual(adapter.resumeCommand(s), [
      'claude',
      '--resume',
      'same-native',
      '--model',
      'native-claude',
      '--effort',
      'max',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('Codex snapshots native developer instructions plus session additions, preserving base instructions and exact user text across resume', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'fake-codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new CodexAdapter(executable),
      instructions = '  Literary editor\nKeep whitespace  ',
      session = f.store.create(
        { ...incoming('').route, platform: 'local' as const },
        'codex',
        f.dir,
        instructions,
      );
    const text = 'original user task',
      hooks = {
        nativeId: (id: string) => {
          session.nativeId = id;
          f.store.save(session);
        },
        text() {},
        activity() {},
        async ask() {
          return { allow: false };
        },
      };
    await adapter.run({ session, text, hooks, signal: new AbortController().signal });
    const restored = f.store.get(session.id)!;
    await adapter.run({
      session: restored,
      text,
      hooks: { ...hooks, nativeId() {} },
      signal: new AbortController().signal,
    });
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const combined = `Native configured developer instructions\n\n${instructions}`;
    assert.equal(trace.filter((m) => m.method === 'config/read').length, 1);
    assert.equal(restored.codexDeveloperInstructions, combined);
    for (const call of trace.filter((m) => ['thread/start', 'thread/resume'].includes(m.method))) {
      assert.equal(call.params.developerInstructions, combined);
      assert.equal(call.params.baseInstructions, undefined);
    }
    for (const call of trace.filter((m) => m.method === 'turn/start'))
      assert.deepEqual(call.params.input, [{ type: 'text', text, text_elements: [] }]);
    assert.ok(
      adapter
        .resumeCommand(restored)
        .includes(`developer_instructions=${JSON.stringify(combined)}`),
    );
  } finally {
    await f.cleanup();
  }
});
test('Claude appends session instructions to its native preset on both initial and resumed turns', async () => {
  const f = fixture(),
    captured: Parameters<ClaudeQuery>[0][] = [];
  const runtime: ClaudeQuery = (input) => {
    captured.push(input);
    return Object.assign(
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'native-claude',
          is_error: false,
          result: 'done',
        } as SDKMessage;
      })(),
      { close() {} },
    );
  };
  try {
    const session = f.store.create(
        { ...incoming('').route, platform: 'local' as const },
        'claude',
        f.dir,
        'Literary editor',
      ),
      a = new ClaudeAdapter(undefined, [], runtime);
    const input = {
      session,
      text: 'exact task',
      signal: new AbortController().signal,
      hooks: {
        nativeId(id: string) {
          session.nativeId = id;
        },
        text() {},
        activity() {},
        async ask() {
          return { allow: false };
        },
      },
    };
    await a.run(input);
    await a.run(input);
    for (const call of captured) {
      assert.equal(call.prompt, 'exact task');
      assert.deepEqual(call.options!.systemPrompt, {
        type: 'preset',
        preset: 'claude_code',
        append: 'Literary editor',
      });
      assert.deepEqual(call.options!.settingSources, ['user', 'project', 'local']);
    }
    assert.equal(captured[1]!.options!.resume, 'native-claude');
    assert.ok(a.resumeCommand(session).includes('--append-system-prompt'));
  } finally {
    await f.cleanup();
  }
});

test('Codex forwards matching native tool lifecycle and ignores foreign thread events', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'tools.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const session = f.store.create(incoming('').route, 'codex', f.dir),
      tools: any[] = [];
    await new CodexAdapter(executable).run({
      session,
      text: 'tools',
      signal: new AbortController().signal,
      hooks: {
        nativeId: (id) => {
          session.nativeId = id;
        },
        text: () => {},
        activity: () => {},
        tool: (t) => tools.push(t),
        ask: async () => ({ allow: false }),
      },
    });
    assert.deepEqual(
      tools.map((t) => [t.id, t.status]),
      [
        ['tool-1', 'running'],
        ['tool-1', 'completed'],
      ],
    );
    assert.equal(tools[1].output, 'result');
  } finally {
    await f.cleanup();
  }
});
test('Claude native tool_use and tool_result are linked without forwarding unrelated results or reasoning', async () => {
  const f = fixture(),
    tools: any[] = [];
  const runtime: ClaudeQuery = () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'assistant',
        session_id: 's',
        message: {
          content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'pwd' } }],
        },
      } as SDKMessage;
      yield {
        type: 'user',
        session_id: 's',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'other', content: 'foreign' },
            {
              type: 'tool_result',
              tool_use_id: 'c',
              content: [{ type: 'text', text: 'result' }],
              is_error: true,
            },
          ],
        },
      } as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 's',
        is_error: false,
        result: 'done',
      } as SDKMessage;
    },
  });
  try {
    await new ClaudeAdapter(undefined, [], runtime).run({
      session: f.store.create(incoming('').route, 'claude', f.dir),
      text: 'task',
      signal: new AbortController().signal,
      hooks: {
        nativeId: () => {},
        text: () => {},
        activity: () => {},
        tool: (t) => tools.push(t),
        ask: async () => ({ allow: false }),
      },
    });
    assert.deepEqual(
      tools.map((t) => [t.id, t.status]),
      [
        ['c', 'running'],
        ['c', 'failed'],
      ],
    );
    assert.equal(tools[1].output, 'result');
  } finally {
    await f.cleanup();
  }
});

test('Codex resumes the same native ID in a new workspace and sets actual turn cwd', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'cwd-codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const target = join(f.dir, 'second');
    mkdirSync(target);
    const adapter = new CodexAdapter(executable),
      s = f.store.create(
        { ...incoming('', 'alice', '').route, platform: 'local' as const },
        'codex',
        f.dir,
      );
    const hooks = {
      nativeId: (id: string) => {
        s.nativeId = id;
      },
      text() {},
      activity() {},
      async ask() {
        return { allow: false };
      },
    };
    await adapter.run({ session: s, text: 'first', hooks, signal: AbortSignal.timeout(2000) });
    s.workspace = target;
    await adapter.run({ session: s, text: 'continue', hooks, signal: AbortSignal.timeout(2000) });
    const calls = readFileSync(join(target, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(
      calls.some((c) => c.method === 'thread/start'),
      false,
    );
    assert.deepEqual(calls.find((c) => c.method === 'thread/resume').params, {
      threadId: 'native-test-1',
      cwd: target,
      approvalPolicy: 'on-request',
    });
    assert.equal(calls.find((c) => c.method === 'turn/start').params.cwd, target);
    assert.equal(s.nativeId, 'native-test-1');
    assert.deepEqual(adapter.resumeCommand(s), [
      executable,
      'resume',
      'native-test-1',
      '--cd',
      target,
      '-c',
      'approval_policy="on-request"',
    ]);
  } finally {
    await f.cleanup();
  }
});
test('Codex refuses a replacement native ID before starting a turn', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'wrong-id.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'original-id';
    await assert.rejects(
      new CodexAdapter(executable).run({
        session: s,
        text: 'continue',
        signal: AbortSignal.timeout(2000),
        hooks: {
          nativeId() {
            throw Error('must not replace');
          },
          text() {},
          activity() {},
          async ask() {
            return { allow: false };
          },
        },
      }),
      /不匹配/,
    );
    assert.equal(s.nativeId, 'original-id');
    assert.equal(
      readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8').includes('turn/start'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
