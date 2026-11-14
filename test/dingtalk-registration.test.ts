import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerDingTalk,
  dingtalkQrUrl,
  DingTalkRegistrationError,
} from '../src/setup/dingtalk-registration.js';
import { safeSetupError } from '../src/setup/providers.js';

const init = { errcode: 0, nonce: 'private-nonce' };
const begin = {
  errcode: 0,
  device_code: 'private-device-code',
  verification_uri_complete:
    'https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=test&source=DING_DWS_CLAW',
  interval: 2,
  expires_in: 7200,
};
const success = {
  errcode: 0,
  status: 'SUCCESS',
  client_id: 'ding-test',
  client_secret: 'private-secret',
};
function requests(results: unknown[]) {
  const calls: { url: URL; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    calls.push({ url: new URL(String(input)), body: JSON.parse(String(options?.body)) });
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    const value = results.shift();
    if (value instanceof Error) throw value;
    return Response.json(value);
  };
  return { calls, fetch: fetcher, pollMs: 1 };
}
test('DingTalk registration uses the official device flow and returns credentials without exposing polling secrets', async () => {
  const mock = requests([init, begin, { errcode: 0, status: 'WAITING' }, success]);
  const urls: string[] = [],
    lifetimes: number[] = [];
  assert.deepEqual(
    await registerDingTalk(
      new AbortController().signal,
      (url, seconds) => {
        urls.push(url);
        lifetimes.push(seconds);
      },
      mock,
    ),
    { clientId: 'ding-test', clientSecret: 'private-secret' },
  );
  assert.deepEqual(urls, [begin.verification_uri_complete]);
  assert.deepEqual(lifetimes, [600]);
  assert.ok(mock.calls.every((c) => c.url.origin === 'https://oapi.dingtalk.com'));
  assert.deepEqual(
    mock.calls.map((c) => c.url.pathname),
    [
      '/app/registration/init',
      '/app/registration/begin',
      '/app/registration/poll',
      '/app/registration/poll',
    ],
  );
  assert.deepEqual(
    mock.calls.map((c) => c.body),
    [
      { source: 'DING_DWS_CLAW' },
      { nonce: init.nonce },
      { device_code: begin.device_code },
      { device_code: begin.device_code },
    ],
  );
  assert.doesNotMatch(JSON.stringify(urls), /private-device-code|private-nonce|private-secret/);
});
test('DingTalk rejects unsafe QR links before displaying or polling them', async () => {
  for (const url of [
    'http://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=x',
    'https://open-dev.dingtalk.com.evil.test/openapp/registration/openClaw?user_code=x',
    'https://open-dev.dingtalk.com/other?user_code=x',
    'https://secret@open-dev.dingtalk.com/openapp/registration/openClaw?user_code=x',
    'https://open-dev.dingtalk.com:8443/openapp/registration/openClaw?user_code=x',
    'https://open-dev.dingtalk.com/openapp/registration/openClaw',
    'bad-url',
  ]) {
    assert.throws(() => dingtalkQrUrl(url), DingTalkRegistrationError);
    const mock = requests([init, { ...begin, verification_uri_complete: url }]);
    await assert.rejects(
      registerDingTalk(new AbortController().signal, () => assert.fail('unsafe QR shown'), mock),
      /授权链接无效/,
    );
    assert.equal(mock.calls.length, 2);
  }
});
test('DingTalk cancellation and deadlines stop polling', async () => {
  const controller = new AbortController(),
    mock = requests([init, begin]);
  await assert.rejects(
    registerDingTalk(controller.signal, () => controller.abort(), mock),
    /已取消/,
  );
  assert.equal(mock.calls.length, 2);
  for (const expires_in of [7200, 0.005]) {
    const polling: typeof fetch = async (input) =>
      Response.json(
        String(input).endsWith('/init')
          ? init
          : String(input).endsWith('/begin')
            ? { ...begin, expires_in }
            : { errcode: 0, status: 'WAITING' },
      );
    await assert.rejects(
      registerDingTalk(new AbortController().signal, () => {}, {
        fetch: polling,
        timeoutMs: 30,
        pollMs: 2,
      }),
      /超时/,
    );
  }
});
test('DingTalk registration rejects incomplete or terminal responses without leaking provider payloads', async () => {
  for (const [response, pattern] of [
    [{ errcode: 0, status: 'SUCCESS', client_id: 'x' }, /未取得完整/],
    [{ errcode: 0, status: 'EXPIRED' }, /已过期/],
    [{ errcode: 0, status: 'FAIL', fail_reason: 'private-secret' }, /未完成或已取消/],
  ] as const) {
    const mock = requests([init, begin, response]);
    await assert.rejects(
      registerDingTalk(new AbortController().signal, () => {}, mock),
      (error) => {
        assert.match(safeSetupError(error), pattern);
        assert.doesNotMatch(safeSetupError(error), /private-secret/);
        return true;
      },
    );
    assert.equal(mock.calls.length, 3);
  }
});
test('DingTalk tolerates transitional statuses without restarting registration and bounds unknown states', async () => {
  const recovering = requests([
    init,
    begin,
    { errcode: 0, status: 'PENDING' },
    { errcode: 0, status: 'WAITING' },
    success,
  ]);
  assert.equal(
    (await registerDingTalk(new AbortController().signal, () => {}, recovering)).clientId,
    'ding-test',
  );
  assert.equal(recovering.calls.filter((c) => c.url.pathname.endsWith('/init')).length, 1);
  let polls = 0;
  await assert.rejects(
    registerDingTalk(new AbortController().signal, () => {}, {
      pollMs: 1,
      statusGraceMs: 5,
      fetch: async (input) =>
        Response.json(
          String(input).endsWith('/init')
            ? init
            : String(input).endsWith('/begin')
              ? begin
              : (++polls, { errcode: 0, status: 'private-secret' }),
        ),
    }),
    (error) => {
      assert.match(safeSetupError(error), /状态异常/);
      assert.doesNotMatch(safeSetupError(error), /private-secret/);
      return true;
    },
  );
  assert.ok(polls >= 2);
});
test('DingTalk retries only polling reads and sanitizes network errors', async () => {
  const recovering = requests([init, begin, new Error('private-device-code'), success]);
  assert.equal(
    (await registerDingTalk(new AbortController().signal, () => {}, recovering)).clientId,
    'ding-test',
  );
  const failed = requests([
    init,
    begin,
    ...Array.from({ length: 3 }, () => new Error('private-secret')),
  ]);
  await assert.rejects(
    registerDingTalk(new AbortController().signal, () => {}, failed),
    (error) => {
      assert.match(safeSetupError(error), /查询钉钉扫码结果失败/);
      assert.doesNotMatch(safeSetupError(error), /private-secret/);
      return true;
    },
  );
  assert.equal(failed.calls.length, 5);
  const failedInit = requests([new Error('private-nonce')]);
  await assert.rejects(
    registerDingTalk(new AbortController().signal, () => {}, failedInit),
    /扫码接入失败/,
  );
  assert.equal(failedInit.calls.length, 1);
});
