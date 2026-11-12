import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, until } from './helpers.js';
import { normalizeLark } from '../src/channels/normalize.js';
import type { AgentRun, Session } from '../src/core/types.js';
import { Store } from '../src/core/store.js';
import { Manager } from '../src/core/manager.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter, type ClaudeQuery } from '../src/agents/claude.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { chmodSync, copyFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentInstructions } from '../src/core/channel-instructions.js';
import { isTopicMain } from '../src/core/topic-control.js';

const message = (
  text: string,
  thread = '',
  sender = 'alice',
  chat = 'oc_research',
  mode: 'auto' | 'context' | 'mention' = 'auto',
  mentioned = false,
) =>
  normalizeLark(
    {
      sender: { sender_type: 'user', sender_id: { open_id: sender } },
      message: {
        message_id: 'om_' + randomUUID(),
        chat_id: chat,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: (mentioned ? '@bot ' : '') + text }),
        ...(mentioned ? { mentions: [{ key: '@bot', id: { open_id: 'bot' } }] } : {}),
        ...(thread ? { root_id: thread, thread_id: 'omt_' + thread } : {}),
      },
    },
    'test-lark',
    'bot',
    { [chat]: mode },
  );
function setup() {
  const f = fixture();
  const c = f.config.channels[0]!;
  if (c.type === 'lark') c.groupModes = { oc_research: 'auto' };
  return f;
}
const mainSession = async (f: ReturnType<typeof setup>) =>
  f.store.current(message('')!.route) ??
  f.store.create(message('')!.route, 'codex', f.dir, undefined, { conversationType: 'group' });
