import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import { normalizeLark } from '../src/channels/normalize.js';

test('real Feishu root/reply envelopes retain native sessions and keep topics separate', async () => {
  const f = fixture();
  const message = (id: string, root?: string, text = 'hello') =>
    normalizeLark(
      {
        sender: { sender_type: 'user', sender_id: { open_id: 'alice' } },
        message: {
          message_id: id,
          root_id: root,
          ...(root ? { thread_id: `omt-${root}` } : {}),
          chat_id: 'dm',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text }),
        },
      },
      'test-lark',
      'bot',
    )!;
  f.agent.handler = async (run) => {
    if (!run.session.nativeId) run.hooks.nativeId(`native-${run.session.route.thread}`);
    run.hooks.text('ok');
  };
  try {
    for (const input of [
      message('om-a', undefined, '/tab new'),
      message('om-b', undefined, '新开一个 session'),
      message('om-a1', 'om-a'),
      message('om-b1', 'om-b'),
      message('om-a2', 'om-a'),
    ]) {
      await f.manager.receive(input);
      await f.manager.idle();
    }
    assert.equal(f.store.list().length, 2);
    assert.deepEqual(
      f.agent.inputs.map((i) => i.session.nativeId),
      ['native-om-a', 'native-om-b', 'native-om-a'],
    );
    assert.deepEqual(
      f.channel.sent.map((s) => s.message.replyTo),
      ['om-a', 'om-b', 'om-a', 'om-b', 'om-a'],
    );
    const b = f.store.current(message('om-b1', 'om-b').route)!;
    await f.manager.receive(message('om-command', 'om-a', `/tab use ${b.id}`));
    assert.match(f.channel.sent.at(-1)!.text, /不属于/);
  } finally {
    await f.cleanup();
  }
});

