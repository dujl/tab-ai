import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import { fixture, incoming } from './helpers.js';
import { Store } from '../src/core/store.js';
import { creationOptions } from '../src/core/session-instructions.js';
import { createDashboard } from '../src/web/server.js';

test('creation options preserve multiline additions literally, reject extra arguments and do not evaluate shell syntax', () => {
  const instructions = '  角色\n$(touch nope) `whoami` --instructions literal';
  assert.deepEqual(creationOptions('/tab new opencode default --instructions ' + instructions), {
    args: ['opencode', 'default'],
    instructions,
  });
  assert.deepEqual(creationOptions('/tab init codex --instructions'), {
    args: ['codex'],
    instructions: '',
  });
  assert.throws(() => creationOptions('/tab new codex default unexpected'));
  assert.throws(() => creationOptions('/tab new --instructions ' + 'x'.repeat(16001)));
});

test('main and topic instructions are chosen at creation, persisted across reopen/restart, and never inserted into conversation', async () => {
  const f = fixture();
  try {
    f.config.defaultInstructions = 'Configured default';
    await f.manager.receive(incoming('/tab init codex --instructions Main role', 'alice', ''));
    const main = f.store.current(incoming('', 'alice', '').route)!;
    assert.equal(main.instructions, 'Main role');
    assert.equal(f.agent.inputs.length, 0);
    assert.deepEqual(f.store.events(main.id), []);
    await f.manager.receive(incoming('  original task\nkeep it  ', 'alice', ''));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.text, '  original task\nkeep it  ');
    f.manager.closeSession(main.id);
    await f.manager.receive(incoming('/tab instructions', 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /Main role/);
    const request = incoming(
      '/tab new opencode --instructions  Literary role\nKeep whitespace',
      'alice',
      '',
    );
    await f.manager.receive(request);
    const child = f.store.current({ ...request.route, thread: request.id })!;
    assert.equal(child.instructions, ' Literary role\nKeep whitespace');
    assert.equal(child.agent, 'opencode');
    assert.deepEqual(f.store.events(child.id), []);
    assert.equal(f.store.current(main.route)!.id, main.id);
    assert.equal(f.store.get(main.id)!.status, 'closed');
    f.config.defaultInstructions = 'Changed default';
    f.manager.openSession(main.id);
    assert.equal(f.store.get(main.id)!.instructions, 'Main role');
    const restored = new Store(f.config.dataDir);
    try {
      assert.equal(restored.get(child.id)!.instructions, child.instructions);
      assert.equal(restored.get(main.id)!.instructions, 'Main role');
    } finally {
      restored.close();
    }
    await f.manager.receive(incoming('/tab init claude --instructions Replace', 'alice', ''));
    assert.equal(f.store.list().length, 2);
    assert.equal(f.store.current(main.route)!.id, main.id);
    assert.ok(
      f.store
        .events(main.id)
        .filter((e) => e.type === 'user')
        .every((e) => !e.text.includes('Main role')),
    );
  } finally {
    await f.cleanup();
  }
});

test('defaults are copied only into new sessions, explicit empty opts out, invalid input creates no topic', async () => {
  const f = fixture();
  try {
    f.config.defaultInstructions = 'First default';
    await f.manager.receive(incoming('ordinary', 'alice', ''));
    await f.manager.idle();
    const main = f.store.current(incoming('', 'alice', '').route)!;
    f.config.defaultInstructions = 'Second default';
    await f.manager.receive(incoming('next', 'alice', ''));
    await f.manager.idle();
    assert.equal(f.agent.inputs.at(-1)!.session.instructions, 'First default');
    for (const [text, expected] of [
      ['/tab new opencode', 'Second default'],
      ['/tab new opencode --instructions', undefined],
    ] as const) {
      const request = incoming(text, 'alice', '');
      await f.manager.receive(request);
      assert.equal(
        f.store.current({ ...request.route, thread: request.id })!.instructions,
        expected,
      );
    }
    const before = f.store.list();
    await f.manager.receive(
      incoming('/tab new codex --instructions ' + 'x'.repeat(16001), 'alice', ''),
    );
    assert.deepEqual(f.store.list(), before);
    assert.equal(f.store.current(main.route)!.id, main.id);
  } finally {
    await f.cleanup();
  }
});

test('OpenCode sessions with additions cannot silently lose them during terminal handoff', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'opencode', f.dir, 'role');
    s.nativeId = 'ses_native';
    f.store.save(s);
    assert.throws(() => f.manager.detach(s.id), /保持指令一致/);
    assert.equal(f.store.get(s.id)!.status, 'idle');
  } finally {
    await f.cleanup();
  }
});

test('dashboard creation requires auth, supports explicit additions and exposes no mutation endpoint', async () => {
  const f = fixture(),
    server = createDashboard(f.manager, 'test-token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    f.config.defaultInstructions = 'Default role';
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
      headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const post = (body: object, h = headers) =>
      fetch(base + '/sessions', { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.equal(
      (await post({ agent: 'codex', workspace: 'default' }, {} as typeof headers)).status,
      401,
    );
    const payload = {
      agent: 'opencode',
      workspace: 'default',
      instructions: '  Literary editor\nNo tools  ',
    };
    const response = await post(payload);
    assert.equal(response.status, 201);
    const session = await response.json();
    assert.equal(session.instructions, payload.instructions);
    assert.deepEqual(f.store.events(session.id), []);
    assert.equal(f.agent.inputs.length, 0);
    const empty = await (await post({ ...payload, instructions: '' })).json();
    assert.equal(empty.instructions, undefined);
    assert.equal((await post({ ...payload, instructions: 'x'.repeat(16001) })).status, 400);
    assert.equal((await post({ ...payload, nativeId: 'hijack' })).status, 400);
    assert.equal(
      (
        await fetch(base + `/sessions/${session.id}/instructions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ instructions: 'overwrite' }),
        })
      ).status,
      404,
    );
    assert.equal(f.store.get(session.id)!.instructions, payload.instructions);
    assert.equal(f.store.list().length, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.cleanup();
  }
});
