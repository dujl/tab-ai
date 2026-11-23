#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const threadId = 'native-scoped-thread';
const turnId = 'current-turn';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const started = (id) =>
  send({ method: 'turn/started', params: { threadId, turn: { id, status: 'inProgress' } } });
const completed = (id) =>
  send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
const text = (value) =>
  send({
    method: 'item/completed',
    params: { threadId, turnId, item: { type: 'agentMessage', text: value } },
  });

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(join(process.cwd(), 'turn-trace.jsonl'), line + '\n');
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'model/list')
    send({
      id: message.id,
      result: {
        data: JSON.parse(readFileSync(join(process.cwd(), 'catalog.json'), 'utf8')),
        nextCursor: null,
      },
    });
  else if (message.method === 'config/read') send({ id: message.id, result: { config: {} } });
  else if (['thread/start', 'thread/resume'].includes(message.method))
    send({ id: message.id, result: { thread: { id: threadId, cwd: process.cwd() } } });
  else if (message.method === 'turn/start') {
    const mode = message.params.input[0].text;
    if (mode === 'early-completion') {
      text('completed before response without started');
      completed(turnId);
      send({ id: message.id, result: { turn: { id: turnId } } });
      return;
    }
    if (mode === 'stale-start-first') started('old-turn');
    started(turnId);
    if (mode === 'stale-start-last') started('old-turn');
    if (mode === 'stale-completion') completed('old-turn');
    if (mode.startsWith('task-')) {
      const params = {
        threadId,
        callId: 'scoped-call',
        tool: 'topic_report',
        arguments: {
          kind: 'final',
          completionEvidence: 'Verified test result',
          remainingWork: [],
          summary: 'Mutating bridge callback',
          artifacts: [],
          issues: [],
        },
      };
      if (mode !== 'task-absent') params.turnId = mode === 'task-current' ? turnId : 'old-turn';
      send({ id: 'scoped-tool-request', method: 'item/tool/call', params });
    } else text('current turn waiting');
    send({ id: message.id, result: { turn: { id: turnId } } });
  } else if (message.method === 'turn/steer') {
    if (message.params.expectedTurnId !== turnId)
      send({ id: message.id, error: { code: -32602, message: 'steered an obsolete turn' } });
    else {
      send({ id: message.id, result: { turnId } });
      text('current turn finished');
      completed(turnId);
    }
  } else if (message.id === 'scoped-tool-request') {
    text(message.result?.success ? 'bridge succeeded' : 'bridge rejected');
    completed(turnId);
  } else if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });
});
