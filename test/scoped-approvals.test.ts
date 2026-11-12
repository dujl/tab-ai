import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  approvalPolicyContext,
  nativeApprovalPolicy,
  selectedApprovalPolicy,
} from '../src/core/approval-policy.js';
import { approvalSummaryText } from '../src/core/approvals.js';
import { interactionText } from '../src/core/interactions.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter, type ClaudeQuery } from '../src/agents/claude.js';
import { approvalChoices } from '../src/core/approval-decisions.js';
import { validateAnswer } from '../src/core/interactions.js';
import { CardRegistry } from '../src/channels/cards.js';
import { larkCard } from '../src/channels/lark-cards.js';
import { wecomCard } from '../src/channels/wecom-cards.js';
import { createDashboard } from '../src/web/server.js';
import { executionRecords } from '../src/core/execution-records.js';
import { fixture, incoming, until } from './helpers.js';
import type { AgentRun, Interaction, Answer } from '../src/core/types.js';

test('approval scope is an explicit offered option, legacy allow/deny remain once-only and forged scopes fail', () => {
  const request = {
    id: 'request',
    sessionId: 'owner',
    kind: 'approval' as const,
    title: 'Run',
    detail: 'pwd',
    createdAt: 0,
  };
  validateAnswer(request, { allow: true });
  assert.throws(() => validateAnswer(request, { allow: true, scope: 'session' }), /不支持/);
  const scoped = { ...request, approvalOptions: approvalChoices(true, true) };
  validateAnswer(scoped, { allow: true, scope: 'session' });
  validateAnswer(scoped, { allow: false, cancel: true });
  for (const answer of [
    { allow: false, scope: 'session' },
    { allow: true, scope: 'project' },
    { allow: true, cancel: true },
  ])
    assert.throws(() => validateAnswer(scoped, answer as Answer));
  let result: Answer | undefined;
  const registry = new CardRegistry(),
    m = incoming('approve'),
    card = registry.open(m, scoped, (_actor, answer) => {
      result = answer;
    }).cards[0]!;
  const serialized = JSON.stringify(larkCard(card));
  assert.match(serialized, /本会话内允许/);
  assert.ok(!serialized.includes('永久允许'));
  assert.match(JSON.stringify(wecomCard(card)), /本会话内允许/);
  assert.equal(
    registry.submit(
      card.id,
      { sender: 'foreign', conversation: m.route.conversation },
      { action: 'session' },
    ).ok,
    false,
  );
  assert.equal(
    registry.submit(
      card.id,
      { sender: m.route.sender, conversation: m.route.conversation },
      { action: 'session' },
    ).ok,
    true,
  );
  assert.deepEqual(result, { allow: true, scope: 'session' });
});

test('approval cards and text show actual scopes even without a summary; unsupported session grants are explained', () => {
  const request: Interaction = {
    id: 'approval',
    sessionId: 'owner',
    kind: 'approval',
    title: 'Execute',
    detail: 'pwd',
    createdAt: 0,
    approvalOptions: approvalChoices(true, true),
    approvalContext: approvalPolicyContext('codex', 'on-request', true),
  };
  const card = new CardRegistry().open(incoming(''), request, () => {}).cards[0]!;
  for (const text of [
    approvalSummaryText(request),
    interactionText(request),
    JSON.stringify(larkCard(card)),
    JSON.stringify(wecomCard(card)),
  ]) {
    assert.match(text, /审批|策略/);
    assert.match(text, /不是允许所有工具|并非所有工具/);
    assert.match(text, /本会话内/);
  }
  const once = { ...request, approvalOptions: approvalChoices(false, true) };
  assert.match(approvalSummaryText(once), /未提供会话内授权/);
  assert.match(JSON.stringify(wecomCard({ ...card, request: once })), /不能扩大为允许所有/);
  assert.ok(wecomCard(card).horizontal_content_list!.length <= 6);
  const granular = approvalPolicyContext(
    'codex',
    {
      granular: {
        sandbox_approval: true,
        rules: false,
        mcp_elicitations: true,
        secret: 'do not display',
      },
    },
    true,
  );
  assert.match(granular.description, /沙箱权限：可询问/);
  assert.match(granular.description, /规则触发：不询问并拒绝/);
  assert.ok(!JSON.stringify(granular).includes('secret'));
});

