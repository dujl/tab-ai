import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { approvalPresentation } from '../src/agents/approval.js';
import { CardRegistry, approvalDetailParts } from '../src/channels/cards.js';
import { larkCard, larkCardAction } from '../src/channels/lark-cards.js';
import { wecomCard } from '../src/channels/wecom-cards.js';
import { dingCardData } from '../src/channels/dingtalk-cards.js';
import { WecomChannel } from '../src/channels/wecom.js';
import { LarkChannel } from '../src/channels/lark.js';
import { interactionText } from '../src/core/interactions.js';
import { incoming, fixture, until } from './helpers.js';
import type { Answer, Interaction } from '../src/core/types.js';

function request(command = 'echo hello'): Interaction {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    kind: 'approval',
    title: 'Codex 请求执行命令',
    createdAt: Date.now(),
    ...approvalPresentation(
      {
        kind: 'command',
        threadId: 'hidden-thread',
        turnId: 'hidden-turn',
        itemId: 'hidden-item',
        command,
        cwd: '/work',
        reason: '检查结果',
      },
      '/fallback',
      true,
    ),
  };
}
function prompt(r = request()) {
  return new CardRegistry().open(incoming(''), r, () => {}).cards[0]!;
}
const script = `/bin/zsh -lc "python3 -c 'import urllib.request,ssl,json
urls=[\n\\\"https://api.example.com/v1/items?category=demo\\\",\n\\\"https://api.example.com/v1/items?page=1\\\",\n\\\"https://files.example.org/v1/series?item=sample\\\"\n]
for u in urls:
 print(urllib.request.urlopen(u).read())'"`;

test('native command stays exact; summary exposes cwd, literal targets and explicit extra permissions', () => {
  const command = 'echo "<at id=all>*hi*</at>"\ncat <<\'EOF\'\n```\n$HOME && rm -rf example\nEOF';
  const result = approvalPresentation(
    {
      command,
      cwd: '/my dir/中文',
      reason: 'test',
      threadId: 'secret-id',
      commandActions: [],
      availableDecisions: ['accept'],
      additionalPermissions: { network: true, fileSystem: { write: ['/work/out'] } },
      newFutureScope: { allowed: false },
    },
    '/fallback',
    true,
  );
  assert.equal(result.approvalSections![0]!.value, command);
  assert.equal(result.approvalSections![1]!.value, '/my dir/中文');
  assert.ok(!result.detail.includes('secret-id'));
  assert.ok(!result.detail.includes('availableDecisions'));
  assert.match(result.detail, /network：true/);
  assert.match(result.detail, /\/work\/out/);
  assert.match(result.detail, /allowed：false/);
  assert.match(JSON.stringify(result.approvalSummary), /额外权限/);
  assert.match(JSON.stringify(result.approvalSummary), /newFutureScope/);
  assert.equal(result.approvalSummary!.operation, '执行复合命令或脚本');
  assert.equal(
    approvalPresentation({ command: 'ls' }, '/fallback', true).approvalSections![2]!.value,
    '/fallback',
  );
  assert.match(
    approvalPresentation({ command: null }, '/fallback', true, true).approvalSummary!.operation,
    /未提供具体命令/,
  );
});

test('nested shell Python script gets deterministic interpreter and URL facts, never an inferred safety claim', () => {
  const r = request(script),
    summary = r.approvalSummary!;
  assert.match(summary.operation, /执行 Python 内联脚本/);
  assert.equal(summary.facts.find((f) => f.label === '执行器')!.value, 'zsh → python3');
  assert.match(
    summary.facts.find((f) => f.label === '命令含网址')!.value,
    /3 处 · api.example.com、files.example.org/,
  );
  assert.match(summary.caution!, /具体操作请核对完整请求/);
  assert.equal(r.approvalSections![0]!.value, script);
  assert.ok(!JSON.stringify(summary).includes('category'));
  const deceptive = approvalPresentation(
    { command: 'curl https://safe.example; rm -rf /data' },
    '/work',
  );
  assert.equal(deceptive.approvalSummary!.operation, '执行复合命令或脚本');
  assert.doesNotMatch(JSON.stringify(deceptive.approvalSummary), /只读|安全|仅访问/);
  assert.equal(
    approvalPresentation({ command: "python3 -c 'print(1)' && rm -rf /data" }, '/work')
      .approvalSummary!.operation,
    '执行复合命令或脚本',
  );
});

