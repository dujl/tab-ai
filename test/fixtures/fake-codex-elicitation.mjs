#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n'),
  threadId = 'native-mcp-test',
  turnId = 'mcp-turn';
let mode = '';
const complete = (text) => {
  send({
    method: 'item/completed',
    params: { threadId, turnId, item: { type: 'agentMessage', text } },
  });
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'completed' } },
  });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  appendFileSync(join(process.cwd(), 'elicitation-trace.jsonl'), line + '\n');
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  else if (m.method === 'config/read')
    send({ id: m.id, result: { config: { developer_instructions: '' } } });
  else if (['thread/start', 'thread/resume'].includes(m.method))
    send({ id: m.id, result: { thread: { id: threadId, cwd: process.cwd() } } });
  else if (m.method === 'turn/start') {
    mode = m.params.input[0].text;
    const params = JSON.parse(
      readFileSync(join(process.cwd(), 'elicitation-request.json'), 'utf8'),
    );
    send({
      method: 'turn/started',
      params: { threadId, turn: { id: turnId, status: 'inProgress' } },
    });
    send({
      id: 'mcp-request-1',
      method: 'mcpServer/elicitation/request',
      params: { threadId, turnId, serverName: 'test-mcp', ...params },
    });
    if (mode === 'duplicate')
      send({
        id: 'mcp-request-1',
        method: 'mcpServer/elicitation/request',
        params: { threadId, turnId, serverName: 'test-mcp', ...params },
      });
    send({ id: m.id, result: { turn: { id: turnId } } });
    if (mode === 'resolved' || mode === 'completed-with-pending')
      setTimeout(() => {
        if (mode === 'resolved')
          send({
            method: 'serverRequest/resolved',
            params: { threadId, requestId: 'mcp-request-1' },
          });
        complete('原生请求已结束，继续其他工作');
      }, 100);
    if (mode === 'foreign-resolved')
      setTimeout(
        () =>
          send({
            method: 'serverRequest/resolved',
            params: { threadId: 'foreign-thread', requestId: 'mcp-request-1' },
          }),
        30,
      );
  } else if (m.id === 'mcp-request-1') {
    if (m.error) complete('Native request rejected safely');
    else complete('MCP response: ' + JSON.stringify(m.result));
  } else if (m.method === 'turn/interrupt') send({ id: m.id, result: {} });
});
