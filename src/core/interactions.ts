import { elicitationValue } from './mcp-elicitation.js';
import { approvalAction, approvalOptions } from './approval-decisions.js';
import { approvalSummaryText } from './approvals.js';
import { type Answer, type Interaction, type Question } from './types.js';

export class InteractionTimeoutError extends Error {
  constructor(
    readonly notificationSessionId: string,
    kind: Interaction['kind'],
  ) {
    super(kind === 'approval' ? '等待确认超时；未自动批准。' : '等待回答超时；未自动代答。');
  }
}
export function interactionTimeoutText(request: Interaction): string {
  const approval = request.kind === 'approval';
  return `【tab-ai · ${approval ? '审批' : '提问'}已超时】\n${approval ? '审批' : '提问'}编号：${request.id.slice(0, 8)}\n${request.title}\n${approval ? '本次待审批操作未获批准，不会因超时自动执行。' : request.mode === 'async' ? '未提交回答，也没有自动代答；Agent 可继续当前分析。' : '未提交回答，本次等待已结束。'}\n旧卡片已失效，请勿继续点击。${request.mode === 'async' ? '可在本轮结束后重新补充要求。' : '如需继续，请重新说明要继续的任务。'}`;
}

export function validateValues(question: Question, values: string[]): void {
  if (question.inputSchema) {
    elicitationValue(question, values);
    return;
  }
  if (question.optional && !values.length) return;
  if (!values.length || values.some((v) => typeof v !== 'string' || !v.trim() || v.length > 8000))
    throw new Error(`请回答问题 ${question.id}（每项最多 8000 字）。`);
  if (!question.multiSelect && values.length !== 1)
    throw new Error(`问题 ${question.id} 只能提交一个答案。`);
  if (new Set(values).size !== values.length) throw new Error('请勿重复选择同一选项。');
  if (
    question.options?.length &&
    question.allowOther === false &&
    values.some((v) => !question.options!.includes(v))
  )
    throw new Error('请选择问题提供的选项。');
}
export function validateAnswer(request: Interaction, answer: Answer): void {
  if (request.kind === 'approval') {
    if (!('allow' in answer) || typeof answer.allow !== 'boolean')
      throw new Error('此请求需要允许或拒绝。');
    if (answer.scope !== undefined && !['once', 'session'].includes(answer.scope))
      throw Error('无效的审批范围');
    if (
      (!answer.allow && answer.scope !== undefined) ||
      (answer.cancel && answer.allow) ||
      (answer.cancel && answer.scope !== undefined)
    )
      throw Error('审批决定与范围不一致');
    if (!approvalOptions(request).some((o) => o.id === approvalAction(answer)))
      throw Error('此原生请求不支持所选审批范围');
    return;
  }
  if ('answers' in answer && answer.action !== undefined) {
    if (!request.elicitation || !['accept', 'decline', 'cancel'].includes(answer.action))
      throw Error('此请求不支持该交互决定');
    if (answer.action !== 'accept') {
      if (Object.keys(answer.answers).length) throw Error('拒绝或取消时不能附带表单数据');
      return;
    }
  }
  if (!('answers' in answer)) throw new Error('此请求需要问题答案。');
  const questions = request.questions ?? [];
  if (Object.keys(answer.answers).some((id) => !questions.some((q) => q.id === id)))
    throw new Error('包含未知问题的答案。');
  for (const question of questions) validateValues(question, answer.answers[question.id] ?? []);
}
export function interactionText(request: Interaction): string {
  const questions = request.questions
    ?.map(
      (q) =>
        `${q.id}: ${q.question}${q.options?.length ? `\n${q.multiSelect ? '多选' : '单选'}：\n` + q.options.map((o, i) => `${i + 1}. ${o}${q.descriptions?.[i] ? ' — ' + q.descriptions[i] : ''}`).join('\n') : ''}`,
    )
    .join('\n\n');
  const commands =
    request.kind === 'approval'
      ? approvalOptions(request)
          .map((o) => `${o.label}：/tab approve ${request.id} ${o.id}`)
          .join('\n')
      : `/tab answer ${request.id} ${JSON.stringify(Object.fromEntries((request.questions ?? []).map((q) => [q.id, ['你的回答']])))}`;
  return `${request.title}\n\n${request.elicitation ? request.detail + '\n\n' : ''}${questions || (request.kind === 'approval' ? approvalSummaryText(request) + `\n完整原文：/tab inspect ${request.id}` : request.detail)}\n\n${commands}${request.elicitation && request.kind === 'question' ? `\n拒绝：/tab answer ${request.id} decline\n取消：/tab answer ${request.id} cancel` : ''}\n仅当前任务发起人可回答，${request.mode === 'async' ? 'Agent 会继续分析；在有效期内提交后回答送回原会话，未选择不会自动代答。' : '超时不会自动批准。'}`;
}
