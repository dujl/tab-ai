import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { ToolProgress, recentTools } from '../src/core/tool-progress.js';
import { codexTool, openCodeTool } from '../src/agents/tool-events.js';
import { larkToolCard } from '../src/channels/lark-tool-card.js';
import type { ToolRunView } from '../src/core/types.js';

test('native tool mappings expose commands/results/failures without reasoning', () => {
  assert.equal(codexTool({ id: 'r', type: 'reasoning', text: 'hidden' }, true), undefined);
  const item = {
    id: 'cmd',
    type: 'commandExecution',
    command: 'pwd',
    cwd: '/work',
    aggregatedOutput: '/work',
    exitCode: 1,
  };
  assert.equal(codexTool(item, false)?.status, 'running');
  assert.equal(codexTool(item, true)?.status, 'failed');
  assert.match(codexTool(item, true)!.input!, /pwd/);
  assert.deepEqual(
    openCodeTool({
      type: 'tool',
      sessionID: 's',
      callID: 'c',
      tool: 'bash',
      state: { status: 'error', input: { command: 'false' }, error: 'failed' },
    }),
    {
      sessionId: 's',
      event: { id: 's:c', name: 'bash', status: 'failed', input: 'false', output: 'failed' },
    },
  );
  assert.equal(openCodeTool({ type: 'reasoning', text: 'hidden' }), undefined);
});
test('tool progress deduplicates starts, patches one card, persists final output and never claims missing results succeeded', async () => {
  const f = fixture(),
    message = incoming('task'),
    session = f.store.create(message.route, 'codex', f.dir),
    sent: ToolRunView[] = [],
    updates: ToolRunView[] = [];
  Object.assign(f.channel, {
    sendToolProgress: async (m: any, v: ToolRunView) => {
      assert.equal(m.route.thread, message.route.thread);
      sent.push(v);
      return 'card';
    },
    updateToolProgress: async (id: string, v: ToolRunView) => {
      assert.equal(id, 'card');
      updates.push(v);
    },
  });
  const p = new ToolProgress(session, message, f.store, f.channel, async () => {
    assert.fail('no fallback');
  });
  try {
    p.record({ id: 'one', name: '命令', status: 'running', input: 'pwd' });
    p.record({ id: 'one', name: '命令', status: 'running', input: 'pwd' });
    await p.flush();
    p.record({ id: 'one', name: '命令', status: 'completed', output: 'OK' });
    p.record({ id: 'one', name: '命令', status: 'running' });
    p.record({ id: 'two', name: '读取', status: 'running' });
    await p.finish('completed');
    assert.equal(sent.length, 1);
    assert.equal(updates.at(-1)!.total, 2);
    assert.equal(updates.at(-1)!.status, 'completed');
    assert.equal(larkToolCard(sent[0]!).header.template, 'blue');
    assert.equal(larkToolCard(updates.at(-1)!).header.template, 'orange');
    assert.match(larkToolCard(updates.at(-1)!).header.title.content, /部分结果未确认/);
    assert.deepEqual(
      recentTools(f.store, session.id).map((t) => [t.input, t.status]),
      [
        ['pwd', 'completed'],
        [undefined, 'unknown'],
      ],
    );
    await f.manager.receive(incoming('/tab tools 1'));
    assert.match(f.channel.sent.at(-1)!.text, /pwd[\s\S]*OK/);
    assert.equal(f.agent.inputs.length, 0);
    await f.manager.receive(incoming('/tab tools', 'bob'));
    assert.doesNotMatch(f.channel.sent.at(-1)!.text, /OK/);
  } finally {
    await p.finish('interrupted');
    await f.cleanup();
  }
});
test('uncertain progress creation is not repeated and cannot block normal agent output', async () => {
  const f = fixture();
  let creates = 0;
  Object.assign(f.channel, {
    sendToolProgress: async () => {
      creates++;
      throw Error('unknown');
    },
    updateToolProgress: async () => {
      assert.fail();
    },
  });
  f.agent.handler = async (r) => {
    r.hooks.tool!({ id: 'one', name: 'cmd', status: 'running', input: 'pwd' });
    r.hooks.text('answer');
  };
  try {
    await f.manager.receive(incoming('go'));
    await f.manager.idle();
    assert.equal(creates, 1);
    assert.equal(f.channel.sent.at(-1)!.text, 'answer');
    assert.equal(
      f.store.events(f.store.list()[0]!.id).filter((e) => e.type === 'delivery_error').length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test('Lark card defaults collapsed, escapes tool text and stays below the message size limit', () => {
  const view: ToolRunView = {
    id: 'run',
    agent: 'codex',
    status: 'completed',
    total: 200,
    tools: Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      name: '执行命令',
      status: 'completed',
      input: '<at id=all> *cmd* ' + '长'.repeat(8000),
      output: 'x'.repeat(8000),
      exitCode: 0,
    })),
  };
  const card = larkToolCard(view),
    raw = JSON.stringify(card);
  assert.ok(Buffer.byteLength(raw) < 24000);
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'green');
  assert.match(card.header.title.content, /工具执行成功/);
  assert.ok(raw.includes('collapsible_panel'));
  assert.ok(!raw.includes('"expanded":true'));
  const markdown: string[] = [];
  const walk = (v: any) => {
    if (v?.tag === 'markdown') markdown.push(v.content);
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(card);
  assert.ok(markdown.every((s) => !s.includes('<at')));
  assert.ok(raw.includes('200 次工具'));
  assert.ok(raw.includes('执行结果'));
});
test('failed, interrupted and partially retained runs cannot be colored as all tools succeeded', () => {
  const base: ToolRunView = {
    id: 'run',
    agent: 'codex',
    status: 'completed',
    total: 1,
    tools: [{ id: 'one', name: 'command', status: 'completed', exitCode: 0 }],
  };
  assert.equal(larkToolCard({ ...base, status: 'failed' }).header.template, 'red');
  assert.equal(larkToolCard({ ...base, status: 'interrupted' }).header.template, 'grey');
  assert.equal(larkToolCard({ ...base, total: 201 }).header.template, 'orange');
  assert.equal(
    larkToolCard({ ...base, tools: [{ ...base.tools[0]!, exitCode: 1 }] }).header.template,
    'red',
  );
  const mixed = larkToolCard({
    ...base,
    total: 2,
    tools: [...base.tools, { ...base.tools[0]!, id: 'two', exitCode: 1 }],
  });
  assert.equal(mixed.header.template, 'orange');
  assert.match(mixed.header.title.content, /含失败调用/);
});
test('restart marks unfinished persisted tool calls interrupted and preserves their results and run identity', async () => {
  const f = fixture();
  const { Store } = await import('../src/core/store.js');
  let restarted: InstanceType<typeof Store> | undefined;
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.status = 'running';
    f.store.save(s);
    f.store.event(
      s.id,
      'tool',
      JSON.stringify({
        runId: 'run',
        id: 'one',
        name: '命令',
        status: 'completed',
        input: 'pwd',
        output: 'done',
      }),
    );
    f.store.event(
      s.id,
      'tool',
      JSON.stringify({
        runId: 'run',
        id: 'two',
        name: '命令',
        status: 'running',
        input: 'sleep 10',
      }),
    );
    restarted = new Store(f.config.dataDir);
    const tools = recentTools(restarted, s.id);
    assert.deepEqual(
      tools.map((t) => t.status),
      ['completed', 'interrupted'],
    );
    assert.equal(tools[0]!.output, 'done');
    assert.equal((tools[1] as any).runId, 'run');
  } finally {
    restarted?.close();
    await f.cleanup();
  }
});