test('Claude file and OpenCode native permission details retain scopes without guessing commands from glob patterns', () => {
  const file = approvalPresentation(
    { file_path: '/work/x.txt', old_string: 'a', new_string: 'b' },
    '/work',
    false,
    false,
    'Edit',
  );
  assert.equal(file.approvalSummary!.operation, '操作文件');
  assert.match(file.detail, /原内容\na/);
  assert.match(file.detail, /新内容\nb/);
  const permission = approvalPresentation(
    { permission: 'bash', patterns: ['python *', 'rm *'], metadata: { future: 'scope' } },
    '/work',
    false,
    false,
    'bash',
  );
  assert.equal(permission.approvalSummary!.operation, '调用 bash');
  assert.match(permission.detail, /python \*/);
  assert.ok(!permission.approvalSummary!.facts.some((f) => f.label === '命令预览'));
});

test('Feishu first card is compact; details callback is owner-bound, exact, and cannot approve', () => {
  const registry = new CardRegistry(),
    answers: Answer[] = [],
    r = request(script),
    batch = registry.open(incoming(''), r, (_sender, a) => answers.push(a)),
    p = batch.cards[0]!;
  p.messageId = 'om-card';
  const card = larkCard(p) as any,
    text = JSON.stringify(card);
  assert.match(text, /执行 Python 内联脚本/);
  assert.ok(!text.includes('urllib.request'));
  assert.equal(card.elements[0].text.tag, 'plain_text');
  const actions = card.elements.find((e: any) => e.tag === 'action').actions;
  assert.deepEqual(
    actions.map((a: any) => a.value.action),
    ['allow', 'deny', 'details'],
  );
  const payload = {
    operator: { open_id: 'alice' },
    context: { open_chat_id: 'chat-1', open_message_id: 'om-card' },
    action: { value: { id: p.id, action: 'details' } },
  };
  assert.equal(
    larkCardAction(registry, { ...payload, operator: { open_id: 'bob' } }).toast.type,
    'error',
  );
  assert.equal(
    larkCardAction(registry, { ...payload, context: { ...payload.context, open_chat_id: 'other' } })
      .toast.type,
    'error',
  );
  assert.equal(
    larkCardAction(registry, {
      ...payload,
      context: { ...payload.context, open_message_id: 'forwarded' },
    }).toast.type,
    'error',
  );
  const view = larkCardAction(registry, payload);
  assert.equal(view.toast.type, 'success');
  assert.equal(view.details!.prompt.request.detail, r.detail);
  assert.equal(p.status, undefined);
  assert.deepEqual(answers, []);
  assert.equal(
    registry.submit(
      p.id,
      { sender: 'alice', conversation: 'chat-1', messageId: 'om-card' },
      { action: 'deny' },
    ).ok,
    true,
  );
  assert.deepEqual(answers, [{ allow: false }]);
  assert.equal(larkCardAction(registry, payload).toast.type, 'error');
});

test('WeCom card presents operation, directory, target hosts and view-original action, without the long script', () => {
  const p = prompt(request(script)),
    card = wecomCard(p);
  assert.equal(card.quote_area, undefined);
  assert.match(card.sub_title_text!, /Python 内联脚本/);
  assert.deepEqual(
    card.button_list!.map((b) => b.key),
    ['allow', 'deny', 'details'],
  );
  assert.equal(card.source?.desc, 'tab-ai 系统');
  assert.equal(card.horizontal_content_list![0]!.value, '/work');
  assert.equal(card.horizontal_content_list![1]!.value, '/fallback');
  assert.match(JSON.stringify(card.horizontal_content_list), /api.example.com/);
  assert.ok(!JSON.stringify(card).includes('urllib.request'));
  p.status = '已拒绝本次操作';
  const closed = wecomCard(p);
  assert.equal(closed.card_type, 'text_notice');
  assert.equal(closed.button_list, undefined);
  assert.match(closed.sub_title_text!, /Python/);
});

