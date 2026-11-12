import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import { fixture, incoming, until } from './helpers.js';
import { type AgentModel, type SessionCardClick, type SessionCardView } from '../src/core/types.js';
import { larkSessionAction, larkSessionCard } from '../src/channels/lark-session-card.js';
import { createDashboard } from '../src/web/server.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const models: AgentModel[] = [
  {
    id: 'model-a',
    label: 'Model A',
    defaultEffort: 'low',
    efforts: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
  },
  { id: 'model-b', label: 'Model B', efforts: [{ id: 'medium', label: 'Medium' }] },
  { id: 'no-effort', label: 'No effort', efforts: [] },
];
function setup() {
  const f = fixture();
  let calls = 0,
    handler!: (click: SessionCardClick) => SessionCardView;
  const sent: SessionCardView[] = [],
    updates: SessionCardView[] = [];
  Object.assign(f.agent, {
    async models() {
      calls++;
      return structuredClone(models);
    },
  });
  Object.assign(f.channel, {
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
  f.manager.registerChannel(f.channel);
  const click = (id: string, action: SessionCardClick['action'], selection?: string) => {
    const card = f.store.card(id)!;
    return {
      id: card.id,
      revision: card.revision,
      action,
      selection,
      sender: 'alice',
      conversation: 'chat-1',
      messageId: card.messageId!,
    };
  };
  return {
    ...f,
    sent,
    updates,
    click,
    act: (c: SessionCardClick) => handler(c),
    calls: () => calls,
  };
}

test('card settings are drafts until save; main/topic and native history stay isolated; persistence adds no conversation events', async () => {
  const f = setup();
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      topic = f.store.create(incoming('', 'alice', 'om_topic').route, 'claude', f.dir);
    main.nativeId = 'native-main';
    f.store.save(main);
    f.manager.closeSession(main.id);
    f.manager.controls.showSettings(main.id);
    await f.manager.settings.load(main.id);
    await f.manager.controls.drain();
    assert.equal(f.channel.sent.length, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.sent.length, 1);
    const history = f.store.events(main.id),
      beforeTopic = f.store.get(topic.id),
      cardId = f.store.card(main.id)!.messageId;
    f.act(f.click(main.id, 'model', 'model-a'));
    await f.manager.controls.drain();
    assert.equal(f.store.get(main.id)!.settings, undefined);
    f.act(f.click(main.id, 'effort', 'high'));
    await f.manager.controls.drain();
    const save = f.click(main.id, 'save_settings');
    f.act(save);
    await f.manager.controls.drain();
    assert.deepEqual(f.store.get(main.id)!.settings, { model: 'model-a', effort: 'high' });
    assert.equal(f.store.get(main.id)!.nativeId, 'native-main');
    assert.equal(f.store.get(main.id)!.status, 'closed');
    assert.equal(f.store.current(main.route)!.id, main.id);
    assert.deepEqual(f.store.get(topic.id), beforeTopic);
    assert.deepEqual(f.store.events(main.id), history);
    assert.equal(f.channel.sent.length, 0);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.card(main.id)!.messageId, cardId);
    assert.throws(() => f.act(save), /状态已更新/);
    const db = new DatabaseSync(join(f.config.dataDir, 'state.sqlite'), { readOnly: true });
    const stored = JSON.parse(
      String(db.prepare('SELECT data FROM sessions WHERE id=?').get(main.id)!.data),
    );
    db.close();
    assert.deepEqual(stored.settings, { model: 'model-a', effort: 'high' });
    assert.equal(stored.settingsRevision, 1);
    f.manager.openSession(main.id);
    await f.manager.receive(incoming('exact user text', 'alice', ''));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.text, 'exact user text');
    assert.deepEqual(f.agent.inputs[0]!.session.settings, stored.settings);
  } finally {
    await f.cleanup();
  }
});

