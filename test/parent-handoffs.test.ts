import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, incoming, until } from './helpers.js';
import { topicReportSchema } from '../src/core/topic-control.js';
import { SessionReports, recordedReport } from '../src/core/session-reports.js';
import type { AgentRun, Session } from '../src/core/types.js';
import { createDashboard } from '../src/web/server.js';
import { reportPresentation } from '../src/core/report-document.js';
import { LarkChannel } from '../src/channels/lark.js';

const lesson = {
  summary: '先固定输入口径',
  appliesWhen: '复核同一批研究样本',
  practice: '记录样本版本，然后按相同方法复算',
  cautions: '样本变更后重新验证',
  evidence: ['task-result'],
};
function child(f: ReturnType<typeof fixture>, parent: Session, n: number) {
  const s = f.store.create({ ...parent.route, thread: `branch-${n}` }, 'codex', f.dir);
  s.parentSessionId = parent.id;
  s.title = `研究子任务 ${n}`;
  s.topicObjective = `核验目标 ${n}`;
  f.store.save(s);
  return s;
}
async function call(run: AgentRun, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'parent-handoff-test', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(run.taskBridge!.url), {
        requestInit: { headers: { Authorization: `Bearer ${run.taskBridge!.token}` } },
      }),
    );
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

test('parent work receives durable source-labelled reports and lessons beyond six children and the event window; full report remains readable without Manager', async () => {
  const f = fixture();
  try {
    f.config.channels[0]!.manager = false;
    const parent = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    parent.nativeId = 'preserved-parent';
    f.store.save(parent);
    const children = Array.from({ length: 8 }, (_, n) => child(f, parent, n));
    const reports = children.map((s, n) => {
      // Historical ready reports need not have an event in the parent's recent history.
      const report = f.store.reports.request(s, undefined, 'close', `close:${s.id}`, 0);
      report.state = 'ready';
      report.body = { ...recordedReport(undefined, `交付总结 ${n}`), lessons: [lesson] };
      f.store.reports.save(report);
      return report;
    });
    for (let n = 0; n < 250; n++) f.store.event(parent.id, 'tool', '已完成工具记录');
    const foreign = f.store.create(
      { ...parent.route, sender: 'bob', thread: 'foreign' },
      'codex',
      f.dir,
    );
    foreign.parentSessionId = parent.id;
    f.store.save(foreign);
    const forbidden = f.store.reports.request(foreign, undefined, 'close', 'foreign', 0);
    forbidden.state = 'ready';
    forbidden.body = recordedReport(undefined, '其他用户的内容');
    f.store.reports.save(forbidden);
    // A newer report from one child replaces its previous version, not another child.
    const latest = f.store.reports.request(children[0]!, undefined, 'manual', 'revised', 0);
    latest.state = 'ready';
    latest.body = { ...recordedReport(undefined, '更新后的阶段总结'), lessons: [lesson] };
    f.store.reports.save(latest);
    const restored = new SessionReports(f.store, {
      active: () => false,
      capacity: () => false,
      refresh() {},
    });
    assert.match(restored.context(parent), /更新后的阶段总结/);
    await restored.close();
    f.agent.handler = async (run) => {
      run.hooks.nativeId(run.session.nativeId!);
      for (const s of children) {
        assert.ok(run.text.includes(s.id));
        assert.ok(run.text.includes(s.title!));
      }
      assert.ok(run.text.includes(latest.id));
      assert.ok(!run.text.includes(reports[0]!.id));
      assert.match(run.text, /先固定输入口径/);
      assert.match(run.text, /样本变更后重新验证/);
      assert.ok(!run.text.includes('其他用户的内容'));
      const read = await call(run, 'task_report_read', { reportId: reports[0]!.id });
      assert.ok(!read.isError);
      assert.match(JSON.stringify(read), /交付总结 0/);
      assert.equal((await call(run, 'task_report_read', { reportId: forbidden.id })).isError, true);
      run.hooks.text('已按来源归纳交付与经验');
    };
    await f.manager.receive(incoming('请根据子任务的总结继续推进', 'alice', ''));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.get(parent.id)!.nativeId, 'preserved-parent');
    assert.equal(f.store.get(parent.id)!.status, 'idle');
    assert.equal(f.store.get(parent.id)!.taskId, undefined);
  } finally {
    await f.cleanup();
  }
});