test('long Unicode commands are on demand; details reconstruct exact original with bounded transport chunks', async () => {
  class Socket extends EventEmitter {
    sent: any[] = [];
    updated: any[] = [];
    connect() {
      this.emit('authenticated');
    }
    disconnect() {}
    async sendMessage(chat: string, body: any) {
      this.sent.push({ chat, body });
      return { errcode: 0 };
    }
    async updateTemplateCard(...args: any[]) {
      this.updated.push(args);
      return { errcode: 0 };
    }
  }
  const socket = new Socket(),
    r = request('echo ' + '中文🙂`'.repeat(600)),
    answers: Answer[] = [],
    channel = new WecomChannel(
      { type: 'wecom', id: 'test', allowedUsers: ['alice'], botIdEnv: 'ID', secretEnv: 'SECRET' },
      () => 'fixture',
    );
  Object.assign(channel, { client: socket });
  await channel.start(async () => {});
  const message = incoming('');
  message.route.platform = 'wecom';
  const delivery = await channel.sendInteraction(message, r, (_sender, a) => answers.push(a));
  assert.ok(delivery);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].body.msgtype, 'template_card');
  const id = socket.sent[0].body.template_card.task_id;
  socket.emit('event.template_card_event', {
    body: {
      from: { userid: 'alice' },
      chattype: 'group',
      chatid: 'chat-1',
      event: { eventtype: 'template_card_event', task_id: id, event_key: 'details' },
    },
  });
  await until(() => socket.updated.length === 1);
  const parts = approvalDetailParts(prompt(r), 900);
  await until(() => socket.sent.length === parts.length + 1);
  assert.equal(socket.sent.length, parts.length + 1);
  socket.sent.slice(1).forEach(({ chat, body }, i) => {
    assert.equal(chat, 'chat-1');
    assert.ok(body.markdown.content.includes(parts[i]));
    assert.ok(Buffer.byteLength(body.markdown.content) < 4096);
  });
  assert.equal(parts.map((part) => part.slice(part.indexOf('\n') + 1)).join(''), r.detail);
  assert.deepEqual(answers, []);
  assert.equal(socket.updated[0][1].card_type, 'button_interaction');
  await delivery!.close('done');
  await channel.stop();
});

test('Feishu long approval details use original topic and exact text only after the owner requests them', async () => {
  const sent: any[] = [],
    r = request('x'.repeat(7000)),
    answers: Answer[] = [],
    channel = new LarkChannel(
      {
        type: 'lark',
        id: 'test',
        allowedUsers: ['alice'],
        appIdEnv: 'ID',
        appSecretEnv: 'SECRET',
        botOpenId: 'bot',
        domain: 'feishu',
      },
      () => 'fixture',
    );
  let dispatcher: any;
  Object.assign(channel, {
    socket: {
      start: async (options: any) => {
        dispatcher = options.eventDispatcher;
      },
      getConnectionStatus: () => ({ state: 'connected' }),
      close() {},
    },
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            sent.push(args);
            return { code: 0, data: { message_id: 'om-card' } };
          },
        },
      },
    },
  });
  await channel.start(async () => {});
  const message = incoming('');
  message.route.thread = 'om_topic';
  assert.ok(await channel.sendInteraction(message, r, (_sender, a) => answers.push(a)));
  assert.equal(sent.length, 1);
  const card = JSON.parse(sent[0].data.content),
    value = card.elements
      .find((e: any) => e.tag === 'action')
      .actions.find((a: any) => a.value.action === 'details').value;
  const response = await dispatcher.invoke(
    {
      schema: '2.0',
      header: { event_type: 'card.action.trigger', event_id: 'details' },
      event: {
        operator: { open_id: 'alice' },
        context: { open_chat_id: 'chat-1', open_message_id: 'om-card' },
        action: { value },
      },
    },
    { needCheck: false },
  );
  assert.equal(response.details, undefined);
  assert.equal(response.toast.type, 'success');
  assert.deepEqual(answers, []);
  await until(() => sent.length === approvalDetailParts(prompt(r)).length + 1);
  assert.ok(sent.length > 2);
  assert.ok(sent.every((s) => s.path.message_id === 'om_topic' && s.data.reply_in_thread));
  const text = sent
    .slice(1)
    .map((s) => JSON.parse(s.data.content).text)
    .map((s) => s.slice(s.indexOf('\n') + 1))
    .join('');
  assert.equal(text, r.detail);
  await channel.stop();
});

