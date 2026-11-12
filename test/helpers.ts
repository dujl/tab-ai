import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Config } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { Manager } from '../src/core/manager.js';
import {
  type AgentAdapter,
  type AgentRun,
  type Channel,
  type Incoming,
  type Session,
} from '../src/core/types.js';
import { type TopicRouter } from '../src/core/topic-router.js';
import { newTopicIntent } from './fixtures/topic-intent.js';

export class FakeAgent implements AgentAdapter {
  supportsWorkspaceSwitch = true;
  inputs: AgentRun[] = [];
  handler: (run: AgentRun) => Promise<void> = async (run) => {
    run.hooks.nativeId('native-1');
    run.hooks.text(`Answer: ${run.text}`);
  };
  async run(input: AgentRun) {
    this.inputs.push(input);
    await this.handler(input);
  }
  resumeCommand(session: Session) {
    return ['codex', 'resume', session.nativeId!];
  }
}
export class FakeChannel implements Channel {
  id = 'test-lark';
  platform = 'lark' as const;
  sent: { message: Incoming; text: string }[] = [];
  closedNotices: Session[] = [];
  fail = false;
  async start() {}
  async stop() {}
  async sendSessionClosed(session: Session) {
    this.closedNotices.push(session);
  }
  async createTopic(message: Incoming, _title?: string): Promise<Incoming> {
    const root = message.route.thread ? `om_${randomUUID()}` : message.id;
    return { ...message, replyTo: root, route: { ...message.route, thread: root } };
  }
  async send(message: Incoming, text: string) {
    if (this.fail) throw new Error('secret webhook must not appear');
    this.sent.push({ message, text });
  }
}
export function incoming(text: string, sender = 'alice', thread = 'topic-1'): Incoming {
  return {
    id: randomUUID(),
    text,
    route: { platform: 'lark', account: 'test-lark', conversation: 'chat-1', thread, sender },
  };
}
export function fixture(
  router: TopicRouter = {
    async classify(input) {
      const intent = newTopicIntent(input.text);
      return intent
        ? {
            action: 'new_topic',
            workspace: null,
            instructions: null,
            agent: null,
            task: intent.task ?? null,
          }
        : { action: 'continue', workspace: null, instructions: null, agent: null, task: null };
    },
  },
) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tab-ai-test-'));
  const config: Config = {
    dataDir: join(dir, 'data'),
    port: 4317,
    defaultAgent: 'codex',
    defaultWorkspace: 'default',
    workspaces: { default: dir },
    agents: { codex: { command: 'codex' }, claude: {}, opencode: { command: 'opencode' } },
    maxConcurrentRuns: 2,
    turnTimeoutMs: 5000,
    interactionTimeoutMs: 1000,
    channels: [
      {
        id: 'test-lark',
        type: 'lark',
        allowedUsers: ['alice', 'bob'],
        appIdEnv: 'TEST_APP_ID',
        appSecretEnv: 'TEST_APP_SECRET',
        botOpenId: 'bot',
        domain: 'feishu',
      },
    ],
  };
  const store = new Store(config.dataDir),
    agent = new FakeAgent(),
    channel = new FakeChannel();
  const manager = new Manager(
    config,
    store,
    { codex: agent, claude: agent, opencode: agent },
    new Map([[channel.id, channel]]),
    router,
  );
  return {
    dir,
    config,
    store,
    agent,
    channel,
    manager,
    async cleanup() {
      await manager.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