test('Codex reports effective native policy on new approvals and preserves it in a retained worker', async () => {
  const f = fixture(),
    command = join(f.dir, 'codex-scopes.mjs');
  copyFileSync(new URL('./fixtures/fake-codex-scopes.mjs', import.meta.url), command);
  chmodSync(command, 0o755);
  const adapter = new CodexAdapter(command);
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir),
      contexts: Interaction['approvalContext'][] = [];
    const run = (text: string) =>
      adapter.run({
        session: s,
        text,
        signal: new AbortController().signal,
        hooks: {
          nativeId: (id) => {
            s.nativeId = id;
          },
          text() {},
          activity() {},
          ask: async (request) => {
            contexts.push(request.approvalContext);
            return { allow: true, scope: 'session' };
          },
        },
      });
    await run('first');
    await run('other');
    assert.equal(contexts.length, 2);
    assert.deepEqual(contexts[0], contexts[1]);
    assert.match(contexts[0]!.label, /按需申请/);
    assert.match(contexts[0]!.description, /原生当前生效/);
    assert.equal(s.approvalPolicy, undefined);
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});

test('management policy choices include visible consequences and pending requests record their own session policy', async () => {
  const f = fixture(),
    views: any[] = [];
  Object.assign(f.channel, {
    sendManagement: async (_m: unknown, view: unknown) => views.push(view),
  });
  f.manager.registerChannel(f.channel);
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.approvalPolicy = 'never';
    f.store.save(s);
    await f.manager.receive(incoming('/tab menu more'));
    assert.ok(views.at(-1).buttons.some((b: any) => b.command === '/tab menu tools'));
    await f.manager.receive(incoming('/tab menu tools'));
    assert.ok(views.at(-1).buttons.some((b: any) => b.command === '/tab approval'));
    await f.manager.receive(incoming('/tab approval'));
    assert.match(views.at(-1).text, /不是允许所有/);
    assert.match(views.at(-1).text, /on-request/);
    assert.equal(f.agent.inputs.length, 0);
    f.agent.handler = async (run) => {
      await run.hooks.ask(
        {
          kind: 'approval',
          title: 'external approval',
          detail: 'pwd',
          approvalOptions: approvalChoices(),
        },
        run.signal,
      );
    };
    await f.manager.receive(incoming('ask'));
    await until(() => f.manager.interactions().length === 1);
    const pending = f.manager.interactions()[0]!;
    assert.match(pending.approvalContext!.label, /不询问/);
    assert.match(pending.approvalContext!.description, /不是允许所有/);
    assert.ok(
      f.store
        .events(s.id)
        .some((e) => e.type === 'interaction' && e.text.includes('approvalContext')),
    );
    f.manager.answer(s.id, pending.id, { allow: false });
    await f.manager.idle();
  } finally {
    await f.cleanup();
  }
});