test('compact text/DingTalk summaries provide exact-request lookup; cross-conversation inspect is rejected', async () => {
  const r = request(script),
    text = interactionText(r);
  assert.match(text, /Python 内联脚本/);
  assert.match(text, /\/tab inspect/);
  assert.ok(!text.includes('urllib.request'));
  const data = dingCardData(prompt(r));
  assert.match(data.body, /Python/);
  assert.ok(!data.body.includes('urllib.request'));
  assert.match(data.hint, new RegExp(r.id));
  assert.equal(data.detailAction, 'details');
  const f = fixture();
  f.agent.handler = async (run) => {
    await run.hooks.ask(
      { kind: 'approval', title: r.title, detail: r.detail, approvalSummary: r.approvalSummary },
      run.signal,
    );
  };
  try {
    await f.manager.receive(incoming('start'));
    await until(() => f.manager.interactions().length === 1);
    const pending = f.manager.interactions()[0]!;
    await f.manager.receive(incoming(`/tab inspect ${pending.id}`));
    assert.ok(f.channel.sent.at(-1)!.text.includes(script));
    assert.equal(f.manager.interactions().length, 1);
    const other = incoming(`/tab inspect ${pending.id}`);
    other.route.conversation = 'other';
    await f.manager.receive(other);
    assert.ok(!f.channel.sent.at(-1)!.text.includes(script));
    await f.manager.receive(incoming(`/tab approve ${pending.id} deny`));
    await f.manager.idle();
  } finally {
    await f.cleanup();
  }
});

test('view-original on expired requests and question cards neither discloses details nor settles answers', () => {
  const registry = new CardRegistry();
  let calls = 0;
  for (const r of [
    { ...request(), expiresAt: Date.now() - 1 },
    { ...request(), kind: 'question' as const, questions: [{ id: 'q', question: 'Choose' }] },
  ]) {
    const batch = registry.open(incoming(''), r, () => calls++),
      p = batch.cards[0]!;
    const result = registry.submit(
      p.id,
      { sender: 'alice', conversation: 'chat-1' },
      { action: 'details' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.details, undefined);
    assert.equal(calls, 0);
    batch.close('done');
  }
});

test('Feishu acknowledges a view-original callback before slow transport completes, without submitting approval', async () => {
  const sent: any[] = [],
    r = request(script),
    answers: Answer[] = [],
    channel = new LarkChannel(
      {
        type: 'lark',
        id: 'test',
        allowedUsers: ['alice'],
        appIdEnv: 'ID',
        appSecretEnv: 'SECRET',
        botOpenId: 'bot',
        domain: 'feishu',
      },
      () => 'fixture',
    );
  let dispatcher: any, release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.assign(channel, {
    socket: {
      start: async (options: any) => {
        dispatcher = options.eventDispatcher;
      },
      getConnectionStatus: () => ({ state: 'connected' }),
      close() {},
    },
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            sent.push(args);
            if (args.data.msg_type === 'text') await gate;
            return { code: 0, data: { message_id: 'om-card' } };
          },
        },
      },
    },
  });
  await channel.start(async () => {});
  const message = incoming('');
  message.route.thread = 'om_topic';
  await channel.sendInteraction(message, r, (_sender, a) => answers.push(a));
  const card = JSON.parse(sent[0].data.content),
    value = card.elements
      .find((e: any) => e.tag === 'action')
      .actions.find((a: any) => a.value.action === 'details').value;
  const callback = dispatcher.invoke(
    {
      schema: '2.0',
      header: { event_type: 'card.action.trigger', event_id: 'slow' },
      event: {
        operator: { open_id: 'alice' },
        context: { open_chat_id: 'chat-1', open_message_id: 'om-card' },
        action: { value },
      },
    },
    { needCheck: false },
  );
  const result = await Promise.race([
    callback,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Card callback waited for detail transport')), 100),
    ),
  ]);
  assert.equal(result.toast.type, 'success');
  assert.deepEqual(answers, []);
  await until(() => sent.length === 2);
  release();
  await channel.stop();
});

