import type { Channel, Incoming } from '../core/types.js';

export interface ChannelState {
  state: 'starting' | 'ready' | 'error';
  at: number;
  detail: string;
}
// A rejected or stalled connector must not take down the control plane.
export async function startChannel(
  channel: Channel,
  receive: (message: Incoming) => Promise<void>,
  changed: (state: ChannelState) => void,
  timeoutMs = 30_000,
): Promise<void> {
  changed({ state: 'starting', at: Date.now(), detail: '正在连接' });
  let timer: NodeJS.Timeout | undefined,
    failed = false;
  const started = Promise.resolve().then(() => channel.start(receive));
  void started.then(
    () => {
      if (failed) void channel.stop().catch(() => {});
    },
    () => {},
  );
  try {
    await Promise.race([
      started,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('timeout')), timeoutMs);
      }),
    ]);
    changed({ state: 'ready', at: Date.now(), detail: '连接已启动；运行中重连由通道处理' });
  } catch {
    failed = true;
    changed({
      state: 'error',
      at: Date.now(),
      detail: '连接启动失败或超时；网页和其他通道仍可使用，请检查凭证、平台设置和网络',
    });
    void channel.stop().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}
