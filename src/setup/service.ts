import { larkPermissionUrl } from '../core/group-mode.js';
import { wechatBase, wechatQrUrl } from '../channels/wechat-api.js';
import { wecomQrUrl } from './wecom-registration.js';
import { dingtalkQrUrl } from './dingtalk-registration.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import QRCode from 'qrcode';
import { type ChannelConfig } from '../config.js';
import { type Channel, type Incoming } from '../core/types.js';
import { createChannel } from '../channels/factory.js';
import { type Draft, SetupStorage, credentialResolver, type SecretResolver } from './storage.js';
import {
  providers,
  LARK_SCOPES,
  safeSetupError,
  SetupError,
  type SetupProviders,
} from './providers.js';

export const setupInput = z
  .object({
    manager: z.boolean().optional(),
    type: z.enum(['lark', 'dingtalk', 'wecom', 'wechat']),
    mode: z.enum(['qr', 'manual', 'draft']),
    domain: z.enum(['feishu', 'lark']).default('feishu'),
    credentialId: z.string().trim().min(1).max(512).optional(),
    credentialSecret: z.string().trim().min(1).max(4096).optional(),
    draftId: z.string().uuid().optional(),
    cardTemplateId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === 'wechat' && v.mode === 'manual')
      ctx.addIssue({ code: 'custom', message: '微信请使用扫码登录。' });
    if (v.mode === 'manual' && (!v.credentialId || !v.credentialSecret))
      ctx.addIssue({ code: 'custom', message: '请输入机器人凭证。' });
    if (v.mode === 'draft' && !v.draftId)
      ctx.addIssue({ code: 'custom', message: '请选择要继续的配置。' });
  });
