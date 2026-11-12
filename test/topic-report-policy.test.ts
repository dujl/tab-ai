import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, until } from './helpers.js';
import { normalizeLark } from '../src/channels/normalize.js';
import { Store } from '../src/core/store.js';
import { Manager } from '../src/core/manager.js';
import {
  topicReportSchema,
  validateTopicCompletion,
  topicRoleInstructions,
} from '../src/core/topic-control.js';
import { validateTopicDecision } from '../src/core/topic-router.js';
import type { AgentRun, Incoming, ManagementView } from '../src/core/types.js';
const msg = (text: string, thread = '', sender = 'alice') =>
  normalizeLark(
    {
      sender: { sender_type: 'user', sender_id: { open_id: sender } },
      message: {
        message_id: 'om_' + randomUUID(),
        chat_id: 'oc_research',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text }),
        ...(thread ? { root_id: thread, thread_id: 'omt_' + thread } : {}),
      },
    },
    'test-lark',
    'bot',
    { oc_research: 'auto' },
  )!;
const complete = (summary = '目标全部完成') => ({
  kind: 'final',
  summary,
  completionEvidence: '整个话题目标已按验收标准验证完成',
  remainingWork: [],
  artifacts: [],
  issues: [],
});
function setup() {
  const f = fixture();
  if (f.config.channels[0]!.type === 'lark')
    f.config.channels[0]!.groupModes = { oc_research: 'auto' };
  return f;
}
async function tool(run: AgentRun, payload: unknown) {
  const c = new Client({ name: 'policy-test', version: '1' });
  try {
    await c.connect(
      new StreamableHTTPClientTransport(new URL(run.taskBridge!.url), {
        requestInit: { headers: { Authorization: `Bearer ${run.taskBridge!.token}` } },
      }),
    );
    return await c.callTool({ name: 'topic_report', arguments: payload as any });
  } finally {
    await c.close();
  }
}
const delay = () => new Promise((r) => setTimeout(r, 60));

