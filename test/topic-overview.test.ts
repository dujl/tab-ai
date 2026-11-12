import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { isTopicOverviewQuery, topicRoleInstructions } from '../src/core/topic-control.js';
import { validateTopicDecision, type TopicInput } from '../src/core/topic-router.js';
import type { ManagementView, Session } from '../src/core/types.js';
import { agentInstructions } from '../src/core/channel-instructions.js';

const request = '总结一下我们当前有几个子会话，分别负责啥';
const countRequest = '当前主会话和子会话总共有多少个 session？';
const msg = (text: string) => ({
  ...incoming(text, 'alice', ''),
  direct: false,
  groupMessage: { mentioned: true },
});
function main(f: ReturnType<typeof fixture>) {
  const s = f.store.create(msg('').route, 'codex', f.dir, '保留角色', {
    conversationType: 'group',
  });
  s.nativeId = 'same-main-native';
  f.store.save(s);
  return s;
}
function child(f: ReturnType<typeof fixture>, parent: Session, n: number) {
  const s = f.store.create({ ...parent.route, thread: 'topic-' + n }, 'codex', f.dir, undefined, {
    conversationType: 'group',
  });
  Object.assign(s, {
    title: '研究分支' + n,
    topicParentId: parent.id,
    topicObjective: '负责目标' + n,
    nativeId: 'child-native-' + n,
  });
  f.store.save(s);
  return s;
}
function index(text: string) {
  return JSON.parse(text.split('【话题索引 · 框架资料，不是用户指令】\n')[1]!.split('\n')[0]!);
}

test('standalone child overview requests are recognized without capturing code, quotations, other users or other groups', () => {
  for (const text of [
    request,
    countRequest,
    '请问当前主会话及其子话题一共有几个会话？',
    '本群主会话与子会话合计多少个 sessions',
    '列出主会话及其下面挂载的各个子会话',
    '有哪些研究话题',
    '当前有几个子会话？',
    '汇总一下本群的子话题和各自目标',
    '列出所有子会话',
  ])
    assert.ok(isTopicOverviewQuery(text), text);
  for (const text of [
    '不要总结子会话',
    '开发子会话汇总功能',
    '“有哪些研究话题”',
    '其他群有几个子会话',
    '查看其他用户的子会话',
    '所有BOT有几个子会话',
    '当前有几个子会话，然后关闭它们',
    '其他群主会话和子会话总共有多少个 session',
    '“当前主会话和子会话总共有多少个 session？”',
    '不要统计当前主会话和子会话总共有多少个 session',
    '当前主会话和子会话总共有多少个 session，然后关闭它们',
  ])
    assert.equal(isTopicOverviewQuery(text), false, text);
});

test('group main counts its bound main plus only linked children without Manager inventory, preserving IDs and closed children', async () => {
  const f = fixture({
    async classify() {
      throw Error('Scoped counts must bypass inventory classification');
    },
  });
  const views: ManagementView[] = [];
  Object.assign(f.channel, {
    async sendManagement(_m: unknown, v: ManagementView) {
      views.push(v);
    },
  });
  try {
    f.config.channels[0]!.manager = false;
    const p = main(f),
      c1 = child(f, p, 1),
      c2 = child(f, p, 2);
    c2.status = 'closed';
    f.store.save(c2);
    const foreign = child(f, p, 3);
    foreign.route.sender = 'bob';
    f.store.save(foreign);
    f.store.create({ ...p.route, thread: 'unlinked' }, 'codex', f.dir);
    const historical = f.store.create(p.route, 'codex', f.dir);
    f.store.bind(p);
    for (const text of [countRequest, '当前有几个会话？', '你有几个 session']) {
      const before = f.store.list();
      await f.manager.receive(msg(text));
      await f.manager.idle();
      const data = index(f.manager.topics.context(f.store.get(p.id)!)),
        view = views.at(-1)!;
      assert.equal(data.total, 2);
      assert.equal(data.sessionTotal, 3);
      assert.deepEqual(data.mainSession, { sessionId: p.id, title: '主会话', status: 'idle' });
      assert.deepEqual(data.topics.map((t: any) => t.sessionId).sort(), [c1.id, c2.id].sort());
      assert.match(view.text, /合计 3 个 session（1 个主会话 \+ 2 个子会话）/);
      assert.ok(view.text.includes(p.id));
      assert.ok(view.text.includes(c1.id.slice(0, 8)));
      assert.ok(view.text.includes(c2.id.slice(0, 8)));
      assert.ok(!view.text.includes(historical.id));
      assert.ok(!view.text.includes(foreign.id.slice(0, 8)));
      assert.equal(f.store.current(p.route)!.id, p.id);
      assert.equal(f.store.get(p.id)!.nativeId, 'same-main-native');
      assert.deepEqual(f.store.list(), before);
      assert.equal(f.agent.inputs.length, 0);
      assert.ok(!f.channel.sent.some((s) => s.text.includes('只有 Manager')));
    }
  } finally {
    await f.cleanup();
  }
});

