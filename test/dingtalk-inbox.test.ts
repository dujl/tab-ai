import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, INBOX_LIMITS, InboxCapacityError } from '../src/core/store.js';
import { Manager } from '../src/core/manager.js';
import { fixture, incoming, until } from './helpers.js';
import type { Incoming } from '../src/core/types.js';

function ding(text: string, sender = 'alice'): Incoming {
  const message = incoming(text, sender, '');
  return { ...message, direct: true, route: { ...message.route, platform: 'dingtalk' } };
}
function dingFixture() {
  const f = fixture();
  f.config.channels = [
    {
      id: f.channel.id,
      type: 'dingtalk',
      allowedUsers: ['alice'],
      clientIdEnv: 'ID',
      clientSecretEnv: 'SECRET',
    },
  ];
  return f;
}

test('inbox survives restart, deduplicates atomically and never replays possibly started input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ding-inbox-'));
  let store = new Store(dir);
  try {
    const pending = ding('pending original'),
      started = ding('/tab reset');
    const pendingId = store.acceptIncoming({
      ...pending,
      sessionWebhook: 'private-signed-url',
    } as Incoming)!;
    const startedId = store.acceptIncoming(started)!;
    assert.equal(store.acceptIncoming(pending), undefined);
    assert.equal(store.startIncoming(startedId), true);
    assert.equal(store.startIncoming(startedId), false);
    store.close();
    store = new Store(dir);
    const rows = store.inbox();
    assert.equal(rows.find((r) => r.id === pendingId)?.state, 'pending');
    assert.equal(rows.find((r) => r.id === startedId)?.state, 'interrupted');
    assert.doesNotMatch(JSON.stringify(rows), /private-signed-url/);
    assert.equal(store.acceptIncoming(started), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox caps unresolved rows, refuses overflow without claiming it, and retains dedup after explicit dismissal', async (t) => {
  const f = dingFixture();
  t.after(() => f.cleanup());
  t.mock.method(console, 'error', () => {});
  let firstId = '';
  for (let n = 0; n < INBOX_LIMITS.rows; n++) {
    const id = f.store.acceptIncoming(ding('retained ' + n))!;
    if (!n) {
      firstId = id;
      f.store.finishIncoming(id, true, 'interrupted');
    }
  }
  const overflow = ding('overflow');
  assert.throws(() => f.store.acceptIncoming(overflow), InboxCapacityError);
  await f.manager.receive(overflow);
  assert.match(f.channel.sent.at(-1)!.text, /本条未接收或执行/);
  const retained = f.store.inbox()[0]!.message;
  assert.equal(f.store.inbox().length, INBOX_LIMITS.rows);
  await f.manager.receive(ding('/tab inbox dismiss ' + firstId.slice(0, 8), 'bob'));
  assert.equal(f.store.inbox().length, INBOX_LIMITS.rows);
  await f.manager.receive(ding('/tab inbox dismiss ' + firstId.slice(0, 8)));
  assert.equal(f.store.inbox().length, INBOX_LIMITS.rows - 1);
  assert.equal(f.store.acceptIncoming(retained), undefined);
  assert.ok(f.store.acceptIncoming(overflow));
  assert.equal(f.agent.inputs.length, 0);
});

test('inbox enforces serialized byte and individual message limits and immediately releases completed source', async (t) => {
  const f = dingFixture();
  t.after(() => f.cleanup());
  const huge = ding('🙂'.repeat(INBOX_LIMITS.messageBytes / 4));
  assert.throws(() => f.store.acceptIncoming(huge), /单条/);
  huge.text = 'small enough';
  const id = f.store.acceptIncoming(huge)!;
  assert.equal(f.store.dismissIncoming(id), false);
  f.store.finishIncoming(id);
  assert.equal(f.store.inbox().length, 0);
  assert.equal(f.store.acceptIncoming(huge), undefined);
  const message = ding('汉'.repeat(60_000));
  let count = 0;
  for (;;) {
    try {
      f.store.acceptIncoming({ ...message, id: 'sized-' + count });
      count++;
    } catch (error) {
      assert.ok(error instanceof InboxCapacityError);
      break;
    }
  }
  assert.ok(count > 1 && count < INBOX_LIMITS.rows);
  const rowBytes = f.store
    .inbox()
    .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.message)) + 1024, 0);
  assert.ok(rowBytes <= INBOX_LIMITS.bytes);
});

