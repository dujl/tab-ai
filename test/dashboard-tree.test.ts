import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildSessionTree, filterSessionTree } = await import(
  new URL('../src/web/public/dashboard.js', import.meta.url).href
);
const route = { platform: 'local', account: 'dashboard' };
const session = (id: string, status = 'idle') => ({
  id,
  title: id,
  route,
  agent: 'codex',
  status,
  updatedAt: 1,
});
const task = (id: string, sessionId?: string, parentId?: string) => ({
  id,
  sessionId,
  parentId,
  title: id,
  objective: `目标 ${id}`,
  route,
  agent: 'codex',
  state: 'waiting',
  updatedAt: 2,
});

test('unified tree deduplicates task sessions while keeping ordinary, leaf and provisioning nodes', () => {
  const tree = buildSessionTree({
    sessions: [session('plain'), session('root-session'), session('child-session')],
    tasks: [
      task('root', 'root-session'),
      task('child', 'child-session', 'root'),
      task('provisioning'),
    ],
  });
  assert.equal(tree.nodes.size, 4);
  assert.equal(tree.roots.length, 3);
  assert.deepEqual(
    tree.nodes.get('task:root').children.map((n: any) => n.key),
    ['task:child'],
  );
  assert.equal(tree.nodes.get('task:child').session.id, 'child-session');
  assert.equal(tree.nodes.get('task:provisioning').session, undefined);
  assert.ok(!tree.nodes.has('session:root-session'));
  assert.ok(tree.nodes.has('session:plain'));
});

test('nested search and state filters preserve the matching node ancestry', () => {
  const tree = buildSessionTree({
    sessions: [session('a'), session('b'), session('c', 'waiting'), session('plain')],
    tasks: [task('root', 'a'), task('child', 'b', 'root'), task('grandchild', 'c', 'child')],
  });
  const result = filterSessionTree(tree, { query: 'grandchild' });
  assert.deepEqual([...result.matches], ['task:grandchild']);
  assert.deepEqual([...result.visible], ['task:grandchild', 'task:child', 'task:root']);
  assert.deepEqual(
    [...filterSessionTree(tree, { status: 'waiting' }).matches],
    ['task:grandchild'],
  );
  assert.deepEqual([...filterSessionTree(tree, { kind: 'plain' }).matches], ['session:plain']);
  assert.equal(filterSessionTree(tree, { kind: 'tasks', bot: 'other' }).visible.size, 0);
});

test('task and session states remain independent in the unified navigation', () => {
  const completed = { ...task('done', 's'), state: 'completed' };
  const tree = buildSessionTree({ sessions: [session('s', 'idle')], tasks: [completed] });
  const node = tree.nodes.get('task:done');
  assert.equal(node.task.state, 'completed');
  assert.equal(node.session.status, 'idle');
  assert.equal(filterSessionTree(tree, { status: 'task:completed' }).matches.size, 1);
  assert.equal(filterSessionTree(tree, { status: 'running' }).matches.size, 0);
});

test('orphan and cyclic tasks stay reachable and do not recurse forever', () => {
  const tree = buildSessionTree({
    sessions: [],
    tasks: [
      task('orphan', undefined, 'missing'),
      task('a', undefined, 'b'),
      task('b', undefined, 'a'),
      task('self', undefined, 'self'),
    ],
  });
  const visit = (nodes: any[]): string[] => nodes.flatMap((n) => [n.key, ...visit(n.children)]);
  const keys = visit(tree.roots);
  assert.equal(new Set(keys).size, 4);
  assert.equal(keys.length, 4);
  assert.ok(tree.nodes.get('task:orphan').anomaly);
  assert.ok(tree.nodes.get('task:self').anomaly);
  assert.equal(filterSessionTree(tree, { query: 'a' }).visible.size > 0, true);
});

test('ordinary legacy topics and new nested sessions form one tree, retaining deep search ancestry', () => {
  const main = {
    ...session('fixture-root'),
    route: { platform: 'lark', account: 'bot', conversation: 'group', sender: 'alice' },
  };
  const child = {
    ...session('fixture-child'),
    route: main.route,
    topicParentId: main.id,
    topicObjective: '示例应用开发',
  };
  const sibling = { ...session('fixture-sibling'), route: main.route, topicParentId: main.id };
  const third = { ...session('fixture-third'), route: main.route, topicParentId: main.id };
  const grandchild = {
    ...session('grandchild'),
    route: main.route,
    parentSessionId: child.id,
    topicObjective: '验证输入校验',
  };
  const tree = buildSessionTree({ sessions: [main, child, sibling, third, grandchild], tasks: [] });
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.nodes.get('session:fixture-root').children.length, 3);
  assert.equal(tree.nodes.get('session:fixture-child').children[0].session.id, 'grandchild');
  const filtered = filterSessionTree(tree, { query: '输入校验' });
  assert.deepEqual(
    [...filtered.visible],
    ['session:grandchild', 'session:fixture-child', 'session:fixture-root'],
  );
});

test('task roots retain their own acceptance hierarchy while navigation nests them under a persisted ordinary source', () => {
  const tree = buildSessionTree({
    sessions: [session('source'), session('root-session'), session('child-session')],
    tasks: [
      { ...task('root', 'root-session'), sourceSessionId: 'source' },
      task('child', 'child-session', 'root'),
    ],
  });
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].key, 'session:source');
  assert.equal(tree.nodes.get('task:root').parentKey, 'session:source');
  assert.equal(tree.nodes.get('task:child').parentKey, 'task:root');
  assert.equal(tree.nodes.get('task:root').task.parentId, undefined);
  assert.deepEqual(
    [...filterSessionTree(tree, { query: 'child' }).visible],
    ['task:child', 'task:root', 'session:source'],
  );
});

test('bad ordinary links remain inspectable as roots and cannot forge cross-chat ancestry', () => {
  const a = { ...session('a'), parentSessionId: 'b' },
    b = { ...session('b'), parentSessionId: 'a' },
    orphan = { ...session('orphan'), topicParentId: 'missing' };
  const foreign = {
    ...session('foreign'),
    route: { ...route, account: 'other' },
    parentSessionId: 'a',
  };
  const tree = buildSessionTree({ sessions: [a, b, orphan, foreign], tasks: [] });
  const visit = (nodes: any[]): string[] => nodes.flatMap((n) => [n.key, ...visit(n.children)]);
  assert.equal(visit(tree.roots).length, 4);
  assert.equal(new Set(visit(tree.roots)).size, 4);
  assert.ok(tree.nodes.get('session:orphan').anomaly);
  assert.ok(tree.nodes.get('session:foreign').anomaly);
});