test('an incomplete preparation report and legacy tool payloads stay in the child and never wake the main', async () => {
  const f = setup();
  try {
    f.agent.handler = async (run) => {
      const r = await tool(run, {
        summary: '已完成示例需求整理。尚未实现接口或运行测试。',
        artifacts: ['requirements.md'],
        issues: ['输入校验尚未实现'],
      });
      assert.ok(!r.isError);
      run.hooks.text('需求整理完成，下一步实现接口');
    };
    await f.manager.receive(msg('开发一个示例应用。', 'om_fixture-development'));
    await f.manager.idle();
    await delay();
    const c = f.store.current(msg('', 'om_fixture-development').route)!,
      p = f.store.current(msg('').route)!;
    assert.equal(c.topicProgress!.result.kind, 'progress');
    assert.equal(c.topicReport, undefined);
    assert.equal(c.topicCompleted, false);
    assert.equal(f.store.topicUpdates().length, 0);
    assert.equal(f.agent.inputs.length, 1);
    assert.ok(!f.manager.topics.context(p).includes('requirements.md'));
    assert.ok(!f.manager.topics.context(p).includes('尚未实现接口'));
    assert.match(f.manager.topics.context(p), /进行中/);
    assert.equal(
      f.store
        .events(p.id)
        .filter((e) => e.type === 'topic_report' || e.type === 'topic_summary_input').length,
      0,
    );
    assert.equal(f.store.events(c.id).filter((e) => e.type === 'topic_progress').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('final reports require explicit whole-topic evidence and an explicit empty remaining-work list', async () => {
  for (const raw of [
    { kind: 'final', summary: '完成准备' },
    { ...complete(), remainingWork: undefined },
    { ...complete(), remainingWork: ['业务尚未完成'] },
    { ...complete(), completionEvidence: '' },
  ])
    assert.throws(() => validateTopicCompletion(topicReportSchema.parse(raw)));
  const f = setup();
  try {
    let rejected: any;
    f.agent.handler = async (run) => {
      rejected = await tool(run, { ...complete(), remainingWork: ['业务尚未完成'] });
    };
    await f.manager.receive(msg('研究', 'om_a'));
    await f.manager.idle();
    assert.equal(rejected.isError, true);
    assert.equal(f.store.topicUpdates().length, 0);
    f.agent.handler = async (run) => {
      if (run.session.topicParentId) await tool(run, complete());
    };
    await f.manager.receive(msg('完成全部目标', 'om_a'));
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    const c = f.store.current(msg('', 'om_a').route)!;
    assert.equal(c.topicCompleted, true);
    assert.equal(c.topicReport!.reason, 'completed');
    assert.match(
      f.agent.inputs.find((r) => r.text.includes('话题交付摘要'))!.text,
      /整体完成后的最终交付/,
    );
  } finally {
    await f.cleanup();
  }
});

test('explicit manual progress reporting is allowed without marking the topic completed; menu inspection has no delivery side effects', async () => {
  const f = setup(),
    views: ManagementView[] = [];
  Object.assign(f.channel, {
    async sendManagement(_m: Incoming, v: ManagementView) {
      views.push(v);
    },
  });
  try {
    f.agent.handler = async (run) => {
      if (run.session.topicParentId)
        await tool(run, { summary: '阶段一完成', remainingWork: ['后续开发'] });
    };
    await f.manager.receive(msg('研究', 'om_a'));
    await f.manager.idle();
    await f.manager.receive(msg('/tab topic-report', 'om_a'));
    assert.match(views.at(-1)!.text, /阶段一完成/);
    assert.equal(f.store.topicUpdates().length, 0);
    const before = f.agent.inputs.length;
    await f.manager.receive(msg('/tab topic-report send', 'om_a'));
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    const c = f.store.current(msg('', 'om_a').route)!;
    assert.equal(c.topicCompleted, false);
    assert.equal(c.topicReport!.reason, 'requested');
    assert.equal(f.agent.inputs.length, before + 1);
    assert.match(f.agent.inputs.at(-1)!.text, /话题尚未完成/);
    assert.match(f.agent.inputs.at(-1)!.text, /reason.*requested/);
  } finally {
    await f.cleanup();
  }
});

test('natural reporting permission is current-turn only and bound to a linked topic; ordinary progress after it remains local', async () => {
  const f = setup();
  let classified = 0;
  // Use a fresh Manager sharing the fixture store but a deterministic intent boundary.
  await f.manager.close();
  const manager = new Manager(
    f.config,
    f.store,
    { codex: f.agent, claude: f.agent, opencode: f.agent },
    new Map([[f.channel.id, f.channel]]),
    {
      async classify(input) {
        classified++;
        return {
          action: input.text === '向主会话汇报当前进度' ? 'report_to_main' : 'continue',
          task: null,
          agent: null,
          workspace: null,
          instructions: null,
        };
      },
    },
  );
  try {
    f.agent.handler = async (run) => {
      if (run.session.topicParentId)
        await tool(run, { summary: run.text.startsWith('向主会话') ? '当前进度' : '普通进度' });
    };
    await manager.receive(msg('研究', 'om_a'));
    await manager.idle();
    await manager.receive(msg('向主会话汇报当前进度', 'om_a'));
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    const calls = f.agent.inputs.length;
    await manager.receive(msg('继续研究', 'om_a'));
    await manager.idle();
    await delay();
    assert.equal(f.agent.inputs.length, calls + 1);
    assert.equal(f.store.topicUpdates().length, 1);
    assert.equal(f.store.current(msg('', 'om_a').route)!.topicCompleted, false);
    const input = { text: '向主会话汇报当前进度', recentUserMessages: [] };
    const d = {
      action: 'report_to_main',
      task: null,
      agent: null,
      workspace: null,
      instructions: null,
    };
    assert.throws(() => validateTopicDecision(d, input));
    assert.equal(
      validateTopicDecision(d, { ...input, topicContext: { canReport: true } }).action,
      'report_to_main',
    );
    assert.throws(() =>
      validateTopicDecision(
        { ...d, workspace: '/tmp' },
        { ...input, topicContext: { canReport: true } },
      ),
    );
    assert.ok(classified >= 3);
  } finally {
    await manager.close();
    await f.cleanup();
  }
});

test('resuming work or saving progress cancels an unsent final report; closing alone never generates a report', async () => {
  const f = setup();
  try {
    f.agent.handler = async (run) => {
      if (run.session.topicParentId) await tool(run, complete());
    };
    const p = f.store.create(msg('').route, 'codex', f.dir, undefined, {
      conversationType: 'group',
    });
    f.manager.closeSession(p.id);
    await f.manager.receive(msg('完成话题', 'om_a'));
    await f.manager.idle();
    assert.equal(f.store.topicUpdates()[0]!.state, 'pending');
    f.agent.handler = async (run) => {
      if (run.session.topicParentId)
        await tool(run, { summary: '新增需求尚在处理', remainingWork: ['新增需求'] });
    };
    await f.manager.receive(msg('追加一个新需求', 'om_a'));
    await f.manager.idle();
    assert.equal(f.store.topicUpdates()[0]!.state, 'cancelled');
    assert.equal(f.store.current(msg('', 'om_a').route)!.topicCompleted, false);
    await f.manager.receive(msg('/tab close', 'om_a'));
    f.manager.openSession(p.id);
    await delay();
    assert.equal(f.agent.inputs.filter((r) => r.session.id === p.id).length, 0);
    assert.equal(f.store.topicUpdates().length, 1);
  } finally {
    await f.cleanup();
  }
});

test('legacy pending reports are cancelled on restart with original summaries, native IDs, history and binding preserved', async () => {
  const f = setup();
  let restored: Store | undefined;
  try {
    await f.manager.receive(msg('研究', 'om_a'));
    await f.manager.idle();
    const child = f.store.current(msg('', 'om_a').route)!,
      parent = f.store.current(msg('').route)!;
    child.topicReport = {
      revision: 1,
      at: Date.now(),
      result: { summary: '开发准备已完成', artifacts: [], issues: ['业务未修复'] } as any,
    };
    f.store.save(child);
    const before = f.store.get(child.id);
    f.store.saveTopicUpdate({
      id: randomUUID(),
      parentId: parent.id,
      childId: child.id,
      revision: 1,
      report: child.topicReport.result,
      state: 'pending',
      at: Date.now(),
    });
    await f.manager.close();
    restored = new Store(f.config.dataDir);
    assert.equal(restored.topicUpdates()[0]!.state, 'cancelled');
    assert.deepEqual(restored.get(child.id), before);
    assert.equal(restored.current(child.route)!.id, child.id);
    assert.match(topicRoleInstructions(child)!, /旧格式报告按 progress/);
  } finally {
    restored?.close();
    await f.cleanup();
  }
});

test('model payloads cannot grant themselves user-requested progress delivery', async () => {
  const f = setup();
  try {
    let result: any;
    f.agent.handler = async (run) => {
      result = await tool(run, { summary: '准备完成', requested: true });
    };
    await f.manager.receive(msg('准备开发', 'om_a'));
    await f.manager.idle();
    assert.ok(result);
    assert.equal(f.store.topicUpdates().length, 0);
    assert.equal(f.store.current(msg('', 'om_a').route)!.topicReport, undefined);
  } finally {
    await f.cleanup();
  }
});

test('explicit user final delivery works with legacy native tools without resetting or running the child Agent', async () => {
  const f = setup();
  try {
    await f.manager.receive(msg('研究', 'om_a'));
    await f.manager.idle();
    const child = f.store.current(msg('', 'om_a').route)!;
    child.nativeId = 'keep-old-native';
    f.store.save(child);
    const before = f.agent.inputs.length;
    await f.manager.receive(msg('/tab topic-report final 整个话题目标已完成，验收通过', 'om_a'));
    await until(() => f.store.topicUpdates()[0]?.state === 'done');
    const fresh = f.store.get(child.id)!;
    assert.equal(fresh.nativeId, 'keep-old-native');
    assert.equal(fresh.topicCompleted, true);
    assert.equal(fresh.topicReport!.reason, 'completed');
    assert.equal(f.agent.inputs.length, before + 1);
    assert.ok(fresh.topicReport!.result.completionEvidence.includes('用户明确确认'));
    assert.ok(
      f.channel.sent.some((s) => s.message.route.thread === 'om_a' && s.text.includes('最终交付')),
    );
  } finally {
    await f.cleanup();
  }
});

test('a final that was cancelled before delivery can be freshly completed again without losing its new delivery', async () => {
  const f = setup();
  try {
    const p = f.store.create(msg('').route, 'codex', f.dir, undefined, {
      conversationType: 'group',
    });
    f.manager.closeSession(p.id);
    f.agent.handler = async (run) => {
      if (run.session.topicParentId) await tool(run, complete());
    };
    await f.manager.receive(msg('完成话题', 'om_a'));
    await f.manager.idle();
    await f.manager.receive(msg('补充要求也完成了', 'om_a'));
    await f.manager.idle();
    assert.deepEqual(
      f.store.topicUpdates().map((j) => j.state),
      ['cancelled', 'pending'],
    );
    f.manager.openSession(p.id);
    await until(() => f.store.topicUpdates()[1]?.state === 'done');
    assert.equal(f.agent.inputs.filter((r) => r.session.id === p.id).length, 1);
  } finally {
    await f.cleanup();
  }
});
