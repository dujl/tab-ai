import { groupIdSchema, groupModeSchema } from './core/group-mode.js';
import { z } from 'zod';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { WECHAT_BASE, wechatBase } from './channels/wechat-api.js';
import { instructionsSchema } from './core/session-instructions.js';
import { sessionWorkspace } from './core/session-workspace.js';
import { isIPv4 } from 'node:net';

// Configuration and data live in the user-level directory, independent of the working directory.
export const CONFIG_DIRECTORY = join(homedir(), '.tab-ai');
export const DEFAULT_DATA_DIRECTORY = 'data';

export function defaultConfigFile(): string {
  return join(CONFIG_DIRECTORY, 'config.json');
}

const access = {
  manager: z.boolean().optional(),
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  defaultWorkspace: z.string().trim().min(1).optional(),
  allowedUsers: z.array(z.string().min(1)).min(1),
};
const schema = z
  .object({
    dataDir: z.string().default(DEFAULT_DATA_DIRECTORY),
    port: z.number().int().min(1024).max(65535).default(4317),
    dashboardLanHost: z
      .string()
      .refine(
        (value) =>
          isIPv4(value) &&
          (/^(?:10\.|192\.168\.)/.test(value) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value)),
        '请输入私有局域网 IPv4 地址',
      )
      .optional(),
    defaultAgent: z.enum(['codex', 'claude', 'opencode']).default('codex'),
    defaultInstructions: instructionsSchema.optional(),
    topicRouterAgent: z.enum(['codex', 'claude']).optional(),
    defaultWorkspace: z.string().default('default'),
    workspaces: z.record(z.string(), z.string()).refine((v) => Object.keys(v).length > 0),
    agents: z
      .object({
        codex: z.object({ command: z.string().default('codex') }).default({ command: 'codex' }),
        claude: z.object({ command: z.string().optional() }).default({}),
        opencode: z
          .object({ command: z.string().default('opencode') })
          .default({ command: 'opencode' }),
      })
      .default({ codex: { command: 'codex' }, claude: {}, opencode: { command: 'opencode' } }),
    maxConcurrentRuns: z.number().int().min(1).max(32).default(4),
    turnTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .default(30 * 60 * 1000),
    interactionTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .default(10 * 60 * 1000),
    channels: z
      .array(
        z.discriminatedUnion('type', [
          z.object({
            ...access,
            type: z.literal('lark'),
            groupModes: z.record(groupIdSchema, groupModeSchema).optional(),
            appIdEnv: z.string(),
            appSecretEnv: z.string(),
            botOpenId: z.string().min(1),
            domain: z.enum(['feishu', 'lark']).default('feishu'),
          }),
          z.object({
            ...access,
            type: z.literal('dingtalk'),
            clientIdEnv: z.string(),
            clientSecretEnv: z.string(),
            cardTemplateId: z.string().trim().min(1).max(200).optional(),
          }),
          z.object({
            ...access,
            type: z.literal('wecom'),
            botIdEnv: z.string(),
            secretEnv: z.string(),
            contextGroups: z
              .array(
                z.string().regex(/^wr[A-Za-z0-9_-]{1,128}$/, '请输入企微群 chat_id（wr 开头）'),
              )
              .max(50)
              .optional(),
          }),
          z.object({
            ...access,
            type: z.literal('wechat'),
            botIdEnv: z.string(),
            tokenEnv: z.string(),
            baseUrl: z
              .string()
              .default(WECHAT_BASE)
              .refine((value) => {
                try {
                  wechatBase(value);
                  return true;
                } catch {
                  return false;
                }
              }, '微信 API 地址无效'),
          }),
        ]),
      )
      .default([]),
  })
  .strict();
export type Config = z.infer<typeof schema>;
export type ChannelConfig = Config['channels'][number];

// Path values are absolute, ~/ or relative to the configuration file's directory.
function expandPath(value: string, base = process.cwd()): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return resolve(base, value);
}

export function loadConfig(file: string): Config {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const base = dirname(resolve(file));
  if (raw.dataDir === undefined) raw.dataDir = DEFAULT_DATA_DIRECTORY;
  const config = schema.parse(raw);
  config.dataDir = expandPath(config.dataDir, base);
  for (const [key, value] of Object.entries(config.workspaces)) {
    const path = realpathSync(expandPath(value, base));
    if (!statSync(path).isDirectory()) throw new Error(`工作目录不是文件夹: ${key}`);
    config.workspaces[key] = path;
  }
  if (!config.workspaces[config.defaultWorkspace])
    throw new Error('defaultWorkspace 不在 workspaces 中');
  for (const channel of config.channels) {
    if (channel.defaultWorkspace)
      channel.defaultWorkspace = sessionWorkspace(channel.defaultWorkspace, config.workspaces);
  }
  const ids = config.channels.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('channel id 必须唯一');
  return config;
}
export function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}
