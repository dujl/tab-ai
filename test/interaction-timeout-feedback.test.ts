import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../src/agents/codex.js';
import { LarkChannel } from '../src/channels/lark.js';
import { WecomChannel } from '../src/channels/wecom.js';
import { fixture, incoming, until } from './helpers.js';
import type { InteractionDelivery } from '../src/core/types.js';

const approval = {
  kind: 'approval' as const,
  title: 'Codex 请求执行命令',
  detail: 'long-script-secret',
};

class Socket extends EventEmitter {
  sent: any[] = [];
  updated: any[] = [];
  connect() {
    this.emit('authenticated');
  }
  disconnect() {}
  async sendMessage(...args: any[]) {
    this.sent.push(args);
    return { errcode: 0 };
  }
  async updateTemplateCard(...args: any[]) {
    this.updated.push(args);
    return { errcode: 0 };
  }
}

test('WeCom approval timeout proactively notifies the original group without waiting for another click', async () => {
  const f = fixture();
  f.config.interactionTimeoutMs = 35;
  f.config.channels = [
    {
      type: 'wecom',
      id: 'test-lark',
      allowedUsers: ['alice'],
      botIdEnv: 'ID',
      secretEnv: 'SECRET',
    },
  ];
  const channel = new WecomChannel(f.config.channels[0], () => 'fixture'),
    socket = new Socket();
  Object.assign(channel, { client: socket });
  await channel.start(async () => {});
  Object.assign(f.channel, { sendInteraction: channel.sendInteraction.bind(channel) });
  let approved = false;
  f.agent.handler = async (run) => {
    await run.hooks.ask(approval, run.signal);
    approved = true;
  };
  try {
    const message = incoming('original', 'alice', '');
    message.route.platform = 'wecom';
    message.route.conversation = 'original-group';
    await f.manager.receive(message);
    await until(() => socket.sent.length === 1);
    await f.manager.idle();
    await until(() => f.channel.sent.some((m) => m.text.includes('审批已超时')));
    const notices = f.channel.sent.filter((m) => m.text.includes('审批已超时'));
    assert.equal(notices.length, 1);
    assert.equal(f.channel.sent.length, 1);
    assert.equal(notices[0]!.message.route.conversation, 'original-group');
    assert.match(notices[0]!.text, /未获批准/);
    assert.match(notices[0]!.text, /旧卡片已失效/);
    assert.ok(!notices[0]!.text.includes('long-script-secret'));
    assert.equal(approved, false);
    assert.equal(f.manager.interactions().length, 0);
    assert.equal(socket.updated.length, 0);
    const task = socket.sent[0][1].template_card.task_id;
    socket.emit('event.template_card_event', {
      headers: { req_id: 'late' },
      body: {
        from: { userid: 'alice' },
        chattype: 'group',
        chatid: 'original-group',
        event: { eventtype: 'template_card_event', task_id: task, event_key: 'allow' },
      },
    });
    await until(() => socket.updated.length === 1);
    assert.equal(approved, false);
  } finally {
    await f.cleanup();
    await channel.stop();
  }
});

for (const rejectPatch of [false, true])
  test(`Feishu timeout updates the card and sends one notice even if patch fails=${rejectPatch}`, async () => {
    const f = fixture();
    f.config.interactionTimeoutMs = 35;
    const channel = new LarkChannel(f.config.channels[0] as any, () => 'fixture'),
      patches: any[] = [];
    Object.assign(channel, {
      client: {
        im: {
          message: {
            reply: async () => ({ code: 0, data: { message_id: 'om-approval' } }),
            patch: async (args: any) => {
              patches.push(args);
              return { code: rejectPatch ? 400 : 0 };
            },
          },
        },
      },
    });
    Object.assign(f.channel, { sendInteraction: channel.sendInteraction.bind(channel) });
    f.agent.handler = async (run) => {
      await run.hooks.ask(approval, run.signal);
      throw Error('must not run');
    };
    try {
      await f.manager.receive(incoming('original', 'alice', 'om_root'));
      await f.manager.idle();
      await until(() => patches.length === 1 && f.channel.sent.length === 1);
      const card = JSON.parse(patches[0].data.content);
      assert.match(card.header.title.content, /审批已超时/);
      assert.equal(card.header.template, 'red');
      assert.ok(!card.elements.some((e: any) => e.tag === 'action' || e.tag === 'form'));
      assert.equal(f.channel.sent[0]!.message.route.thread, 'om_root');
      assert.match(f.channel.sent[0]!.text, /未获批准/);
      assert.equal(f.manager.interactions().length, 0);
    } finally {
      await f.cleanup();
      await channel.stop();
    }
  });

