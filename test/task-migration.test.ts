import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.js';
import { migrateTaskDatabase } from '../src/core/task-migration.js';
import { fixture, incoming } from './helpers.js';
const route = {
  platform: 'local' as const,
  account: 'dashboard',
  conversation: 'main',
  thread: '',
  sender: 'local-owner',
};
const rows = (file: string, table: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  } finally {
    db.close();
  }
};
test('full migration backs up and preserves native identities, archived records, bindings and events; repeated apply is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-migrate-')),
    file = join(dir, 'state.sqlite');
  let store: Store | undefined = new Store(dir);
  try {
    const main = store.create(route, 'codex', dir),
      child = store.create({ ...route, thread: 'child' }, 'claude', dir);
    child.parentSessionId = main.id;
    child.status = 'closed';
    child.nativeId = 'native-preserved';
    child.settings = { model: 'native-model' };
    store.save(child);
    store.event(child.id, 'user', '完成调研');
    const before = Object.fromEntries(
      ['sessions', 'bindings', 'events', 'task_jobs'].map((t) => [t, rows(file, t)]),
    );
    store.close();
    store = undefined;
    const preview = await migrateTaskDatabase(file);
    assert.equal(preview.create, 2);
    assert.equal(rows(file, 'task_records').length, 0);
    const applied = await migrateTaskDatabase(file, true);
    assert.equal(applied.create, 2);
    assert.ok(applied.backupFile && existsSync(applied.backupFile));
    for (const table of Object.keys(before)) {
      assert.deepEqual(rows(file, table), before[table]);
      assert.deepEqual(rows(applied.backupFile!, table), before[table]);
    }
    const after = rows(file, 'task_records'),
      repeat = await migrateTaskDatabase(file, true);
    assert.equal(repeat.create, 0);
    assert.equal(repeat.update, 0);
    assert.equal(repeat.backupFile, undefined);
    assert.deepEqual(rows(file, 'task_records'), after);
    store = new Store(dir);
    assert.equal(store.taskModelUnified(), true);
    assert.equal(store.taskRecord(child.id)!.parentId, main.id);
    assert.equal(store.taskRecord(child.id)!.state, 'waiting');
    assert.equal(store.get(child.id)!.nativeId, 'native-preserved');
    assert.equal(store.taskJobs().length, 0);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('migration holds the instance lease and refuses concurrent service ownership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-migrate-lock-'));
  try {
    const store = new Store(dir);
    store.create(route, 'codex', dir);
    store.close();
    writeFileSync(join(dir, 'daemon.lock'), String(process.pid));
    await assert.rejects(migrateTaskDatabase(join(dir, 'state.sqlite'), true), /实例运行/);
    assert.equal(rows(join(dir, 'state.sqlite'), 'task_records').length, 0);
    assert.equal(readFileSync(join(dir, 'daemon.lock'), 'utf8'), String(process.pid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('migration detects a database writer during asynchronous backup and commits no stale plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-migrate-race-')),
    file = join(dir, 'state.sqlite');
  try {
    const store = new Store(dir),
      s = store.create(route, 'codex', dir);
    store.close();
    const pending = migrateTaskDatabase(file, true),
      db = new DatabaseSync(file),
      value = JSON.parse(
        String(db.prepare('SELECT data FROM sessions WHERE id=?').get(s.id)!.data),
      );
    value.title = 'updated-during-backup';
    db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(value), s.id);
    db.close();
    await assert.rejects(pending, /数据发生变化/);
    assert.equal(rows(file, 'task_records').length, 0);
    assert.equal(existsSync(join(dir, 'daemon.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('archived interactive children remain navigable without blocking parent acceptance, and cancellation survives unrelated writes', async () => {
  const f = fixture();
  try {
    f.store.enableEmptyTaskModel();
    const root = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir),
      archived = f.store.create(incoming('', 'alice', 'old-topic').route, 'codex', f.dir);
    archived.parentSessionId = root.id;
    archived.status = 'closed';
    f.store.save(archived);
    const replacement = f.store.create(archived.route, 'codex', f.dir);
    f.manager.tasks.adoptSession(root.id);
    assert.equal(
      f.manager.tasks.report(root.id, {
        summary: '已完成当前目标',
        artifacts: [],
        checks: ['已验证'],
        issues: [],
      }).state,
      'completed',
    );
    assert.equal(f.store.taskRecord(archived.id)!.executionMode, 'interactive');
    f.manager.tasks.cancel(root.id);
    assert.equal(f.store.taskRecord(archived.id)!.state, 'cancelled');
    f.store.save(replacement);
    f.store.save(archived);
    assert.equal(f.store.taskRecord(archived.id)!.state, 'cancelled');
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    await f.cleanup();
  }
});
test('session writes roll back both sides on invalid hierarchy and support enclosing transactions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-migrate-atomic-')),
    store = new Store(dir);
  try {
    store.enableEmptyTaskModel();
    const s = store.create(route, 'codex', dir),
      other = store.create({ ...route, conversation: 'other' }, 'codex', dir),
      before = store.get(s.id);
    s.parentSessionId = 'missing';
    assert.throws(() => store.save(s), /父会话/);
    assert.deepEqual(store.get(s.id), before);
    other.title = 'healthy';
    store.atomic(() => store.save(other));
    assert.equal(store.taskRecord(other.id)!.title, 'healthy');
    assert.throws(
      () =>
        store.atomic(() => {
          other.title = 'rolled-back';
          store.save(other);
          throw Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(store.get(other.id)!.title, 'healthy');
    assert.equal(store.taskRecord(other.id)!.title, 'healthy');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
