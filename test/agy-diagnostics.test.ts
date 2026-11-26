import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgyDiagnostics, agyFailure } from '../src/agents/agy-diagnostics.js';

test('AGY native diagnostic categories never return log secrets and distinguish recoverable connection errors', () => {
  const credential =
    'https://example.test/?token=private-native-secret Authorization: private-native-secret';
  for (const [log, category, terminal] of [
    [
      'unknown model key MODEL_PLACEHOLDER_TEST: model not found\nEOF',
      /模型初始化失败.*连接中断/,
      true,
    ],
    ['invalid_grant', /认证失败/, true],
    ['401 UNAUTHENTICATED', /认证失败/, false],
    ['429 RESOURCE_EXHAUSTED', /额度或频率/, false],
    ['connection reset: EOF', /连接失败或超时/, false],
  ] as const) {
    const error = agyFailure(log + '\n' + credential)!;
    assert.match(error.message, category);
    assert.equal(error.terminal, terminal);
    assert.ok(!error.message.includes('private-native-secret'));
    assert.ok(!error.message.includes('https://'));
  }
  assert.equal(agyFailure('working normally'), undefined);
});
test('AGY diagnostic log has private permissions, reads a bounded tail and is removed after use', () => {
  const d = new AgyDiagnostics();
  try {
    assert.equal(statSync(d.file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(d.file)).mode & 0o777, 0o700);
    writeFileSync(d.file, 'unknown model key old\n' + 'normal output\n'.repeat(3000));
    assert.equal(d.failure(), undefined);
    writeFileSync(d.file, 'I1126 13:07:01 input] user mentioned unknown model key\n');
    assert.equal(d.failure(), undefined);
    writeFileSync(
      d.file,
      'normal output\n'.repeat(3000) +
        'E1126 13:07:01 errorreport.go:123] failed to construct executor: model not found\n',
    );
    assert.match(d.failure()!.message, /模型初始化失败/);
    d.beginPrompt();
    assert.equal(d.failure(), undefined); // A previous initialization error is not this prompt's failure.
  } finally {
    d.close();
  }
  assert.equal(existsSync(d.file), false);
});

test('AGY distinguishes failed keychain sign-in from transient startup warnings', () => {
  const keyring =
    'W1126 14:38:20 composite_token_storage.go:614] Failed to load stored token from keyring, falling back to file: exit status 36\n';
  assert.equal(agyFailure(keyring), undefined);
  assert.equal(agyFailure('You are not logged into Antigravity.'), undefined);
  assert.match(agyFailure('Authentication required')!.message, /原生认证失败/);
  const d = new AgyDiagnostics();
  try {
    writeFileSync(
      d.file,
      keyring +
        'I1126 14:38:20 boot.go:103] Silent sign-in failed; session requests fail with auth_required until the client signs in.\n',
    );
    assert.match(d.failure()!.message, /macOS 登录钥匙串/);
    assert.equal(d.failure()!.terminal, true);
  } finally {
    d.close();
  }
});
