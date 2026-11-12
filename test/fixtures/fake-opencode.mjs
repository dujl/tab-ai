import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const mode = process.env.TEST_OPENCODE_MODE;
let stream,
  prompt,
  replies = 0;
const log = (data) => appendFileSync(process.env.TEST_OPENCODE_LOG, JSON.stringify(data) + '\n');
const emit = (type, properties) =>
  stream.write(`data: ${JSON.stringify({ id: 'evt_1', type, properties })}\n\n`);
const finish = () => {
  if (replies === 2 && prompt) {
    prompt.end(
      JSON.stringify({
        info: { sessionID: 'ses_created' },
        parts: [
          { type: 'reasoning', text: 'private thought' },
          { type: 'text', text: 'OpenCode answer' },
        ],
      }),
    );
    prompt = undefined;
  }
};
const server = createServer(async (req, res) => {
  if (
    req.headers.authorization !==
    `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
  ) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : undefined;
  log({ path, method: req.method, body, directory: url.searchParams.get('directory') });
  res.setHeader('content-type', 'application/json');
  if (path === '/path') {
    res.end(
      JSON.stringify({
        directory: mode === 'wrong-cwd' ? '/wrong-directory' : url.searchParams.get('directory'),
      }),
    );
    return;
  }
  if (path === '/event') {
    res.setHeader('content-type', 'text/event-stream');
    stream = res;
    emit('server.connected', {});
    return;
  }
  if (path === '/provider') {
    res.end(
      JSON.stringify({
        connected: ['native'],
        all: [
          {
            id: 'native',
            key: 'NEVER-EXPOSE',
            models: {
              'm/sub': {
                id: 'm/sub',
                name: 'Native model',
                status: 'active',
                variants: { low: {}, high: {} },
              },
            },
          },
          { id: 'disconnected', models: { m: { id: 'm', name: 'Invisible', status: 'active' } } },
        ],
      }),
    );
    return;
  }
  if (path === '/session' && req.method === 'POST') {
    res.end(JSON.stringify({ id: 'ses_created', directory: url.searchParams.get('directory') }));
    return;
  }
  if (path === '/session/ses_missing') {
    res.writeHead(404).end('{}');
    return;
  }
  if (/^\/session\/[^/]+$/.test(path)) {
    res.end(
      JSON.stringify({
        id: mode === 'wrong-id' ? 'ses_other' : path.split('/')[2],
        directory:
          mode === 'old-directory' ? '/original-directory' : url.searchParams.get('directory'),
        ...(path.endsWith('ses_child') ? { parentID: 'ses_created' } : {}),
      }),
    );
    return;
  }
  if (path.endsWith('/abort')) {
    log({ aborted: true });
    res.end('true');
    prompt?.end('{}');
    return;
  }
  if (path.endsWith('/message')) {
    if (mode === 'todos') {
      for (const sessionID of ['ses_other', 'ses_child', 'ses_created'])
        emit('todo.updated', {
          sessionID,
          todos: [
            { id: '1', content: '核对数据', status: 'completed' },
            { id: '2', content: '运行验证', status: 'in_progress' },
          ],
        });
      emit('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'ses_created',
          callID: 'clear',
          tool: 'todowrite',
          state: { status: 'completed', input: { todos: [] }, output: 'cleared' },
        },
      });
      setTimeout(
        () =>
          res.end(
            JSON.stringify({
              info: { sessionID: 'ses_created' },
              parts: [{ type: 'text', text: 'done' }],
            }),
          ),
        100,
      );
      return;
    }
    if (mode === 'wait') {
      prompt = res;
      return;
    }
    if (mode === 'disconnect') {
      prompt = res;
      stream.end();
      return;
    }
    if (mode === 'error') {
      res.end(
        JSON.stringify({
          info: {
            sessionID: 'ses_created',
            error: { name: 'ProviderAuthError', data: { message: 'Please sign in to OpenCode' } },
          },
          parts: [],
        }),
      );
      return;
    }
    if (mode === 'tools') {
      for (const sessionID of ['ses_created', 'ses_other'])
        for (const status of ['running', 'completed'])
          emit('message.part.updated', {
            part: {
              type: 'tool',
              sessionID,
              callID: 'cmd',
              tool: 'bash',
              state: {
                status,
                input: { command: 'pwd' },
                ...(status === 'completed' ? { output: 'done' } : {}),
              },
            },
          });
      // Give the adapter time to verify the foreign session's ancestry.
      setTimeout(
        () =>
          res.end(
            JSON.stringify({
              info: { sessionID: 'ses_created' },
              parts: [{ type: 'text', text: 'done' }],
            }),
          ),
        100,
      );
      return;
    }
    if (mode === 'interact') {
      prompt = res;
      emit('permission.asked', {
        id: 'per_other',
        sessionID: 'ses_other',
        permission: 'edit',
        patterns: ['unrelated'],
      });
      const per = { id: 'per_1', sessionID: 'ses_child', permission: 'bash', patterns: ['pwd'] };
      emit('permission.asked', per);
      emit('permission.asked', per);
      emit('question.asked', {
        id: 'que_1',
        sessionID: 'ses_created',
        questions: [
          {
            header: 'Choice',
            question: 'Which?',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiple: true,
            custom: false,
          },
        ],
      });
      return;
    }
    res.end(
      JSON.stringify({
        info: { sessionID: path.split('/')[2] },
        parts: [{ type: 'text', text: 'OpenCode answer' }],
      }),
    );
    return;
  }
  if (path.endsWith('/reply')) {
    replies++;
    res.end('true');
    finish();
    return;
  }
  res.writeHead(404).end('{}');
});
server.listen(0, '127.0.0.1', () =>
  console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`),
);
