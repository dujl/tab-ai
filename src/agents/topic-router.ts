import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { type AgentKind } from '../core/types.js';
import {
  type TopicRouter,
  type TopicInput,
  type TopicDecision,
  TOPIC_ROUTER_INSTRUCTIONS,
  topicDecisionSchema,
  validateTopicDecision,
  InvalidTopicDecisionError,
} from '../core/topic-router.js';
import { RpcProcess } from './rpc.js';
import { agentEnvironment } from './environment.js';
import { type ClaudeQuery } from './claude.js';

type RouterRpc = Pick<RpcProcess, 'request' | 'write' | 'close' | 'onMessage' | 'onFailure'>;
interface RouterRuntime {
  rpc?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => RouterRpc;
  query?: ClaudeQuery;
  timeoutMs?: number;
}

// Separate, ephemeral classifier. Nothing here resumes or alters a work session.
export class NativeTopicRouter implements TopicRouter {
  private codexRpc?: RouterRpc;
  private tail: Promise<void> = Promise.resolve();
  private shutdown = new AbortController();
  constructor(
    private kind: Extract<AgentKind, 'codex' | 'claude'>,
    private command?: string,
    private secretKeys: string[] = [],
    private runtime: RouterRuntime = {},
  ) {}
  async classify(input: TopicInput, signal: AbortSignal): Promise<TopicDecision> {
    let raw: unknown;
    try {
      raw = await this.generate(input, TOPIC_ROUTER_INSTRUCTIONS, topicDecisionSchema, signal);
    } catch (error) {
      if (error instanceof SyntaxError) throw new InvalidTopicDecisionError();
      throw error;
    }
    try {
      return validateTopicDecision(raw, input);
    } catch {
      throw new InvalidTopicDecisionError();
    }
  }
  async generate(
    input: unknown,
    instructions: string,
    schema: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const job = this.tail.then(() => this.classifyOne(input, signal, instructions, schema));
    this.tail = job.then(
      () => {},
      () => {},
    );
    return job;
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    await this.tail;
    await this.codexRpc?.close();
    this.codexRpc = undefined;
  }
  private async classifyOne(
    input: unknown,
    signal: AbortSignal,
    instructions: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('语义判断超时')),
      this.runtime.timeoutMs ?? 60_000,
    );
    const combined = AbortSignal.any([signal, controller.signal, this.shutdown.signal]);
    const cwd = mkdtempSync(join(tmpdir(), 'tab-ai-intent-'));
    try {
      combined.throwIfAborted();
      const result =
        this.kind === 'codex'
          ? await this.codex(input, cwd, combined, instructions, schema)
          : await this.claude(input, cwd, combined, instructions, schema);
      return result;
    } finally {
      clearTimeout(timeout);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  private async codex(
    input: unknown,
    cwd: string,
    signal: AbortSignal,
    instructions: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const initialize = !this.codexRpc;
    const rpc = (this.codexRpc ??= (this.runtime.rpc ?? ((...args) => new RpcProcess(...args)))(
      this.command ?? 'codex',
      ['app-server'],
      tmpdir(),
      agentEnvironment(this.secretKeys),
    ));
    let threadId: string | undefined,
      succeeded = false;
    let output = '';
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void done.catch(() => {});
    const abort = () => {
      reject(new Error('意图判断已取消'));
      void rpc.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    rpc.onFailure = reject;
    rpc.onMessage = (message) => {
      if (message.id !== undefined && message.method) {
        rpc.write({
          id: message.id,
          error: {
            code: -32601,
            message: 'Intent classifier cannot use tools or request approval.',
          },
        });
        reject(new Error('Unexpected classifier tool request'));
        void rpc.close();
        return;
      }
      const params = message.params as
        | { threadId?: string; item?: { type?: string; text?: string }; turn?: { status?: string } }
        | undefined;
      if (params?.threadId && params.threadId !== threadId) return;
      if (message.method === 'item/completed' && params?.item?.type === 'agentMessage')
        output = params.item.text ?? '';
      if (message.method === 'turn/completed')
        params?.turn?.status === 'completed'
          ? resolve()
          : reject(new Error('Intent classification failed'));
    };
    try {
      if (initialize) {
        await rpc.request('initialize', {
          clientInfo: { name: 'tab-ai-intent', version: '0.3.0' },
          capabilities: { experimentalApi: true },
        });
        rpc.write({ method: 'initialized' });
      }
      const loaded = (await rpc.request('config/read', { includeLayers: false })) as {
        config: { mcp_servers?: Record<string, Record<string, unknown>> };
      };
      const config: Record<string, unknown> = {
        web_search: 'disabled',
        project_doc_max_bytes: 0,
        model_reasoning_effort: 'low',
        'features.shell_tool': false,
        'features.shell_snapshot': false,
        'features.apps': false,
        'features.plugins': false,
        'features.hooks': false,
        'features.multi_agent': false,
        'features.browser_use': false,
        'features.computer_use': false,
        'features.js_repl': false,
        'features.image_generation': false,
        'features.memories': false,
      };
      config.mcp_servers = Object.fromEntries(
        Object.keys(loaded.config.mcp_servers ?? {}).map((name) => [name, { enabled: false }]),
      );
      const result = (await rpc.request('thread/start', {
        cwd,
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        baseInstructions: instructions,
        developerInstructions: '',
        config,
        environments: [],
        dynamicTools: [],
      })) as { thread: { id: string } };
      threadId = result.thread.id;
      signal.throwIfAborted();
      await rpc.request('turn/start', {
        threadId: result.thread.id,
        input: [{ type: 'text', text: JSON.stringify(input), text_elements: [] }],
        outputSchema: schema,
      });
      await done;
      signal.throwIfAborted();
      const value: unknown = JSON.parse(output);
      await rpc.request('thread/unsubscribe', { threadId });
      succeeded = true;
      return value;
    } finally {
      signal.removeEventListener('abort', abort);
      if (!succeeded) {
        await rpc.close();
        this.codexRpc = undefined;
      } else {
        rpc.onMessage = () => {};
        rpc.onFailure = () => {
          this.codexRpc = undefined;
        };
      }
    }
  }
  private async claude(
    input: unknown,
    cwd: string,
    signal: AbortSignal,
    instructions: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const conversation = (this.runtime.query ?? query)({
      prompt: JSON.stringify(input),
      options: {
        cwd,
        ...(this.command ? { pathToClaudeCodeExecutable: this.command } : {}),
        env: agentEnvironment(this.secretKeys),
        systemPrompt: instructions,
        settingSources: [],
        tools: [],
        mcpServers: {},
        persistSession: false,
        maxTurns: 1,
        abortController: controller,
        outputFormat: { type: 'json_schema', schema },
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'Intent classifier cannot use tools.',
        }),
      },
    });
    try {
      for await (const message of conversation) {
        signal.throwIfAborted();
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error)
            throw new Error('Intent classification failed');
          return message.structured_output ?? JSON.parse(message.result);
        }
      }
      throw new Error('No intent decision');
    } finally {
      signal.removeEventListener('abort', abort);
      conversation.close();
    }
  }
}