test('settings reject foreign actors, stale dashboard revisions, invalid model/effort pairs and busy runs', async () => {
  const f = setup();
  let finish!: () => void;
  try {
    const session = f.store.create(incoming('').route, 'codex', f.dir);
    session.nativeId = 'native-saved';
    f.store.save(session);
    await f.manager.receive(incoming('/tab settings'));
    await f.manager.settings.load(session.id);
    await f.manager.controls.drain();
    for (const change of [{ sender: 'bob' }, { conversation: 'other' }, { messageId: 'forwarded' }])
      assert.throws(
        () => f.act({ ...f.click(session.id, 'model', 'model-a'), ...change }),
        /不属于/,
      );
    assert.throws(
      () => f.manager.settings.save(session.id, { model: 'invented', effort: 'high' }, 0),
      /模型不在/,
    );
    assert.throws(
      () => f.manager.settings.save(session.id, { model: 'model-b', effort: 'high' }, 0),
      /思考深度/,
    );
    assert.throws(() => f.manager.settings.save(session.id, { model: 'model-b' }, 0), /思考深度/);
    assert.throws(
      () => f.manager.settings.save(session.id, { model: 'no-effort', effort: 'high' }, 0),
      /思考深度/,
    );
    f.act(f.click(session.id, 'model', 'model-a'));
    await f.manager.controls.drain();
    f.manager.settings.save(session.id, { model: 'no-effort' }, 0);
    await f.manager.controls.drain();
    assert.throws(() => f.act(f.click(session.id, 'save_settings')), /设置已被更新/);
    f.act(f.click(session.id, 'cancel_settings'));
    await f.manager.controls.drain();
    f.act(f.click(session.id, 'model', 'model-b'));
    await f.manager.controls.drain();
    assert.equal(f.store.card(session.id)!.draftSettings!.effort, undefined);
    f.agent.handler = async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await f.manager.receive(incoming('working'));
    await until(() => !!finish);
    assert.throws(
      () => f.manager.settings.save(session.id, { model: 'model-a', effort: 'low' }, 1),
      /当前任务结束/,
    );
    finish();
    await f.manager.idle();
    f.manager.detach(session.id);
    assert.throws(
      () => f.manager.settings.save(session.id, { model: 'model-a', effort: 'low' }, 1),
      /原生终端/,
    );
  } finally {
    finish?.();
    await f.cleanup();
  }
});

test('real Lark dropdown callback carries selection only as control data; renderer offers supported options', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    await f.manager.receive(incoming('/tab settings'));
    await f.manager.settings.load(s.id);
    await f.manager.controls.drain();
    const click = f.click(s.id, 'model');
    const raw = {
      operator: { open_id: 'alice' },
      context: { open_message_id: click.messageId, open_chat_id: 'chat-1' },
      action: {
        value: { kind: 'session', id: click.id, revision: click.revision, action: 'model' },
        option: 'model-b',
      },
    };
    assert.equal(larkSessionAction(raw, f.act).toast.type, 'success');
    await f.manager.controls.drain();
    const card = JSON.stringify(larkSessionCard(f.manager.controls.snapshot(f.store.card(s.id)!)));
    assert.ok(card.includes('select_static'));
    assert.ok(card.includes('medium · Medium'));
    assert.ok(!card.includes('high · High'));
    assert.equal(f.store.get(s.id)!.settings, undefined);
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(larkSessionAction(raw, f.act).toast.type, 'error');
    f.config.channels[0]!.allowedUsers = [];
    assert.throws(() => f.act(f.click(s.id, 'save_settings')), /无权/);
  } finally {
    await f.cleanup();
  }
});

test('capability failure does not overwrite saved settings; refresh and shutdown are bounded', async () => {
  const f = setup();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    await f.manager.settings.load(s.id);
    f.manager.settings.save(s.id, { model: 'model-a', effort: 'high' }, 0);
    Object.assign(f.agent, {
      async models() {
        throw new Error('secret upstream token');
      },
    });
    await f.manager.settings.load(s.id, true);
    assert.equal(f.manager.settings.snapshot(s.id).state, 'error');
    assert.ok(!JSON.stringify(f.manager.settings.snapshot(s.id)).includes('secret'));
    assert.throws(() => f.manager.settings.save(s.id, { model: 'no-effort' }, 1), /刷新/);
    assert.deepEqual(f.store.get(s.id)!.settings, { model: 'model-a', effort: 'high' });
    Object.assign(f.agent, {
      async models(_s: unknown, signal: AbortSignal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new Error('cancelled');
      },
    });
    const loading = f.manager.settings.load(s.id, true);
    await f.manager.settings.close();
    await loading;
    assert.throws(() => f.manager.settings.save(s.id, { model: 'no-effort' }, 1), /关闭/);
  } finally {
    await f.cleanup();
  }
});

test('dashboard settings require local authentication and validated revisions without creating turns', async () => {
  const f = setup(),
    server = createDashboard(f.manager, 'test-token');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir),
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${s.id}/settings`;
    assert.equal((await fetch(base)).status, 401);
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const data = await (await fetch(base, { headers })).json();
    assert.equal(data.capabilities.state, 'ready');
    assert.equal(data.revision, 0);
    const payload = JSON.stringify({
      revision: 0,
      settings: { model: 'model-b', effort: 'medium' },
    });
    assert.equal((await fetch(base, { headers, method: 'POST', body: payload })).status, 200);
    assert.equal((await fetch(base, { headers, method: 'POST', body: payload })).status, 400);
    assert.deepEqual(f.store.get(s.id)!.settings, { model: 'model-b', effort: 'medium' });
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.events(s.id).length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});
