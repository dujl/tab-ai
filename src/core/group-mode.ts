import { z } from 'zod';
export const groupModeSchema = z.enum(['mention', 'context', 'auto']);
export type GroupMode = z.infer<typeof groupModeSchema>;
export const groupModeNames: Record<GroupMode, string> = {
  mention: '仅 @ 触发',
  context: '全量接收，仅 @ 回复',
  auto: '全量接收，自动响应',
};
export const groupIdSchema = z
  .string()
  .regex(/^oc_[A-Za-z0-9_-]{1,128}$/, '请输入飞书群 chat_id（oc_ 开头）');
export const groupModeInput = z.object({ chatId: groupIdSchema, mode: groupModeSchema }).strict();
export const groupModePermissionHint =
  'context / auto 需要飞书应用开通 im:message.group_msg 并发布生效；订阅 im.message.receive_v1。保存模式不代表平台已授权。';

export interface GroupPermission {
  status: 'ready' | 'missing' | 'unknown';
  scope: string;
  message: string;
  url?: string;
  qrDataUrl?: string;
  checkedAt: number;
}
export function larkPermissionUrl(
  appId: string,
  domain: 'feishu' | 'lark',
  scopes = ['im:message.group_msg'],
): string | undefined {
  if (!/^cli_[a-zA-Z0-9_-]+$/.test(appId)) return;
  const url = new URL(
    `https://${domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'}/app/${appId}/auth`,
  );
  url.searchParams.set('q', scopes.join(','));
  url.searchParams.set('op_from', 'openapi');
  url.searchParams.set('token_type', 'tenant');
  return url.toString();
}
