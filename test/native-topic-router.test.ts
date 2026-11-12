import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { NativeTopicRouter } from '../src/agents/topic-router.js';
import { type RpcMessage } from '../src/agents/rpc.js';
import { type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';

test('Codex semantic classification is ephemeral, bounded and isolated from work sessions and connector credentials', async () => {
  let cwd = '',
    closed = false,
    threads = 0,
    processes = 0;
  const calls: { method: string; params: any }[] = [];
  const rpc = {
    onMessage: (_: RpcMessage) => {},
    onFailure: (_: Error) => {},
    write(_message: object) {},
    async close() {
      closed = true;
    },
    async request(method: string, params: any): Promise<unknown> {
      calls.push({ method, params });
      if (method === 'config/read')
        return {
          config: { mcp_servers: { 'server.with.dot': { command: 'unused', enabled: true } } },
        };
      if (method === 'thread/start') {
        cwd = params.cwd;
        return { thread: { id: `ephemeral-${++threads}` } };
      }
      if (method === 'turn/start') {
        rpc.onMessage({
          method: 'item/completed',
          params: {
            item: {
              type: 'agentMessage',
              text: '{"action":"new_topic","workspace":null,"instructions":null,"agent":null,"task":"制作视频"}',
            },
          },
        });
        rpc.onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      }
      return {};
    },
  };
  const router = new NativeTopicRouter('codex', 'native-codex', [], {
    rpc(command, args, _dir, env) {
      processes++;
      assert.equal(command, 'native-codex');
      assert.deepEqual(args, ['app-server']);
      assert.ok(!Object.keys(env).some((k) => k.startsWith('BOTMUX_')));
      return rpc;
    },
  });
  assert.deepEqual(
    await router.classify(
      { text: '独立会话制作视频', recentUserMessages: [] },
      new AbortController().signal,
    ),
    { action: 'new_topic', workspace: null, instructions: null, agent: null, task: '制作视频' },
  );
  const start = calls.find((c) => c.method === 'thread/start')!.params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.config.mcp_servers['server.with.dot'].enabled, false);
  assert.equal(start.config['features.hooks'], false);
  assert.equal(start.config['features.shell_tool'], false);
  assert.ok(calls.find((c) => c.method === 'turn/start')!.params.outputSchema);
  assert.ok(!calls.some((c) => c.method === 'thread/resume'));
  assert.equal(closed, false);
  assert.equal(existsSync(cwd), false);
  await router.classify(
    { text: '换一个全新对话制作视频', recentUserMessages: [] },
    new AbortController().signal,
  );
  assert.equal(processes, 1);
  assert.equal(threads, 2);
  assert.equal(calls.filter((c) => c.method === 'initialize').length, 1);
  assert.deepEqual(
    calls.filter((c) => c.method === 'turn/start').map((c) => c.params.threadId),
    ['ephemeral-1', 'ephemeral-2'],
  );
  assert.ok(calls.some((c) => c.method === 'thread/unsubscribe'));
  await router.close();
  assert.equal(closed, true);
});

test('Codex router timeout closes the native process and cleans temporary context', async () => {
  let cwd = '',
    closed = false;
  const rpc = {
    onMessage: (_: RpcMessage) => {},
    onFailure: (_: Error) => {},
    write(_message: object) {},
    async close() {
      closed = true;
    },
    async request(method: string, params: any) {
      if (method === 'thread/start') cwd = params.cwd;
      return method === 'config/read'
        ? { config: {} }
        : method === 'thread/start'
          ? { thread: { id: 'temporary' } }
          : {};
    },
  };
  const router = new NativeTopicRouter('codex', undefined, [], {
    timeoutMs: 10,
    rpc() {
      return rpc;
    },
  });
  await assert.rejects(
    router.classify({ text: 'test', recentUserMessages: [] }, new AbortController().signal),
    /取消/,
  );
  assert.equal(closed, true);
  assert.equal(existsSync(cwd), false);
});

test('Claude classifier has no work-session resume, tools or persistence and validates structured output', async () => {
  let options!: Options,
    closed = false,
    prompt = '';
  const router = new NativeTopicRouter('claude', 'native-claude', [], {
    query(input) {
      options = input.options!;
      prompt = String(input.prompt);
      const messages = (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          structured_output: {
            action: 'new_topic',
            workspace: null,
            instructions: null,
            agent: null,
            task: '做视频',
          },
        } as SDKMessage;
      })();
      return Object.assign(messages, {
        close() {
          closed = true;
        },
      });
    },
  });
  assert.deepEqual(
    await router.classify(
      { text: '另外开个上下文做视频', recentUserMessages: [] },
      new AbortController().signal,
    ),
    { action: 'new_topic', workspace: null, instructions: null, agent: null, task: '做视频' },
  );
  assert.equal(JSON.parse(prompt).text, '另外开个上下文做视频');
  assert.equal(options.resume, undefined);
  assert.equal(options.persistSession, false);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.maxTurns, 1);
  assert.equal(closed, true);
  assert.equal(existsSync(options.cwd!), false);
});
