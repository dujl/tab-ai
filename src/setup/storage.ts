import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { groupModeInput, type GroupMode } from '../core/group-mode.js';
import { z } from 'zod';
import { sessionWorkspace } from '../core/session-workspace.js';
import { loadConfig, type ChannelConfig, type Config } from '../config.js';

const secretsSchema = z.record(z.string(), z.string());
export type SecretResolver = (key: string) => string;
export function readCredentials(dataDir: string): Record<string, string> {
  const file = join(dataDir, 'credentials.json');
  return existsSync(file) ? secretsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
}
export function credentialResolver(config: Config): SecretResolver {
  const saved = readCredentials(config.dataDir);
  return (key) => {
    const value = process.env[key] || saved[key];
    if (!value) throw new Error(`缺少凭证 ${key}，请运行 tab-ai setup。`);
    return value;
  };
}
export function atomicJson(file: string, data: unknown): void {
  // Write through symlinks so an aliased path cannot fork the canonical file.
  if (existsSync(file)) file = realpathSync(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(data, null, 2) + '\n');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, file);
    const parent = openSync(dirname(file), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export const draftSchema = z.object({
  manager: z.boolean().optional(),
  id: z.string().uuid(),
  type: z.enum(['lark', 'dingtalk', 'wecom', 'wechat']),
  domain: z.enum(['feishu', 'lark']),
  credentialId: z.string().min(1),
  credentialSecret: z.string().min(1),
  expectedUserId: z.string().optional(),
  baseUrl: z.string().optional(),
  createdAt: z.number(),
  displayName: z.string().min(1).optional(),
  cardTemplateId: z.string().trim().min(1).max(200).optional(),
  pairingMode: z.enum(['code', 'message']).optional(),
});
export type Draft = z.infer<typeof draftSchema>;
export class SetupStorage {
  constructor(readonly configFile: string) {}
  config(): Config {
    return loadConfig(this.configFile);
  }
  setManager(id: string, manager: boolean): void {
    const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as { channels: ChannelConfig[] };
    const channel = raw.channels?.find((c) => c.id === id);
    if (!channel) throw new Error('机器人不存在');
    channel.manager = manager;
    atomicJson(resolve(this.configFile), raw);
  }
  setDetails(id: string, input: unknown): { displayName: string; defaultWorkspace: string } {
    const data = z
      .object({
        displayName: z.string().trim().min(1).max(80),
        defaultWorkspace: z.string().trim().min(1).max(4096),
      })
      .strict()
      .parse(input);
    const config = this.config();
    const workspace = sessionWorkspace(data.defaultWorkspace, config.workspaces);
    const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as { channels: ChannelConfig[] };
    const channel = raw.channels.find((c) => c.id === id);
    if (!channel) throw new Error('机器人不存在');
    channel.displayName = data.displayName;
    channel.defaultWorkspace = workspace;
    atomicJson(resolve(this.configFile), raw);
    return { displayName: data.displayName, defaultWorkspace: workspace };
  }
  setGroupMode(id: string, chatId: string, mode: GroupMode): void {
    groupModeInput.parse({ chatId, mode });
    const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as { channels: ChannelConfig[] };
    const channel = raw.channels?.find((c) => c.id === id);
    if (!channel || channel.type !== 'lark') throw new Error('群接收模式目前仅支持飞书 BOT');
    channel.groupModes = { ...channel.groupModes, [chatId]: mode };
    atomicJson(resolve(this.configFile), raw);
  }
  reserveBotName(): string {
    const config = this.config(),
      resolveSecret = credentialResolver(config);
    const file = join(config.dataDir, 'bot-names.json');
    const counter = z.object({
      lastSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    });
    let sequence = existsSync(file)
      ? counter.parse(JSON.parse(readFileSync(file, 'utf8'))).lastSequence
      : 0;
    const accounts = new Set<string>();
    const observeName = (name?: string) => {
      const match = /^tab-ai-bot([1-9]\d*)$/.exec(name ?? '');
      if (match) {
        const number = Number(match[1]);
        if (Number.isSafeInteger(number)) sequence = Math.max(sequence, number);
      }
    };
    for (const channel of config.channels) {
      const key =
        channel.type === 'lark'
          ? channel.appIdEnv
          : channel.type === 'dingtalk'
            ? channel.clientIdEnv
            : channel.botIdEnv;
      const domain = channel.type === 'lark' ? channel.domain : '';
      try {
        accounts.add(`${channel.type}/${domain}/${resolveSecret(key)}`);
      } catch {
        accounts.add(`unresolved/${channel.id}`);
      }
      observeName(channel.displayName);
    }
    for (const draft of this.drafts()) {
      accounts.add(
        `${draft.type}/${draft.type === 'lark' ? draft.domain : ''}/${draft.credentialId}`,
      );
      observeName(draft.displayName);
    }
    sequence = Math.max(sequence, accounts.size) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('机器人编号已超出可用范围');
    // The daemon/setup directory lock serializes reservations. Persist before the remote
    // request: cancellation or an ambiguous platform response must not reuse a name.
    atomicJson(file, { lastSequence: sequence });
    return `tab-ai-bot${sequence}`;
  }
  private directory(): string {
    const directory = join(this.config().dataDir, 'setup-drafts');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return directory;
  }
  saveDraft(draft: Draft): void {
    atomicJson(join(this.directory(), `${draftSchema.parse(draft).id}.json`), draft);
  }
  draft(id: string): Draft {
    z.string().uuid().parse(id);
    return draftSchema.parse(
      JSON.parse(readFileSync(join(this.directory(), `${id}.json`), 'utf8')),
    );
  }
  drafts(): Omit<Draft, 'credentialSecret' | 'expectedUserId'>[] {
    return readdirSync(this.directory())
      .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
      .flatMap((name) => {
        try {
          const {
            credentialSecret: _secret,
            expectedUserId: _user,
            ...safe
          } = this.draft(name.slice(0, -5));
          return [safe];
        } catch {
          return [];
        }
      });
  }
  commit(channel: ChannelConfig, values: Record<string, string>, draftId: string): void {
    const config = this.config();
    if (config.channels.some((c) => c.id === channel.id))
      throw new Error('此机器人已经接入，请刷新页面。');
    // Preserve user formatting semantics and unknown optional fields through a parsed copy.
    const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as { channels?: ChannelConfig[] };
    const file = join(config.dataDir, 'credentials.json');
    const saved = readCredentials(config.dataDir);
    for (const key of Object.keys(values)) {
      if (process.env[key] || saved[key]) throw new Error('凭证名称冲突，请重新创建配对。');
    }
    // Credentials first, then activation. A crash can leave unused credentials, never an enabled bot without credentials.
    atomicJson(file, { ...saved, ...values });
    // Never roll credentials back after an ambiguous rename/fsync failure: the configuration may already be durable.
    atomicJson(resolve(this.configFile), { ...raw, channels: [...(raw.channels ?? []), channel] });
    const draftPath = join(this.directory(), `${draftId}.json`);
    try {
      if (existsSync(draftPath)) unlinkSync(draftPath);
    } catch {
      /* An unused protected draft is safe to retain. */
    }
  }
}
