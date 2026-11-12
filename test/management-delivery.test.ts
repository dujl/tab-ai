import { cardElements, callbackValue } from './card-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverManagement,
  ManagementDeliveryError,
} from '../src/channels/lark-management-delivery.js';
import { LarkChannel } from '../src/channels/lark.js';
import { managementView } from '../src/core/management-view.js';
import { fixture, incoming, until } from './helpers.js';
import { maintenanceFailure, readCompaction } from '../src/core/maintenance-diagnostics.js';
import { Store } from '../src/core/store.js';

test('management delivery bounds transient retries and exposes only safe diagnostics', async () => {
  let count = 0;
  const waits: number[] = [];
  await assert.rejects(
    deliverManagement(
      async () => {
        count++;
        throw Object.assign(Error('Bearer secret-token https://private'), {
          response: {
            status: 503,
            headers: { 'x-tt-logid': 'safe_request_1', authorization: 'secret-token' },
            data: { code: 123, msg: 'private' },
          },
        });
      },
      async (ms) => {
        waits.push(ms);
      },
    ),
    (error) => {
      assert.ok(error instanceof ManagementDeliveryError);
      assert.deepEqual(error.diagnostic, {
        apiCode: 123,
        httpStatus: 503,
        transport: undefined,
        requestId: 'safe_request_1',
        attempts: 3,
        outcome: 'rejected',
      });
      assert.ok(!JSON.stringify(error).includes('secret-token'));
      return true;
    },
  );
  assert.equal(count, 3);
  assert.deepEqual(waits, [500, 1500]);
  for (const response of [{ code: 99991672, msg: 'private' }, { code: 0 }]) {
    count = 0;
    await assert.rejects(
      deliverManagement(
        async () => {
          count++;
          return response;
        },
        async () => {},
      ),
      ManagementDeliveryError,
    );
    assert.equal(count, 1);
  }
});

test('Feishu retries the same UUID and payload in the original topic, without executing management commands', async () => {
  const f = fixture(),
    lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture'),
    sent: any[] = [];
  Object.assign(lark, {
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            sent.push(args);
            if (sent.length === 1) throw Object.assign(Error('private'), { code: 'ECONNRESET' });
            return { code: 0, data: { message_id: 'om_confirmation' } };
          },
        },
      },
    },
  });
  try {
    const m = incoming('/tab compact', 'alice', 'om_original');
    await lark.sendManagement(
      m,
      managementView('compact', 'confirmation', undefined, [
        { label: '开始压缩', command: '/tab compact start', mutation: true },
      ]),
    );
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.ok(sent[0].data.uuid);
    assert.equal(sent[0].path.message_id, 'om_original');
    assert.equal(sent[0].data.reply_in_thread, true);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await lark.stop();
    await f.cleanup();
  }
});

test('failed compact confirmation falls back to original-topic text with commands, sanitized audit, and no native execution', async () => {
  const f = fixture(),
    lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture'),
    sent: any[] = [];
  let compactions = 0;
  Object.assign(lark, {
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            sent.push(args);
            return args.data.msg_type === 'interactive'
              ? { code: 99991672, msg: 'Bearer hidden-token' }
              : { code: 0, data: { message_id: 'om_fallback' } };
          },
        },
      },
    },
  });
  Object.assign(f.channel, {
    sendManagement: lark.sendManagement.bind(lark),
    sendManagementFallback: lark.sendManagementFallback.bind(lark),
  });
  Object.assign(f.agent, {
    async compact() {
      compactions++;
      return { compacted: true };
    },
  });
  try {
    const m = incoming('/tab compact', 'alice', 'om_original'),
      s = f.store.create(m.route, 'codex', f.dir);
    s.nativeId = 'same';
    f.store.save(s);
    await f.manager.receive(m);
    assert.equal(sent.length, 2);
    const text = JSON.parse(sent[1].data.content).text;
    assert.match(text, /尚未发起新的压缩/);
    assert.match(text, /\/tab compact start/);
    assert.equal(sent[1].path.message_id, 'om_original');
    assert.ok(sent[1].data.uuid);
    assert.equal(compactions, 0);
    assert.equal(f.manager.maintenanceInfo(s.id).lastCompaction, undefined);
    const events = f.store.events(s.id),
      failure = JSON.parse(events.find((e) => e.type === 'delivery_error')!.text);
    assert.equal(failure.apiCode, 99991672);
    assert.equal(failure.stage, 'confirmation');
    assert.equal(failure.targetSessionId, s.id);
    assert.ok(!JSON.stringify(events).includes('hidden-token'));
    assert.ok(events.some((e) => e.type === 'management_delivery'));
  } finally {
    await lark.stop();
    await f.cleanup();
  }
});

