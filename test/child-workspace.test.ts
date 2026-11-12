import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming } from './helpers.js';
import { normalizeLark } from '../src/channels/normalize.js';

function directories(f: ReturnType<typeof fixture>) {
  const dirs = Object.fromEntries(
    ['main project', 'bot', 'explicit'].map((name) => {
      const p = join(f.dir, name);
      mkdirSync(p);
      return [name, realpathSync(p)];
    }),
  );
  f.config.channels[0]!.defaultWorkspace = dirs.bot;
  f.config.workspaces.explicit = dirs.explicit!;
  return dirs;
}

test('slash and natural child creation inherit the direct parent directory, including a different-directory nested topic', async () => {
  const f = fixture();
  const d = directories(f);
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    main.nativeId = 'main-native';
    main.instructions = 'main instructions';
    f.store.save(main);
    f.store.event(main.id, 'user', 'keep history');
    await f.manager.receive(incoming(`/tab workspace ${d['main project']}`, 'alice', ''));
    const snapshot = f.store.get(main.id),
      history = f.store.events(main.id);
    const source = f.store.create(incoming('', 'alice', 'old-topic').route, 'claude', d.explicit!);
    source.nativeId = 'source-native';
    f.store.save(source);
    const sourceSnapshot = f.store.get(source.id);
    for (const [text, thread] of [
      ['/tab new', ''],
      ['/tab topic claude', 'old-topic'],
      ['新开一个话题：看看目录', ''],
      ['新开一个话题：看看目录', 'old-topic'],
    ]) {
      const before = new Set(f.store.list().map((s) => s.id));
      const m = incoming(text, 'alice', thread);
      await f.manager.receive(m);
      await f.manager.idle();
      const created = f.store.list().filter((s) => !before.has(s.id));
      assert.equal(created.length, 1, text + ' from ' + thread);
      assert.equal(
        created[0]!.workspace,
        thread === 'old-topic' ? d.explicit : d['main project'],
        text + ' from ' + thread,
      );
    }
    assert.deepEqual(f.store.get(main.id), snapshot);
    assert.deepEqual(
      f.store.events(main.id).filter((e) => e.type !== 'topic_registered'),
      history,
    );
    assert.deepEqual(f.store.get(source.id), sourceSnapshot);
    assert.ok(
      f.agent.inputs.every((i) => [d['main project'], d.explicit].includes(i.session.workspace)),
    );
    assert.equal(f.store.current(main.route)!.id, main.id);
  } finally {
    await f.cleanup();
  }
});

test('explicit child directories override inheritance and older children are not moved when the main directory changes', async () => {
  const f = fixture({
      async classify(input) {
        return {
          action: 'new_topic',
          workspace: input.text.includes('explicit') ? 'explicit' : null,
          agent: null,
          instructions: null,
          task: null,
        };
      },
    }),
    d = directories(f);
  try {
    const main = f.store.create(incoming('', 'alice', '').route, 'codex', d['main project']!);
    for (const text of ['/tab new codex explicit', '新开一个话题，使用 explicit']) {
      const m = incoming(text, 'alice', '');
      await f.manager.receive(m);
      assert.equal(f.store.current({ ...m.route, thread: m.id })!.workspace, d.explicit);
    }
    const m = incoming('/tab new', 'alice', '');
    await f.manager.receive(m);
    const old = f.store.current({ ...m.route, thread: m.id })!;
    old.nativeId = 'child-native';
    f.store.save(old);
    const before = f.store.get(old.id);
    await f.manager.receive(incoming(`/tab workspace ${d.explicit}`, 'alice', ''));
    const next = incoming('/tab new', 'alice', '');
    await f.manager.receive(next);
    assert.equal(f.store.current({ ...next.route, thread: next.id })!.workspace, d.explicit);
    assert.deepEqual(f.store.get(old.id), before);
    assert.equal(f.store.current(main.route)!.id, main.id);
  } finally {
    await f.cleanup();
  }
});