async function report(run: AgentRun, summary = '已完成通胀研究') {
  assert.ok(run.taskBridge);
  const client = new Client({ name: 'topic-test', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(run.taskBridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${run.taskBridge.token}` } },
      }),
    );
    assert.ok((await client.listTools()).tools.some((t) => t.name === 'topic_report'));
    return await client.callTool({
      name: 'topic_report',
      arguments: {
        kind: 'final',
        completionEvidence: '本话题整体目标已验收完成',
        remainingWork: [],
        summary,
        artifacts: ['https://example.com/report'],
        issues: [],
      },
    });
  } finally {
    await client.close();
  }
}
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('group topics automatically create/register their main without any switch and keep full histories independent', async () => {
  const f = setup();
  try {
    await f.manager.receive(message('先从原生话题开始研究', 'om_first')!);
    await f.manager.idle();
    const main = f.store.current(message('')!.route)!,
      first = f.store.current(message('', 'om_first')!.route)!;
    assert.ok(main);
    assert.ok(isTopicMain(main));
    assert.equal(first.topicParentId, main.id);
    assert.equal(f.agent.inputs.length, 1);
    await f.manager.receive(message('主会话私密原始资料')!);
    await f.manager.idle();
    await f.manager.receive(message('研究通胀', 'om_inflation')!);
    await f.manager.idle();
    const child = f.store.current(message('', 'om_inflation')!.route)!;
    assert.equal(child.topicParentId, main.id);
    assert.notEqual(child.id, main.id);
    const childInput = f.agent.inputs.find((r) => r.session.id === child.id)!;
    assert.equal(childInput.text.split('\n\n【话题索引')[0], '研究通胀');
    assert.ok(!childInput.text.includes('主会话私密'));
    assert.match(agentInstructions(child)!, /独立话题/);
    assert.ok(!child.topicReport);
    assert.equal(f.store.topicUpdates().length, 0);
    await f.manager.receive(message('有哪些研究话题')!);
    await f.manager.idle();
    const text = f.agent.inputs.at(-1)!.text;
    assert.ok(text.includes(child.id));
    assert.ok(text.includes(first.id));
    assert.ok(text.includes('研究通胀'));
    assert.ok(f.store.events(main.id).some((e) => e.type === 'topic_registered'));
    assert.equal(
      f.store
        .events(main.id)
        .filter((e) => e.type === 'user')
        .at(-1)!.text,
      '有哪些研究话题',
    );
    assert.equal('topicControl' in f.store.get(main.id)!, false);
  } finally {
    await f.cleanup();
  }
});

test('auto is inherited in both main and child routes; context and mention changes stop unmentioned child execution', async () => {
  const f = setup();
  try {
    await mainSession(f);
    await f.manager.receive(message('主任务')!);
    await f.manager.receive(message('话题任务', 'om_child')!);
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 2);
    const c = f.config.channels[0]!;
    if (c.type === 'lark') c.groupModes = { oc_research: 'context' };
    await f.manager.receive(
      message('仅参考，不执行', 'om_child', 'alice', 'oc_research', 'context')!,
    );
    assert.equal(f.agent.inputs.length, 2);
    await f.manager.receive(
      message('点名执行', 'om_child', 'alice', 'oc_research', 'context', true)!,
    );
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 3);
    if (c.type === 'lark') c.groupModes = { oc_research: 'mention' };
    assert.equal(message('未点名', 'om_child', 'alice', 'oc_research', 'mention'), undefined);
    await f.manager.receive(
      message('点名继续', 'om_child', 'alice', 'oc_research', 'mention', true)!,
    );
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 4);
    const ids = f.agent.inputs.map((r) => r.session.id);
    assert.equal(ids[1], ids[2]);
    assert.equal(ids[2], ids[3]);
    assert.notEqual(ids[0], ids[1]);
  } finally {
    await f.cleanup();
  }
});

test('private main chats and private topics remain mention-free and cannot switch a group mode', async () => {
  const f = setup();
  const dm = (text: string, thread = '') =>
    normalizeLark(
      {
        sender: { sender_type: 'user', sender_id: { open_id: 'alice' } },
        message: {
          message_id: 'om_' + randomUUID(),
          chat_id: 'oc_private',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text }),
          ...(thread ? { root_id: thread, thread_id: 'omt_private' } : {}),
        },
      },
      'test-lark',
      'bot',
      { oc_private: 'mention' },
    )!;
  try {
    await f.manager.receive(dm('单聊输入'));
    await f.manager.idle();
    await f.manager.receive(dm('单聊话题输入', 'om_private_topic'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 2);
    assert.notEqual(f.agent.inputs[0]!.session.id, f.agent.inputs[1]!.session.id);
    const before = structuredClone(f.config.channels[0]);
    await f.manager.receive(dm('/tab group-mode auto'));
    assert.deepEqual(f.config.channels[0], before);
    assert.match(f.channel.sent.at(-1)!.text, /群/);
    await f.manager.receive(dm('单聊话题继续', 'om_private_topic'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 3);
    assert.equal(f.agent.inputs[1]!.session.id, f.agent.inputs[2]!.session.id);
  } finally {
    await f.cleanup();
  }
});

test('topics explicitly created in the main chat register before work starts; task trees keep their own coordinator', async () => {
  const f = setup();
  try {
    const main = await mainSession(f);
    await f.manager.receive(message('/tab new codex --instructions 独立研究角色')!);
    const child = f.manager.topics.children(main)[0]!;
    assert.ok(child);
    assert.equal(child.nativeId, undefined);
    assert.equal(child.instructions, '独立研究角色');
    assert.equal(f.agent.inputs.length, 0);
    await f.manager.receive(message('新话题研究', '' + child.route.thread)!);
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.session.id, child.id);
    assert.ok(f.agent.inputs[0]!.taskBridge);
    const task = await f.manager.createTask({
      sourceSessionId: main.id,
      key: 'tree-separate',
      title: '任务树',
      objective: '保持原任务树',
      workspace: 'default',
    });
    await until(() => f.store.taskRecord(task.id)?.state === 'waiting');
    assert.equal(f.store.get(task.sessionId!)!.topicParentId, undefined);
    assert.equal(f.manager.topics.children(main).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('successful explicit MCP report returns one summary turn to the same main native session and original top-level chat', async () => {
  const f = setup();
  let childResult: any;
  f.agent.handler = async (run) => {
    run.hooks.nativeId('native-' + run.session.id);
    if (run.session.topicParentId) {
      childResult = await report(run);
      run.hooks.text('话题的完整研究正文，仅留话题');
    } else run.hooks.text('主会话已汇总');
  };
  try {
    const main = await mainSession(f);
    await f.manager.receive(message('原来的主任务')!);
    await f.manager.idle();
    const native = f.store.get(main.id)!.nativeId;
    await f.manager.receive(message('研究CPI', 'om_child')!);
    await f.manager.idle();
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    assert.equal(childResult.isError, undefined);
    assert.equal(f.store.get(main.id)!.nativeId, native);
    const child = f.store.current(message('', 'om_child')!.route)!;
    assert.equal(child.topicReport!.revision, 1);
    assert.equal(f.store.topicUpdates().length, 1);
    const summary = f.agent.inputs.find(
      (r) => r.session.id === main.id && r.text.includes('话题交付摘要'),
    )!;
    assert.ok(summary.text.includes('已完成通胀研究'));
    assert.ok(!summary.text.includes('话题的完整研究正文'));
    assert.ok(
      !f.agent.inputs.find((r) => r.session.id === child.id)!.text.includes('原来的主任务'),
    );
    assert.ok(
      f.channel.sent.some((s) => s.text === '主会话已汇总' && s.message.route.thread === ''),
    );
    assert.ok(
      f.channel.sent.some(
        (s) => s.text.includes('话题的完整') && s.message.route.thread === 'om_child',
      ),
    );
    assert.equal(f.store.events(main.id).filter((e) => e.type === 'user').length, 1);
    assert.equal(f.store.events(main.id).filter((e) => e.type === 'topic_summary_input').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('main running work is never interrupted; a child delivery waits and duplicate reports do not wake twice', async () => {
  const f = setup();
  let release!: () => void;
  f.agent.handler = async (r) => {
    if (r.text.startsWith('主会话长任务'))
      await new Promise<void>((done) => {
        release = done;
      });
    if (r.session.topicParentId) await report(r);
    r.hooks.text('done');
  };
  try {
    const main = await mainSession(f);
    await f.manager.receive(message('主会话长任务')!);
    await until(() => !!release);
    await f.manager.receive(message('独立研究', 'om_child')!);
    await until(() => f.store.topicUpdates().length === 1);
    await sleep();
    assert.equal(f.store.topicUpdates()[0]!.state, 'pending');
    assert.equal(f.agent.inputs.filter((r) => r.session.id === main.id).length, 1);
    release();
    await f.manager.idle();
    await until(() => f.store.topicUpdates()[0]!.state === 'done');
    await f.manager.receive(message('重复提交相同成果', 'om_child')!);
    await f.manager.idle();
    await sleep();
    assert.equal(f.store.topicUpdates().length, 1);
    assert.equal(
      f.agent.inputs.filter((r) => r.session.id === main.id && r.text.includes('话题交付摘要'))
        .length,
      1,
    );
  } finally {
    release?.();
    await f.cleanup();
  }
});

test('failed/aborted child turns cannot publish a staged report, and bare progress does not mean delivered', async () => {
  const f = setup();
  f.agent.handler = async (r) => {
    if (r.session.topicParentId) {
      await report(r);
      throw Error('research failed after draft');
    }
  };
  try {
    await mainSession(f);
    await f.manager.receive(message('失败研究', 'om_failed')!);
    await f.manager.idle();
    await sleep();
    const child = f.store.current(message('', 'om_failed')!.route)!;
    assert.equal(child.status, 'error');
    assert.equal(child.topicReport, undefined);
    assert.equal(f.store.topicUpdates().length, 0);
    f.agent.handler = async (r) => {
      r.hooks.text('还在研究，只是一轮结束');
    };
    await f.manager.receive(message('进度研究', 'om_progress')!);
    await f.manager.idle();
    await sleep();
    assert.equal(f.store.topicUpdates().length, 0);
  } finally {
    await f.cleanup();
  }
});

test('summary delivery stays bound to bot, group and owner; rebinding a source rejects a stale bridge', async () => {
  const f = setup();
  let output: any;
  f.agent.handler = async (r) => {
    if (r.session.topicParentId) {
      f.store.create(r.session.route, 'codex', f.dir);
      output = await report(r);
    }
  };
  try {
    const main = await mainSession(f);
    await f.manager.receive(message('其他人研究', 'om_other', 'bob')!);
    await f.manager.idle();
    assert.equal(f.store.current(message('', 'om_other', 'bob')!.route)!.topicParentId, undefined);
    await f.manager.receive(message('其他群研究', 'om_other', 'alice', 'oc_other', 'auto', true)!);
    await f.manager.idle();
    assert.equal(
      f.store.current(message('', 'om_other', 'alice', 'oc_other', 'auto', true)!.route)!
        .topicParentId,
      undefined,
    );
    await f.manager.receive(message('过期绑定', 'om_stale')!);
    await f.manager.idle();
    assert.equal(output.isError, true);
    assert.equal(f.store.topicUpdates().length, 0);
    assert.equal(f.manager.topics.children(main).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('close holds reports and unsupported topic options cannot mutate coordination', async () => {
  const f = setup();
  f.agent.handler = async (r) => {
    if (r.session.topicParentId) await report(r);
    r.hooks.text('done');
  };
  const views: any[] = [];
  Object.assign(f.channel, {
    async sendManagement(m: any, v: any) {
      views.push({ m, v });
    },
  });
  try {
    const main = await mainSession(f);
    f.manager.closeSession(main.id);
    await f.manager.receive(message('独立研究', 'om_child')!);
    await f.manager.idle();
    await sleep();
    assert.equal(f.store.topicUpdates()[0]!.state, 'pending');
    const before = f.agent.inputs.length;
    await f.manager.receive(message('/tab topics')!);
    assert.equal(f.agent.inputs.length, before);
    assert.match(views.at(-1).v.text, /已完成通胀研究/);
    const snapshot = f.store.get(main.id)!;
    for (const option of ['on', 'off']) {
      await f.manager.receive(message('/tab topics ' + option)!);
      assert.deepEqual(f.store.get(main.id), snapshot);
      assert.match(views.at(-1).v.text, /用法/);
      assert.ok(!views.at(-1).v.buttons.some((b: any) => /topics (on|off)$/.test(b.command)));
    }
    f.manager.openSession(main.id);
    await until(() => f.store.topicUpdates()[0]!.state === 'done');
    assert.equal(f.agent.inputs.filter((r) => r.session.id === main.id).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('stopping a summary turn pauses later deliveries until explicit resume and never retries the interrupted report', async () => {
  const f = setup();
  let began = false;
  f.agent.handler = async (r) => {
    if (r.session.topicParentId) await report(r, r.text);
    else if (r.text.includes('话题交付摘要')) {
      began = true;
      await new Promise<void>((_, reject) =>
        r.signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }),
      );
    }
  };
  try {
    const main = await mainSession(f);
    await f.manager.receive(message('第一份成果', 'om_a')!);
    await until(() => began);
    await f.manager.receive(message('第二份成果', 'om_b')!);
    await until(() => f.store.topicUpdates().length === 2);
    f.manager.stop(main.id);
    await f.manager.idle();
    await sleep();
    assert.equal(f.store.get(main.id)!.topicReportsPaused, true);
    assert.deepEqual(
      f.store.topicUpdates().map((j) => j.state),
      ['interrupted', 'pending'],
    );
    f.agent.handler = async () => {};
    await f.manager.receive(message('/tab topics resume')!);
    await until(() => f.store.topicUpdates().find((j) => j.state === 'done') !== undefined);
    assert.equal(f.store.topicUpdates().filter((j) => j.state === 'interrupted').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('manual topic report uses the same durable queue, while root reports and invalid payloads are rejected', async () => {
  const f = setup();
  try {
    await mainSession(f);
    await f.manager.receive(message('研究', 'om_child')!);
    await f.manager.idle();
    await f.manager.receive(message('/tab topic-report 人工确认已交付', 'om_child')!);
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    assert.equal(
      f.store.current(message('', 'om_child')!.route)!.topicReport!.result.summary,
      '人工确认已交付',
    );
    const before = f.store.topicUpdates().length;
    await f.manager.receive(message('/tab topic-report 不能从主会话伪造话题成果')!);
    assert.equal(f.store.topicUpdates().length, before);
    assert.match(f.channel.sent.at(-1)!.text, /子话题/);
  } finally {
    await f.cleanup();
  }
});

test('pending reports survive restart; a previously running report is marked unconfirmed and never auto-replayed', async () => {
  const f = setup();
  let manager: Manager | undefined, restored: Store | undefined;
  try {
    const main = await mainSession(f);
    await f.manager.receive(message('研究', 'om_child')!);
    await f.manager.idle();
    f.manager.closeSession(main.id);
    const child = f.store.current(message('', 'om_child')!.route)!;
    f.manager.topics.publish(child, {
      kind: 'final',
      completionEvidence: '目标完成并验收',
      remainingWork: [],
      summary: '持久化成果',
    });
    const job = f.store.topicUpdates()[0]!;
    job.state = 'running';
    f.store.saveTopicUpdate(job);
    await f.manager.close();
    restored = new Store(f.config.dataDir);
    assert.equal(restored.topicUpdates()[0]!.state, 'interrupted');
    assert.equal(restored.get(child.id)!.topicParentId, main.id);
    manager = new Manager(
      f.config,
      restored,
      { codex: f.agent, claude: f.agent, opencode: f.agent },
      new Map([[f.channel.id, f.channel]]),
    );
    const before = f.agent.inputs.length;
    manager.openSession(main.id);
    await sleep();
    assert.equal(f.agent.inputs.length, before);
    assert.equal(restored.topicUpdates()[0]!.state, 'interrupted');
    assert.match(manager.topics.describe(restored.get(main.id)!), /持久化成果/);
  } finally {
    await manager?.close();
    restored?.close();
    await f.cleanup();
  }
});

test('Codex native dynamic tool calls use the session-bound report endpoint, retain native context and deliver to an existing main', async () => {
  const f = setup();
  const executable = join(f.dir, 'codex.mjs');
  copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  const adapter = new CodexAdapter(executable);
  f.agent.handler = async (r) => {
    if (r.session.topicParentId) await adapter.run({ ...r, text: 'topic-report-fixture' });
    else {
      r.hooks.nativeId('existing-root-native');
      r.hooks.text('汇总完成');
    }
  };
  try {
    const main = await mainSession(f);
    await f.manager.receive(message('已有主上下文')!);
    await f.manager.idle();
    await f.manager.receive(message('Codex 研究', 'om_codex')!);
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    const child = f.store.current(message('', 'om_codex')!.route)!;
    assert.equal(child.nativeId, 'native-test-1');
    assert.equal(f.store.get(main.id)!.nativeId, 'existing-root-native');
    assert.equal(child.topicReport!.result.summary, 'Codex 已交付研究结论');
    await f.manager.receive(message('继续同一话题', 'om_codex')!);
    await f.manager.idle();
    await sleep();
    assert.equal(f.store.topicUpdates().length, 1);
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    assert.ok(
      trace
        .find((m) => m.method === 'thread/start')
        .params.dynamicTools.some((t: any) => t.name === 'topic_report'),
    );
    assert.ok(
      trace
        .find((m) => m.method === 'thread/start')
        .params.dynamicTools.some((t: any) => t.name === 'task_create'),
    );
    assert.equal(trace.filter((m) => m.method === 'thread/start').length, 1);
    assert.ok(
      trace.some((m) => m.method === 'thread/resume' && m.params.threadId === 'native-test-1'),
    );
    assert.ok(trace.some((m) => m.id === 'topic-report-1' && m.result?.success === true));
  } finally {
    await f.cleanup();
  }
});

test('Claude native preset and approved report-tool transport preserve role and return only the child summary', async () => {
  const f = setup();
  let nativeCalls = 0;
  const runtime: ClaudeQuery = (input) =>
    Object.assign(
      (async function* () {
        nativeCalls++;
        assert.match(JSON.stringify(input.options!.systemPrompt), /独立话题/);
        const options = input.options!;
        const allowed = await options.canUseTool!(
          'mcp__tab_ai_tasks__topic_report',
          {},
          { signal: new AbortController().signal, toolUseID: 'report' },
        );
        assert.equal(allowed.behavior, 'allow');
        assert.equal(
          (
            await options.canUseTool!(
              'mcp__tab_ai_tasks__task_progress',
              { summary: '阶段' },
              { signal: new AbortController().signal, toolUseID: 'progress' },
            )
          ).behavior,
          'allow',
        );
        const endpoint = (options.mcpServers as any).tab_ai_tasks;
        const client = new Client({ name: 'claude-fixture', version: '1' });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(endpoint.url), {
              requestInit: { headers: endpoint.headers },
            }),
          );
          const result = await client.callTool({
            name: 'topic_report',
            arguments: {
              kind: 'final',
              completionEvidence: '本话题整体目标已完成并验收',
              remainingWork: [],
              summary: 'Claude 交付摘要',
              artifacts: [],
              issues: [],
            },
          });
          assert.ok(!result.isError);
        } finally {
          await client.close();
        }
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-child',
          is_error: false,
          result: '完整研究留在话题',
        } as SDKMessage;
      })(),
      { close() {} },
    );
  const adapter = new ClaudeAdapter(undefined, [], runtime);
  f.agent.handler = async (r) => {
    if (r.session.topicParentId) await adapter.run(r);
    else r.hooks.text('主会话汇总');
  };
  try {
    await mainSession(f);
    await f.manager.receive(message('Claude 研究', 'om_claude')!);
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    assert.equal(nativeCalls, 1);
    assert.equal(f.store.topicUpdates()[0]!.report.summary, 'Claude 交付摘要');
    assert.ok(
      f.agent.inputs.find((r) => r.text.includes('话题交付摘要'))!.text.includes('Claude 交付摘要'),
    );
    assert.ok(
      !f.agent.inputs
        .find((r) => r.text.includes('话题交付摘要'))!
        .text.includes('完整研究留在话题'),
    );
  } finally {
    await f.cleanup();
  }
});

test('resetting the main preserves topic associations and cancels old queued deliveries without replaying history', async () => {
  const f = setup();
  try {
    const main = await mainSession(f);
    await f.manager.receive(message('研究', 'om_child')!);
    await f.manager.idle();
    f.manager.closeSession(main.id);
    const child = f.store.current(message('', 'om_child')!.route)!;
    f.manager.topics.publish(child, {
      kind: 'final',
      completionEvidence: '目标完成并验收',
      remainingWork: [],
      summary: '重置前成果',
    });
    const fresh = f.store.resetSession(f.store.get(main.id)!);
    assert.ok(isTopicMain(fresh));
    assert.equal(f.store.get(child.id)!.topicParentId, fresh.id);
    assert.equal(f.store.topicUpdates()[0]!.state, 'cancelled');
    assert.equal(fresh.nativeId, undefined);
    assert.ok(f.manager.topics.context(fresh).includes(child.id));
  } finally {
    await f.cleanup();
  }
});

test('legacy on and off preferences retire without changing native IDs, bindings, histories or timestamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-topics-default-'));
  let store: Store | undefined;
  try {
    store = new Store(dir);
    const snapshots: Session[] = [];
    for (const flag of [true, false]) {
      const s = store.create(
        message('', '', flag ? 'alice' : 'bob')!.route,
        'codex',
        dir,
        'keep instructions',
        { conversationType: 'group' },
      );
      Object.assign(s, {
        title: 'legacy',
        nativeId: 'native-' + flag,
        settings: { model: 'chosen', effort: 'high' },
        topicControl: flag,
      });
      store.save(s);
      store.event(s.id, 'user', 'keep history');
      snapshots.push(store.get(s.id)!);
    }
    store.close();
    store = new Store(dir);
    for (const previous of snapshots) {
      const expected = { ...previous };
      delete (expected as Session & { topicControl?: boolean }).topicControl;
      assert.deepEqual(store.get(previous.id), expected);
      assert.equal(store.current(previous.route)!.id, previous.id);
      assert.deepEqual(
        store.events(previous.id).map((e) => e.text),
        ['keep history'],
      );
      assert.ok(isTopicMain(store.get(previous.id)!));
      assert.match(agentInstructions(store.get(previous.id)!)!, /默认统筹/);
    }
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