test('Codex session approval retains one isolated worker across turns; release restores history but clears native grants', async () => {
  const f = fixture();
  const command = join(f.dir, 'codex-scopes.mjs');
  copyFileSync(new URL('./fixtures/fake-codex-scopes.mjs', import.meta.url), command);
  chmodSync(command, 0o755);
  const adapter = new CodexAdapter(command);
  try {
    const a = f.store.create(incoming('', 'alice', 'a').route, 'codex', f.dir),
      b = f.store.create(incoming('', 'alice', 'b').route, 'codex', f.dir);
    let asks = 0;
    const output: string[] = [],
      usage: any[] = [];
    const run = (
      session: typeof a,
      text: string,
      answer: Answer = { allow: true, scope: 'session' },
    ) =>
      adapter.run({
        session,
        text,
        signal: new AbortController().signal,
        hooks: {
          nativeId: (id) => {
            session.nativeId = id;
          },
          text: (t) => output.push(t),
          activity() {},
          usage: (v) => usage.push(v),
          ask: async (request) => {
            asks++;
            assert.ok(request.approvalOptions?.some((o) => o.id === 'session'));
            return answer;
          },
        },
      });
    await run(a, 'first');
    const native = a.nativeId;
    await run(a, 'again');
    assert.equal(asks, 1);
    assert.equal(output.at(-1), 'cached-approval');
    assert.equal(usage.at(-1).last.cachedInputTokens, 80);
    let trace = readFileSync(join(f.dir, 'scope-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(new Set(trace.map((m) => m.pid)).size, 1);
    assert.equal(trace.filter((m) => m.method === 'initialize').length, 1);
    assert.equal(trace.filter((m) => m.method === 'thread/start').length, 1);
    assert.ok(!trace.some((m) => m.method === 'thread/resume'));
    await run(b, 'first');
    assert.equal(asks, 2);
    assert.notEqual(a.nativeId, b.nativeId);
    await adapter.release(a.id);
    await run(a, 'again');
    assert.equal(asks, 3);
    assert.equal(a.nativeId, native);
    await run(a, 'recall');
    assert.match(output.at(-1)!, /first\|again\|again\|recall/);
    trace = readFileSync(join(f.dir, 'scope-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(new Set(trace.map((m) => m.pid)).size, 3);
    assert.equal(trace.filter((m) => m.method === 'thread/resume').length, 1);
    assert.ok(!JSON.stringify(trace).includes('acceptWithExecpolicyAmendment'));
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});

test('Codex exposes only available decisions and policy is a per-thread override without sandbox changes', async () => {
  const f = fixture(),
    command = join(f.dir, 'codex-scopes.mjs');
  copyFileSync(new URL('./fixtures/fake-codex-scopes.mjs', import.meta.url), command);
  chmodSync(command, 0o755);
  const adapter = new CodexAdapter(command);
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.approvalPolicy = 'untrusted';
    await adapter.run({
      session: s,
      text: 'once-only',
      signal: new AbortController().signal,
      hooks: {
        nativeId: (id) => {
          s.nativeId = id;
        },
        text() {},
        activity() {},
        ask: async (request) => {
          assert.deepEqual(
            request.approvalOptions?.map((o) => o.id),
            ['allow', 'deny'],
          );
          return { allow: true };
        },
      },
    });
    const trace = readFileSync(join(f.dir, 'scope-trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x)),
      params = trace.find((m) => m.method === 'thread/start').params;
    assert.equal(params.approvalPolicy, 'untrusted');
    assert.equal(params.sandbox, undefined);
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});

test('Claude session rules are rewritten to session destination and reapplied through native allow rules, enforced callbacks still prompt', async () => {
  const f = fixture();
  let count = 0;
  const captured: any[] = [];
  const runtime: ClaudeQuery = (input) => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      captured.push(input.options);
      yield { type: 'system', subtype: 'init', session_id: 'native-claude' } as any;
      const decision = await input.options!.canUseTool!(
        'Bash',
        { command: 'git status' },
        {
          signal: new AbortController().signal,
          toolUseID: 'tool',
          suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Bash', ruleContent: 'git status*' }],
              destination: 'projectSettings',
            },
          ],
        },
      );
      assert.equal(decision!.behavior, 'allow');
      if (decision!.behavior === 'allow')
        assert.equal(decision!.updatedPermissions?.[0]?.destination, 'session');
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'native-claude',
        is_error: false,
        result: 'done',
      } as any;
    },
  });
  const adapter = new ClaudeAdapter(undefined, [], runtime);
  try {
    const a = f.store.create(incoming('', 'alice', 'a').route, 'claude', f.dir),
      b = f.store.create(incoming('', 'alice', 'b').route, 'claude', f.dir);
    const run = (session: typeof a) =>
      adapter.run({
        session,
        text: 'task',
        signal: new AbortController().signal,
        hooks: {
          nativeId: (id) => {
            session.nativeId = id;
          },
          text() {},
          activity() {},
          ask: async (q) => {
            count++;
            assert.ok(q.approvalOptions?.some((o) => o.id === 'session'));
            return { allow: true, scope: 'session' };
          },
        },
      });
    await run(a);
    await run(a);
    assert.deepEqual(captured[1].allowedTools, ['Bash(git status*)']);
    assert.equal(count, 2, 'a forced callback must still prompt');
    await run(b);
    assert.equal(captured[2].allowedTools, undefined);
    await adapter.release(a.id);
    await run(a);
    assert.equal(captured[3].allowedTools, undefined);
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});

test('policy API and slash controls affect only the selected session, revoke grants, reject stale/busy changes, and reset starts on-request', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`,
    headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };
  const released: string[] = [];
  Object.assign(f.agent, {
    release: async (id: string) => {
      released.push(id);
    },
  });
  try {
    const a = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      b = f.store.create(incoming('', 'bob', '').route, 'codex', f.dir),
      url = base + `/api/sessions/${a.id}/approval-policy`,
      get = () => fetch(url, { headers }).then((r) => r.json()) as Promise<any>;
    assert.equal((await fetch(url)).status, 401);
    let info = await get();
    const original = info.revision;
    assert.equal(info.mode, 'on-request');
    assert.equal(info.defaulted, true);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ mode: 'untrusted', revision: original }),
        })
      ).status,
      200,
    );
    assert.equal(f.store.get(a.id)!.approvalPolicy, 'untrusted');
    assert.equal(f.store.get(b.id)!.approvalPolicy, undefined);
    assert.deepEqual(released, [a.id]);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ mode: 'never', revision: original }),
        })
      ).status,
      400,
    );
    info = await get();
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ mode: 'bypassPermissions', revision: info.revision }),
        })
      ).status,
      400,
    );
    await f.manager.receive(incoming('/tab approval native', 'alice', ''));
    assert.equal(f.store.get(a.id)!.approvalPolicy, 'native');
    assert.equal((await get()).defaulted, false);
    assert.equal(f.agent.inputs.length, 0);
    const busy = f.store.get(a.id)!;
    busy.status = 'waiting';
    f.store.save(busy);
    info = await get();
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ mode: 'never', revision: info.revision }),
        })
      ).status,
      400,
    );
    busy.status = 'idle';
    f.store.save(busy);
    const before = f.store.get(a.id)!;
    before.approvalPolicy = 'never';
    f.store.save(before);
    const child = await f.manager.createChildSession(a.id, { key: 'child', title: 'child' });
    assert.equal(child.approvalPolicy, undefined);
    assert.equal(selectedApprovalPolicy(child), 'on-request');
    const fresh = f.store.resetSession(f.store.get(a.id)!);
    assert.equal(fresh.approvalPolicy, undefined);
    assert.equal(selectedApprovalPolicy(fresh), 'on-request');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('Codex default on-request is passed on start, resume and terminal handoff; explicit native opts out per session', async () => {
  const f = fixture(),
    command = join(f.dir, 'codex-scopes.mjs');
  copyFileSync(new URL('./fixtures/fake-codex-scopes.mjs', import.meta.url), command);
  chmodSync(command, 0o755);
  const adapter = new CodexAdapter(command);
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const run = () =>
      adapter.run({
        session: s,
        text: 'once-only',
        signal: new AbortController().signal,
        hooks: {
          nativeId: (id) => {
            s.nativeId = id;
          },
          text() {},
          activity() {},
          ask: async () => ({ allow: true }),
        },
      });
    await run();
    const id = s.nativeId;
    await run();
    assert.equal(s.nativeId, id);
    assert.ok(adapter.resumeCommand(s).includes('approval_policy="on-request"'));
    s.approvalPolicy = 'native';
    await run();
    assert.ok(!adapter.resumeCommand(s).some((x) => x.startsWith('approval_policy=')));
    s.approvalPolicy = 'never';
    await run();
    assert.ok(adapter.resumeCommand(s).includes('approval_policy="never"'));
    const trace = readFileSync(join(f.dir, 'scope-trace.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x)),
      requests = trace.filter((x) => ['thread/start', 'thread/resume'].includes(x.method));
    assert.deepEqual(
      requests.map((x) => x.params.approvalPolicy),
      ['on-request', 'on-request', undefined, 'never'],
    );
    for (const r of requests) assert.equal(r.params.sandbox, undefined);
    assert.equal(nativeApprovalPolicy({ agent: 'claude' }), undefined);
    assert.equal(nativeApprovalPolicy({ agent: 'opencode' }), undefined);
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});

test('clearing temporary grants preserves default-on-request storage and explicit native opt-out', async () => {
  const f = fixture();
  Object.assign(f.agent, { release: async () => {} });
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    await f.manager.receive(incoming('/tab approval clear'));
    assert.equal(f.store.get(s.id)!.approvalPolicy, undefined);
    assert.equal(f.manager.approvalPolicyInfo(s.id).mode, 'on-request');
    await f.manager.receive(incoming('/tab approval native'));
    await f.manager.receive(incoming('/tab approval clear'));
    assert.equal(f.store.get(s.id)!.approvalPolicy, 'native');
    assert.equal(f.manager.approvalPolicyInfo(s.id).mode, 'native');
  } finally {
    await f.cleanup();
  }
});

test('session approval scope is recorded durably and request options reject escalation through the API', async () => {
  const f = fixture();
  try {
    f.agent.handler = async (run) => {
      run.hooks.nativeId('native-approval');
      await run.hooks.ask(
        { kind: 'approval', title: 'Run', detail: 'pwd', approvalOptions: approvalChoices(true) },
        run.signal,
      );
      run.hooks.usage?.({
        source: 'codex',
        last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 },
        total: { inputTokens: 200, cachedInputTokens: 80, outputTokens: 20 },
      });
    };
    await f.manager.receive(incoming('approval'));
    await until(() => f.manager.interactions().length === 1);
    const request = f.manager.interactions()[0]!;
    f.manager.answer(request.sessionId, request.id, { allow: true, scope: 'session' });
    await f.manager.idle();
    const record = executionRecords(
      f.store,
      request.sessionId,
      { kind: 'approvals', limit: 30, q: '' },
      [],
    );
    assert.equal((record.items[0] as any).answer.scope, 'session');
    assert.equal((record.usage as any).last.cachedInputTokens, 80);
  } finally {
    await f.cleanup();
  }
});

test('Codex idle worker reclamation revokes only ephemeral grants, keeps stored thread IDs and logs invalidation', async () => {
  const f = fixture(),
    command = join(f.dir, 'codex-scopes.mjs');
  copyFileSync(new URL('./fixtures/fake-codex-scopes.mjs', import.meta.url), command);
  chmodSync(command, 0o755);
  const adapter = new CodexAdapter(command, [], 1);
  const notices: string[] = [];
  let asks = 0;
  try {
    const a = f.store.create(incoming('', 'alice', 'lru-a').route, 'codex', f.dir),
      b = f.store.create(incoming('', 'alice', 'lru-b').route, 'codex', f.dir);
    const run = (session: typeof a) =>
      adapter.run({
        session,
        text: 'first',
        signal: new AbortController().signal,
        hooks: {
          nativeId: (id) => {
            session.nativeId = id;
          },
          text() {},
          activity: (s) => notices.push(s),
          ask: async () => {
            asks++;
            return { allow: true, scope: 'session' };
          },
        },
      });
    await run(a);
    const id = a.nativeId;
    await run(b);
    assert.ok(notices.some((s) => s.includes('回收')));
    await run(a);
    assert.equal(asks, 3);
    assert.equal(a.nativeId, id);
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});

test('Dashboard cannot escalate a once-only native request by posting session scope, and the original request remains answerable', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`,
    headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };
  try {
    f.agent.handler = async (run) => {
      await run.hooks.ask({ kind: 'approval', title: 'Once only', detail: 'pwd' }, run.signal);
    };
    await f.manager.receive(incoming('ask'));
    await until(() => f.manager.interactions().length === 1);
    const request = f.manager.interactions()[0]!,
      url = base + `/api/sessions/${request.sessionId}/answer`;
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: request.id, answer: { allow: true, scope: 'session' } }),
        })
      ).status,
      400,
    );
    assert.equal(f.manager.interactions().length, 1);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: request.id, answer: { allow: true } }),
        })
      ).status,
      200,
    );
    await f.manager.idle();
    assert.equal(f.manager.interactions().length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