test('background detail delivery deduplicates clicks, serializes a topic and stops after unknown send timeout', async () => {
  const { ApprovalDetailsDelivery } = await import('../src/channels/approval-details.js');
  const sent: string[] = [],
    errors: string[] = [],
    p = prompt(request('x'.repeat(6500)));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = new ApprovalDetailsDelivery(
    'test',
    async (_message, text) => {
      sent.push(text);
      if (sent.length === 1) await gate;
    },
    2400,
    10,
  );
  const oldError = console.error;
  console.error = (value: any) => errors.push(String(value));
  try {
    assert.equal(delivery.enqueue({ message: incoming(''), prompt: p }), true);
    assert.equal(delivery.enqueue({ message: incoming(''), prompt: p }), true);
    await until(() => sent.length === 2);
    assert.equal(sent.length, 2);
    assert.match(sent[1]!, /未确认投递成功/);
    assert.match(errors[0]!, new RegExp(p.request.id));
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 2);
    delivery.stop();
    assert.equal(delivery.enqueue({ message: incoming(''), prompt: prompt() }), false);
  } finally {
    console.error = oldError;
    delivery.stop();
    release();
  }
});

test('DingTalk view-original callbacks retain native approval and provide exact raw details to their own space', () => {
  const registry = new CardRegistry(),
    answers: Answer[] = [],
    r = request(script),
    batch = registry.open(incoming(''), r, (_sender, a) => answers.push(a)),
    p = batch.cards[0]!;
  const targets = new Map([
    [p.id, { conversation: 'chat-1', spaceId: 'alice', spaceType: 'IM_ROBOT' }],
  ]);
  const payload = {
    outTrackId: p.id,
    userId: 'alice',
    userIdType: 1,
    spaceId: 'alice',
    spaceType: 'IM_ROBOT',
    content: JSON.stringify({ cardPrivateData: { params: { action: 'details' } } }),
  };
  return import('../src/channels/dingtalk-cards.js').then(({ dingCardAction }) => {
    const wrong = dingCardAction(registry, { ...payload, userId: 'bob' }, targets);
    assert.equal(wrong.details, undefined);
    const result = dingCardAction(registry, payload, targets);
    assert.equal(result.details!.prompt.request.detail, r.detail);
    assert.equal(result.details!.message.route.conversation, 'chat-1');
    assert.deepEqual(answers, []);
    assert.equal(p.status, undefined);
  });
});

