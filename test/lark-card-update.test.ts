import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateLarkCard } from '../src/channels/lark-card-update.js';
import { LarkChannel } from '../src/channels/lark.js';
import { createDashboard } from '../src/web/server.js';
import { fixture, incoming, until } from './helpers.js';

test('terminal card replacement retries transient failures with a bound, without leaking raw transport data', async () => {
  const waits: number[] = [];
  let calls = 0;
  await updateLarkCard(
    async () => {
      calls++;
      if (calls === 1) throw Object.assign(Error('secret headers'), { code: 'ECONNABORTED' });
      return { code: calls === 2 ? 99991400 : 0 };
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1500]);
  calls = 0;
  await assert.rejects(
    updateLarkCard(
      async () => {
        calls++;
        throw { code: 'ETIMEDOUT', config: { token: 'secret' } };
      },
      async () => {},
    ),
    /网络 ETIMEDOUT；尝试 3 次/,
  );
  assert.equal(calls, 3);
  for (const code of [99991672, 99991403, 400]) {
    calls = 0;
    await assert.rejects(
      updateLarkCard(
        async () => {
          calls++;
          return { code };
        },
        async () => {},
      ),
      new RegExp(`飞书错误码 ${code}；尝试 1 次`),
    );
    assert.equal(calls, 1);
  }
  calls = 0;
  await updateLarkCard(
    async () => {
      if (++calls === 1) throw { response: { status: 503 } };
      return { code: 0 };
    },
    async () => {},
  );
  assert.equal(calls, 2);
});

for (const allowed of [true, false])
  test(`Dashboard answer updates the original Feishu approval card; allow=${allowed}`, async () => {
    const f = fixture();
    f.config.interactionTimeoutMs = 10000;
    const lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture'),
      sent: any[] = [],
      patches: any[] = [];
    let patchCalls = 0,
      approvals = 0;
    Object.assign(lark, {
      client: {
        im: {
          message: {
            reply: async (args: any) => {
              sent.push(args);
              return { code: 0, data: { message_id: 'om-original-card' } };
            },
            patch: async (args: any) => {
              patches.push(args);
              if (++patchCalls === 1)
                throw Object.assign(Error('hidden authorization'), { code: 'ECONNABORTED' });
              return { code: 0 };
            },
          },
        },
      },
    });
    Object.assign(f.channel, { sendInteraction: lark.sendInteraction.bind(lark) });
    f.agent.handler = async (run) => {
      const a = await run.hooks.ask(
        { kind: 'approval', title: 'Test approval', detail: 'test command' },
        run.signal,
      );
      approvals++;
      assert.deepEqual(a, { allow: allowed });
    };
    const server = createDashboard(f.manager, 'test-token');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      await f.manager.receive(incoming('task', 'alice', 'om_root'));
      await until(() => sent.length === 1);
      const pending = f.manager.interactions()[0]!;
      const url = `http://127.0.0.1:${(server.address() as any).port}/api/sessions/${pending.sessionId}/answer`;
      const result = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pending.id, answer: { allow: allowed } }),
      });
      assert.equal(result.status, 200);
      await f.manager.idle();
      await until(() => patchCalls === 2);
      assert.equal(approvals, 1);
      assert.equal(sent.length, 1);
      assert.equal(patches[0].path.message_id, 'om-original-card');
      assert.equal(patches[0].data.content, patches[1].data.content);
      const card = JSON.parse(patches[1].data.content);
      assert.equal(card.header.template, allowed ? 'green' : 'red');
      assert.ok(!card.elements.some((e: any) => ['action', 'form'].includes(e.tag)));
      assert.throws(
        () => f.manager.answer(pending.sessionId, pending.id, { allow: true }),
        /已结束/,
      );
      await until(() =>
        f.store.events(pending.sessionId).some((e) => e.type === 'interaction_card_synced'),
      );
      assert.ok(
        !JSON.stringify(f.store.events(pending.sessionId)).includes('hidden authorization'),
      );
    } finally {
      await f.cleanup();
      await lark.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

test('permanent update failure notifies the original topic once and does not repeat approval', async () => {
  const f = fixture(),
    lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture');
  let approved = 0,
    calls = 0;
  Object.assign(lark, {
    client: {
      im: {
        message: {
          reply: async () => ({ code: 0, data: { message_id: 'om-card' } }),
          patch: async () => {
            calls++;
            return { code: 99991672, msg: 'secret raw body' };
          },
        },
      },
    },
  });
  Object.assign(f.channel, { sendInteraction: lark.sendInteraction.bind(lark) });
  f.agent.handler = async (run) => {
    await run.hooks.ask({ kind: 'approval', title: 'Test', detail: 'private script' }, run.signal);
    approved++;
  };
  try {
    await f.manager.receive(incoming('original', 'alice', 'om_root'));
    await until(() => f.manager.interactions().length === 1);
    await new Promise((r) => setTimeout(r, 10));
    const p = f.manager.interactions()[0]!;
    f.manager.answer(p.sessionId, p.id, { allow: true });
    await f.manager.idle();
    await until(() => f.channel.sent.some((m) => m.text.includes('卡片状态同步提示')));
    assert.equal(calls, 1);
    assert.equal(approved, 1);
    const notices = f.channel.sent.filter((m) => m.text.includes('卡片状态同步提示'));
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.message.route.thread, 'om_root');
    assert.match(notices[0]!.text, /已允许本次操作/);
    assert.ok(!notices[0]!.text.includes('private script'));
    const errors = f.store.events(p.sessionId).filter((e) => e.type === 'delivery_error');
    assert.ok(errors.some((e) => e.text.includes('99991672') && e.text.includes(p.id)));
    assert.ok(!JSON.stringify(errors).includes('secret raw body'));
  } finally {
    await f.cleanup();
    await lark.stop();
  }
});
