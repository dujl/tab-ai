import type { CardPrompt } from './cards.js';
import type { ToolRunView } from '../core/types.js';

export function interactionAppearance(prompt: CardPrompt) {
  const status = prompt.status;
  if (!status)
    return {
      color: prompt.question ? 'blue' : 'orange',
      label: prompt.question ? '待回答' : '待审批',
    };
  if (status.includes('超时')) return { color: 'red', label: status };
  if (status.includes('已拒绝')) return { color: 'red', label: '已拒绝' };
  if (status.includes('已允许')) return { color: 'green', label: '已允许 · 待执行结果' };
  if (status.includes('已提交') || status.includes('回答已提交'))
    return { color: 'green', label: '回答已提交' };
  if (status.includes('投递')) return { color: 'orange', label: '投递未确认' };
  return { color: 'grey', label: prompt.question ? '提问已结束' : '审批已结束 · 未批准' };
}

export function toolRunAppearance(view: ToolRunView) {
  if (view.status === 'running') return { color: 'blue', label: '执行中' };
  if (view.status === 'failed') return { color: 'red', label: '本轮失败' };
  if (view.status === 'interrupted') return { color: 'grey', label: '本轮已中断' };
  const failed = (t: ToolRunView['tools'][number]) =>
    t.status === 'failed' ||
    (t.status === 'completed' && t.exitCode !== undefined && t.exitCode !== 0);
  if (view.tools.some(failed))
    return view.tools.length === view.total && view.tools.every(failed)
      ? { color: 'red', label: '工具执行失败' }
      : { color: 'orange', label: '本轮已结束 · 含失败调用' };
  if (view.tools.some((t) => t.status !== 'completed') || view.tools.length < view.total)
    return { color: 'orange', label: '本轮已结束 · 部分结果未确认' };
  if (!view.total) return { color: 'grey', label: '本轮已结束 · 无工具调用' };
  return { color: 'green', label: '工具执行成功' };
}
