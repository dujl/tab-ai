import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, incoming, until } from './helpers.js';
import { ClaudeAdapter, type ClaudeQuery } from '../src/agents/claude.js';
import { AgyAdapter } from '../src/agents/agy.js';

function setup() {
  const f = fixture();
  (f.manager.reports as any).writer = {
    async generate() {
      return {
        summary: '接口已实现，待测试。',
        deliverables: [],
        specifications: [],
        validation: [],
        risks: [],
        remainingWork: ['测试'],
        nextSteps: [],
        lessons: [],
      };
    },
  };
  return f;
}
async function relay(
  f: ReturnType<typeof setup>,
  agent: 'claude' | 'agy' = 'claude',
  approvalPolicy?: string,
) {
  const source = f.store.create(incoming('').route, 'codex', f.dir);
  const stage = await f.manager.relay.prepare(source.id, {
    agent,
    key: 'receipt-test',
    approvalPolicy,
  });
  await until(() => f.store.reports.get(stage.inputReportId!)?.state === 'ready');
  await f.manager.relay.confirm(source.id, stage.id);
  return { source, stage };
}
for (const afterInit of [false, true]) {
  test(`Claude ${afterInit ? 'init-only disconnect' : 'SDK launch failure'} does not claim native acceptance`, async () => {
    const f = setup();
    try {
      const runtime = ((input: any) => {
        if (!afterInit) throw Error('SDK launch failed');
        return Object.assign(
          (async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'only-started', tools: [] } as any;
            throw Error('connection lost before prompt acceptance');
          })(),
          { close() {} },
        );
      }) as ClaudeQuery;
      const a = new ClaudeAdapter(undefined, [], runtime);
      a.models = async () => [{ id: 'model', label: 'Model', efforts: [] }];
      (f.manager as any).agents.claude = a;
      const { source, stage } = await relay(f);
      f.manager.submit(source.id, '继续');
      await f.manager.idle();
      assert.equal(f.store.get(source.id)!.status, 'error');
      assert.equal(f.store.stages.get(stage.id)!.transition!.phase, 'unconfirmed');
      assert.equal(f.store.stages.get(stage.id)!.transition!.inputReceipt, undefined);
      assert.ok(
        !f.store
          .events(source.id)
          .some((e) => e.type === 'agent_input' && JSON.parse(e.text).status === 'submitted'),
      );
      assert.throws(() => f.manager.submit(source.id, '继续'), /未确认/);
    } finally {
      await f.cleanup();
    }
  });
}
test('ACP disconnect before any prompt event is unconfirmed, including after creating the native session', async () => {
  const f = setup();
  try {
    const executable = join(f.dir, 'fake-agy.mjs');
    copyFileSync(new URL('./fixtures/fake-agy.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    (f.manager as any).agents.agy = new AgyAdapter(executable);
    const { source, stage } = await relay(f, 'agy');
    writeFileSync(join(f.dir, 'prompt-fail-before-events'), '');
    f.manager.submit(source.id, '继续');
    await f.manager.idle();
    assert.ok(f.store.get(source.id)!.nativeId);
    assert.equal(f.store.stages.get(stage.id)!.transition!.phase, 'unconfirmed');
    assert.equal(f.store.stages.get(stage.id)!.transition!.inputReceipt, undefined);
  } finally {
    await f.cleanup();
  }
});
test('native acceptance is recorded once and is retained when later business execution fails', async () => {
  const f = setup();
  try {
    const { source, stage } = await relay(f);
    f.agent.handler = async (run) => {
      run.hooks.nativeId('new-native');
      run.hooks.input?.({
        text: run.text,
        nativeId: 'new-native',
        instructions: 'effective instructions',
      });
      run.hooks.inputAccepted?.({
        nativeId: 'new-native',
        nativeTurnId: 'turn-1',
        evidence: 'native turn accepted',
      });
      run.hooks.inputAccepted?.({ nativeId: 'new-native', evidence: 'duplicate' });
      throw Error('test failure after native acceptance');
    };
    f.manager.submit(source.id, '继续');
    await f.manager.idle();
    const t = f.store.stages.get(stage.id)!.transition!;
    assert.equal(t.phase, 'submitted');
    assert.equal(t.inputReceipt!.nativeTurnId, 'turn-1');
    assert.equal(f.store.get(source.id)!.status, 'error');
    const submitted = f.store
      .events(source.id)
      .filter((e) => e.type === 'agent_input' && JSON.parse(e.text).status === 'submitted');
    assert.equal(submitted.length, 1);
    assert.equal(JSON.parse(submitted[0]!.text).instructions, 'effective instructions');
  } finally {
    await f.cleanup();
  }
});
test('report reads are audited by the server with stage/run/version, unauthorized and out-of-turn reads cannot forge receipts', async () => {
  const f = setup();
  let client: Client | undefined;
  try {
    const { source, stage } = await relay(f);
    const foreign = f.store.create(incoming('', 'bob', 'unrelated').route, 'codex', f.dir);
    const otherReport = f.manager.reports.request(foreign.id);
    await until(() => f.store.reports.get(otherReport.id)?.state === 'ready');
    let firstRun = '';
    f.agent.handler = async (run) => {
      run.hooks.nativeId('reader-native');
      run.hooks.input?.({ text: run.text, nativeId: 'reader-native' });
      if (!client) {
        client = new Client({ name: 'receipt-test', version: '1' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(run.taskBridge!.url), {
            requestInit: { headers: { Authorization: `Bearer ${run.taskBridge!.token}` } },
          }),
        );
      }
      const denied = await client.callTool({
        name: 'task_report_read',
        arguments: { reportId: otherReport.id },
      });
      assert.equal(denied.isError, true);
      const read = await client.callTool({
        name: 'task_report_read',
        arguments: { reportId: stage.inputReportId! },
      });
      assert.notEqual(read.isError, true);
      run.hooks.text('已取得报告');
    };
    f.manager.submit(source.id, '读取报告继续');
    await f.manager.idle();
    let t = f.store.stages.get(stage.id)!.transition!;
    assert.equal(t.phase, 'submitted');
    assert.equal(t.inputReceipt!.evidence, 'task_report_read served');
    firstRun = t.reportRead!.runId;
    assert.equal(t.reportRead!.reportId, stage.inputReportId);
    assert.equal(t.reportRead!.version, f.store.reports.get(stage.inputReportId!)!.version);
    const reads = () => f.store.events(source.id).filter((e) => e.type === 'task_report_read');
    assert.equal(reads().length, 1);
    const detail = JSON.parse(reads()[0]!.text);
    assert.equal(reads()[0]!.stageId, stage.id);
    assert.equal(detail.readerStageId, stage.id);
    assert.equal(detail.readerNativeId, 'reader-native');
    assert.equal(detail.sourceStageId, stage.sourceStageId);
    assert.equal(
      f.store
        .transcriptEvents(source.id, undefined, 120, stage.id)
        .filter((e) => e.type === 'task_report_read').length,
      1,
    );
    f.manager.reports.document(source.id, stage.inputReportId!);
    assert.equal(reads().length, 1); // A user's document preview is not an Agent read.
    const late = await client!.callTool({
      name: 'task_report_read',
      arguments: { reportId: stage.inputReportId! },
    });
    assert.equal(late.isError, true);
    assert.equal(reads().length, 1);
    f.manager.submit(source.id, '再次核对报告');
    await f.manager.idle();
    t = f.store.stages.get(stage.id)!.transition!;
    assert.notEqual(t.reportRead!.runId, firstRun);
    assert.equal(reads().length, 2);
  } finally {
    await client?.close();
    await f.cleanup();
  }
});
test('relay validates and previews the target policy without inheriting source grants', async () => {
  const f = setup();
  try {
    const source = f.store.create(incoming('').route, 'codex', f.dir);
    source.approvalPolicy = 'auto-allow';
    f.store.save(source);
    await assert.rejects(
      f.manager.relay.prepare(source.id, {
        agent: 'agy',
        key: 'invalid',
        approvalPolicy: 'on-request',
      }),
      /不支持/,
    );
    const stage = await f.manager.relay.prepare(source.id, {
      agent: 'agy',
      key: 'native-auto',
      approvalPolicy: 'auto',
    });
    await until(() => f.store.reports.get(stage.inputReportId!)?.state === 'ready');
    assert.match(
      f.manager.relay.view(source.id).stages.find((s) => s.id === stage.id)!.approval.label,
      /原生自动/,
    );
    await assert.rejects(
      f.manager.relay.prepare(source.id, {
        agent: 'agy',
        key: 'native-auto',
        approvalPolicy: 'auto-allow',
      }),
      /不同/,
    );
    await f.manager.relay.confirm(source.id, stage.id);
    assert.equal(f.store.get(source.id)!.approvalPolicy, 'auto');
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('AGY reports first-acceptance timeout instead of waiting silently and does not replay the prompt', async () => {
  const f = setup();
  try {
    const executable = join(f.dir, 'fake-agy.mjs');
    copyFileSync(new URL('./fixtures/fake-agy.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    (f.manager as any).agents.agy = new AgyAdapter(executable, [], 60);
    const { source, stage } = await relay(f, 'agy');
    writeFileSync(join(f.dir, 'prompt-stall'), '');
    f.manager.submit(source.id, '继续');
    await f.manager.idle();
    assert.equal(f.store.stages.get(stage.id)!.transition!.phase, 'unconfirmed');
    assert.equal(f.store.stages.get(stage.id)!.transition!.inputReceipt, undefined);
    assert.match(f.store.latestEvent(source.id, 'error')!.text, /未确认处理本轮输入/);
    assert.throws(() => f.manager.submit(source.id, '继续'), /未确认/);
    const trace = readFileSync(join(f.dir, 'acp-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(trace.filter((x) => x.method === 'session/prompt').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('AGY native model failure is reported promptly even when ACP never returns an error response', async () => {
  const f = setup();
  try {
    const executable = join(f.dir, 'fake-agy.mjs');
    copyFileSync(new URL('./fixtures/fake-agy.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    (f.manager as any).agents.agy = new AgyAdapter(executable, [], 5000);
    const { source, stage } = await relay(f, 'agy');
    writeFileSync(join(f.dir, 'prompt-log-failure'), '');
    const started = Date.now();
    f.manager.submit(source.id, '继续');
    await f.manager.idle();
    assert.ok(Date.now() - started < 4000);
    assert.equal(f.store.get(source.id)!.status, 'error');
    assert.equal(f.store.stages.get(stage.id)!.transition!.phase, 'unconfirmed');
    assert.match(f.store.latestEvent(source.id, 'error')!.text, /模型初始化失败.*连接中断/);
    assert.ok(f.channel.sent.some((m) => /模型初始化失败/.test(m.text)));
    assert.ok(!JSON.stringify(f.store.events(source.id)).includes('private-native-secret'));
    const trace = readFileSync(join(f.dir, 'acp-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(trace.filter((x) => x.method === 'session/prompt').length, 1);
  } finally {
    await f.cleanup();
  }
});

for (const flag of ['prompt-error-as-success', 'prompt-error-after-acceptance']) {
  test(`AGY native failure (${flag}) is a failed run with a user-visible reason`, async () => {
    const f = setup();
    try {
      const executable = join(f.dir, 'fake-agy.mjs');
      copyFileSync(new URL('./fixtures/fake-agy.mjs', import.meta.url), executable);
      chmodSync(executable, 0o755);
      (f.manager as any).agents.agy = new AgyAdapter(executable, [], 5000);
      const { source, stage } = await relay(f, 'agy');
      writeFileSync(join(f.dir, flag), '1');
      f.manager.submit(source.id, '继续');
      await f.manager.idle();
      assert.equal(f.store.get(source.id)!.status, 'error');
      assert.match(f.store.latestEvent(source.id, 'error')!.text, /模型初始化失败/);
      assert.ok(f.channel.sent.some((message) => /模型初始化失败/.test(message.text)));
      const runs = f.store
        .events(source.id)
        .filter((e) => e.type === 'agent_run')
        .map((e) => JSON.parse(e.text));
      assert.equal(runs.at(-1).status, 'failed');
      assert.equal(f.store.stages.get(stage.id)!.transition!.phase, 'submitted');
      assert.ok(f.store.stages.get(stage.id)!.transition!.inputReceipt);
    } finally {
      await f.cleanup();
    }
  });
}
