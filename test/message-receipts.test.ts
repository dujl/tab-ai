import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LarkChannel } from '../src/channels/lark.js';
import type { Channel, Incoming } from '../src/core/types.js';
import { fixture, incoming, until } from './helpers.js';

const message = (thread = '', text = 'hello'): Incoming => ({
  ...incoming(text, 'alice', thread),
  id: `om_${randomUUID()}`,
  direct: !thread,
});

test('accepted DM, group and topic input gets one original-message receipt without waiting for its delivery', async () => {
  const f = fixture(),
    received: Incoming[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  (f.channel as Channel).acknowledgeMessage = async (m) => {
    received.push(m);
    await pending;
  };
  try {
    const dm = message();
    await Promise.all([f.manager.receive(dm), f.manager.receive(dm)]);
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    const group = {
      ...message('', '/tab status'),
      direct: false,
      groupMessage: { mentioned: true },
    };
    const topic = {
      ...message('om_topic', '/tab help'),
      direct: false,
      groupMessage: { mentioned: true },
    };
    await f.manager.receive(group);
    await f.manager.receive(topic);
    assert.deepEqual(
      received.map((m) => m.id),
      [dm.id, group.id, topic.id],
    );
    assert.equal(received[2]!.route.thread, 'om_topic');
  } finally {
    release();
    await f.cleanup();
  }
});

test('passive, unauthorized and unknown-topic attachment messages do not claim receipt', async () => {
  const f = fixture(),
    received: Incoming[] = [];
  (f.channel as Channel).acknowledgeMessage = async (m) => {
    received.push(m);
  };
  const config = f.config.channels[0]!;
  if (config.type === 'lark') config.groupModes = { 'chat-1': 'context' };
  try {
    const passive = { ...message(), direct: false, groupMessage: { mentioned: false } };
    await f.manager.receive(passive);
    await f.manager.receive({
      ...passive,
      id: `om_${randomUUID()}`,
      route: { ...passive.route, sender: 'stranger' },
    });
    const upload = {
      ...message('om_attachment'),
      text: '',
      requiresExistingSession: true,
      attachments: [{ key: 'image_key', name: 'image', type: 'image' as const }],
    };
    await f.manager.receive(upload);
    assert.equal(received.length, 0);
    if (config.type === 'lark') config.groupModes = { 'chat-1': 'auto' };
    await f.manager.receive({ ...passive, id: `om_${randomUUID()}`, text: '/tab status' });
    assert.equal(received.length, 1);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('a failed receipt cannot block normal input or expose raw transport errors', async () => {
  const f = fixture(),
    errors: unknown[][] = [],
    log = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  (f.channel as Channel).acknowledgeMessage = async () => {
    throw Error('secret transport credential');
  };
  try {
    await f.manager.receive(message());
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.match(JSON.stringify(errors), /message receipt failed/);
    assert.doesNotMatch(JSON.stringify(errors), /secret transport credential/);
  } finally {
    console.error = log;
    await f.cleanup();
  }
});

test('Lark receipts use the original message, native Get emoji and bounded requests; stop prevents new sends', async () => {
  const f = fixture(),
    channel = new LarkChannel(f.config.channels[0] as any, () => 'credential', f.config.dataDir),
    sent: any[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  (channel as any).client = {
    im: {
      messageReaction: {
        create: async (request: any) => {
          sent.push(request);
          await pending;
          return { code: 0 };
        },
      },
    },
  };
  try {
    const jobs = Array.from({ length: 10 }, () => channel.acknowledgeMessage(message('om_root')));
    assert.equal(sent.length, 8);
    assert.ok(sent.every((r) => r.path.message_id !== 'om_root'));
    assert.ok(sent.every((r) => r.data.reaction_type.emoji_type === 'Get'));
    await channel.acknowledgeMessage({
      ...message(),
      route: { ...message().route, account: 'other-bot' },
    });
    await channel.stop();
    release();
    await Promise.all(jobs);
    await channel.acknowledgeMessage(message());
    assert.equal(sent.length, 8);
  } finally {
    release();
    await channel.stop();
    await f.cleanup();
  }
});

test('Lark rejects and uncertain receipt failures are not retried and warn without leaking credentials', async () => {
  const f = fixture(),
    channel = new LarkChannel(f.config.channels[0] as any, () => 'credential', f.config.dataDir),
    errors: unknown[][] = [],
    log = console.error;
  let calls = 0;
  console.error = (...args) => {
    errors.push(args);
  };
  (channel as any).client = {
    im: {
      messageReaction: {
        create: async () => {
          if (++calls === 1) return { code: 99991672 };
          throw Error('secret signed transport payload');
        },
      },
    },
  };
  try {
    await channel.acknowledgeMessage(message());
    await channel.acknowledgeMessage(message());
    await until(() => calls === 2);
    assert.equal(errors.length, 1);
    assert.match(JSON.stringify(errors), /im:message.reactions:write_only/);
    assert.doesNotMatch(JSON.stringify(errors), /secret signed transport payload/);
  } finally {
    console.error = log;
    await channel.stop();
    await f.cleanup();
  }
});
