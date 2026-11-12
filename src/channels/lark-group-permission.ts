import { larkPermissionUrl, type GroupPermission } from '../core/group-mode.js';
// Probe a single message only to verify the app's effective group read scope.
// Message contents and credentials never leave this channel or enter Agent context.
export async function checkLarkGroupPermission(
  appId: string,
  domain: 'feishu' | 'lark',
  probe: () => Promise<{ code?: number; msg?: string }>,
): Promise<GroupPermission> {
  const result: GroupPermission = {
    status: 'unknown',
    scope: 'im:message.group_msg',
    message:
      '暂时无法确认群消息权限，请检查网络、机器人群成员身份和事件订阅；未确认免 @ 接收可用。',
    url: larkPermissionUrl(appId, domain),
    checkedAt: Date.now(),
  };
  let data: { code?: number; msg?: string } | undefined;
  try {
    data = await probe();
  } catch (error) {
    data = (error as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  }
  if (data?.code === 0)
    return {
      ...result,
      status: 'ready',
      message:
        '群消息读取权限已验证。请保持 im.message.receive_v1 事件订阅，实际推送仍由飞书平台负责。',
    };
  if (data && [230027, 99991672, 234009].includes(data.code ?? 0))
    return {
      ...result,
      status: 'missing',
      message:
        '群消息权限尚未就绪：请由应用开发者／管理员打开权限申请入口，申请 im:message.group_msg，发布版本并完成管理员审核；仅保存 group mode 不会开通权限。',
    };
  return result;
}

export async function permissionRequest<T>(request: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('permission check timeout')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
