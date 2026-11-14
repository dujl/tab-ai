import { input, password, select, confirm } from '@inquirer/prompts';
import QRCode from 'qrcode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../config.js';
import { SetupService, type SetupInput, type SetupView } from './service.js';
import { GUIDES } from './providers.js';
import { type SetupStorage } from './storage.js';
import { lockDirectory } from '../runtime.js';

export interface SetupClient {
  info(): Promise<{ current?: SetupView; drafts: ReturnType<SetupStorage['drafts']> }>;
  start(input: SetupInput): Promise<SetupView>;
  status(id: string): Promise<SetupView>;
  confirm(id: string): Promise<SetupView>;
  verify(id: string, code: string): Promise<SetupView>;
  cancel(id: string): Promise<SetupView>;
  close(): Promise<void>;
}
export async function setupClient(configFile: string): Promise<SetupClient> {
  const config = loadConfig(configFile);
  let token = '';
  try {
    token = readFileSync(join(config.dataDir, 'token'), 'utf8').trim();
  } catch {
    /* First run. */
  }
  const call = async (path: string, data?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/setup${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(20_000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error((value as { error: string }).error);
    return value;
  };
  if (token) {
    let available = false;
    try {
      const info = await call('');
      available = !!info && typeof info === 'object' && 'drafts' in info;
    } catch {
      /* Try exclusive standalone mode below. */
    }
    if (available)
      return {
        info: () => call(''),
        start: (data) => call('/start', data),
        status: (id) => call(`/${id}`),
        verify: (id, code) => call(`/${id}/verify`, { code }),
        confirm: (id) => call(`/${id}/confirm`, {}),
        cancel: (id) => call(`/${id}/cancel`, {}),
        close: async () => {},
      };
  }
  const unlock = lockDirectory(config.dataDir),
    service = new SetupService(configFile);
  return {
    info: async () => ({ current: service.current(), drafts: service.storage.drafts() }),
    start: async (data) => service.start(data),
    status: async (id) => service.status(id),
    verify: async (id, code) => service.verify(id, { code }),
    confirm: (id) => service.confirm(id),
    cancel: (id) => service.cancel(id),
    close: async () => {
      try {
        await service.close();
      } finally {
        unlock();
      }
    },
  };
}
export async function runWizard(configFile: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      '交互向导需要终端。无终端时先用 init --local，再启动 serve，通过 dashboard 的“接入机器人”完成。',
    );
  const client = await setupClient(configFile);
  const controller = new AbortController(),
    context = { signal: controller.signal };
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let attempt: SetupView | undefined;
  try {
    const info = await client.info();
    if (
      info.current &&
      !['complete', 'cancelled', 'expired', 'error'].includes(info.current.phase)
    ) {
      if (await confirm({ message: '有一个未完成的接入向导，继续？', default: true }, context))
        attempt = info.current;
      else {
        console.log('保留现有向导。');
        return;
      }
    }
    if (!attempt) {
      const type = await select(
        {
          message: '接入哪个聊天平台？',
          choices: [
            { name: '飞书 / Lark（支持扫码创建）', value: 'lark' as const },
            { name: '微信（扫码登录）', value: 'wechat' as const },
            { name: '钉钉（支持扫码创建）', value: 'dingtalk' as const },
            { name: '企业微信（支持扫码创建）', value: 'wecom' as const },
          ],
        },
        context,
      );
      const drafts = info.drafts.filter((d) => d.type === type);
      const choices = [
        ...drafts.map((d) => ({
          name: `继续未完成配置 · ${d.credentialId}`,
          value: `draft:${d.id}`,
        })),
        ...(['lark', 'wechat', 'wecom', 'dingtalk'].includes(type)
          ? [
              {
                name:
                  type === 'wechat'
                    ? '微信扫码登录'
                    : type === 'wecom'
                      ? '企业微信扫码创建 / 授权（推荐）'
                      : type === 'dingtalk'
                        ? '钉钉扫码创建 / 绑定（推荐）'
                        : '扫码创建新机器人（推荐）',
                value: 'qr',
              },
            ]
          : []),
        ...(type === 'wechat' ? [] : [{ name: '接入已有机器人，按提示填写凭证', value: 'manual' }]),
      ];
      const mode = await select({ message: '选择接入方式', choices }, context);
      const domain =
        type === 'lark' && !mode.startsWith('draft:')
          ? await select(
              {
                message: '选择区域',
                choices: [
                  { name: '飞书（中国版）', value: 'feishu' as const },
                  { name: 'Lark（国际版）', value: 'lark' as const },
                ],
              },
              context,
            )
          : 'feishu';
      let request: SetupInput;
      if (mode.startsWith('draft:')) request = { type, mode: 'draft', draftId: mode.slice(6) };
      else if (mode === 'qr') request = { type, mode: 'qr', domain };
      else {
        const guide = GUIDES[type];
        console.log(
          `\n${guide.title} 开通步骤：\n${guide.url}\n${guide.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`,
        );
        if (!(await confirm({ message: '已准备好机器人凭证，继续？', default: true }, context)))
          return;
        const credentialId = await input(
          {
            message:
              type === 'wecom' ? 'Bot ID' : type === 'lark' ? 'App ID' : 'Client ID / AppKey',
            validate: (value) => !!value.trim() || '不能为空',
          },
          context,
        );
        const credentialSecret = await password(
          {
            message:
              type === 'wecom'
                ? 'Secret'
                : type === 'lark'
                  ? 'App Secret'
                  : 'Client Secret / AppSecret',
            mask: '*',
            validate: (value) => !!value.trim() || '不能为空',
          },
          context,
        );
        request = { type, mode: 'manual', domain, credentialId, credentialSecret };
        if (type === 'dingtalk') {
          const template = await input(
            { message: 'tab-ai 卡片模板 ID（可选，留空使用文字回答）' },
            context,
          );
          if (template.trim()) request.cardTemplateId = template.trim();
        }
      }
      request.manager = await select(
        {
          message: '此 BOT 的会话管理权限',
          choices: [
            { name: '普通 BOT：仅当前用户、当前聊天的主会话及子会话', value: false },
            { name: 'Manager：允许已绑定用户查看和管理本实例全部会话', value: true },
          ],
        },
        context,
      );
      attempt = await client.start(request);
    }
    let signature = '';
    while (attempt) {
      controller.signal.throwIfAborted();
      const key = JSON.stringify([
        attempt.phase,
        attempt.url,
        attempt.pairCommand,
        attempt.message,
        attempt.permission?.url,
      ]);
      if (signature !== key) {
        signature = key;
        console.log(`\n${attempt.message}`);
        if (attempt.url) {
          console.log(await QRCode.toString(attempt.url, { type: 'terminal', small: true }));
          console.log(
            `授权链接（微信请用手机扫码）：\n${attempt.url}\n链接只用于本次授权，请勿转发。`,
          );
        }
        if (attempt.permission) {
          console.log(
            `\n请打开当前应用的权限申请入口，申请群消息权限并完成发布审核：\n${attempt.permission.url}`,
          );
          console.log(
            await QRCode.toString(attempt.permission.url, { type: 'terminal', small: true }),
          );
        }
        if (attempt.pairCommand)
          console.log(`\n${attempt.pairCommand}\n\n请复制到机器人私聊。不要发在群里。`);
      }
      if (attempt.needsVerifyCode) {
        const code = await input(
          {
            message: '输入微信手机端显示的验证码',
            validate: (value) =>
              (value.trim().length > 0 &&
                value.trim().length <= 128 &&
                !/[\x00-\x1f]/.test(value.trim())) ||
              '请输入手机端显示的验证码',
          },
          context,
        );
        attempt = await client.verify(attempt.id, code.trim());
        continue;
      }
      if (attempt.phase === 'paired') {
        const accepted = await confirm(
          {
            message: `绑定用户 ${attempt.candidate!.sender}，允许通过此机器人使用本机 agent？`,
            default: true,
          },
          context,
        );
        attempt = accepted ? await client.confirm(attempt.id) : await client.cancel(attempt.id);
        console.log(attempt.message);
        break;
      }
      if (['error', 'expired', 'cancelled', 'complete'].includes(attempt.phase)) {
        if (['error', 'expired'].includes(attempt.phase)) process.exitCode = 1;
        break;
      }
      await delay(1000, undefined, context);
      attempt = await client.status(attempt.id);
    }
  } finally {
    try {
      if (attempt && !['complete', 'cancelled', 'expired', 'error'].includes(attempt.phase))
        await client.cancel(attempt.id).catch(() => {});
      await client.close();
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}
