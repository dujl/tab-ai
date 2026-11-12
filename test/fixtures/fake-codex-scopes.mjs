#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const file = join(process.cwd(), 'scope-history.json'),
  data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {},
  grants = new Map(),
  pending = new Map();
let id, turn;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const save = () => writeFileSync(file, JSON.stringify(data));
function done(text) {
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: id,
      turnId: turn,
      tokenUsage: {
        last: {
          inputTokens: 100,
          cachedInputTokens: data[id].length > 1 ? 80 : 0,
          outputTokens: 10,
        },
        total: {
          inputTokens: data[id].length * 100,
          cachedInputTokens: Math.max(0, data[id].length - 1) * 80,
          outputTokens: data[id].length * 10,
        },
      },
    },
  });
  send({
    method: 'item/completed',
    params: { threadId: id, turnId: turn, item: { type: 'agentMessage', text } },
  });
  send({
    method: 'turn/completed',
    params: { threadId: id, turn: { id: turn, status: 'completed' } },
  });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  appendFileSync(
    join(process.cwd(), 'scope-trace.jsonl'),
    JSON.stringify({ pid: process.pid, ...m }) + '\n',
  );
  if (m.method === 'initialize' || m.method === 'config/read')
    send({ id: m.id, result: m.method === 'config/read' ? { config: {} } : {} });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    id = m.params.threadId ?? randomUUID();
    data[id] ??= [];
    save();
    send({
      id: m.id,
      result: {
        thread: { id, cwd: process.cwd() },
        approvalPolicy: m.params.approvalPolicy ?? 'on-request',
      },
    });
  } else if (m.method === 'turn/start') {
    turn = randomUUID();
    const text = m.params.input[0].text;
    data[id].push(text);
    save();
    send({
      method: 'turn/started',
      params: { threadId: id, turn: { id: turn, status: 'inProgress' } },
    });
    send({ id: m.id, result: { turn: { id: turn } } });
    if (text === 'recall') {
      done(data[id].join('|'));
      return;
    }
    const command = text === 'other' ? 'echo other' : 'echo status';
    if (grants.get(id)?.has(command)) {
      done('cached-approval');
      return;
    }
    const rid = randomUUID();
    pending.set(rid, command);
    send({
      id: rid,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: id,
        turnId: turn,
        command,
        availableDecisions:
          text === 'once-only'
            ? ['accept', 'decline']
            : ['accept', 'acceptForSession', 'decline', 'cancel'],
      },
    });
  } else if (pending.has(m.id)) {
    const command = pending.get(m.id);
    pending.delete(m.id);
    const choice = m.result.decision;
    if (choice === 'acceptForSession') {
      if (!grants.has(id)) grants.set(id, new Set());
      grants.get(id).add(command);
    }
    done(choice);
  } else if (m.method === 'turn/interrupt') send({ id: m.id, result: {} });
});
