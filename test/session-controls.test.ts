import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until, FakeAgent, FakeChannel } from './helpers.js';
import { type SessionCardClick, type SessionCardView } from '../src/core/types.js';
import { Manager } from '../src/core/manager.js';
import { Store } from '../src/core/store.js';
import { rmSync } from 'node:fs';
import { larkSessionAction, larkSessionCard } from '../src/channels/lark-session-card.js';

function controls(channel: FakeChannel) {
  let handler!: (click: SessionCardClick) => SessionCardView;
  const sent: SessionCardView[] = [],
    updates: SessionCardView[] = [];
  Object.assign(channel, {
    onSessionAction(fn: typeof handler) {
      handler = fn;
    },
    async sendSessionCard(view: SessionCardView) {
      sent.push(structuredClone(view));
      return `om_card_${view.session.id}`;
    },
    async updateSessionCard(view: SessionCardView) {
      updates.push(structuredClone(view));
    },
  });
  return { sent, updates, click: (value: SessionCardClick) => handler(value) };
}
function click(
  f: ReturnType<typeof fixture>,
  id: string,
  action: SessionCardClick['action'],
): SessionCardClick {
  const card = f.store.card(id)!;
  return {
    id: card.id,
    revision: card.revision,
    action,
    sender: 'alice',
    conversation: 'chat-1',
    messageId: card.messageId!,
  };
}
for (const agent of ['codex', 'claude'] as const)
  test(`${agent} publishes native ID to the initial card before the first task completes`, async () => {
    const f = fixture(),
      ui = controls(f.channel);
    f.manager.registerChannel(f.channel);
    let publish!: () => void, finish!: () => void;
    f.agent.handler = async (run) => {
      await new Promise<void>((resolve) => {
        publish = () => {
          run.hooks.nativeId(`${agent}-native-id`);
          resolve();
        };
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    try {
      await f.manager.receive(incoming(`/tab new ${agent}`, 'alice', ''));
      await f.manager.controls.drain();
      const session = f.store.list()[0]!,
        original = f.store.card(session.id)!;
      await f.manager.receive(incoming('first task', 'alice', session.route.thread));
      await f.manager.controls.drain();
      assert.equal(ui.updates.at(-1)!.session.nativeId, undefined);
      await until(() => !!publish);
      publish();
      await until(() => !!finish);
      await f.manager.controls.drain();
      const updated = ui.updates.at(-1)!;
      assert.equal(updated.session.status, 'running');
      assert.equal(updated.active, true);
      assert.equal(updated.session.nativeId, `${agent}-native-id`);
      assert.equal(updated.card.messageId, original.messageId);
      assert.equal(ui.sent.length, 1);
      const card = JSON.stringify(larkSessionCard(updated));
      assert.ok(
        card.includes(`${agent === 'codex' ? 'Codex' : 'Claude Code'} 原生 ID：${agent}-native-id`),
      );
      assert.ok(card.includes(`tab-ai native ${session.id}`));
    } finally {
      finish?.();
      await f.cleanup();
    }
  });
test('creation, closed status and card distinguish management ID from the native resume ID without reopening', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('/tab new codex', 'alice', ''));
    await f.manager.controls.drain();
    const session = f.store.list()[0]!;
    assert.ok(f.channel.sent.at(-1)!.text.includes(`tab-ai 管理 ID：${session.id}`));
    let card = JSON.stringify(
      larkSessionCard(f.manager.controls.snapshot(f.store.card(session.id)!)),
    );
    assert.ok(card.includes('尚未启动'));
    assert.ok(!card.includes('codex resume'));
    await f.manager.receive(incoming('hello', 'alice', session.route.thread));
    await f.manager.idle();
    f.manager.closeSession(session.id);
    await f.manager.controls.drain();
    await f.manager.receive(incoming('/tab status', 'alice', session.route.thread));
    const status = f.channel.sent.at(-1)!.text;
    card = JSON.stringify(larkSessionCard(f.manager.controls.snapshot(f.store.card(session.id)!)));
    for (const text of [status, card]) {
      assert.ok(text.includes(`tab-ai 管理 ID：${session.id}`));
      assert.ok(text.includes('Codex 原生 ID：native-1'));
      assert.ok(text.includes(`tab-ai native ${session.id}`));
      assert.ok(!text.includes(`codex resume ${session.id}`));
    }
    assert.equal(f.store.get(session.id)!.status, 'closed');
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(ui.sent.length, 1);
  } finally {
    await f.cleanup();
  }
});
test('one persistent card per session; close blocks inputs and open resumes native history without a model turn', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('hello', 'alice', 'om_root'));
    await f.manager.idle();
    await f.manager.controls.drain();
    const session = f.store.list()[0]!;
    assert.equal(ui.sent.length, 1);
    assert.equal(f.store.card(session.id)!.delivery, 'sent');
    const close = click(f, session.id, 'close');
    ui.click(close);
    await f.manager.controls.drain();
    assert.equal(f.store.get(session.id)!.status, 'closed');
    await f.manager.receive(incoming('must not run', 'alice', 'om_root'));
    assert.equal(f.agent.inputs.length, 1);
    ui.click(click(f, session.id, 'open'));
    await f.manager.controls.drain();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.get(session.id)!.nativeId, 'native-1');
    assert.equal(f.store.get(session.id)!.status, 'idle');
    assert.throws(() => ui.click(close), /状态已更新/);
    await f.manager.receive(incoming('continued', 'alice', 'om_root'));
    await f.manager.idle();
    await f.manager.controls.drain();
    assert.equal(f.agent.inputs.length, 2);
    assert.equal(ui.sent.length, 1);
    const history = ui.click(click(f, session.id, 'history'));
    assert.ok(history.events.some((e) => e.text === 'hello'));
    assert.ok(history.events.every((e) => ['user', 'response'].includes(e.type)));
  } finally {
    await f.cleanup();
  }
});
test('session controls reject other actors, moved cards, other accounts and revoked access', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('hello'));
    await f.manager.idle();
    await f.manager.controls.drain();
    const id = f.store.list()[0]!.id;
    const request = click(f, id, 'close');
    for (const changes of [
      { sender: 'bob' },
      { conversation: 'elsewhere' },
      { messageId: 'om_forwarded' },
      { id: crypto.randomUUID() },
    ])
      assert.throws(() => ui.click({ ...request, ...changes }), /无权|不属于/);
    const other = new FakeChannel();
    other.id = 'other-account';
    const otherUi = controls(other);
    f.manager.registerChannel(other);
    assert.throws(() => otherUi.click(request), /不属于/);
    f.config.channels[0]!.allowedUsers = [];
    assert.throws(() => ui.click(request), /无权/);
    assert.equal(f.store.get(id)!.status, 'idle');
  } finally {
    await f.cleanup();
  }
});
test('closing a waiting run cancels approval; late completion cannot reopen the session', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  f.agent.handler = async (run) => {
    run.hooks.nativeId('native-wait');
    await run.hooks.ask({ kind: 'approval', title: 'test', detail: 'no action' }, run.signal);
  };
  try {
    await f.manager.receive(incoming('wait'));
    await until(() => f.manager.interactions().length === 1);
    await f.manager.controls.drain();
    const id = f.store.list()[0]!.id;
    ui.click(click(f, id, 'close'));
    assert.throws(() => f.manager.openSession(id), /等待/);
    await f.manager.idle();
    await f.manager.controls.drain();
    assert.equal(f.store.get(id)!.status, 'closed');
    assert.equal(f.manager.interactions().length, 0);
    assert.equal(f.store.get(id)!.nativeId, 'native-wait');
    assert.equal(ui.updates.at(-1)!.active, false);
  } finally {
    await f.cleanup();
  }
});
test('card IDs and closed state survive restart; old delivered card remains usable', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  let next: Manager | undefined, nextStore: Store | undefined;
  try {
    await f.manager.receive(incoming('hello'));
    await f.manager.idle();
    await f.manager.controls.drain();
    const id = f.store.list()[0]!.id;
    f.manager.closeSession(id);
    await f.manager.controls.drain();
    const card = f.store.card(id)!;
    await f.manager.close();
    f.store.close();
    nextStore = new Store(f.config.dataDir);
    const channel = new FakeChannel(),
      nextUi = controls(channel),
      agent = new FakeAgent();
    next = new Manager(
      f.config,
      nextStore,
      { codex: agent, claude: agent, opencode: agent },
      new Map([[channel.id, channel]]),
    );
    nextUi.click({
      id: card.id,
      revision: card.revision,
      action: 'open',
      sender: 'alice',
      conversation: 'chat-1',
      messageId: card.messageId!,
    });
    await next.controls.drain();
    assert.equal(nextStore.get(id)!.status, 'idle');
    assert.equal(nextStore.get(id)!.nativeId, 'native-1');
    assert.equal(agent.inputs.length, 0);
    assert.equal(nextUi.sent.length, 0);
  } finally {
    if (next) {
      await next.close();
      nextStore!.close();
      rmSync(f.dir, { recursive: true, force: true });
    } else await f.cleanup();
  }
});
test('ambiguous first send is not retried automatically; explicit retry replaces the old capability', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  let sends = 0;
  Object.assign(f.channel, {
    async sendSessionCard() {
      sends++;
      throw new Error('secret upstream detail');
    },
  });
  try {
    await f.manager.receive(incoming('hello'));
    await f.manager.idle();
    await f.manager.controls.drain();
    const id = f.store.list()[0]!.id,
      old = f.store.card(id)!;
    assert.equal(old.delivery, 'unknown');
    f.manager.controls.refresh(id);
    await f.manager.controls.drain();
    assert.equal(sends, 1);
    assert.ok(!JSON.stringify(f.store.events(id)).includes('secret upstream detail'));
    Object.assign(f.channel, {
      async sendSessionCard() {
        sends++;
        return 'om_retry';
      },
    });
    f.manager.controls.show(id);
    await f.manager.controls.drain();
    assert.equal(sends, 2);
    assert.notEqual(f.store.card(id)!.id, old.id);
    assert.throws(() => ui.click({ ...click(f, id, 'close'), id: old.id }), /不属于/);
  } finally {
    await f.cleanup();
  }
});
test('Lark management callbacks are separate from approvals and renderer treats transcript as plain text', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('<at id=all>hello</at>'));
    await f.manager.idle();
    await f.manager.controls.drain();
    const id = f.store.list()[0]!.id;
    const request = click(f, id, 'history'),
      raw = {
        operator: { open_id: request.sender },
        context: { open_message_id: request.messageId, open_chat_id: request.conversation },
        action: {
          value: { kind: 'session', id: request.id, revision: request.revision, action: 'history' },
        },
      };
    assert.equal(larkSessionAction(raw, ui.click).toast.type, 'success');
    assert.equal(
      larkSessionAction({ ...raw, operator: { open_id: 'bob' } }, ui.click).toast.type,
      'error',
    );
    const card = larkSessionCard(f.manager.controls.snapshot(f.store.card(id)!));
    assert.equal(card.config.enable_forward, false);
    assert.ok(JSON.stringify(card).includes('<at id=all>'));
    assert.ok(!JSON.stringify(card).includes('"lark_md"'));
  } finally {
    await f.cleanup();
  }
});

