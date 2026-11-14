import { lockDirectory } from './instance-lock.js';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { type Config } from './config.js';
import { Store } from './core/store.js';
import { Manager } from './core/manager.js';
import { type Channel } from './core/types.js';
import { startChannel, type ChannelState } from './channels/lifecycle.js';
import { CodexAdapter } from './agents/codex.js';
import { OpenCodeAdapter } from './agents/opencode.js';
import { ClaudeAdapter } from './agents/claude.js';
import { NativeTopicRouter } from './agents/topic-router.js';
import { createChannel } from './channels/factory.js';
import { credentialResolver, SetupStorage } from './setup/storage.js';
import { SetupService } from './setup/service.js';
import { createDashboard } from './web/server.js';

export function credentialKeys(config: Config): string[] {
  return config.channels.flatMap((channel) =>
    Object.entries(channel)
      .filter(([key]) => key.endsWith('Env'))
      .map(([, value]) => String(value)),
  );
}
export function accessToken(config: Config): string {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, 'token');
  try {
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  chmodSync(path, 0o600);
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error('本地 token 文件无效；停止服务后删除该文件以重新生成。');
  return token;
}
export { lockDirectory } from './instance-lock.js';
export async function serve(config: Config, configFile?: string): Promise<() => Promise<void>> {
  const unlock = lockDirectory(config.dataDir);
  let store: Store | undefined;
  let manager: Manager | undefined;
  let server: ReturnType<typeof createDashboard> | undefined;
  let setup: SetupService | undefined;
  const channels = new Map<string, Channel>();
  const channelErrors = new Map<string, ChannelState>();
  try {
    store = new Store(config.dataDir);
    if (!store.list().length && !store.taskRecords().length && !store.taskModelUnified())
      store.enableEmptyTaskModel();
    const keys = credentialKeys(config);
    const resolveSecret = credentialResolver(config);
    for (const c of config.channels) {
      try {
        const channel = createChannel(c, resolveSecret, config.dataDir);
        channels.set(c.id, channel);
      } catch {
        channelErrors.set(c.id, {
          state: 'error',
          at: Date.now(),
          detail: '连接初始化失败；请检查机器人凭证和配置，网页仍可使用',
        });
      }
    }
    // Routing uses its own classifier; this never selects or overrides the requested work Agent.
    const routerAgent =
      config.topicRouterAgent ?? (config.defaultAgent === 'claude' ? 'claude' : 'codex');
    const reportWriter = new NativeTopicRouter(
      routerAgent,
      config.agents[routerAgent].command,
      keys,
    );
    manager = new Manager(
      config,
      store,
      {
        codex: new CodexAdapter(config.agents.codex.command, keys),
        claude: new ClaudeAdapter(config.agents.claude.command, keys),
        opencode: new OpenCodeAdapter(config.agents.opencode.command, keys),
      },
      channels,
      new NativeTopicRouter(routerAgent, config.agents[routerAgent].command, keys),
      configFile ? (id, role) => new SetupStorage(configFile).setManager(id, role) : undefined,
      configFile
        ? (id, chat, mode) => new SetupStorage(configFile).setGroupMode(id, chat, mode)
        : undefined,
      undefined,
      reportWriter,
    );
    if (configFile)
      setup = new SetupService(configFile, {
        receive: (message) => manager!.receive(message),
        adopt: (channelConfig, channel) => {
          config.channels.push(channelConfig);
          manager!.registerChannel(channel);
        },
      });
    server = createDashboard(manager, accessToken(config), setup);
    const readyServer = server;
    await new Promise<void>((resolve, reject) => {
      readyServer.once('error', reject);
      readyServer.listen(config.port, config.dashboardLanHost ? '0.0.0.0' : '127.0.0.1', resolve);
    });
    for (const [id, state] of channelErrors) manager.channelStates.set(id, state);
    await Promise.all(
      [...channels.values()].map((channel) =>
        startChannel(
          channel,
          (message) => manager!.receive(message),
          (state) => manager!.channelStates.set(channel.id, state),
        ),
      ),
    );
    manager.refreshSessionCards();
    manager.tasks.start();
    void manager.resumeInbox();
    console.log(`tab-ai listening on http://127.0.0.1:${config.port}`);
    console.log('Run tab-ai dashboard to get the authenticated local URL.');
  } catch (error) {
    await setup?.close();
    for (const channel of channels.values()) await channel.stop().catch(() => {});
    server?.close();
    await manager?.close();
    store?.close();
    unlock();
    throw error;
  }
  let stopping = false;
  return async () => {
    if (stopping) return;
    stopping = true;
    await setup?.close();
    await manager!.close();
    for (const channel of channels.values()) await channel.stop().catch(() => {});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    store!.close();
    unlock();
  };
}
