import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming } from './helpers.js';
const { taskInbox, readRecentOpened } = await import(
  new URL('../src/web/public/dashboard.js', import.meta.url).href
);
const { buildSessionTree } = await import(
  new URL('../src/web/public/dashboard.js', import.meta.url).href
);
const s = (id: string, extra: any = {}) => ({
  id,
  title: id,
  agent: 'codex',
  status: 'idle',
  workspace: '/tmp',
  createdAt: 1,
  updatedAt: 1,
  route: {
    platform: 'local',
    account: 'dashboard',
    conversation: 'a',
    thread: '',
    sender: 'owner',
  },
  ...extra,
});

test('inbox groups actual requests, orders deadlines, includes async questions on running children, ignores expired and closed', () => {
  const tree = buildSessionTree({
    sessions: [
      s('main'),
      s('child', { parentSessionId: 'main', status: 'running' }),
      s('later'),
      s('closed', { status: 'closed' }),
      s('idle'),
    ],
    tasks: [],
  });
  const req = (id: string, sessionId: string, kind: string, expiresAt: number) => ({
    id,
    sessionId,
    kind,
    expiresAt,
    createdAt: 5,
  });
  const requests = [
    req('a', 'later', 'approval', 300),
    req('q', 'child', 'question', 200),
    req('b', 'child', 'approval', 250),
    req('old', 'idle', 'question', 99),
    req('c', 'closed', 'approval', 120),
  ];
  const inbox = taskInbox(tree, requests, {}, 100);
  assert.deepEqual(
    inbox.attention.map((e: any) => [e.node.session.id, e.label, e.tab]),
    [
      ['child', '待审批 1 · 待回答 1', 'records'],
      ['later', '待审批 1', 'records'],
    ],
  );
  assert.equal(tree.nodes.get('session:child').parentKey, 'session:main');
  assert.equal(inbox.preparation.length, 0);
  assert.equal(taskInbox(tree, [], {}, 100).attention.length, 0);
});

test('recent prioritizes user messages and actual opens, never background tool activity', () => {
  const tree = buildSessionTree({
    sessions: [
      s('tool', { updatedAt: 999 }),
      s('user'),
      s('opened'),
      s('closed', { status: 'closed' }),
    ],
    tasks: [],
  });
  tree.nodes.get('session:user').record = { lastUserAt: 50 };
  assert.deepEqual(
    taskInbox(tree, [], { 'session:opened': 70 }, 100).recent.map((n: any) => n.session.id),
    ['opened', 'user', 'tool'],
  );
  assert.equal(readRecentOpened('{broken')['session:a'], undefined);
  assert.deepEqual(readRecentOpened('{"session:a":10,"task:b":200,"x":9,"session:c":"11"}', 100), {
    'session:a': 10,
  });
  assert.equal(
    Object.keys(
      readRecentOpened(
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 110 }, (_, i) => ['session:' + i, i + 1])),
        ),
        200,
      ),
    ).length,
    100,
  );
});

test('preparation identifies drafts and saved first tasks without flagging all idle histories', () => {
  const tree = buildSessionTree({
    sessions: [
      s('history'),
      s('draft', { creationKey: 'new' }),
      s('init', { pendingInitialTask: 'review first' }),
      s('done', { nativeId: 'native', creationKey: 'new' }),
      s('busy', { status: 'running', pendingInitialTask: 'already starting' }),
    ],
    tasks: [],
  });
  const inbox = taskInbox(tree, [], {}, 100);
  assert.deepEqual(inbox.preparation.map((e: any) => e.node.session.id).sort(), ['draft', 'init']);
});

test('catalog exposes latest real user event rather than system updates without modifying history', async () => {
  const f = fixture();
  try {
    const session = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
    f.store.event(session.id, 'user', 'user input');
    const at = f.store.latestEvent(session.id, 'user')!.at;
    f.store.event(session.id, 'system', 'background');
    const before = f.store.events(session.id);
    assert.equal(f.manager.taskCatalog().find((n) => n.sessionId === session.id)!.lastUserAt, at);
    assert.deepEqual(f.store.events(session.id), before);
  } finally {
    await f.cleanup();
  }
});
