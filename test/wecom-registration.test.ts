import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerWecom,
  wecomQrUrl,
  WecomRegistrationError,
} from '../src/setup/wecom-registration.js';
import { safeSetupError } from '../src/setup/providers.js';
const qr = {
  data: { scode: 'private&code=1', auth_url: 'https://work.weixin.qq.com/ai/qc/c?key=test' },
};
const success = {
  data: { status: 'success', bot_info: { botid: 'bot-test', secret: 'private-secret' } },
};
function requests(results: unknown[]) {
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(new URL(String(input)));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const result = results.shift();
    if (result instanceof Error) throw result;
    return Response.json(result);
  };
  return { calls, fetch: fetcher };
}
test('WeCom QR registration obtains credentials through the official endpoint and encodes query secrets', async () => {
  const mock = requests([qr, { data: { status: 'waiting' } }, success]);
  const urls: string[] = [];
  const result = await registerWecom(new AbortController().signal, (url) => urls.push(url), {
    ...mock,
    pollMs: 1,
  });
  assert.deepEqual(result, { botId: 'bot-test', secret: 'private-secret' });
  assert.deepEqual(urls, [qr.data.auth_url]);
  assert.ok(mock.calls.every((url) => url.origin === 'https://work.weixin.qq.com'));
  assert.equal(mock.calls[0]!.pathname, '/ai/qc/generate');
  assert.equal(mock.calls[0]!.searchParams.get('source'), 'tab-ai');
  assert.equal(mock.calls[1]!.pathname, '/ai/qc/query_result');
  assert.equal(mock.calls[1]!.searchParams.get('scode'), qr.data.scode);
  assert.equal([...mock.calls[1]!.searchParams].length, 1);
});
test('WeCom QR rejects untrusted authorization links before exposing or polling them', async () => {
  for (const url of [
    'http://work.weixin.qq.com/ai/qc/c',
    'https://work.weixin.qq.com.evil.test/ai/qc/c',
    'https://work.weixin.qq.com/other',
    'https://secret@work.weixin.qq.com/ai/qc/c',
    'https://work.weixin.qq.com:8443/ai/qc/c',
    'bad-url',
  ]) {
    assert.throws(() => wecomQrUrl(url), WecomRegistrationError);
    const mock = requests([{ data: { ...qr.data, auth_url: url } }]);
    await assert.rejects(
      registerWecom(new AbortController().signal, () => assert.fail('unsafe QR shown'), mock),
      /授权链接无效/,
    );
    assert.equal(mock.calls.length, 1);
  }
});
test('WeCom cancellation and expiration stop polling; missing credentials cannot succeed', async () => {
  const controller = new AbortController(),
    mock = requests([qr]);
  await assert.rejects(
    registerWecom(controller.signal, () => controller.abort(), mock),
    /已取消/,
  );
  assert.equal(mock.calls.length, 1);
  const waiting: typeof fetch = async (input) =>
    Response.json(String(input).includes('/generate?') ? qr : { data: { status: 'waiting' } });
  await assert.rejects(
    registerWecom(new AbortController().signal, () => {}, {
      fetch: waiting,
      timeoutMs: 20,
      pollMs: 2,
    }),
    /超时/,
  );
  await assert.rejects(
    registerWecom(
      new AbortController().signal,
      () => {},
      requests([qr, { data: { status: 'success', bot_info: { botid: 'x' } } }]),
    ),
    /未取得完整/,
  );
});
test('WeCom polling retries transient reads but never leaks response or network secrets', async () => {
  const recover = requests([qr, new Error('private-secret'), success]);
  assert.equal(
    (await registerWecom(new AbortController().signal, () => {}, { ...recover, pollMs: 1 })).botId,
    'bot-test',
  );
  const broken = requests([qr, ...Array.from({ length: 3 }, () => new Error('private-secret'))]);
  await assert.rejects(
    registerWecom(new AbortController().signal, () => {}, { ...broken, pollMs: 1 }),
    (error) => {
      assert.match(safeSetupError(error), /查询企业微信扫码结果失败/);
      assert.ok(!safeSetupError(error).includes('private-secret'));
      return true;
    },
  );
  assert.equal(broken.calls.length, 4);
});
