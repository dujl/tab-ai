import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
  lstatSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIRECTORY, defaultConfigFile, loadConfig } from '../src/config.js';
import { agentEnvironment } from '../src/agents/environment.js';
test('configuration resolves from the user directory and data defaults beside it', () => {
  assert.equal(defaultConfigFile(), join(homedir(), '.tab-ai', 'config.json'));
  assert.equal(CONFIG_DIRECTORY, join(homedir(), '.tab-ai'));
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tab-ai-brand-'));
  try {
    const raw = { workspaces: { default: dir }, defaultWorkspace: 'default' };
    // Omitted dataDir stays inside the configuration directory, never beside a legacy one.
    writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
    assert.equal(loadConfig(join(dir, 'config.json')).dataDir, join(dir, 'data'));
    // Absolute, ~ and file-relative data paths all resolve.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, dataDir: 'state' }));
    assert.equal(loadConfig(join(dir, 'config.json')).dataDir, join(dir, 'state'));
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ ...raw, dataDir: '~/tab-ai-test-state' }),
    );
    assert.equal(
      loadConfig(join(dir, 'config.json')).dataDir,
      join(homedir(), 'tab-ai-test-state'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('workspaces resolve through absolute, ~ and file-relative paths', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tab-ai-workspace-'));
  try {
    mkdirSync(join(dir, 'project'));
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        workspaces: { default: 'project', home: '~' },
        defaultWorkspace: 'default',
      }),
    );
    const config = loadConfig(join(dir, 'config.json'));
    assert.equal(config.workspaces.default, join(dir, 'project'));
    assert.equal(config.workspaces.home, homedir());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('agent environment removes management and host bot secrets', () => {
  const keys = ['TAB_AI_TEST_SECRET', 'BOTMUX_TEST_SECRET'];
  const old = keys.map((k) => process.env[k]);
  try {
    keys.forEach((k) => (process.env[k] = 'secret'));
    const env = agentEnvironment();
    keys.forEach((k) => assert.equal(env[k], undefined));
  } finally {
    keys.forEach((k, i) => {
      if (old[i] === undefined) delete process.env[k];
      else process.env[k] = old[i];
    });
  }
});

// @ts-ignore Browser module is JavaScript.
import { sessionDisplayTitle } from '../src/web/public/dashboard.js';
import { SetupStorage, credentialResolver, atomicJson } from '../src/setup/storage.js';

test('historical report titles display as group main tasks', () => {
  assert.equal(
    sessionDisplayTitle({ title: '【tab-ai 话题交付摘要 · 仅作研究资料】' }),
    '群主任务',
  );
  assert.equal(sessionDisplayTitle({ title: '用户自己起的名字' }), '用户自己起的名字');
});

test('bot naming continues saved sequences and keeps credential references', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tab-ai-names-'));
  try {
    const file = join(dir, 'config.json'),
      raw = {
        workspaces: { default: dir },
        defaultWorkspace: 'default',
        channels: ['tab-ai-bot17', 'tab-ai-bot9', '研究助手'].map((displayName, i) => ({
          id: 'bot' + i,
          type: 'wecom',
          displayName,
          allowedUsers: ['owner'],
          botIdEnv: 'TAB_AI_ID_' + i,
          secretEnv: 'TAB_AI_SECRET_' + i,
        })),
      };
    writeFileSync(file, JSON.stringify(raw));
    const storage = new SetupStorage(file);
    assert.equal(storage.reserveBotName(), 'tab-ai-bot18');
    assert.equal(storage.reserveBotName(), 'tab-ai-bot19');
    assert.deepEqual(
      storage.config().channels.map((c) => c.displayName),
      raw.channels.map((c) => c.displayName),
    );
    writeFileSync(
      join(storage.config().dataDir, 'credentials.json'),
      JSON.stringify({ TAB_AI_SECRET_0: 'saved-secret' }),
    );
    assert.equal(credentialResolver(storage.config())('TAB_AI_SECRET_0'), 'saved-secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic configuration updates write through symlinks to one canonical file', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tab-ai-alias-'));
  try {
    const canonical = join(dir, 'config.json'),
      alias = join(dir, 'legacy-link.json');
    writeFileSync(canonical, '{}');
    symlinkSync('config.json', alias);
    atomicJson(alias, { updated: true });
    assert.equal(lstatSync(alias).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(readFileSync(canonical, 'utf8')), { updated: true });
    assert.equal(readFileSync(alias, 'utf8'), readFileSync(canonical, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