test('a child proactively saves stage lessons through MCP; parent sees them next turn without an automatic summary run or completion', async () => {
  const f = fixture();
  try {
    const parent = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir, undefined, {
      conversationType: 'group',
    });
    const source = child(f, parent, 1);
    source.channelContext = { conversationType: 'group' };
    f.store.save(source);
    f.agent.handler = async (run) => {
      if (run.session.id === source.id) {
        const response = await call(run, 'topic_report', {
          summary: '阶段采样已完成，结论仍待核验',
          lessons: [lesson],
          remainingWork: ['复核结论'],
        });
        assert.ok(!response.isError);
      } else {
        assert.match(run.text, /阶段采样已完成/);
        assert.match(run.text, /先固定输入口径/);
        assert.match(run.text, /复核结论/);
        assert.ok(run.text.includes(source.id));
        assert.ok(run.text.includes(source.title!));
      }
      run.hooks.text('已保存');
    };
    await f.manager.receive(incoming('继续采样', 'alice', 'branch-1'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.topicUpdates().length, 0);
    assert.equal(f.store.get(source.id)!.topicCompleted, false);
    assert.deepEqual(f.store.get(source.id)!.topicProgress!.result.lessons, [lesson]);
    await f.manager.receive(incoming('子任务总结了哪些经验？', 'alice', ''));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 2);
    assert.equal(f.store.get(parent.id)!.status, 'idle');
  } finally {
    await f.cleanup();
  }
});