export type SetupInput = z.input<typeof setupInput>;
export interface SetupView {
  id: string;
  type: 'lark' | 'dingtalk' | 'wecom' | 'wechat';
  phase:
    | 'authorizing'
    | 'checking'
    | 'pairing'
    | 'testing'
    | 'paired'
    | 'saving'
    | 'complete'
    | 'cancelled'
    | 'expired'
    | 'error';
  permission?: { url: string; qrDataUrl: string; scopes: string[] };
  needsVerifyCode?: boolean;
  expiresAt: number;
  url?: string;
  qrDataUrl?: string;
  name?: string;
  pairCommand?: string;
  candidate?: { sender: string; conversation: string };
  message: string;
  channelId?: string;
}
interface Attempt {
  view: SetupView;
  controller: AbortController;
  timer: NodeJS.Timeout;
  draft?: Draft;
  config?: ChannelConfig;
  channel?: Channel;
  values?: Record<string, string>;
  route?: Incoming;
  adopted: boolean;
  verifyResolve?: (code: string) => void;
}
interface Dependencies {
  providers: SetupProviders;
  channel(config: ChannelConfig, resolver: SecretResolver): Channel;
  receive?(message: Incoming): Promise<void>;
  adopt?(config: ChannelConfig, channel: Channel): void;
  timeoutMs?: number;
}
const terminal = new Set(['complete', 'cancelled', 'expired', 'error']);
export class SetupService {
  private active?: Attempt;
  readonly storage: SetupStorage;
  private deps: Dependencies;
  constructor(configFile: string, deps: Partial<Dependencies> = {}) {
    this.storage = new SetupStorage(configFile);
    this.deps = {
      providers,
      channel: (config, resolver) => createChannel(config, resolver, this.storage.config().dataDir),
      ...deps,
    };
  }
  current(): SetupView | undefined {
    return this.active ? this.view(this.active) : undefined;
  }
  private view(attempt: Attempt): SetupView {
    return structuredClone(attempt.view);
  }
  status(id: string): SetupView {
    if (this.active?.view.id !== id) throw new SetupError('接入记录不存在，请重新开始。');
    return this.view(this.active);
  }
  start(raw: unknown): SetupView {
    const input = setupInput.parse(raw);
    if (this.active && !terminal.has(this.active.view.phase))
      throw new SetupError('已有接入向导进行中，请继续或取消后重试。');
    const id = randomUUID(),
      duration = this.deps.timeoutMs ?? 10 * 60_000;
    const attempt: Attempt = {
      view: {
        id,
        type: input.type,
        phase: input.mode === 'qr' ? 'authorizing' : 'checking',
        message: input.mode === 'qr' ? '正在获取平台授权链接…' : '正在验证机器人…',
        expiresAt: Date.now() + duration,
      },
      controller: new AbortController(),
      timer: setTimeout(() => {
        void this.expire(id);
      }, duration),
      adopted: false,
    };
    this.active = attempt;
    void this.prepare(attempt, input).catch(async (error) => {
      if (attempt.controller.signal.aborted || terminal.has(attempt.view.phase)) return;
      const detail = safeSetupError(error);
      const stage = attempt.view.phase === 'checking' ? '连接校验未完成：' : '';
      console.error(`[setup:${attempt.view.type}] ${attempt.view.phase}: ${detail}`);
      await this.finish(attempt, 'error', stage + detail);
    });
    return this.view(attempt);
  }
  private async prepare(attempt: Attempt, input: z.infer<typeof setupInput>): Promise<void> {
    const signal = attempt.controller.signal;
    let draft: Draft;
    if (input.mode === 'draft') {
      draft = this.storage.draft(input.draftId!);
      if (draft.type !== input.type) throw new SetupError('配置平台不匹配。');
    } else if (input.mode === 'qr' && input.type === 'wechat') {
      if (!this.deps.providers.wechatLogin)
        throw new SetupError('当前实例不支持微信扫码，请更新服务。');
      const result = await this.deps.providers.wechatLogin(
        signal,
        (url, seconds) => {
          if (signal.aborted) return;
          attempt.view.url = wechatQrUrl(url);
          void QRCode.toDataURL(url, { width: 400, margin: 2 })
            .then((image) => {
              if (!signal.aborted && attempt.view.url === url) attempt.view.qrDataUrl = image;
            })
            .catch(() => {});
          attempt.view.expiresAt = Math.min(attempt.view.expiresAt, Date.now() + seconds * 1000);
          attempt.view.message = '请用微信扫码，在手机上确认登录。';
        },
        () => this.waitForVerification(attempt),
      );
      draft = {
        id: attempt.view.id,
        type: 'wechat',
        domain: 'feishu',
        credentialId: result.botId,
        credentialSecret: result.token,
        baseUrl: wechatBase(result.baseUrl),
        expectedUserId: result.userId,
        createdAt: Date.now(),
      };
      this.storage.saveDraft(draft);
    } else if (input.mode === 'qr' && input.type === 'dingtalk') {
      if (!this.deps.providers.dingtalkRegister)
        throw new SetupError('当前实例不支持钉钉扫码，请更新服务。');
      const name = this.storage.reserveBotName();
      attempt.view.name = name;
      const result = await this.deps.providers.dingtalkRegister(signal, (url, seconds) => {
        if (signal.aborted) return;
        attempt.view.url = dingtalkQrUrl(url);
        void QRCode.toDataURL(url, { width: 400, margin: 2 })
          .then((image) => {
            if (!signal.aborted && attempt.view.url === url) attempt.view.qrDataUrl = image;
          })
          .catch(() => {});
        attempt.view.expiresAt = Math.min(attempt.view.expiresAt, Date.now() + seconds * 1000);
        attempt.view.message = `请使用钉钉扫码，在手机上确认创建或绑定机器人；建议名称：${name}。凭证将自动保存，无需手工复制。钉钉名称需在官方页面设置，本地显示名会保存为此名称。`;
      });
      draft = {
        id: attempt.view.id,
        type: 'dingtalk',
        domain: 'feishu',
        credentialId: result.clientId,
        credentialSecret: result.clientSecret,
        createdAt: Date.now(),
        displayName: name,
        pairingMode: 'message',
        ...(input.cardTemplateId ? { cardTemplateId: input.cardTemplateId } : {}),
      };
      // Preserve issued credentials if cancellation raced with authorization.
      this.storage.saveDraft(draft);
    } else if (input.mode === 'qr' && input.type === 'wecom') {
      if (!this.deps.providers.wecomRegister)
        throw new SetupError('当前实例不支持企业微信扫码，请更新服务。');
      const result = await this.deps.providers.wecomRegister(signal, (url, seconds) => {
        if (signal.aborted) return;
        attempt.view.url = wecomQrUrl(url);
        void QRCode.toDataURL(url, { width: 400, margin: 2 })
          .then((image) => {
            if (!signal.aborted && attempt.view.url === url) attempt.view.qrDataUrl = image;
          })
          .catch(() => {});
        attempt.view.expiresAt = Math.min(attempt.view.expiresAt, Date.now() + seconds * 1000);
        attempt.view.message =
          '请使用企业微信扫码并在手机确认创建 / 授权；Bot ID 和 Secret 将自动保存，无需手工复制。';
      });
      draft = {
        id: attempt.view.id,
        type: 'wecom',
        domain: 'feishu',
        credentialId: result.botId,
        credentialSecret: result.secret,
        createdAt: Date.now(),
        pairingMode: 'message',
      };
      // Preserve issued credentials even if cancellation raced with the remote authorization.
      this.storage.saveDraft(draft);
    } else if (input.mode === 'qr') {
      const name = this.storage.reserveBotName();
      attempt.view.name = name;
      const result = await this.deps.providers.register(
        input.domain,
        signal,
        (url, seconds) => {
          if (signal.aborted) return;
          // Only expose vendor authentication links, never arbitrary URLs from an upstream response.
          const parsed = new URL(url);
          const accountPage = ['accounts.feishu.cn', 'accounts.larksuite.com'].includes(
            parsed.hostname,
          );
          const launcherPage =
            ['open.feishu.cn', 'open.larksuite.com'].includes(parsed.hostname) &&
            parsed.pathname === '/page/launcher';
          if (
            parsed.protocol !== 'https:' ||
            parsed.port ||
            parsed.username ||
            parsed.password ||
            (!accountPage && !launcherPage)
          )
            throw new SetupError('平台返回的授权链接无效。');
          attempt.view.url = url;
          void QRCode.toDataURL(url, { width: 400, margin: 2 })
            .then((image) => {
              if (!signal.aborted && attempt.view.url === url) attempt.view.qrDataUrl = image;
            })
            .catch(() => {});
          attempt.view.expiresAt = Math.min(attempt.view.expiresAt, Date.now() + seconds * 1000);
          attempt.view.message = '用飞书 / Lark 扫码或打开链接，确认创建 tab-ai 应用及所需权限。';
        },
        name,
      );
      draft = {
        id: attempt.view.id,
        type: 'lark',
        credentialId: result.client_id,
        credentialSecret: result.client_secret,
        domain: result.user_info?.tenant_brand ?? input.domain,
        expectedUserId: result.user_info?.open_id,
        createdAt: Date.now(),
        displayName: name,
      };
      // Registration has a remote side effect. Keep recoverable credentials even if pairing is cancelled.
      this.storage.saveDraft(draft);
    } else {
      draft = {
        id: attempt.view.id,
        type: input.type,
        credentialId: input.credentialId!,
        credentialSecret: input.credentialSecret!,
        domain: input.domain,
        createdAt: Date.now(),
        ...(input.type === 'dingtalk' && input.cardTemplateId
          ? { cardTemplateId: input.cardTemplateId }
          : {}),
      };
    }
    signal.throwIfAborted();
    if (draft.type === 'wechat' && (!draft.expectedUserId || !draft.baseUrl))
      throw new SetupError('微信登录信息不完整，请重新扫码。');
    draft.manager = input.manager ?? draft.manager ?? false;
    attempt.draft = draft;
    this.rejectDuplicate(draft);
    attempt.view.phase = 'checking';
    attempt.view.url = undefined;
    attempt.view.qrDataUrl = undefined;
    attempt.view.message = '正在验证身份和连接…';
    const identity = await this.deps.providers.identify(draft, signal);
    signal.throwIfAborted();
    if (draft.type === 'lark') {
      draft.displayName = identity.name;
      if (input.mode !== 'qr') {
        const url = larkPermissionUrl(draft.credentialId, draft.domain, LARK_SCOPES);
        if (url)
          attempt.view.permission = {
            url,
            qrDataUrl: await QRCode.toDataURL(url, { width: 320, margin: 2 }),
            scopes: [...LARK_SCOPES],
          };
      }
    }
    this.storage.saveDraft(draft);
    const prefix = `TAB_AI_SETUP_${attempt.view.id.replaceAll('-', '').toUpperCase()}`;
    const idKey = `${prefix}_ID`,
      secretKey = `${prefix}_SECRET`;
    const common = {
      manager: draft.manager ?? false,
      id: `${draft.type}-${draft.id.slice(0, 8)}`,
      allowedUsers: draft.type === 'wechat' ? [draft.expectedUserId!] : ([] as string[]),
      ...(draft.displayName ? { displayName: draft.displayName } : {}),
    };
    const channelConfig: ChannelConfig =
      draft.type === 'lark'
        ? {
            ...common,
            type: 'lark',
            appIdEnv: idKey,
            appSecretEnv: secretKey,
            domain: draft.domain,
            botOpenId: identity.botOpenId!,
          }
        : draft.type === 'dingtalk'
          ? {
              ...common,
              type: 'dingtalk',
              clientIdEnv: idKey,
              clientSecretEnv: secretKey,
              ...(draft.cardTemplateId ? { cardTemplateId: draft.cardTemplateId } : {}),
            }
          : draft.type === 'wechat'
            ? {
                ...common,
                type: 'wechat',
                botIdEnv: idKey,
                tokenEnv: secretKey,
                baseUrl: wechatBase(draft.baseUrl!),
              }
            : { ...common, type: 'wecom', botIdEnv: idKey, secretEnv: secretKey };
    if (channelConfig.type === 'lark' && !channelConfig.botOpenId)
      throw new SetupError('无法获取机器人 ID，请检查机器人能力。');
    attempt.config = channelConfig;
    attempt.values = { [idKey]: draft.credentialId, [secretKey]: draft.credentialSecret };
    // Capture a private immutable credential snapshot; later scrub the wizard's copy.
    const values = { ...attempt.values };
    const channel = this.deps.channel(channelConfig, (key) => values[key]!);
    attempt.channel = channel;
    await channel.start(async (message) => {
      if (attempt.adopted) return this.deps.receive?.(message);
      await this.pair(attempt, message);
    });
    if (signal.aborted) {
      await channel.stop();
      return;
    }
    attempt.view.name = draft.displayName ?? identity.name;
    attempt.view.phase = 'pairing';
    const messagePairing = this.messagePairing(draft);
    attempt.view.pairCommand = messagePairing
      ? undefined
      : `/tab pair ${randomBytes(16).toString('hex')}`;
    attempt.view.message =
      draft.type === 'wechat'
        ? '请用刚才扫码的微信账号，私聊机器人发送任意文字；收到测试回执后确认启用。'
        : messagePairing
          ? `请用你的${draft.type === 'dingtalk' ? '钉钉' : '企业微信'}账号私聊机器人发送“你好”等任意文字，无需配对命令；收到回执后，在这里核对账号并确认启用。`
          : '请私聊机器人发送下方配对命令。收到回执后，在这里确认绑定。';
    clearTimeout(attempt.timer);
    const duration = this.deps.timeoutMs ?? 5 * 60_000;
    attempt.view.expiresAt = Date.now() + duration;
    attempt.timer = setTimeout(() => {
      void this.expire(attempt.view.id);
    }, duration);
  }
  private rejectDuplicate(draft: Draft): void {
    const config = this.storage.config(),
      resolve = credentialResolver(config);
    for (const channel of config.channels) {
      if (channel.type !== draft.type) continue;
      const key =
        channel.type === 'lark'
          ? channel.appIdEnv
          : channel.type === 'dingtalk'
            ? channel.clientIdEnv
            : channel.botIdEnv;
      let existing: string | undefined;
      try {
        existing = resolve(key);
      } catch {
        continue;
      }
      if (
        existing === draft.credentialId &&
        (channel.type !== 'lark' || channel.domain === draft.domain)
      )
        throw new SetupError('这个机器人已经接入，不能重复建立连接。');
    }
  }
  private messagePairing(draft?: Draft): boolean {
    return (
      draft?.type === 'wechat' ||
      ((draft?.type === 'wecom' || draft?.type === 'dingtalk') && draft.pairingMode === 'message')
    );
  }
  private async pair(attempt: Attempt, message: Incoming): Promise<void> {
    if (
      attempt.view.phase !== 'pairing' ||
      attempt.controller.signal.aborted ||
      Date.now() > attempt.view.expiresAt
    )
      return;
    if (
      !message.direct ||
      message.route.platform !== attempt.config?.type ||
      message.route.account !== attempt.config.id
    )
      return;
    if (attempt.draft?.expectedUserId && message.route.sender !== attempt.draft.expectedUserId)
      return;
    if (!this.messagePairing(attempt.draft)) {
      const input = Buffer.from(message.text.trim()),
        expected = Buffer.from(attempt.view.pairCommand!);
      if (input.length !== expected.length || !timingSafeEqual(input, expected)) return;
    } else if (!message.text.trim()) return;
    attempt.view.phase = 'testing'; // One candidate wins; no duplicate reply sends.
    try {
      await attempt.channel!.send(
        message,
        'tab-ai 双向连接测试成功。请回到安装向导确认绑定，确认前不会执行任何 agent 任务。',
      );
      if (attempt.controller.signal.aborted) return;
      attempt.route = message;
      attempt.view.candidate = {
        sender: message.route.sender,
        conversation: message.route.conversation,
      };
      attempt.view.pairCommand = undefined;
      attempt.view.phase = 'paired';
      attempt.view.message =
        '已收到你的消息，机器人回执发送成功。确认后，此用户可通过机器人操作本机 agent。';
    } catch {
      await this.finish(
        attempt,
        'error',
        '已收到配对消息，但发送回执失败或结果未知。请检查发送权限，重新配对；未启用机器人。',
      );
    }
  }
  private waitForVerification(attempt: Attempt): Promise<string> {
    const signal = attempt.controller.signal;
    signal.throwIfAborted();
    attempt.view.needsVerifyCode = true;
    attempt.view.message = '请在下方输入微信手机端显示的验证码。验证码仅提交给微信。';
    return new Promise((resolve, reject) => {
      const abort = () => {
        attempt.verifyResolve = undefined;
        reject(new SetupError('扫码已取消'));
      };
      signal.addEventListener('abort', abort, { once: true });
      attempt.verifyResolve = (code) => {
        signal.removeEventListener('abort', abort);
        attempt.verifyResolve = undefined;
        attempt.view.needsVerifyCode = false;
        attempt.view.message = '验证码已提交，等待微信确认…';
        resolve(code);
      };
    });
  }
  verify(id: string, raw: unknown): SetupView {
    const code = z
      .object({
        code: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .refine((value) => !/[\x00-\x1f]/.test(value)),
      })
      .strict()
      .parse(raw).code;
    const attempt = this.active;
    if (
      !attempt ||
      attempt.view.id !== id ||
      !attempt.verifyResolve ||
      attempt.controller.signal.aborted ||
      Date.now() > attempt.view.expiresAt
    )
      throw new SetupError('当前没有待提交的微信验证码。');
    attempt.verifyResolve(code);
    return this.view(attempt);
  }
  async confirm(id: string): Promise<SetupView> {
    const attempt = this.active;
    if (!attempt || attempt.view.id !== id) throw new SetupError('接入记录不存在。');
    if (attempt.view.phase === 'complete') return this.view(attempt); // HTTP retries must not duplicate activation.
    if (
      attempt.view.phase !== 'paired' ||
      !attempt.route ||
      !attempt.config ||
      !attempt.values ||
      !attempt.draft
    )
      throw new SetupError('请先完成双向配对，再确认绑定。');
    if (Date.now() > attempt.view.expiresAt) {
      await this.expire(id);
      throw new SetupError('配对已过期，请重新开始。');
    }
    attempt.view.phase = 'saving';
    clearTimeout(attempt.timer);
    try {
      this.rejectDuplicate(attempt.draft);
      const channelConfig = { ...attempt.config, allowedUsers: [attempt.route.route.sender] };
      this.storage.commit(channelConfig, attempt.values, attempt.draft.id);
      if (this.deps.adopt) {
        this.deps.adopt(channelConfig, attempt.channel!);
        attempt.adopted = true;
      } else await attempt.channel!.stop();
      attempt.view.phase = 'complete';
      attempt.view.channelId = channelConfig.id;
      attempt.view.message = attempt.adopted
        ? '机器人已接入，现在可以发送任务。'
        : '机器人已配置完成。启动 tab-ai serve 后即可发送任务。';
      this.scrub(attempt);
      return this.view(attempt);
    } catch (error) {
      await this.finish(
        attempt,
        'error',
        error instanceof SetupError
          ? error.message
          : '保存或启用未完成，请检查配置文件与磁盘状态。',
      );
      throw new SetupError(attempt.view.message);
    }
  }
  async cancel(id: string): Promise<SetupView> {
    if (this.active?.view.id !== id) throw new SetupError('接入记录不存在。');
    if (this.active.view.phase === 'complete') return this.view(this.active);
    if (this.active.view.phase === 'saving') throw new SetupError('正在保存确认结果，请等待完成。');
    await this.finish(
      this.active,
      'cancelled',
      '已取消本地接入。已创建的平台应用不会自动删除；可从未完成配置继续。',
    );
    return this.view(this.active);
  }
  private async expire(id: string): Promise<void> {
    if (this.active?.view.id === id && !terminal.has(this.active.view.phase))
      await this.finish(
        this.active,
        'expired',
        '接入已超时，未授权用户。可继续未完成配置，或重新获取授权链接。',
      );
  }
  private scrub(attempt: Attempt): void {
    attempt.values = undefined;
    attempt.draft = undefined;
    attempt.view.needsVerifyCode = false;
    attempt.view.url = undefined;
    attempt.view.qrDataUrl = undefined;
    attempt.view.pairCommand = undefined;
  }
  private async finish(
    attempt: Attempt,
    phase: SetupView['phase'],
    message: string,
  ): Promise<void> {
    clearTimeout(attempt.timer);
    attempt.view.phase = phase;
    attempt.view.message = message;
    attempt.controller.abort();
    if (!attempt.adopted) await attempt.channel?.stop().catch(() => {});
    this.scrub(attempt);
  }
  async close(): Promise<void> {
    if (this.active && !terminal.has(this.active.view.phase))
      await this.cancel(this.active.view.id);
  }
}
