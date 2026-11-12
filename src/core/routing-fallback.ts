import type { TopicDecision } from './topic-router.js';
// Conservative fallback: only framework control requests are held for explicit
// commands. Ordinary work stays in its current native session, verbatim.
export function needsExplicitManagement(text: string): boolean {
  const s = text.trim();
  if (
    /^(?:解释|介绍|为什么|如何实现|怎么实现|修复|开发|实现|优化|分析.*(?:报错|错误|问题))/.test(s)
  )
    return false;
  return (
    /(?:新建|创建|建个|建一个|开个|新开|另开|另起|切换|更换|重置|压缩|关闭|恢复|打开|停止|暂停|取消|设置|修改|调整|开启|启用|禁用).{0,24}(?:会话|话题|对话|上下文|session|工作目录|工作区|模型|审批策略|群模式|group[ -]?mode|机器人权限|管理权限|manager|scoped)/i.test(
      s,
    ) ||
    /(?:工作目录|工作区|模型|审批策略|群模式|group[ -]?mode).{0,18}(?:改为|改成|切换|设置|换成)/i.test(
      s,
    ) ||
    /\b(?:new|start|create|switch|reset|close|open)\b.{0,24}\b(?:session|thread|workspace|model)\b/i.test(
      s,
    ) ||
    /^(?:请|帮我|麻烦)?(?:换个地方|另开一个|另外开|重新开始|清空上下文)/.test(s)
  );
}
export function fallbackDecision(text: string): TopicDecision {
  const attachment =
    !/(?:不要|别|取消|不用|如何|怎么实现|修复|开发|功能|代码)/.test(text) &&
    /(?:分析|读取|下载|识别|查看|看看|处理|转换|转成|总结).{0,30}(?:附件|文件|图片|这个图)|(?:这个|那个|刚才|上一个|最近).{0,8}(?:附件|文件|图片).{0,30}(?:分析|读取|下载|识别|处理|转换|转成|总结)/.test(
      text,
    );
  return {
    action: attachment ? 'attachment_request' : 'continue',
    task: null,
    agent: null,
    instructions: null,
    workspace: null,
    management: null,
  };
}
