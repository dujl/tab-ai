// Bound transport waiting without retrying an ambiguous message or native work.
export function deliveryDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(Error('服务停止，消息投递结果未确认'));
    const timer = setTimeout(
      () => finish(Error('消息投递超时，结果未确认；未自动重试')),
      timeoutMs,
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
  });
}