test('a native Lark topic uses the bound main directory before its first Agent turn and keeps a closed main closed', async () => {
  const f = fixture(),
    d = directories(f);
  try {
    const raw = (text: string, thread = '') =>
      normalizeLark(
        {
          sender: { sender_type: 'user', sender_id: { open_id: 'alice' } },
          message: {
            message_id: 'om_' + crypto.randomUUID(),
            chat_id: 'oc_group',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: '@bot ' + text }),
            mentions: [{ key: '@bot', id: { open_id: 'bot' } }],
            ...(thread ? { root_id: thread, thread_id: 'omt_' + thread } : {}),
          },
        },
        'test-lark',
        'bot',
      )!;
    const main = f.store.create(raw('').route, 'codex', d['main project']!, undefined, {
      conversationType: 'group',
    });
    main.nativeId = 'main-native';
    main.status = 'closed';
    f.store.save(main);
    await f.manager.receive(raw('research', 'om_native'));
    await f.manager.idle();
    const child = f.store.current(raw('', 'om_native').route)!;
    assert.equal(child.workspace, d['main project']);
    assert.equal(f.agent.inputs[0]!.session.workspace, d['main project']);
    assert.equal(child.topicParentId, main.id);
    assert.equal(f.store.get(main.id)!.status, 'closed');
    assert.equal(f.store.get(main.id)!.nativeId, 'main-native');
  } finally {
    await f.cleanup();
  }
});

for (const platform of ['wechat', 'wecom', 'dingtalk'] as const)
  test(`${platform} virtual children inherit only their own main, including nested /tab to creation`, async () => {
    const f = fixture(),
      d = directories(f);
    Object.assign(f.config.channels[0]!, { type: platform });
    const msg = (text: string, sender = 'alice') => ({
      ...incoming(text, sender, ''),
      route: { ...incoming('', sender, '').route, platform },
    });
    try {
      const main = f.store.create(msg('').route, 'codex', d['main project']!);
      main.nativeId = 'main-native';
      f.store.save(main);
      await f.manager.receive(msg('/tab new codex'));
      const child = f.store.list().find((s) => s.route.thread)!;
      assert.equal(child.workspace, d['main project']);
      const own = f.store.get(child.id)!;
      own.workspace = d.explicit!;
      f.store.save(own);
      await f.manager.receive(msg(`/tab to ${child.id} /tab new claude`));
      const next = f.store.list().find((s) => s.route.thread && s.id !== child.id)!;
      assert.equal(next.workspace, d.explicit);
      assert.equal(f.store.get(child.id)!.workspace, d.explicit);
      const before = new Set(f.store.list().map((s) => s.id));
      await f.manager.receive(msg('/tab new', 'bob'));
      const otherChild = f.store.list().find((s) => !before.has(s.id) && s.route.thread)!;
      assert.equal(otherChild.workspace, d.bot);
      assert.equal(f.store.current(main.route)!.nativeId, 'main-native');
      assert.equal(f.agent.inputs.length, 0);
    } finally {
      await f.cleanup();
    }
  });

test('without a bound main use the BOT default; foreign user/chat/BOT/session history cannot provide the inherited directory', async () => {
  const f = fixture(),
    d = directories(f);
  try {
    const base = incoming('', 'alice', '').route;
    for (const r of [
      { ...base, sender: 'bob' },
      { ...base, conversation: 'other-chat' },
      { ...base, account: 'other' },
    ])
      f.store.create(r, 'codex', d.explicit!);
    const old = f.store.create(base, 'codex', d.explicit!),
      bound = f.store.create(base, 'codex', d['main project']!);
    f.store.bind(bound);
    const m = incoming('/tab new', 'alice', '');
    await f.manager.receive(m);
    assert.equal(f.store.current({ ...base, thread: m.id })!.workspace, d['main project']);
    assert.equal(f.store.get(old.id)!.workspace, d.explicit);
    const other = incoming('/tab new', 'alice', '');
    other.route.conversation = 'fresh-chat';
    await f.manager.receive(other);
    assert.equal(f.store.current({ ...other.route, thread: other.id })!.workspace, d.bot);
  } finally {
    await f.cleanup();
  }
});

test('an inaccessible inherited main directory fails before creating a remote topic rather than silently falling back', async () => {
  const f = fixture(),
    d = directories(f);
  let created = 0;
  f.channel.createTopic = async (m) => {
    created++;
    return { ...m, route: { ...m.route, thread: m.id } };
  };
  try {
    f.store.create(incoming('', 'alice', '').route, 'codex', d['main project']!);
    rmSync(d['main project']!, { recursive: true });
    const before = f.store.list();
    await f.manager.receive(incoming('/tab new', 'alice', ''));
    assert.equal(created, 0);
    assert.deepEqual(f.store.list(), before);
    assert.match(f.channel.sent.at(-1)!.text, /工作目录不存在/);
  } finally {
    await f.cleanup();
  }
});