test('a late card delivery is invalidated after timeout while the timeout notice is sent only once', async () => {
  const f = fixture();
  f.config.interactionTimeoutMs = 35;
  let release!: (delivery: InteractionDelivery) => void;
  const closed: string[] = [];
  Object.assign(f.channel, {
    sendInteraction: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  f.agent.handler = async (run) => {
    await run.hooks.ask(approval, run.signal);
  };
  try {
    await f.manager.receive(incoming('original'));
    await until(() => !!release);
    await f.manager.idle();
    await until(() => f.channel.sent.length === 1);
    release({
      close: async (status) => {
        closed.push(status);
      },
    });
    await until(() => closed.length === 1);
    assert.match(closed[0]!, /审批已超时/);
    assert.equal(f.channel.sent.length, 1);
    assert.equal(f.manager.interactions().length, 0);
  } finally {
    await f.cleanup();
  }
});

test('async question expiry notifies without stopping the background analysis or submitting an answer', async () => {
  const f = fixture();
  f.config.interactionTimeoutMs = 35;
  Object.assign(f.agent, {
    steer: async () => {
      throw Error('must not submit');
    },
  });
  f.agent.handler = async (run) => {
    run.hooks.nativeId('same-native');
    run.hooks.askAsync!({
      kind: 'question',
      title: '补充对象',
      detail: '',
      questions: [{ id: '1', question: '选择对象', options: ['A', 'B'] }],
    });
    await new Promise<void>((_, reject) =>
      run.signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }),
    );
  };
  try {
    await f.manager.receive(incoming('original'));
    await until(() => f.channel.sent.some((m) => m.text.includes('提问已超时')));
    assert.match(f.channel.sent.at(-1)!.text, /Agent 可继续当前分析/);
    assert.equal(f.store.list()[0]!.status, 'running');
    assert.equal(f.manager.interactions().length, 0);
    assert.equal(
      f.store.events(f.store.list()[0]!.id).filter((e) => e.type === 'decision').length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test('child approval timeout notice follows the approval to the root task topic', async () => {
  const f = fixture();
  f.config.interactionTimeoutMs = 35;
  Object.assign(f.channel, { sendInteraction: async () => ({ close: async () => {} }) });
  f.agent.handler = async (run) => {
    if (f.manager.tasks.forSession(run.session.id)?.parentId)
      await run.hooks.ask(approval, run.signal);
  };
  try {
    const source = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    const root = await f.manager.createTask({
      sourceSessionId: source.id,
      key: crypto.randomUUID(),
      title: '主任务',
      objective: '目标',
      workspace: 'default',
    });
    await until(() => f.store.taskRecord(root.id)?.state === 'waiting');
    const child = await f.manager.tasks.createChild(root.sessionId!, {
      key: 'child',
      title: '子任务',
      objective: '处理',
      criteria: '完成',
      context: '',
      workspaceMode: 'shared',
      dependencies: [],
    });
    await until(() => f.channel.sent.some((m) => m.text.includes('审批已超时')));
    await f.manager.idle();
    const notices = f.channel.sent.filter((m) => m.text.includes('审批已超时'));
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.message.route.thread, root.route.thread);
    const event = f.store.events(child.sessionId!).find((e) => e.type === 'interaction_timeout')!;
    assert.equal(JSON.parse(event.text).notificationSessionId, root.sessionId);
  } finally {
    await f.cleanup();
  }
});

test('native Codex approval timeout preserves the timeout result and sends no duplicate generic error', async () => {
  const f = fixture();
  f.config.interactionTimeoutMs = 50;
  const executable = join(f.dir, 'fake-codex.mjs');
  copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  const adapter = new CodexAdapter(executable);
  f.agent.handler = (run) => adapter.run(run);
  try {
    await f.manager.receive(incoming('approval'));
    await f.manager.idle();
    await until(() => f.channel.sent.some((m) => m.text.includes('审批已超时')));
    assert.equal(f.channel.sent.filter((m) => m.text.includes('审批已超时')).length, 1);
    assert.ok(!f.channel.sent.some((m) => m.text.startsWith('tab-ai：等待确认超时')));
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.ok(!trace.some((m) => m.id === 'approval-1' && m.result));
    assert.equal(f.store.list()[0]!.status, 'error');
  } finally {
    await f.cleanup();
  }
});
