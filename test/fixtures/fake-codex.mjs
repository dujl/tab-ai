#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const complete = (text) => {
  send({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
  send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
};
let mode = '';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(join(process.cwd(), 'rpc-trace.jsonl'), line + '\n');
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
  else if (message.method === 'config/read')
    send({
      id: message.id,
      result: { config: { developer_instructions: 'Native configured developer instructions' } },
    });
  else if (message.method === 'model/list')
    send({
      id: message.id,
      result: {
        data: [
          {
            model: message.params.cursor ? 'model-b' : 'model-a',
            displayName: message.params.cursor ? 'Model B' : 'Model A',
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Low' },
              { reasoningEffort: 'high', description: 'High' },
            ],
          },
        ],
        nextCursor: message.params.cursor ? null : 'page-2',
      },
    });
  else if (['thread/start', 'thread/resume'].includes(message.method)) {
    if (
      message.method === 'thread/resume' &&
      existsSync(join(process.cwd(), 'compact-mode')) &&
      readFileSync(join(process.cwd(), 'compact-mode'), 'utf8') === 'usage'
    )
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'native-test-1',
          turnId: 'previous-turn',
          tokenUsage: {
            last: {
              inputTokens: 99000,
              cachedInputTokens: 90000,
              outputTokens: 1000,
              totalTokens: 100000,
            },
            total: {
              inputTokens: 199000,
              cachedInputTokens: 180000,
              outputTokens: 1000,
              totalTokens: 200000,
            },
            modelContextWindow: 200000,
          },
        },
      });
    send({ id: message.id, result: { thread: { id: 'native-test-1' } } });
  } else if (message.method === 'thread/goal/get') {
    const file = join(process.cwd(), 'goal.json');
    send({
      id: message.id,
      result: { goal: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null },
    });
  } else if (message.method === 'thread/goal/clear') {
    writeFileSync(join(process.cwd(), 'goal.json'), 'null');
    send({ id: message.id, result: {} });
  } else if (message.method === 'thread/compact/start') {
    const mode = existsSync(join(process.cwd(), 'compact-mode'))
      ? readFileSync(join(process.cwd(), 'compact-mode'), 'utf8')
      : 'complete';
    if (mode === 'rpc-error') {
      send({
        id: message.id,
        error: { code: -32001, message: 'authentication failed Bearer private-token' },
      });
      return;
    }
    const params = { threadId: message.params.threadId, turnId: 'compact-turn' };
    send({
      method: 'turn/started',
      params: { threadId: params.threadId, turn: { id: 'compact-turn', status: 'inProgress' } },
    });
    if (mode === 'usage') {
      const tokenUsage = {
        last: {
          inputTokens: 19500,
          cachedInputTokens: 10000,
          outputTokens: 500,
          totalTokens: 20000,
        },
        total: {
          inputTokens: 303500,
          cachedInputTokens: 190000,
          outputTokens: 1500,
          totalTokens: 305000,
        },
        modelContextWindow: 200000,
      };
      send({ method: 'thread/tokenUsage/updated', params: { ...params, tokenUsage } });
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          ...params,
          threadId: 'foreign',
          tokenUsage: { ...tokenUsage, last: { ...tokenUsage.last, totalTokens: 999999 } },
        },
      });
    }
    if (mode !== 'hang') {
      if (mode !== 'missing')
        send({
          method: 'item/completed',
          params: { ...params, item: { type: 'contextCompaction', id: 'compact-item' } },
        });
      send({
        method: 'turn/completed',
        params: {
          threadId: params.threadId,
          turn: {
            id: 'compact-turn',
            status: mode === 'failed' ? 'failed' : 'completed',
            ...(mode === 'failed' ? { error: { message: 'native compact failed' } } : {}),
          },
        },
      });
    }
    send({ id: message.id, result: {} });
  } else if (message.method === 'turn/start') {
    const text = message.params.input[0].text;
    mode = text;
    send({ method: 'turn/started', params: { turn: { id: 'turn-1', status: 'inProgress' } } });
    if (text === 'topic-report-fixture')
      send({
        id: 'topic-report-1',
        method: 'item/tool/call',
        params: {
          threadId: 'native-test-1',
          callId: 'topic-call',
          tool: 'topic_report',
          arguments: {
            kind: 'final',
            completionEvidence: '本话题整体目标已完成并验收',
            remainingWork: [],
            summary: 'Codex 已交付研究结论',
            artifacts: [],
            issues: [],
          },
        },
      });
    else if (text === 'approval')
      send({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'echo hello', threadId: 'native-test-1', turnId: 'turn-1' },
      });
    else if (text === 'question')
      send({
        id: 'question-1',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            {
              id: 'database',
              header: '数据库',
              question: '选择数据库',
              isOther: false,
              isSecret: false,
              options: [
                { label: 'SQLite', description: '本地文件' },
                { label: 'PostgreSQL', description: '独立服务' },
              ],
            },
          ],
        },
      });
    else if (text.startsWith('async-')) {
      const item = {
        type: 'agentMessage',
        id: 'async-question-1',
        text: '你指的是示例项目甲吗？\n- 是，项目甲\n- 指示例项目乙\n- 指示例项目丙',
        delivery: 'async',
        questions: [
          {
            title: '你指的是示例项目甲吗？',
            options: ['是，项目甲', '指示例项目乙', '指示例项目丙'],
          },
        ],
      };
      if (text === 'async-multiple')
        item.questions.push({ title: '分析哪个区间？', options: ['近一个月', '本季度'] });
      send({
        method: 'item/completed',
        params: { threadId: 'foreign-thread', turnId: 'turn-1', item },
      });
      send({
        method: 'item/completed',
        params: { threadId: 'native-test-1', turnId: 'turn-1', item },
      });
      send({
        method: 'item/completed',
        params: { threadId: 'native-test-1', turnId: 'turn-1', item },
      });
      if (text === 'async-complete') complete('先继续独立的分析。');
      else if (text === 'async-error')
        send({
          method: 'turn/completed',
          params: {
            turn: { id: 'turn-1', status: 'failed', error: { message: 'fixture failure' } },
          },
        });
    } else if (text === 'plans') {
      const plan = {
        threadId: 'native-test-1',
        turnId: 'turn-1',
        explanation: '先检查，再实现和验证',
        plan: [
          { step: '检查现状', status: 'inProgress' },
          { step: '实现功能', status: 'pending' },
        ],
      };
      send({ method: 'turn/plan/updated', params: { ...plan, threadId: 'foreign' } });
      send({ method: 'turn/plan/updated', params: { ...plan, turnId: 'foreign-turn' } });
      send({ method: 'turn/plan/updated', params: plan });
      send({
        method: 'turn/plan/updated',
        params: {
          ...plan,
          plan: [
            { step: '检查现状', status: 'completed' },
            { step: '实现功能', status: 'pending' },
          ],
        },
      });
      complete('本轮到此，下一轮继续');
    } else if (text === 'unknown')
      send({ id: 'unknown-1', method: 'new/unsafe/approval', params: {} });
    else if (text === 'tools') {
      const item = { id: 'tool-1', type: 'commandExecution', command: 'pwd', cwd: process.cwd() };
      send({
        method: 'item/started',
        params: { threadId: 'other-thread', item: { ...item, id: 'foreign' } },
      });
      send({ method: 'item/started', params: { threadId: 'native-test-1', item } });
      send({
        method: 'item/completed',
        params: {
          threadId: 'native-test-1',
          item: { ...item, aggregatedOutput: 'result', exitCode: 0, status: 'completed' },
        },
      });
      complete('done');
    } else if (text === 'hang') {
    } else complete(text);
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
  } else if (message.id === 'topic-report-1')
    complete(message.result.success ? '研究成果已提交，等待主会话汇总。' : '提交失败。');
  else if (message.id === 'approval-1') complete(message.result.decision);
  else if (message.id === 'question-1') complete(JSON.stringify(message.result));
  else if (message.method === 'turn/steer') {
    if (mode === 'async-steer-error')
      send({ id: message.id, error: { code: -32000, message: 'fixture delivery uncertain' } });
    else {
      send({ id: message.id, result: { turnId: 'turn-1' } });
      complete('收到补充：' + message.params.input[0].text);
    }
  } else if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });
});
