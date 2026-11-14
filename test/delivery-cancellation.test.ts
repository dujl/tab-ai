import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryDeadline } from '../src/core/delivery-deadline.js';
import { DingTalkApi } from '../src/channels/dingtalk-api.js';

test('delivery deadline aborts the underlying operation and never starts an already cancelled operation', async () => {
  let seen: AbortSignal | undefined;
  await assert.rejects(
    deliveryDeadline(
      (signal) => {
        seen = signal;
        return new Promise<void>(() => {});
      },
      5,
      new AbortController().signal,
    ),
    /超时/,
  );
  assert.equal(seen?.aborted, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    deliveryDeadline(async () => assert.fail('must not start'), 100, controller.signal),
    /服务停止/,
  );
});

test('cancelled token waiter never sends and does not cancel or duplicate another waiter shared refresh', async (t) => {
  let token!: (value: Response) => void;
  let refreshes = 0,
    posts = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    if (String(url).endsWith('/accessToken')) {
      refreshes++;
      return new Promise<Response>((resolve) => {
        token = resolve;
      });
    }
    options.signal!.throwIfAborted();
    posts++;
    return Response.json({ processQueryKey: 'ok' });
  });
  const api = new DingTalkApi('test-client', 'test-secret'),
    controller = new AbortController();
  const cancelled = api.request('POST', '/first', {}, controller.signal);
  const rejection = assert.rejects(cancelled, /失败或结果未知/);
  controller.abort();
  await rejection;
  const surviving = api.request('POST', '/second', {});
  token(Response.json({ accessToken: 'test-token', expireIn: 7200 }));
  await surviving;
  assert.equal(refreshes, 1);
  assert.equal(posts, 1);
});