test('task adoption retains stage lessons; native task_progress updates reach the same parent on its next turn', async () => {
  const f = fixture();
  try {
    const parent = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const source = child(f, parent, 1);
    source.topicProgress = {
      revision: 1,
      at: Date.now(),
      result: topicReportSchema.parse({ summary: '迁移前的阶段总结', lessons: [lesson] }),
    };
    f.store.save(source);
    f.manager.tasks.adoptSession(parent.id);
    assert.match(f.manager.tasks.context(parent.id), /迁移前的阶段总结/);
    assert.match(f.manager.tasks.context(parent.id), /先固定输入口径/);
    f.agent.handler = async (run) => {
      if (run.session.id === source.id) {
        assert.ok(
          !(
            await call(run, 'task_progress', {
              summary: '新的阶段总结',
              lessons: [{ ...lesson, summary: '复核时记录异常样本' }],
            })
          ).isError,
        );
      } else {
        assert.match(run.text, /新的阶段总结/);
        assert.match(run.text, /复核时记录异常样本/);
        assert.ok(run.text.includes(source.id));
      }
      run.hooks.text('已处理');
    };
    await f.manager.receive(incoming('继续研究', 'alice', 'branch-1'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.taskJobs().filter((j) => j.taskId === parent.id).length, 0);
    await f.manager.receive(incoming('根据子任务经验继续', 'alice', ''));
    await until(() => f.agent.inputs.length === 2);
    await f.manager.idle();
    assert.notEqual(f.store.taskRecord(source.id)!.state, 'completed');
    assert.equal(f.store.get(parent.id)!.status, 'idle');
  } finally {
    await f.cleanup();
  }
});

test('large durable report indexes retain every source and version while bounding details; changing ancestry revokes access', async () => {
  const f = fixture();
  try {
    const parent = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const children = Array.from({ length: 100 }, (_, n) => child(f, parent, n));
    const reports = children.map((s) => {
      const r = f.store.reports.request(s, undefined, 'close', `budget:${s.id}`, 0);
      r.state = 'ready';
      r.body = {
        ...recordedReport(undefined, '总结'.repeat(3000)),
        remainingWork: Array(30).fill('遗留'.repeat(400)),
        lessons: Array(20).fill({ ...lesson, practice: '实践'.repeat(3000) }),
      };
      f.store.reports.save(r);
      return r;
    });
    const context = f.manager.reports.context(parent);
    assert.ok(context.length < 48_000, String(context.length));
    for (const r of reports) assert.ok(context.includes(r.id));
    assert.match(context, /"detailsOmitted":true/);
    const another = f.store.create({ ...parent.route, thread: 'another' }, 'codex', f.dir);
    children[0]!.parentSessionId = another.id;
    f.store.save(children[0]!);
    assert.ok(!f.manager.reports.context(parent).includes(reports[0]!.id));
    assert.throws(() => f.manager.reports.readForTask(parent.id, reports[0]!.id), /只能读取/);
    assert.ok(f.manager.reports.context(another).includes(reports[0]!.id));
  } finally {
    await f.cleanup();
  }
});

test('close summarization includes publicly submitted stage experience as evidence instead of losing it', async () => {
  const f = fixture();
  try {
    const parent = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const source = child(f, parent, 1);
    const event = f.store.event(
      source.id,
      'topic_progress',
      JSON.stringify({ summary: '阶段总结', lessons: [lesson] }),
    );
    (f.manager.reports as any).writer = {
      async generate(input: any) {
        assert.ok(
          input.history.events.some(
            (e: any) => e.id === event.id && e.text.includes(lesson.summary),
          ),
        );
        assert.ok(input.allowedEvidence.includes(`event:${event.id}`));
        return {
          ...recordedReport(undefined, '结束交接'),
          lessons: [{ ...lesson, evidence: [`event:${event.id}`] }],
        };
      },
    };
    f.manager.closeSession(source.id);
    await until(() => f.store.reports.list(source.id)[0]?.state === 'ready');
    assert.equal(f.store.reports.list(source.id)[0]!.quality, 'generated');
    assert.match(f.manager.reports.context(parent), /先固定输入口径/);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('the configurable inline boundary counts Unicode characters and long summaries have a bounded digest plus a document', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    const r = f.store.reports.request(s, undefined, 'close', 'boundary', 0);
    r.body = recordedReport(undefined, '😀'.repeat(50));
    assert.equal(reportPresentation(r, s).document, undefined);
    r.body.summary += '字';
    const long = reportPresentation(r, s);
    assert.ok(long.document);
    assert.equal(Array.from(long.summary).length, 50);
    assert.ok(!long.summary.includes('\uFFFD'));
    r.body.summary = '短总结';
    assert.ok(reportPresentation(r, s, 2).document);
    assert.equal(reportPresentation(r, s, 3).document, undefined);
  } finally {
    await f.cleanup();
  }
});

test('stage summaries are durable parent history messages with authenticated full documents; IM gets the same digest and attachment once', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'test-token');
  const files: { route: any; document: any }[] = [],
    cards: any[] = [];
  Object.assign(f.channel, {
    async sendDocument(message: any, document: any) {
      files.push({ route: message.route, document });
    },
    async sendManagement(message: any, view: any) {
      cards.push({ route: message.route, view });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`,
    headers = { Authorization: 'Bearer test-token' };
  try {
    f.config.handoffInlineLimit = 10;
    const parent = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      source = child(f, parent, 1);
    const summary = '采样阶段已经完成。后续需要核验统计口径，当前结论尚未最终验收。';
    const r = f.manager.reports.recordSummary(
      source.id,
      { summary, lessons: [lesson] },
      'phase-1',
      0,
    );
    assert.equal(f.manager.reports.recordSummary(source.id, { summary }, 'phase-1', 0).id, r.id);
    await until(() => f.store.reports.get(r.id)?.notifications?.[0]?.state === 'delivered');
    assert.equal(files.length, 1);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].view.title, '子任务阶段总结');
    assert.equal(files[0]!.route.thread, '');
    assert.ok(files[0]!.document.content.includes(summary));
    assert.ok(files[0]!.document.content.includes(lesson.practice));
    assert.ok(!cards[0].view.text.includes(summary));
    assert.match(cards[0].view.text, /更详细的信息在交接文档/);
    // Unrelated tool volume cannot hide the durable handoff from Web history.
    for (let n = 0; n < 250; n++) f.store.event(parent.id, 'tool', '工具记录');
    const response = await fetch(`${base}/sessions/${parent.id}/events`, { headers });
    assert.equal(response.status, 200);
    const entries = ((await response.json()) as any[]).filter((e) => e.type === 'handoff_received');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].handoff.sourceSessionId, source.id);
    assert.equal(entries[0].handoff.sourceTitle, source.title);
    assert.equal(entries[0].handoff.kind, 'progress');
    assert.ok(Array.from(entries[0].handoff.summary).length <= 10);
    const url = `${base}/sessions/${parent.id}/reports/${r.id}/document`;
    assert.equal((await fetch(url)).status, 401);
    const document = (await (await fetch(url, { headers })).json()) as any;
    assert.deepEqual(document, files[0]!.document);
    assert.match(document.filename, /\.md$/);
    const foreign = f.store.create(
      { ...parent.route, sender: 'bob', thread: 'other' },
      'codex',
      f.dir,
    );
    assert.notEqual(
      (await fetch(`${base}/sessions/${foreign.id}/reports/${r.id}/document`, { headers })).status,
      200,
    );
    await f.manager.receive(incoming(`/tab report ${r.id} document`, 'alice', ''));
    assert.equal(files.length, 2);
    assert.equal(f.agent.inputs.length, 0);
    const short = f.manager.reports.recordSummary(source.id, { summary: '核验待做' }, 'phase-2', 0);
    await until(() => f.store.reports.get(short.id)?.notifications?.[0]?.state === 'delivered');
    assert.equal(files.length, 2);
    assert.ok(
      !f.manager.reports
        .history(parent.id)
        .filter((e: any) => e.handoff)
        .at(-1)!.handoff.document,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});

test('Lark document delivery uploads UTF-8 Markdown and replies only in the original thread; unknown sends are not retried', async () => {
  const channel = Object.create(LarkChannel.prototype) as LarkChannel;
  const uploads: any[] = [],
    replies: any[] = [],
    creates: any[] = [];
  (channel as any).client = {
    im: {
      file: {
        async create(input: any) {
          uploads.push(input);
          return { file_key: 'test-key' };
        },
      },
      message: {
        async reply(input: any) {
          replies.push(input);
          return { code: 0 };
        },
        async create(input: any) {
          creates.push(input);
          return { code: 0 };
        },
      },
    },
  };
  const doc = { filename: 'handoff.md', content: '# 总结\n\n阶段经验' };
  await channel.sendDocument(incoming('', 'alice', 'om_original'), doc);
  assert.equal(uploads[0].data.file_type, 'stream');
  assert.equal(uploads[0].data.file.toString('utf8'), doc.content);
  assert.equal(replies[0].path.message_id, 'om_original');
  assert.equal(replies[0].data.reply_in_thread, true);
  assert.equal(creates.length, 0);
  await channel.sendDocument(incoming('', 'alice', ''), doc);
  assert.equal(creates[0].data.receive_id, 'chat-1');
  (channel as any).client.im.message.reply = async () => {
    replies.push({ failed: true });
    throw Error('unknown delivery');
  };
  await assert.rejects(channel.sendDocument(incoming('', 'alice', 'om_original'), doc));
  assert.equal(replies.length, 2);
  assert.equal(creates.length, 1);
});

test('the transcript records actual assembled native input, instructions, public replies and full tool results; an unread handoff is not a model message', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'transcript-token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`,
    headers = { Authorization: 'Bearer transcript-token' };
  try {
    const parent = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      source = child(f, parent, 1);
    const report = f.manager.reports.recordSummary(
      source.id,
      { summary: '阶段核验完成，仍需复核口径', lessons: [lesson] },
      'transcript-phase',
      0,
    );
    const path = `${base}/sessions/${parent.id}/transcript`;
    assert.equal((await fetch(path)).status, 401);
    const unread = (await (await fetch(path, { headers })).json()) as any;
    assert.deepEqual(unread.events, []);
    const received = (await (
      await fetch(`${base}/sessions/${parent.id}/reports/received`, { headers })
    ).json()) as any;
    assert.equal(received.handoffs[0].reportId, report.id);
    const output = '完整工具输出'.repeat(3000);
    let exact = '',
      bridgeToken = '';
    f.agent.handler = async (run) => {
      exact = run.text;
      bridgeToken = run.taskBridge!.token;
      run.hooks.nativeId('same-parent-native');
      run.hooks.input?.({
        text: run.text,
        nativeId: 'same-parent-native',
        instructions: '公开的本轮附加指令',
        instructionMode: 'codex-developer',
      });
      run.hooks.inputAccepted?.({
        nativeId: 'same-parent-native',
        evidence: 'test native acknowledgement',
      });
      run.hooks.inputAccepted?.({
        nativeId: 'same-parent-native',
        evidence: 'test native acknowledgement',
      });
      run.hooks.tool?.({
        id: 'research-read',
        name: '读取交接资料',
        status: 'completed',
        input: 'read report',
        output,
      });
      run.hooks.text('已依据子任务总结及经验安排复核');
    };
    await f.manager.receive(incoming('结合子任务经验继续推进', 'alice', ''));
    await f.manager.idle();
    const page = (await (await fetch(path, { headers })).json()) as any;
    const input = page.events
      .filter((e: any) => e.type === 'agent_input')
      .map((e: any) => JSON.parse(e.text))
      .at(-1);
    assert.equal(input.status, 'submitted');
    assert.equal(input.text, exact);
    assert.match(input.text, /先固定输入口径/);
    assert.match(input.text, /研究子任务 1/);
    assert.equal(input.userText, '结合子任务经验继续推进');
    assert.equal(input.instructions, '公开的本轮附加指令');
    assert.equal(input.handoffs[0].reportId, report.id);
    assert.ok(!JSON.stringify(page).includes(bridgeToken));
    const tool = JSON.parse(page.events.find((e: any) => e.type === 'agent_tool').text);
    assert.equal(tool.output, output);
    assert.equal(tool.runId, input.runId);
    assert.ok(page.events.some((e: any) => e.type === 'assistant' && e.text.includes('安排复核')));
    assert.ok(!page.events.some((e: any) => e.type === 'handoff_received'));
    assert.equal(f.store.get(parent.id)!.nativeId, 'same-parent-native');
    // Historical records retain their real coverage instead of inventing sent prompts.
    for (let n = 0; n < 135; n++) f.store.event(parent.id, 'assistant', `公开历史 ${n}`);
    const latest = (await (await fetch(path, { headers })).json()) as any;
    assert.equal(latest.events.length, 120);
    assert.ok(latest.nextBefore);
    const older = (await (
      await fetch(`${path}?before=${latest.nextBefore}`, { headers })
    ).json()) as any;
    assert.ok(older.events.some((e: any) => e.type === 'agent_input'));
    assert.ok(older.events.every((e: any) => e.id < latest.nextBefore));
    assert.match(older.coverage, /旧轮次/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