test('receipt cleanup runs during continuous uptime and preserves unresolved message dedup', async (t) => {
  const f = dingFixture();
  t.after(() => f.cleanup());
  const pending = ding('pending');
  f.store.acceptIncoming(pending);
  f.store.claim('ordinary-old');
  const db = new DatabaseSync(join(f.config.dataDir, 'state.sqlite'));
  try {
    db.prepare('UPDATE receipts SET at=?').run(Date.now() - 8 * 86400_000);
    t.mock.timers.enable({ apis: ['setInterval'] });
    // Use a new Store after enabling the fake interval, then age its receipts again.
    const other = new Store(f.config.dataDir);
    try {
      other.claim('during-uptime');
      db.prepare("UPDATE receipts SET at=? WHERE key='during-uptime'").run(
        Date.now() - 8 * 86400_000,
      );
      t.mock.timers.tick(60_000);
      assert.equal(other.claim('during-uptime'), true);
      assert.equal(other.acceptIncoming(pending), undefined);
    } finally {
      other.close();
    }
  } finally {
    db.close();
  }
});

test('shutdown after receipt retains input; recovery executes it once when transport becomes ready', async (t) => {
  const f = dingFixture();
  let restarted: Manager | undefined;
  t.after(async () => {
    await restarted?.close();
    await f.cleanup();
  });
  const message = ding('persist before shutdown');
  const receiving = f.manager.receive(message);
  await f.manager.close();
  await receiving;
  assert.equal(f.agent.inputs.length, 0);
  assert.equal(f.store.inbox()[0]?.state, 'pending');
  restarted = new Manager(
    f.config,
    f.store,
    { codex: f.agent, claude: f.agent, opencode: f.agent },
    new Map([[f.channel.id, f.channel]]),
    {
      async classify() {
        return { action: 'continue', workspace: null, instructions: null, agent: null, task: null };
      },
    },
  );
  restarted.channelStates.set(f.channel.id, { state: 'error', at: Date.now(), detail: 'offline' });
  await restarted.resumeInbox();
  assert.equal(f.agent.inputs.length, 0);
  restarted.channelStates.set(f.channel.id, { state: 'ready', at: Date.now(), detail: 'ready' });
  await Promise.all([restarted.resumeInbox(), restarted.resumeInbox()]);
  await until(() => f.agent.inputs.length === 1);
  await restarted.idle();
  await restarted.receive(message);
  assert.equal(f.agent.inputs.length, 1);
  assert.equal(f.store.inbox().length, 0);
});

test('inbox recovery rechecks authorization and exposes interrupted source only to the original sender and chat', async (t) => {
  const f = dingFixture();
  t.after(() => f.cleanup());
  const id = f.store.acceptIncoming(ding('original to inspect'))!;
  f.config.channels[0]!.allowedUsers = [];
  await f.manager.resumeInbox();
  assert.equal(f.store.inbox()[0]?.state, 'interrupted');
  assert.equal(f.agent.inputs.length, 0);
  f.config.channels[0]!.allowedUsers = ['alice', 'bob'];
  await f.manager.receive(ding('/tab inbox ' + id.slice(0, 8), 'bob'));
  assert.doesNotMatch(f.channel.sent.at(-1)!.text, /original to inspect/);
  await f.manager.receive(ding('/tab inbox ' + id.slice(0, 8)));
  assert.match(f.channel.sent.at(-1)!.text, /original to inspect/);
  assert.match(f.channel.sent.at(-1)!.text, /不会自动重跑/);
  assert.equal(f.agent.inputs.length, 0);
});

test('pending recovery waits for capacity and resumes after active work finishes', async (t) => {
  const f = dingFixture();
  t.after(() => f.cleanup());
  f.config.maxConcurrentRuns = 1;
  let release!: () => void;
  f.agent.handler = async () => {
    if (f.agent.inputs.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  await f.manager.receive(ding('first'));
  await until(() => !!release);
  const second = ding('second');
  second.route.conversation = 'another-chat';
  f.store.acceptIncoming(second);
  await f.manager.resumeInbox();
  assert.equal(f.agent.inputs.length, 1);
  release();
  await until(() => f.agent.inputs.length === 2);
  await f.manager.idle();
  assert.equal(f.store.inbox().length, 0);
});
