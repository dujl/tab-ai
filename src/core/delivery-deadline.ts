// Bound transport waiting without retrying an ambiguous message or native work.
export function deliveryDeadline<T>(
  operation: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const cancel = (error: Error) => {
      finish(error);
      controller.abort(error);
    };
    const abort = () => cancel(Error('服务停止，消息投递结果未确认'));
    const timer = setTimeout(
      () => cancel(Error('消息投递超时，结果未确认；未自动重试')),
      timeoutMs,
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // A lazy operation receives the same cancellation budget as its caller.
    // Observe late settlements even when a transport ignores cancellation.
    const pending =
      typeof operation === 'function'
        ? Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return operation(controller.signal);
          })
        : operation;
    pending.then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
  });
}
