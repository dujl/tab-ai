import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { incoming } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { accessToken, lockDirectory } from '../src/runtime.js';
import { selectedApprovalPolicy } from '../src/core/approval-policy.js';

test('on-request upgrade preserves audited legacy native opt-outs, timestamps, bindings and history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-approval-migrate-'));
  try {
    let store = new Store(dir);
    const native = store.create(incoming('', 'alice', 'native').route, 'codex', dir),
      unset = store.create(incoming('', 'alice', 'unset').route, 'codex', dir),
      explicit = store.create(incoming('', 'alice', 'explicit').route, 'codex', dir);
    native.nativeId = 'same-native';
    store.save(native);
    store.event(
      native.id,
      'system',
      '已修改本会话审批策略：native；原临时授权已清除，仅影响此 session。',
    );
    store.event(native.id, 'system', '已清除本会话内的临时授权；后续按当前原生策略重新审批。');
    explicit.approvalPolicy = 'never';
    store.save(explicit);
    const at = store.get(native.id)!.updatedAt,
      history = store.events(native.id);
    store.close();
    store = new Store(dir);
    assert.equal(store.get(native.id)!.approvalPolicy, 'native');
    assert.equal(selectedApprovalPolicy(store.get(native.id)!), 'native');
    assert.equal(store.get(native.id)!.updatedAt, at);
    assert.equal(store.get(native.id)!.nativeId, 'same-native');
    assert.equal(store.current(native.route)!.id, native.id);
    assert.deepEqual(store.events(native.id), history);
    assert.equal(selectedApprovalPolicy(store.get(unset.id)!), 'on-request');
    assert.equal(store.get(unset.id)!.approvalPolicy, undefined);
    assert.equal(selectedApprovalPolicy(store.get(explicit.id)!), 'never');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart restores native IDs, bindings and deduplication without replaying incomplete work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-state-'));
  try {
    let store = new Store(dir);
    const route = incoming('').route,
      session = store.create(route, 'codex', dir);
    session.nativeId = 'original-thread';
    session.status = 'waiting';
    store.save(session);
    assert.equal(store.claim('event-key'), true);
    store.close();
    store = new Store(dir);
    assert.equal(store.current(route)!.id, session.id);
    assert.equal(store.get(session.id)!.nativeId, 'original-thread');
    assert.equal(store.get(session.id)!.status, 'interrupted');
    assert.equal(store.claim('event-key'), false);
    assert.ok(store.events(session.id).some((e) => e.type === 'system'));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('config validates sender allowlists, workspace aliases and unique connector IDs', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tab-ai-config-')),
    path = join(dir, 'config.json');
  try {
    const base = { workspaces: { default: '.' }, channels: [] };
    writeFileSync(path, JSON.stringify(base));
    assert.equal(loadConfig(path).workspaces.default, dir);
    writeFileSync(path, JSON.stringify({ ...base, defaultWorkspace: 'missing' }));
    assert.throws(() => loadConfig(path), /defaultWorkspace/);
    const c = {
      type: 'wecom',
      id: 'wx',
      allowedUsers: ['alice'],
      botIdEnv: 'BOT_ID',
      secretEnv: 'SECRET',
    };
    writeFileSync(path, JSON.stringify({ ...base, channels: [c, c] }));
    assert.throws(() => loadConfig(path), /唯一/);
    writeFileSync(path, JSON.stringify({ ...base, channels: [{ ...c, allowedUsers: [] }] }));
    assert.throws(() => loadConfig(path));
    writeFileSync(path, JSON.stringify(base));
    const config = loadConfig(path),
      token = accessToken(config);
    assert.equal(token.length, 64);
    assert.equal(accessToken(config), token);
    assert.equal(statSync(join(config.dataDir, 'token')).mode & 0o777, 0o600);
    writeFileSync(join(config.dataDir, 'token'), '');
    assert.throws(() => accessToken(config), /token 文件无效/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('only one daemon can acquire the same state directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-lock-'));
  try {
    const unlock = lockDirectory(dir);
    assert.throws(() => lockDirectory(dir), /已有/);
    unlock();
    lockDirectory(dir)();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