test('new empty Lark session card accepts multiline instructions without conversation messages; first task locks editing', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('/tab new codex', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!,
      snapshot = () => f.manager.controls.snapshot(f.store.card(s.id)!);
    assert.equal(snapshot().instructionsEditable, true);
    const form = larkSessionCard(snapshot()).body.elements.find(
      (e: any) => e.tag === 'form',
    ) as any;
    assert.ok(form.elements.some((e: any) => e.name === 'session_instructions'));
    assert.equal(
      form.elements.find((e: any) => e.name === 'session_workspace_path').default_value,
      s.workspace,
    );
    assert.equal(form.elements.at(-1).form_action_type, 'submit');
    const request = click(f, s.id, 'save_instructions'),
      role = '你是一位编辑。\n  用中文回答。';
    const raw = {
      operator: { open_id: 'alice' },
      context: { open_message_id: request.messageId, open_chat_id: request.conversation },
      action: {
        value: {
          kind: 'session',
          id: request.id,
          revision: request.revision,
          action: request.action,
        },
        form_value: { session_instructions: role },
      },
    };
    assert.equal(larkSessionAction(raw, ui.click).toast.type, 'success');
    await f.manager.controls.drain();
    assert.equal(f.store.get(s.id)!.instructions, role);
    assert.equal(f.agent.inputs.length, 0);
    assert.deepEqual(f.store.events(s.id), []);
    assert.equal(larkSessionAction(raw, ui.click).toast.type, 'error'); // stale/replayed submission
    for (const changes of [
      { sender: 'bob' },
      { conversation: 'wrong' },
      { messageId: 'forwarded' },
    ])
      assert.throws(
        () =>
          ui.click({
            ...click(f, s.id, 'save_instructions'),
            instructions: 'overwrite',
            ...changes,
          }),
        /不属于/,
      );
    const stale = click(f, s.id, 'save_instructions');
    await f.manager.receive(incoming('写一篇散文', 'alice', s.route.thread));
    await f.manager.idle();
    await f.manager.controls.drain();
    assert.equal(f.agent.inputs[0]!.session.instructions, role);
    assert.equal(f.agent.inputs[0]!.text, '写一篇散文');
    assert.equal(snapshot().instructionsEditable, false);
    assert.ok(!larkSessionCard(snapshot()).body.elements.some((e: any) => e.tag === 'form'));
    assert.throws(() => ui.click({ ...stale, instructions: 'late role' }));
    assert.throws(
      () => ui.click({ ...click(f, s.id, 'save_instructions'), instructions: 'late role' }),
      /首次任务/,
    );
    f.manager.closeSession(s.id);
    f.manager.openSession(s.id);
    await f.manager.controls.drain();
    assert.throws(
      () => ui.click({ ...click(f, s.id, 'save_instructions'), instructions: 'replacement' }),
      /首次任务/,
    );
    assert.equal(f.store.get(s.id)!.instructions, role);
    const restored = new Store(f.config.dataDir);
    try {
      assert.equal(restored.get(s.id)!.instructions, role);
    } finally {
      restored.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('card instruction edits validate size, reject missing values, allow explicit empty and preserve long existing roles', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('/tab init codex --instructions Default role', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!;
    for (const instructions of ['x'.repeat(1001), 'a\0b'])
      assert.throws(() => ui.click({ ...click(f, s.id, 'save_instructions'), instructions }));
    ui.click({ ...click(f, s.id, 'save_instructions') });
    await f.manager.controls.drain();
    assert.equal(f.store.get(s.id)!.instructions, 'Default role');
    ui.click({ ...click(f, s.id, 'save_instructions'), instructions: '' });
    await f.manager.controls.drain();
    assert.equal(f.store.get(s.id)!.instructions, undefined);
    assert.equal(f.agent.inputs.length, 0);
    const stored = f.store.get(s.id)!;
    stored.instructions = '长'.repeat(1001);
    f.store.save(stored);
    const render = JSON.stringify(
      larkSessionCard(f.manager.controls.snapshot(f.store.card(s.id)!)),
    );
    assert.ok(!render.includes('"name":"session_instructions"'));
    assert.ok(render.includes('"name":"session_workspace_path"'));
    assert.ok(render.includes('完整保留'));
    assert.throws(
      () => ui.click({ ...click(f, s.id, 'save_instructions'), instructions: 'short' }),
      /超过卡片容量/,
    );
    assert.equal(f.store.get(s.id)!.instructions, stored.instructions);
  } finally {
    await f.cleanup();
  }
});

for (const mode of ['save', 'skip', 'command', 'restart'] as const)
  test(`Lark creation with an initial task waits for instructions; ${mode} starts the preserved task once`, async () => {
    const f = fixture(),
      ui = controls(f.channel);
    f.manager.registerChannel(f.channel);
    let replacement: Manager | undefined, restored: Store | undefined;
    try {
      const request = incoming('新开一个话题，整理示例图书目录', 'alice', '');
      await f.manager.receive(request);
      await f.manager.controls.drain();
      const s = f.store.list()[0]!,
        task = s.pendingInitialTask!;
      assert.ok(task.includes('整理示例图书目录'));
      assert.equal(f.agent.inputs.length, 0);
      assert.equal(s.nativeId, undefined);
      assert.deepEqual(f.store.events(s.id), []);
      assert.equal(s.status, 'idle');
      for (const view of ['status', 'settings', 'history'] as const) {
        const card = { ...f.store.card(s.id)!, view };
        const rendered = JSON.stringify(larkSessionCard(f.manager.controls.snapshot(card)));
        assert.ok(rendered.includes('session_instructions'));
        assert.ok(rendered.includes('start_initial'));
        assert.ok(rendered.includes('首个任务尚未执行'));
      }
      await f.manager.receive(incoming('我还没有填好', 'alice', s.route.thread));
      await f.manager.idle();
      assert.equal(f.agent.inputs.length, 0);
      assert.equal(f.store.get(s.id)!.pendingInitialTask, task);
      for (const sender of ['bob', 'eve'])
        assert.throws(() => ui.click({ ...click(f, s.id, 'start_initial'), sender }), /不属于/);
      const original = click(f, s.id, 'start_initial');
      if (mode === 'restart') {
        await f.manager.close();
        restored = new Store(f.config.dataDir);
        replacement = new Manager(
          f.config,
          restored,
          { codex: f.agent, claude: f.agent, opencode: f.agent },
          new Map([[f.channel.id, f.channel]]),
        );
        replacement.refreshSessionCards();
        await replacement.controls.drain();
        assert.equal(f.agent.inputs.length, 0);
        assert.equal(restored.get(s.id)!.pendingInitialTask, task);
      }
      const manager = replacement ?? f.manager;
      if (mode === 'command')
        await manager.receive(incoming('/tab begin', 'alice', s.route.thread));
      else if (mode === 'save')
        ui.click({
          ...click(f, s.id, 'save_instructions'),
          instructions: '请只做研究，使用中文。',
        });
      else ui.click(click(f, s.id, 'start_initial'));
      await manager.idle();
      await manager.controls.drain();
      assert.equal(f.agent.inputs.length, 1);
      assert.equal(f.agent.inputs[0]!.text, task);
      assert.equal(
        f.agent.inputs[0]!.session.instructions,
        mode === 'save' ? '请只做研究，使用中文。' : undefined,
      );
      assert.equal(f.store.get(s.id)!.pendingInitialTask, undefined);
      assert.throws(() => ui.click(original));
      assert.throws(() => ui.click(click(f, s.id, 'start_initial')));
      await manager.receive(incoming('/tab begin', 'alice', s.route.thread));
      assert.equal(f.agent.inputs.length, 1);
    } finally {
      await replacement?.close();
      restored?.close();
      await f.cleanup();
    }
  });

test('pending initial task survives close and busy capacity rejection, and explicit instructions still run immediately', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('新开一个话题：写小说', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!,
      task = s.pendingInitialTask;
    f.manager.closeSession(s.id);
    await f.manager.controls.drain();
    assert.throws(() => ui.click(click(f, s.id, 'start_initial')));
    assert.equal(f.store.get(s.id)!.pendingInitialTask, task);
    f.manager.openSession(s.id);
    await f.manager.controls.drain();
    const limit = f.config.maxConcurrentRuns;
    f.config.maxConcurrentRuns = 0;
    assert.throws(() => ui.click(click(f, s.id, 'start_initial')), /并发上限/);
    assert.equal(f.store.get(s.id)!.pendingInitialTask, task);
    assert.equal(f.agent.inputs.length, 0);
    f.config.maxConcurrentRuns = limit;
    const card = f.store.card(s.id)!;
    card.draftSettings = { model: 'pending-model' };
    f.store.saveCard(card);
    assert.throws(
      () => ui.click({ ...click(f, s.id, 'save_instructions'), instructions: 'do not save yet' }),
      /模型设置/,
    );
    assert.equal(f.store.get(s.id)!.instructions, undefined);
    delete card.draftSettings;
    f.store.saveCard(card);
    ui.click(click(f, s.id, 'start_initial'));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('initialization form saves configured workspace and instructions separately, then starts in that directory', async () => {
  const { mkdirSync } = await import('node:fs'),
    { join } = await import('node:path');
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    const project = join(f.dir, 'second project');
    mkdirSync(project);
    f.config.workspaces.project = project;
    await f.manager.receive(incoming('新开一个话题：处理此项目', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!,
      task = s.pendingInitialTask!;
    const req = click(f, s.id, 'save_instructions');
    const raw = {
      operator: { open_id: 'alice' },
      context: { open_message_id: req.messageId, open_chat_id: req.conversation },
      action: {
        value: { kind: 'session', id: req.id, revision: req.revision, action: req.action },
        form_value: { session_workspace: 'project', session_instructions: '请用中文回复。' },
      },
    };
    assert.equal(larkSessionAction(raw, ui.click).toast.type, 'success');
    await f.manager.idle();
    await f.manager.controls.drain();
    assert.equal(f.agent.inputs[0]!.session.workspace, project);
    assert.equal(f.agent.inputs[0]!.session.instructions, '请用中文回复。');
    assert.equal(f.agent.inputs[0]!.text, task);
    assert.deepEqual(
      f.store
        .events(s.id)
        .filter((e) => e.type === 'user')
        .map((e) => e.text),
      [task],
    );
    assert.equal(f.store.get(s.id)!.workspace, project);
    assert.equal(f.config.workspaces.default, f.dir);
    assert.throws(
      () =>
        ui.click({
          ...click(f, s.id, 'save_instructions'),
          workspace: 'default',
          instructions: 'new',
        }),
      /首次任务/,
    );
    const restored = new Store(f.config.dataDir);
    try {
      assert.equal(restored.get(s.id)!.workspace, project);
    } finally {
      restored.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('initialization shows the inherited main directory and unchanged form submission starts there despite other defaults', async () => {
  const { mkdirSync, realpathSync } = await import('node:fs'),
    { join } = await import('node:path');
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    const inherited = join(f.dir, 'main project'),
      botDefault = join(f.dir, 'bot default');
    mkdirSync(inherited);
    mkdirSync(botDefault);
    f.config.channels[0]!.defaultWorkspace = botDefault;
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', realpathSync(inherited));
    await f.manager.receive(incoming('新开一个话题：分析项目', 'alice', ''));
    await f.manager.controls.drain();
    const child = f.store.list().find((s) => s.route.thread)!;
    const form = (
      larkSessionCard(f.manager.controls.snapshot(f.store.card(child.id)!)).body.elements as any[]
    ).find((e) => e.tag === 'form');
    const workspace = form.elements.find((e: any) => e.name === 'session_workspace_path');
    assert.equal(workspace.default_value, realpathSync(inherited));
    assert.equal(workspace.input_type, 'multiline_text');
    assert.equal(workspace.rows, 3);
    assert.ok(!form.elements.some((e: any) => e.name === 'session_workspace'));
    // Later changes to the main session must not replace this child's saved directory.
    main.workspace = botDefault;
    f.store.save(main);
    const req = click(f, child.id, 'save_instructions');
    const result = larkSessionAction(
      {
        operator: { open_id: 'alice' },
        context: { open_message_id: req.messageId, open_chat_id: req.conversation },
        action: {
          value: { kind: 'session', id: req.id, revision: req.revision, action: req.action },
          form_value: { session_workspace_path: workspace.default_value },
        },
      },
      ui.click,
    );
    assert.equal(result.toast.type, 'success');
    await f.manager.idle();
    await f.manager.controls.drain();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.agent.inputs[0]!.session.workspace, realpathSync(inherited));
    assert.equal(f.store.get(child.id)!.workspace, realpathSync(inherited));
    assert.equal(f.store.get(main.id)!.workspace, botDefault);
    assert.equal(f.config.workspaces.default, f.dir);
  } finally {
    await f.cleanup();
  }
});

test('initialization does not truncate saved directories longer than the input limit', async () => {
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('/tab new', 'alice', ''));
    await f.manager.controls.drain();
    const session = f.store.list()[0]!,
      workspace = '/' + 'project/'.repeat(130);
    session.workspace = workspace;
    f.store.save(session);
    const card = larkSessionCard(f.manager.controls.snapshot(f.store.card(session.id)!));
    const form = (card.body.elements as any[]).find((e) => e.tag === 'form');
    assert.equal(
      form.elements.find((e: any) => e.name === 'session_workspace_path').default_value,
      '',
    );
    assert.ok(JSON.stringify(card).includes(workspace));
    ui.click({ ...click(f, session.id, 'save_initial'), workspacePath: '' });
    await f.manager.controls.drain();
    assert.equal(f.store.get(session.id)!.workspace, workspace);
  } finally {
    await f.cleanup();
  }
});

test('workspace selection rejects unconfigured, deleted, changed paths and clears old directory model settings only on success', async () => {
  const { mkdirSync, rmSync, symlinkSync } = await import('node:fs'),
    { join } = await import('node:path');
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    const project = join(f.dir, 'project'),
      removed = join(f.dir, 'removed'),
      link = join(f.dir, 'link');
    mkdirSync(project);
    mkdirSync(removed);
    symlinkSync(project, link);
    Object.assign(f.config.workspaces, { project, removed, link });
    rmSync(removed, { recursive: true });
    await f.manager.receive(incoming('/tab init codex --instructions Original', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!;
    for (const workspace of ['unknown', '../project', '__proto__', project, 'removed', 'link']) {
      assert.throws(() =>
        ui.click({
          ...click(f, s.id, 'save_instructions'),
          workspace,
          instructions: 'must not persist',
        }),
      );
      assert.equal(f.store.get(s.id)!.workspace, f.dir);
      assert.equal(f.store.get(s.id)!.instructions, 'Original');
    }
    const saved = f.store.get(s.id)!;
    saved.settings = { model: 'old-project-model' };
    saved.settingsRevision = 2;
    f.store.save(saved);
    ui.click({
      ...click(f, s.id, 'save_instructions'),
      workspace: 'project',
      instructions: 'Project role',
    });
    await f.manager.controls.drain();
    assert.equal(f.store.get(s.id)!.workspace, project);
    assert.equal(f.store.get(s.id)!.settings, undefined);
    assert.equal(f.store.get(s.id)!.settingsRevision, 3);
    assert.equal(f.manager.settings.snapshot(s.id).state, 'unloaded');
    assert.equal(f.agent.inputs.length, 0);
    assert.deepEqual(f.store.events(s.id), []);
    const current = f.store.get(s.id)!;
    current.instructions = '长'.repeat(1001);
    f.store.save(current);
    ui.click({ ...click(f, s.id, 'save_instructions'), workspace: 'default' });
    await f.manager.controls.drain();
    assert.equal(f.store.get(s.id)!.workspace, f.dir);
    assert.equal(f.store.get(s.id)!.instructions, current.instructions);
  } finally {
    await f.cleanup();
  }
});

test('explicit natural instructions also wait for directory choice on a card-capable channel', async () => {
  const f = fixture({
      async classify() {
        return {
          action: 'new_topic',
          workspace: null,
          agent: 'codex',
          instructions: '角色说明',
          task: '首个任务',
        };
      },
    }),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(
      incoming('新开话题用 codex，系统提示词：角色说明，执行首个任务', 'alice', ''),
    );
    await f.manager.controls.drain();
    const s = f.store.list()[0]!;
    assert.equal(s.instructions, '角色说明');
    assert.equal(s.pendingInitialTask, '首个任务');
    assert.equal(f.agent.inputs.length, 0);
    ui.click(click(f, s.id, 'start_initial'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.session.instructions, '角色说明');
    assert.equal(f.agent.inputs[0]!.session.workspace, f.dir);
  } finally {
    await f.cleanup();
  }
});

test('save initialization only changes directory without consuming the pending task, allowing model selection next', async () => {
  const { mkdirSync } = await import('node:fs'),
    { join } = await import('node:path');
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    const dir = join(f.dir, 'selected');
    mkdirSync(dir);
    f.config.workspaces.selected = dir;
    await f.manager.receive(incoming('新开一个话题：待执行任务', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!;
    ui.click({
      ...click(f, s.id, 'save_initial'),
      workspace: 'selected',
      instructions: '保持此角色',
    });
    await f.manager.controls.drain();
    assert.equal(f.store.get(s.id)!.workspace, dir);
    assert.equal(f.store.get(s.id)!.pendingInitialTask, s.pendingInitialTask);
    assert.equal(f.agent.inputs.length, 0);
    ui.click(click(f, s.id, 'start_initial'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.session.workspace, dir);
    assert.equal(f.agent.inputs[0]!.session.instructions, '保持此角色');
  } finally {
    await f.cleanup();
  }
});

for (const agent of ['codex', 'claude', 'opencode'] as const)
  test(`${agent} initialization accepts a custom directory outside presets and preserves it until start`, async () => {
    const { mkdirSync, realpathSync } = await import('node:fs');
    const { join } = await import('node:path');
    const f = fixture(),
      ui = controls(f.channel);
    f.manager.registerChannel(f.channel);
    try {
      const custom = join(f.dir, '自定义 project');
      mkdirSync(custom);
      await f.manager.receive(incoming(`/tab new ${agent}`, 'alice', ''));
      await f.manager.controls.drain();
      const s = f.store.list()[0]!;
      const req = click(f, s.id, 'save_initial');
      const raw = {
        operator: { open_id: 'alice' },
        context: { open_message_id: req.messageId, open_chat_id: req.conversation },
        action: {
          value: { kind: 'session', id: req.id, revision: req.revision, action: req.action },
          form_value: {
            session_workspace: 'default',
            session_workspace_path: custom,
            session_instructions: '自定义角色',
          },
        },
      };
      assert.equal(larkSessionAction(raw, ui.click).toast.type, 'success');
      await f.manager.controls.drain();
      assert.equal(f.store.get(s.id)!.workspace, realpathSync(custom));
      assert.equal(f.agent.inputs.length, 0);
      assert.deepEqual(Object.keys(f.config.workspaces), ['default']);
      const form = (larkSessionCard(ui.updates.at(-1)!).body.elements as any[]).find(
        (e) => e.tag === 'form',
      );
      assert.equal(
        form.elements.find((e: any) => e.name === 'session_workspace_path').default_value,
        realpathSync(custom),
      );
      assert.ok(!form.elements.some((e: any) => e.name === 'session_workspace'));
      // Saving again with blank custom input must not reset the custom path to default.
      ui.click({
        ...click(f, s.id, 'save_initial'),
        workspacePath: '',
        instructions: '自定义角色',
      });
      await f.manager.controls.drain();
      assert.equal(f.store.get(s.id)!.workspace, realpathSync(custom));
      await f.manager.receive(incoming('开始工作', 'alice', s.route.thread));
      await f.manager.idle();
      assert.equal(f.agent.inputs[0]!.session.workspace, realpathSync(custom));
      assert.equal(f.agent.inputs[0]!.text, '开始工作');
      assert.equal(f.agent.inputs[0]!.session.instructions, '自定义角色');
      assert.throws(
        () =>
          ui.click({ ...click(f, s.id, 'save_initial'), workspacePath: f.dir, instructions: '' }),
        /首次任务/,
      );
    } finally {
      await f.cleanup();
    }
  });

test('custom workspace validates before any mutation and retains owner and revision checks', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('/tab new', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!;
    const file = join(f.dir, 'a-file');
    writeFileSync(file, 'content');
    const before = f.store.get(s.id)!;
    for (const workspacePath of [
      'relative/path',
      join(f.dir, 'missing'),
      file,
      f.dir + '\ninvalid',
    ]) {
      assert.throws(
        () =>
          ui.click({
            ...click(f, s.id, 'save_initial'),
            workspacePath,
            instructions: 'do not save',
          }),
        /目录|路径/,
      );
      assert.deepEqual(f.store.get(s.id), before);
    }
    assert.throws(
      () =>
        ui.click({
          ...click(f, s.id, 'save_initial'),
          sender: 'bob',
          workspacePath: f.dir,
          instructions: '',
        }),
      /无权|不属于/,
    );
    assert.throws(
      () =>
        ui.click({
          ...click(f, s.id, 'save_initial'),
          revision: -1,
          workspacePath: f.dir,
          instructions: '',
        }),
      /已更新/,
    );
    assert.deepEqual(f.store.get(s.id), before);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('custom workspace expands home paths and resolves symbolic links', async () => {
  const { symlinkSync, realpathSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('/tab new', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!;
    ui.click({ ...click(f, s.id, 'save_initial'), workspacePath: '~/', instructions: '' });
    await f.manager.controls.drain();
    assert.equal(f.store.get(s.id)!.workspace, realpathSync(homedir()));
    const link = join(f.dir, 'linked');
    symlinkSync(f.dir, link);
    ui.click({ ...click(f, s.id, 'save_initial'), workspacePath: link, instructions: '' });
    await f.manager.controls.drain();
    assert.equal(f.store.get(s.id)!.workspace, realpathSync(f.dir));
  } finally {
    await f.cleanup();
  }
});

test('blank optional Lark form fields keep the saved custom workspace and missing instructions, then start once', async () => {
  const { mkdirSync, realpathSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = fixture(),
    ui = controls(f.channel);
  f.manager.registerChannel(f.channel);
  try {
    await f.manager.receive(incoming('/tab new', 'alice', ''));
    await f.manager.controls.drain();
    const s = f.store.list()[0]!;
    const dir = join(f.dir, 'custom');
    mkdirSync(dir);
    s.workspace = realpathSync(dir);
    s.instructions = '保留角色';
    s.pendingInitialTask = '原始任务';
    f.store.save(s);
    for (const empty of ['', null, undefined]) {
      const req = click(f, s.id, 'save_initial');
      const result = larkSessionAction(
        {
          operator: { open_id: 'alice' },
          context: { open_message_id: req.messageId, open_chat_id: req.conversation },
          action: {
            value: { kind: 'session', id: req.id, revision: req.revision, action: req.action },
            form_value: { session_workspace: empty, session_workspace_path: empty },
          },
        },
        ui.click,
      );
      assert.equal(result.toast.type, 'success');
      await f.manager.controls.drain();
      assert.equal(f.store.get(s.id)!.workspace, realpathSync(dir));
      assert.equal(f.store.get(s.id)!.instructions, '保留角色');
      assert.equal(f.agent.inputs.length, 0);
    }
    const req = click(f, s.id, 'save_instructions');
    const result = larkSessionAction(
      {
        operator: { open_id: 'alice' },
        context: { open_message_id: req.messageId, open_chat_id: req.conversation },
        action: {
          value: { kind: 'session', id: req.id, revision: req.revision, action: req.action },
          form_value: { session_workspace: '', session_workspace_path: '' },
        },
      },
      ui.click,
    );
    assert.equal(result.toast.type, 'success');
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.agent.inputs[0]!.session.workspace, realpathSync(dir));
    assert.equal(f.agent.inputs[0]!.session.instructions, '保留角色');
    assert.equal(f.agent.inputs[0]!.text, '原始任务');
  } finally {
    await f.cleanup();
  }
});