test('inspect shows durable approval details after settlement without a generic menu or repeated decisions', async () => {
  const f = fixture(),
    views: import('../src/core/types.js').ManagementView[] = [];
  Object.assign(f.channel, {
    async sendManagement(_message: unknown, view: import('../src/core/types.js').ManagementView) {
      views.push(view);
    },
  });
  f.agent.handler = async (run) => {
    await run.hooks.ask(
      { kind: 'approval', title: 'Inspect regression', detail: script },
      run.signal,
    );
  };
  try {
    await f.manager.receive(incoming('start'));
    await until(() => f.manager.interactions().length === 1);
    const pending = f.manager.interactions()[0]!;
    await f.manager.receive(incoming(`/tab inspect ${pending.id}`));
    assert.match(views.at(-1)!.text, /状态：等待处理/);
    assert.equal(views.at(-1)!.action, 'inspect');
    assert.equal(views.at(-1)!.information, undefined);
    assert.deepEqual(views.at(-1)!.buttons, []);
    assert.equal(f.manager.interactions().length, 1);
    await f.manager.receive(incoming(`/tab approve ${pending.id} allow`));
    await f.manager.idle();
    for (let n = 0; n < 1100; n++) f.store.event(pending.sessionId, 'activity', 'filler');
    const count = () => f.store.interactionHistory(pending.sessionId, pending.id).length;
    const before = count();
    await f.manager.receive(incoming(`/tab inspect ${pending.id}`));
    const view = views.at(-1)!;
    assert.match(view.title, /请求详情/);
    assert.ok(view.text.includes(script));
    assert.match(view.text, /状态：已允许/);
    assert.match(view.text, /授权范围：仅本次/);
    assert.match(view.text, /不代表工具已经执行成功/);
    assert.equal(view.information, undefined);
    assert.deepEqual(view.buttons, []);
    assert.equal(count(), before);
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.manager.interactions().length, 0);
    const other = incoming(`/tab inspect ${pending.id}`, 'alice', 'other-topic');
    f.store.create(other.route, 'codex', f.dir);
    await f.manager.receive(other);
    assert.match(views.at(-1)!.text, /未找到此请求/);
    assert.ok(!views.at(-1)!.text.includes(script));
    assert.deepEqual(views.at(-1)!.buttons, []);
    await f.manager.receive(incoming('/tab inspect'));
    assert.match(views.at(-1)!.text, /用法/);
    assert.deepEqual(views.at(-1)!.buttons, []);
  } finally {
    await f.cleanup();
  }
});