test('compaction runs once despite notification failure and persists accepted/running/completed through the API model', async () => {
  const f = fixture();
  let count = 0,
    release!: (value: { compacted: boolean }) => void;
  Object.assign(f.channel, {
    async sendManagement() {
      throw Error('hidden response body');
    },
  });
  Object.assign(f.agent, {
    async compact() {
      count++;
      return new Promise((r) => {
        release = r;
      });
    },
  });
  try {
    const m = incoming('/tab compact start'),
      s = f.store.create(m.route, 'codex', f.dir);
    s.nativeId = 'same';
    f.store.save(s);
    await f.manager.receive(m);
    await until(() => !!release);
    assert.equal(f.manager.maintenanceInfo(s.id).lastCompaction!.phase, 'running');
    assert.throws(() => f.manager.startCompaction(s.id), /等待/);
    release({ compacted: true });
    await f.manager.idle();
    assert.equal(count, 1);
    assert.equal(f.manager.maintenanceInfo(s.id).lastCompaction!.phase, 'completed');
    const records = f.store
      .events(s.id)
      .filter((e) => e.type === 'compaction')
      .map((e) => readCompaction(e.text)!);
    assert.deepEqual(
      records.map((r) => r.phase),
      ['accepted', 'running', 'completed'],
    );
    assert.equal(new Set(records.map((r) => r.id)).size, 1);
    assert.ok(f.channel.sent.every((v) => v.message.route.thread === m.route.thread));
    assert.ok(!JSON.stringify(f.store.events(s.id)).includes('hidden response body'));
  } finally {
    await f.cleanup();
  }
});

test('compaction safe causes, no-op and missing completion remain distinct, persisted after restart', async () => {
  for (const [error, phase, code] of [
    ['authentication failed Bearer secret', 'failed', 'authentication'],
    ['原生轮次已结束，但没有压缩完成标记。', 'unconfirmed', 'completion_unconfirmed'],
    ['unknown secret', 'unconfirmed', 'native_error'],
    ['', 'noop', undefined],
  ] as const) {
    const f = fixture();
    Object.assign(f.agent, {
      async compact() {
        if (error) throw Error(error);
        return { compacted: false };
      },
    });
    try {
      const s = f.store.create(incoming('').route, 'codex', f.dir);
      s.nativeId = 'same';
      f.store.save(s);
      f.manager.startCompaction(s.id);
      await f.manager.idle();
      const last = f.manager.maintenanceInfo(s.id).lastCompaction!;
      assert.equal(last.phase, phase);
      assert.equal(last.code, code);
      assert.ok(!JSON.stringify(last).includes('secret'));
      assert.equal(f.store.get(s.id)!.status, 'idle');
      assert.equal(f.store.get(s.id)!.nativeId, 'same');
      f.store.close();
      const reopened = new Store(f.config.dataDir);
      try {
        assert.equal(readCompaction(reopened.latestEvent(s.id, 'compaction')?.text)!.phase, phase);
      } finally {
        reopened.close();
      } // cleanup handles closed SQLite below
    } finally {
      await f.manager.close();
      try {
        f.store.close();
      } catch {}
      await import('node:fs').then((fs) => fs.rmSync(f.dir, { recursive: true, force: true }));
    }
  }
  assert.equal(maintenanceFailure(Error('ECONNRESET private')).code, 'connection');
});

test('service recovery marks an interrupted native compaction unconfirmed without re-running it', async () => {
  const f = fixture();
  const s = f.store.create(incoming('').route, 'codex', f.dir);
  s.nativeId = 'same';
  s.operation = 'compact';
  s.status = 'running';
  f.store.save(s);
  f.store.event(
    s.id,
    'compaction',
    JSON.stringify({
      id: 'operation-1',
      phase: 'running',
      startedAt: 1,
      updatedAt: 2,
      detail: 'pending',
    }),
  );
  await f.manager.close();
  f.store.close();
  const reopened = new Store(f.config.dataDir);
  try {
    const last = readCompaction(reopened.latestEvent(s.id, 'compaction')?.text)!;
    assert.equal(last.phase, 'unconfirmed');
    assert.equal(last.code, 'service_restarted');
    assert.equal(last.id, 'operation-1');
    assert.equal(reopened.get(s.id)!.nativeId, 'same');
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    reopened.close();
    await import('node:fs').then((fs) => fs.rmSync(f.dir, { recursive: true, force: true }));
  }
});

test('the actual Feishu confirmation callback starts compaction once and a repeated click cannot run it again', async () => {
  const f = fixture(),
    lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture'),
    sent: any[] = [];
  let count = 0;
  Object.assign(lark, {
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            sent.push(args);
            return { code: 0, data: { message_id: 'om_' + sent.length } };
          },
        },
      },
    },
  });
  Object.assign(f.channel, { sendManagement: lark.sendManagement.bind(lark) });
  lark.onManagementAction((m) => f.manager.receive(m));
  Object.assign(f.agent, {
    async compact() {
      count++;
      return { compacted: true };
    },
  });
  try {
    const m = incoming('/tab compact', 'alice', 'om_original'),
      s = f.store.create(m.route, 'codex', f.dir);
    s.nativeId = 'same';
    f.store.save(s);
    await f.manager.receive(m);
    assert.equal(count, 0);
    const native = JSON.parse(sent[0].data.content),
      button = cardElements(native).find((b: any) => b.text?.content === '开始压缩');
    assert.ok(button);
    const { larkManagementAction } = await import('../src/channels/management-cards.js');
    const raw = {
      operator: { open_id: 'alice' },
      context: { open_chat_id: 'chat-1', open_message_id: 'om_1' },
      action: { value: callbackValue(button) },
    };
    const action = larkManagementAction((lark as any).managementCards, raw);
    assert.equal(action.ok, true);
    await action.run!();
    await f.manager.idle();
    assert.equal(count, 1);
    assert.equal(f.manager.maintenanceInfo(s.id).lastCompaction!.phase, 'completed');
    assert.equal(larkManagementAction((lark as any).managementCards, raw).ok, false);
    assert.equal(count, 1);
    assert.ok(sent.every((args) => args.path.message_id === 'om_original'));
  } finally {
    await lark.stop();
    await f.cleanup();
  }
});