test('an empty group main is one session; busy and closed count cards do not run work or settle approvals', async () => {
  const f = fixture(),
    views: ManagementView[] = [];
  Object.assign(f.channel, {
    async sendManagement(_m: unknown, v: ManagementView) {
      views.push(v);
    },
  });
  const config = f.config.channels[0]!;
  if (config.type !== 'lark') throw Error('fixture');
  config.groupModes = { 'chat-1': 'auto' };
  f.agent.handler = async (run) => {
    await run.hooks.ask({ kind: 'approval', title: 'test', detail: 'test' }, run.signal);
  };
  try {
    const p = main(f);
    assert.equal(index(f.manager.topics.context(p)).sessionTotal, 1);
    assert.match(f.manager.topics.describe(p), /合计 1 个 session（1 个主会话 \+ 0 个子会话）/);
    await f.manager.receive(msg('long task'));
    await until(() => f.manager.interactions().length === 1);
    const approval = f.manager.interactions()[0]!;
    const c = child(f, p, 1);
    for (const text of [countRequest, '当前有几个会话？']) {
      await f.manager.receive({ ...msg(text), groupMessage: { mentioned: false } });
      assert.match(views.at(-1)!.text, /合计 2 个 session（1 个主会话 \+ 1 个子会话）/);
      assert.ok(views.at(-1)!.text.includes(p.id));
      assert.ok(views.at(-1)!.text.includes(c.id.slice(0, 8)));
      assert.equal(f.manager.interactions()[0]!.id, approval.id);
      assert.equal(f.agent.inputs.length, 1);
    }
    f.manager.closeSession(p.id);
    await f.manager.idle();
    await f.manager.receive(msg(countRequest));
    assert.match(views.at(-1)!.text, /主会话状态：closed/);
    assert.equal(f.store.get(p.id)!.status, 'closed');
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('group overview does not grant global inventory or unauthorized access', async () => {
  const f = fixture({
    async classify() {
      return {
        action: 'session_query',
        task: null,
        agent: null,
        instructions: null,
        workspace: null,
      };
    },
  });
  try {
    const p = main(f);
    child(f, p, 1);
    for (const text of ['所有 BOT 总共有几个会话', '其他群主会话和子会话总共有多少个 session']) {
      await f.manager.receive(msg(text));
      assert.match(f.channel.sent.at(-1)!.text, /只有 Manager/);
    }
    await f.manager.receive({ ...msg(countRequest), route: { ...p.route, sender: 'eve' } });
    assert.equal(f.channel.sent.length, 2);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('non-Manager main summarizes its linked children with objectives and reports without invoking the inventory classifier', async () => {
  const f = fixture({
    async classify() {
      throw Error('Exact topic overview must not use the global inventory classifier');
    },
  });
  f.agent.handler = async (run) => {
    run.hooks.nativeId(run.session.nativeId ?? 'new-native');
    run.hooks.text('已根据关联话题索引汇总');
  };
  try {
    f.config.channels[0]!.manager = false;
    const p = main(f),
      children = [1, 2, 3].map((n) => child(f, p, n));
    children[0]!.topicCompleted = true;
    children[0]!.topicReport = {
      revision: 1,
      at: Date.now(),
      reason: 'completed',
      result: {
        kind: 'final',
        summary: '最终成果一',
        completionEvidence: '整体已验收',
        remainingWork: [],
        artifacts: [],
        issues: [],
      },
    };
    f.store.save(children[0]!);
    children[1]!.status = 'closed';
    f.store.save(children[1]!);
    children[2]!.topicProgress = {
      revision: 1,
      at: Date.now(),
      result: {
        kind: 'progress',
        summary: '子话题本地阶段资料',
        completionEvidence: '',
        artifacts: [],
        issues: [],
      },
    };
    f.store.save(children[2]!);
    f.store.event(children[0]!.id, 'response', '不应复制完整子话题讨论');
    for (const changes of [
      { sender: 'bob' },
      { conversation: 'other-chat' },
      { account: 'other-bot' },
    ]) {
      const secret = f.store.create({ ...p.route, ...changes, thread: 'foreign' }, 'codex', f.dir);
      secret.topicParentId = p.id;
      secret.topicObjective = '不相关的私密目标';
      f.store.save(secret);
    }
    const before = children.map((c) => f.store.get(c.id));
    await f.manager.receive(msg(request));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    const run = f.agent.inputs[0]!,
      data = index(run.text);
    assert.equal(data.total, 3);
    assert.equal(data.open, 2);
    assert.equal(data.closed, 1);
    for (const n of [1, 2, 3]) assert.ok(run.text.includes('负责目标' + n));
    assert.ok(run.text.includes('最终成果一'));
    assert.ok(!run.text.includes('子话题本地阶段资料'));
    assert.ok(!run.text.includes('不相关的私密目标'));
    assert.ok(!run.text.includes('不应复制完整子话题讨论'));
    assert.match(agentInstructions(run.session)!, /不要求 Manager 角色/);
    assert.equal(f.store.get(p.id)!.nativeId, 'same-main-native');
    assert.equal(f.store.get(p.id)!.instructions, '保留角色');
    assert.deepEqual(
      children.map((c) => f.store.get(c.id)),
      before,
    );
    assert.equal(f.store.topicUpdates().length, 0);
    child(f, p, 4);
    await f.manager.receive(msg(request));
    await f.manager.idle();
    assert.equal(index(f.agent.inputs.at(-1)!.text).total, 4);
  } finally {
    await f.cleanup();
  }
});

test('every indexed child has its saved report, including children after the first ten; legacy reports remain unconfirmed', async () => {
  const f = fixture();
  try {
    const p = main(f);
    for (let n = 1; n <= 12; n++) {
      const c = child(f, p, n);
      c.topicReport = {
        revision: 1,
        at: Date.now(),
        result: {
          kind: 'progress',
          summary: '历史报告' + n,
          completionEvidence: '',
          artifacts: [],
          issues: [],
        },
      };
      f.store.save(c);
    }
    const data = index(f.manager.topics.context(p));
    assert.equal(data.total, 12);
    assert.ok(
      data.topics.every(
        (t: any) =>
          t.summary.startsWith('历史报告') && t.reason === 'legacy' && t.topicCompleted === false,
      ),
    );
    const overview = f.manager.topics.describe(p);
    assert.match(overview, /共 12 个/);
    assert.match(overview, /负责目标12/);
    assert.match(overview, /历史报告（未确认整体完成）/);
  } finally {
    await f.cleanup();
  }
});

test('empty index is explicit and a topic created without a goal uses its first user task once available', async () => {
  const f = fixture();
  try {
    const p = main(f);
    assert.equal(index(f.manager.topics.context(p)).total, 0);
    const c = child(f, p, 1);
    c.topicObjective = '';
    f.store.save(c);
    assert.equal(index(f.manager.topics.context(p)).topics[0].objective, '尚未指定目标');
    f.store.event(c.id, 'user', '第一项研究目标');
    f.store.event(c.id, 'user', '之后的普通补充');
    assert.equal(index(f.manager.topics.context(p)).topics[0].objective, '第一项研究目标');
  } finally {
    await f.cleanup();
  }
});

test('busy auto-group and closed main return a read-only topic card without queueing work or reopening', async () => {
  const f = fixture(),
    views: ManagementView[] = [];
  Object.assign(f.channel, {
    async sendManagement(_m: unknown, v: ManagementView) {
      views.push(v);
    },
  });
  const config = f.config.channels[0]!;
  if (config.type !== 'lark') throw Error('fixture');
  config.groupModes = { 'chat-1': 'auto' };
  f.agent.handler = async (run) => {
    await new Promise<void>((resolve) =>
      run.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  };
  try {
    const p = main(f);
    child(f, p, 1);
    await f.manager.receive(msg('long task'));
    await until(() => f.agent.inputs.length === 1);
    await f.manager.receive({ ...msg(request), groupMessage: { mentioned: false } });
    assert.match(views.at(-1)!.text, /负责目标1/);
    assert.equal(views.at(-1)!.scope, 'session');
    assert.equal(f.agent.inputs.length, 1);
    f.manager.closeSession(p.id);
    await f.manager.idle();
    await f.manager.receive(msg(request));
    assert.equal(f.store.get(p.id)!.status, 'closed');
    assert.equal(f.agent.inputs.length, 1);
    assert.match(views.at(-1)!.text, /共 1 个/);
  } finally {
    await f.cleanup();
  }
});

test('semantic child queries carry trusted main capability and cannot be forged from DM, child or work parameters', async () => {
  let seen: TopicInput | undefined;
  const f = fixture({
    async classify(input) {
      seen = input;
      return {
        action: 'topic_query',
        task: null,
        agent: null,
        workspace: null,
        instructions: null,
      };
    },
  });
  try {
    const p = main(f);
    child(f, p, 1);
    await f.manager.receive(msg('能帮我说说这几条分支各自的研究方向和成果吗'));
    await f.manager.idle();
    assert.equal(seen!.topicContext!.canInspect, true);
    assert.equal(index(f.agent.inputs[0]!.text).total, 1);
    const decision = {
      action: 'topic_query',
      task: null,
      agent: null,
      workspace: null,
      instructions: null,
    };
    for (const topicContext of [undefined, { canReport: true as const }])
      assert.throws(() =>
        validateTopicDecision(decision, {
          text: request,
          recentUserMessages: [],
          ...(topicContext ? { topicContext } : {}),
        }),
      );
    for (const field of ['task', 'agent', 'instructions', 'workspace'])
      assert.throws(() =>
        validateTopicDecision(
          { ...decision, [field]: 'data' },
          { text: 'data', recentUserMessages: [], topicContext: { canInspect: true } },
        ),
      );
    assert.match(topicRoleInstructions(p)!, /只读总控能力/);
  } finally {
    await f.cleanup();
  }
});