test('inspect distinguishes archived timeout, denial and unknown outcome without reviving requests', async () => {
  const f = fixture();
  try {
    const session = f.store.create(incoming('').route, 'codex', f.dir);
    for (const [status, label] of [
      ['timed_out', '已超时，未批准'],
      ['denied', '已拒绝'],
      ['cancelled', '已取消'],
      ['ended_unknown', '已结束，结果未记录'],
    ]) {
      const r = { ...request('unique archived command'), sessionId: session.id };
      f.store.event(session.id, 'interaction', JSON.stringify(r));
      if (status !== 'ended_unknown')
        f.store.event(session.id, 'interaction_closed', JSON.stringify({ id: r.id, status }));
      await f.manager.receive(incoming(`/tab inspect ${r.id}`));
      const text = f.channel.sent.at(-1)!.text;
      assert.ok(text.includes(label!));
      assert.ok(text.includes(r.detail));
      assert.equal(f.manager.interactions().length, 0);
    }
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('inspect permits a parent to read descendant history but does not disclose parent or sibling requests to children', async () => {
  const f = fixture();
  try {
    const parent = f.store.create(incoming('', 'alice', 'parent').route, 'codex', f.dir);
    const child = f.store.create(incoming('', 'alice', 'child').route, 'codex', f.dir);
    const sibling = f.store.create(incoming('', 'alice', 'sibling').route, 'codex', f.dir);
    for (const session of [parent, child, sibling]) {
      session.taskId = randomUUID();
      f.store.save(session);
    }
    for (const session of [parent, child, sibling]) {
      f.store.saveTask({
        id: session.taskId!,
        rootId: parent.taskId!,
        ...(session === parent ? {} : { parentId: parent.taskId! }),
        sessionId: session.id,
        route: session.route,
        key: randomUUID(),
        title: 'task',
        objective: 'inspect scope',
        criteria: 'test',
        context: '',
        agent: 'codex',
        workspace: f.dir,
        dependencies: [],
        state: 'paused',
        revision: 0,
        autoTurns: 0,
        executionMode: 'interactive',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    const records = [parent, child, sibling].map((session) => {
      const r = { ...request(`private ${session.id}`), sessionId: session.id };
      f.store.event(session.id, 'interaction', JSON.stringify(r));
      f.store.event(
        session.id,
        'interaction_closed',
        JSON.stringify({ id: r.id, status: 'denied' }),
      );
      return r;
    });
    await f.manager.receive(incoming(`/tab inspect ${records[1]!.id}`, 'alice', 'parent'));
    assert.ok(f.channel.sent.at(-1)!.text.includes(records[1]!.detail));
    for (const record of [records[0]!, records[2]!]) {
      await f.manager.receive(incoming(`/tab inspect ${record.id}`, 'alice', 'child'));
      assert.match(f.channel.sent.at(-1)!.text, /未找到此请求/);
      assert.ok(!f.channel.sent.at(-1)!.text.includes(record.detail));
    }
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('approval distinguishes native execution cwd from session default across channel renderers without rewriting the request', () => {
  const params = { command: 'git status --short', cwd: '/work/worktree', reason: 'Check worktree' };
  const before = structuredClone(params);
  const r = {
    ...request(),
    ...approvalPresentation(params, '/work/main', true),
    approvalContext: { label: '按需审批', description: 'test' },
  };
  assert.deepEqual(params, before);
  assert.equal(r.approvalSections!.find((s) => s.label === '本次执行目录')!.value, params.cwd);
  assert.equal(r.approvalSections!.find((s) => s.label === '会话默认目录')!.value, '/work/main');
  assert.equal(r.approvalSections!.find((s) => s.label === '执行命令')!.value, params.command);
  assert.match(r.approvalSummary!.caution!, /不会修改会话设置/);
  for (const text of [
    JSON.stringify(larkCard(prompt(r))),
    dingCardData(prompt(r)).body,
    interactionText(r),
  ]) {
    assert.ok(text.includes('/work/main'));
    assert.ok(text.includes('/work/worktree'));
    assert.ok(text.includes('本次执行目录'));
    assert.ok(text.includes('会话默认目录'));
  }
  const card = wecomCard(prompt(r));
  assert.deepEqual(card.horizontal_content_list!.slice(0, 2), [
    { keyname: '执行目录', value: '/work/worktree' },
    { keyname: '会话目录', value: '/work/main' },
  ]);
  assert.ok(card.horizontal_content_list!.length <= 6);
  assert.deepEqual(
    card.button_list!.map((b) => b.key),
    ['allow', 'deny', 'details'],
  );
});

test('missing native cwd stays unknown and does not present the session default as verified execution cwd', () => {
  for (const params of [{ command: 'pwd' }, { command: 'pwd', cwd: '' }]) {
    const p = approvalPresentation(params, '/work/default', true);
    assert.equal(
      p.approvalSections!.find((s) => s.label === '本次执行目录')!.value,
      '原生未单独提供',
    );
    assert.equal(
      p.approvalSections!.find((s) => s.label === '会话默认目录')!.value,
      '/work/default',
    );
    assert.match(p.approvalSummary!.caution!, /不能据此确认/);
  }
});

test('canonical aliases display their original paths without claiming that execution changed directories', async () => {
  const f = fixture();
  try {
    const alias = join(f.dir, 'workspace-alias');
    symlinkSync(f.dir, alias, 'dir');
    const p = approvalPresentation({ command: 'pwd', cwd: alias }, f.dir, true);
    assert.equal(p.approvalSections!.find((s) => s.label === '本次执行目录')!.value, alias);
    assert.equal(p.approvalSections!.find((s) => s.label === '会话默认目录')!.value, f.dir);
    assert.equal(p.approvalSummary!.caution, undefined);
  } finally {
    await f.cleanup();
  }
});