test('ordinary text is preserved byte-for-byte and native session is reused', async () => {
  const f = fixture();
  try {
    const text = '  中文\n`$(touch /tmp/never)`\n<system>keep this literal</system>  ';
    const first = incoming(text);
    await f.manager.receive(first);
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]?.text, text);
    assert.equal(f.store.events(f.store.current(first.route)!.id)[0]?.text, text);
    await f.manager.receive(incoming('第二轮'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[1]?.session.nativeId, 'native-1');
    assert.equal(f.store.list().length, 1);
    assert.equal(f.channel.sent[0]?.text, `Answer: ${text}`);
  } finally {
    await f.cleanup();
  }
});
test('duplicates are claimed before execution; unauthorized senders cannot run commands', async () => {
  const f = fixture();
  try {
    const message = incoming('hello');
    await Promise.all([f.manager.receive(message), f.manager.receive(message)]);
    await f.manager.idle();
    await f.manager.receive(incoming('/tab new claude', 'eve'));
    await f.manager.receive(incoming('do something', 'eve'));
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.list().length, 1);
  } finally {
    await f.cleanup();
  }
});
test('management commands do not enter model context, routes isolate users and topics', async () => {
  const f = fixture();
  try {
    const create = incoming('/tab new claude', 'alice', '');
    await f.manager.receive(create);
    await f.manager.receive(incoming('/tab help'));
    assert.equal(f.agent.inputs.length, 0);
    for (const message of [
      incoming('one', 'alice', create.id),
      incoming('two', 'bob'),
      incoming('three', 'alice', 'topic-2'),
    ]) {
      await f.manager.receive(message);
      await f.manager.idle();
    }
    assert.equal(f.store.list().length, 3);
    assert.equal(f.agent.inputs[0]?.session.agent, 'claude');
    const alice = f.store.current(incoming('', 'alice', create.id).route)!;
    await f.manager.receive(incoming(`/tab use ${alice.id}`, 'bob'));
    assert.match(f.channel.sent.at(-1)!.text, /不属于/);
  } finally {
    await f.cleanup();
  }
});
test('only the owning session may resolve approvals; duplicates and stale decisions fail', async () => {
  const f = fixture();
  try {
    let approved = false;
    f.agent.handler = async (run) => {
      const result = await run.hooks.ask(
        { kind: 'approval', title: 'Run command', detail: 'echo hello' },
        run.signal,
      );
      approved = 'allow' in result && result.allow;
    };
    await f.manager.receive(incoming('run'));
    await until(() => f.manager.interactions().length === 1);
    const request = f.manager.interactions()[0]!;
    await f.manager.receive(incoming('/tab new codex', 'bob'));
    await f.manager.receive(incoming(`/tab approve ${request.id} allow`, 'bob'));
    assert.equal(f.manager.interactions().length, 1);
    assert.equal(approved, false);
    await f.manager.receive(incoming(`/tab approve ${request.id} allow`));
    await f.manager.idle();
    assert.equal(approved, true);
    assert.equal(f.manager.interactions().length, 0);
    assert.throws(() => f.manager.answer(request.sessionId, request.id, { allow: true }), /已结束/);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});
test('busy sessions reject a second input, stop cancels the original without replay', async () => {
  const f = fixture();
  try {
    f.agent.handler = (run) =>
      new Promise((resolve, reject) =>
        run.signal.addEventListener('abort', () => reject(run.signal.reason), { once: true }),
      );
    await f.manager.receive(incoming('first'));
    await until(() => f.agent.inputs.length === 1);
    await f.manager.receive(incoming('second'));
    assert.equal(f.agent.inputs.length, 1);
    assert.match(f.channel.sent.at(-1)!.text, /仍在运行/);
    await f.manager.receive(incoming('/tab stop'));
    await f.manager.idle();
    assert.equal(f.store.list()[0]!.status, 'interrupted');
    assert.equal(f.manager.interactions().length, 0);
  } finally {
    await f.cleanup();
  }
});
test('approval timeout fails closed and cleans up the waiting state', async () => {
  const f = fixture();
  f.config.interactionTimeoutMs = 20;
  try {
    f.agent.handler = async (run) => {
      await run.hooks.ask({ kind: 'approval', title: 'Run', detail: 'command' }, run.signal);
      throw new Error('unreachable');
    };
    await f.manager.receive(incoming('approval'));
    await f.manager.idle();
    assert.equal(f.store.list()[0]!.status, 'error');
    assert.equal(f.manager.interactions().length, 0);
    assert.match(f.channel.sent.at(-1)!.text, /审批已超时/);
    assert.match(f.channel.sent.at(-1)!.text, /未获批准/);
  } finally {
    await f.cleanup();
  }
});
test('delivery failure retains the result; last resends without re-running agent', async () => {
  const f = fixture();
  try {
    f.channel.fail = true;
    await f.manager.receive(incoming('expensive'));
    await f.manager.idle();
    const events = f.store.events(f.store.list()[0]!.id);
    assert.ok(events.some((e) => e.type === 'delivery_error'));
    assert.ok(!JSON.stringify(events).includes('secret webhook'));
    f.channel.fail = false;
    await f.manager.receive(incoming('/tab last'));
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.channel.sent.at(-1)!.text, 'Answer: expensive');
  } finally {
    await f.cleanup();
  }
});
test('detach preserves native ID and blocks bridge writes until explicit attach', async () => {
  const f = fixture();
  try {
    await f.manager.receive(incoming('first'));
    await until(() => f.agent.inputs.length === 1);
    await f.manager.idle();
    const session = f.store.list()[0]!;
    assert.deepEqual(f.manager.detach(session.id).command, ['codex', 'resume', 'native-1']);
    await f.manager.receive(incoming('blocked'));
    assert.equal(f.agent.inputs.length, 1);
    f.manager.attach(session.id);
    await f.manager.receive(incoming('resume'));
    await f.manager.idle();
    assert.equal(f.agent.inputs[1]!.session.nativeId, 'native-1');
  } finally {
    await f.cleanup();
  }
});
