#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('1.0.0\n');
  process.exit(0);
}

if (args.includes('--print') || args.includes('-p')) {
  appendFileSync(join(fixtureDir, 'print-args.jsonl'), JSON.stringify(args) + '\n');
  const promptIdx = args.indexOf('--print');
  const prompt = promptIdx >= 0 ? (args[promptIdx + 1] ?? '') : '';
  if (prompt.includes('trigger-router-error')) {
    process.stderr.write('simulated router failure\n');
    process.exit(1);
  }
  const decision = prompt.includes('新开话题用 agy')
    ? {
        action: 'new_topic',
        workspace: null,
        instructions: null,
        agent: 'agy',
        task: '分析代码',
      }
    : {
        action: 'continue',
        workspace: null,
        instructions: null,
        agent: null,
        task: null,
      };
  process.stdout.write(
    JSON.stringify({
      conversation_id: 'agy-router-1',
      status: 'SUCCESS',
      response: JSON.stringify(decision),
      structured_output: decision,
      usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
    }) + '\n',
  );
  process.exit(0);
}

if (args[0] !== 'acp') {
  process.stderr.write(`Unexpected args: ${args.join(' ')}\n`);
  process.exit(2);
}

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const modeFlag = (name) => existsSync(join(process.cwd(), name));

let activeSessionId = 'agy-native-1';
let pendingPromptId = null;
let serverSeq = 100;
const waitingResponses = new Map();

function askClient(method, params) {
  const id = ++serverSeq;
  return new Promise((resolve) => {
    waitingResponses.set(id, resolve);
    send({ id, method, params });
  });
}

function defaultConfigOptions() {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept Edits' },
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modeFlag('invalid-default-model') ? 'MODEL_PLACEHOLDER_TEST' : 'agy-model-a',
      options: modeFlag('empty-model-catalogue')
        ? []
        : [
            { value: 'agy-model-a', name: 'AGY Model A' },
            { value: 'agy-model-b', name: 'AGY Model B' },
            { value: 'agy-model-fixed', name: 'AGY Model Fixed' },
          ],
    },
    {
      id: 'thought_level',
      name: 'Thinking Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ];
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(join(fixtureDir, 'acp-trace.jsonl'), line + '\n');

  if (message.id !== undefined && !message.method) {
    const resolver = waitingResponses.get(message.id);
    if (resolver) {
      waitingResponses.delete(message.id);
      resolver(message);
    }
    return;
  }

  if (message.method === 'initialize') {
    const noResume = modeFlag('no-resume');
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          load_session: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: {
            ...(noResume ? {} : { resume: {} }),
            load: {},
            close: {},
            list: {},
          },
          _meta: {
            antigravity: {
              tier: true,
              systemPrompt: { append: !modeFlag('no-system-prompt') },
            },
          },
        },
        agentInfo: { name: 'Antigravity ACP Server', version: '1.0.0' },
      },
    });
    return;
  }

  if (
    modeFlag('keychain-auth-failure') &&
    ['session/new', 'session/resume'].includes(message.method)
  ) {
    const log = args[args.indexOf('--log-file') + 1];
    appendFileSync(
      log,
      'W1126 14:38:20 composite_token_storage.go:614] Failed to load stored token from keyring, falling back to file: exit status 36\n' +
        'I1126 14:38:20 boot.go:103] Silent sign-in failed; session requests fail with auth_required until the client signs in.\n',
    );
    send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
    return;
  }

  if (message.method === 'session/new') {
    activeSessionId = modeFlag('custom-session-id')
      ? readFileSync(join(process.cwd(), 'custom-session-id'), 'utf8').trim()
      : 'agy-native-1';
    if (modeFlag('legacy-models')) {
      send({
        id: message.id,
        result: {
          sessionId: activeSessionId,
          models: {
            currentModelId: 'gemini-legacy',
            availableModels: [{ modelId: 'gemini-legacy', name: 'Gemini Legacy' }],
          },
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'accept-edits', name: 'Accept Edits' },
            ],
          },
        },
      });
    } else {
      send({
        id: message.id,
        result: {
          sessionId: activeSessionId,
          models: {
            currentModelId: 'agy-model-a-medium',
            availableModels: modeFlag('empty-model-catalogue')
              ? []
              : [
                  { modelId: 'agy-model-a-low', name: 'AGY Model A (Low)' },
                  { modelId: 'agy-model-a-medium', name: 'AGY Model A (Medium)' },
                  { modelId: 'agy-model-a-high', name: 'AGY Model A (High)' },
                  { modelId: 'agy-model-b-low', name: 'AGY Model B (Low)' },
                  { modelId: 'agy-model-b-high', name: 'AGY Model B (High)' },
                  { modelId: 'agy-model-fixed', name: 'AGY Model Fixed' },
                ],
          },
          configOptions: defaultConfigOptions(),
        },
      });
    }
    return;
  }

  if (message.method === 'session/resume') {
    activeSessionId = message.params.sessionId;
    send({
      id: message.id,
      result: {
        sessionId: activeSessionId,
        configOptions: defaultConfigOptions(),
      },
    });
    return;
  }

  if (message.method === 'session/load') {
    activeSessionId = message.params.sessionId;
    // Emit replayed historical events before responding to session/load.
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'REPLAYED OLD MESSAGE' },
        },
      },
    });
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'old-tool',
          title: 'Old Tool',
          kind: 'read',
          status: 'completed',
        },
      },
    });
    send({
      id: message.id,
      result: {
        sessionId: activeSessionId,
        configOptions: defaultConfigOptions(),
      },
    });
    return;
  }

  if (message.method === 'session/set_config_option') {
    if (
      message.params.configId === 'mode' &&
      !['default', 'accept-edits', 'auto', 'plan'].includes(message.params.value)
    ) {
      send({
        id: message.id,
        error: { code: -32602, message: `Unknown mode: ${message.params.value}` },
      });
      return;
    }
    const opts = defaultConfigOptions().map((opt) =>
      opt.id === message.params.configId ? { ...opt, currentValue: message.params.value } : opt,
    );
    send({ id: message.id, result: { configOptions: opts } });
    return;
  }

  if (message.method === 'session/set_mode' || message.method === 'session/set_model') {
    if (
      message.method === 'session/set_mode' &&
      !['default', 'accept-edits', 'auto', 'plan'].includes(message.params.modeId)
    ) {
      send({
        id: message.id,
        error: { code: -32602, message: `Unknown mode: ${message.params.modeId}` },
      });
      return;
    }
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === 'session/close') {
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === 'session/cancel') {
    if (pendingPromptId !== null) {
      const id = pendingPromptId;
      pendingPromptId = null;
      send({ id, result: { stopReason: 'cancelled' } });
    }
    return;
  }

  if (message.method === 'session/prompt') {
    if (modeFlag('prompt-error-as-success') || modeFlag('prompt-error-after-acceptance')) {
      if (modeFlag('prompt-error-after-acceptance')) {
        send({
          method: 'session/update',
          params: {
            sessionId: activeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'working...' },
            },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const log = args[args.indexOf('--log-file') + 1];
      appendFileSync(
        log,
        'E1126 14:01:37 errorreport.go:282] failed to construct executor: unknown model key MODEL_PLACEHOLDER_TEST: model not found\n',
      );
      send({
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: '⚠ failed to construct executor: unknown model key MODEL_PLACEHOLDER_TEST: model not found',
            },
          },
        },
      });
      if (modeFlag('prompt-error-as-success'))
        send({ id: message.id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (modeFlag('prompt-log-failure')) {
      const log = args[args.indexOf('--log-file') + 1];
      appendFileSync(
        log,
        'E1126 13:07:00 errorreport.go:123] loadCodeAssistResponse failed: EOF https://example.test/?token=private-native-secret\nE1126 13:07:01 errorreport.go:123] failed to construct executor: unknown model key MODEL_PLACEHOLDER_TEST: model not found\n',
      );
      return;
    }
    if (modeFlag('prompt-stall')) return;
    if (modeFlag('prompt-fail-before-events')) {
      send({
        id: message.id,
        error: { code: -32000, message: 'prompt transport failed before acceptance' },
      });
      return;
    }
    const promptId = message.id;
    const text = (message.params.prompt ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (text === 'slow-cancel') {
      pendingPromptId = promptId;
      send({
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'working...' },
          },
        },
      });
      return;
    }

    if (text === 'refusal') {
      send({ id: promptId, result: { stopReason: 'refusal' } });
      return;
    }
    if (text === 'persistent-approval') {
      const reply = await askClient('session/request_permission', {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: 'persistent',
          title: 'Run command',
          kind: 'execute',
          rawInput: { command: 'npm test' },
        },
        options: [
          { optionId: 'allow_always', kind: 'allow_always' },
          { optionId: 'reject_always', kind: 'reject_always' },
        ],
      });
      send({
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: reply.result?.outcome?.outcome },
          },
        },
      });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text === 'unknown-request') {
      await askClient('fs/read_text_file', { sessionId: activeSessionId, path: '/etc/hosts' });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text === 'wrong-session-id') {
      send({
        method: 'session/update',
        params: {
          sessionId: 'other-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'MUST NOT LEAK' },
          },
        },
      });
      const resp = await askClient('session/request_permission', {
        sessionId: 'other-session',
        toolCall: {
          toolCallId: 'bad-1',
          title: 'Run rm',
          kind: 'execute',
          rawInput: { command: 'rm -rf /' },
        },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      });
      send({
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `wrong-session-error:${resp.error?.code ?? 'none'}` },
          },
        },
      });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text === 'need-approval') {
      send({
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '即将执行测试命令' },
          },
        },
      });
      const reply = await askClient('session/request_permission', {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: 'perm-1',
          title: 'Run npm test',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'npm test', cwd: process.cwd() },
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const outcome = reply.result?.outcome;
      const summary =
        outcome?.outcome === 'selected' ? `selected:${outcome.optionId}` : String(outcome?.outcome);
      send({
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `approval=${summary}` },
          },
        },
      });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text === 'repeat-approval') {
      const req = {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: 'perm-r1',
          title: 'Run echo hi',
          kind: 'execute',
          rawInput: { command: 'echo hi', cwd: process.cwd() },
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      };
      const first = await askClient('session/request_permission', req);
      const second = await askClient('session/request_permission', {
        ...req,
        toolCall: { ...req.toolCall, toolCallId: 'perm-r2' },
      });
      send({
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `${first.result?.outcome?.optionId},${second.result?.outcome?.optionId}`,
            },
          },
        },
      });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text === 'task-tool-approval') {
      const reply1 = await askClient('session/request_permission', {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: 'task-1',
          title: 'mcp__tab_ai_tasks__task_list',
          kind: 'other',
          rawInput: {},
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const reply2 = await askClient('session/request_permission', {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: 'task-2',
          title: 'Run mcp_tab_ai_tasks_task_report',
          kind: 'other',
          rawInput: { summary: 'done' },
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      send({
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `task=${reply1.result?.outcome?.optionId},${reply2.result?.outcome?.optionId}`,
            },
          },
        },
      });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }

    // Default full-featured turn: chunked text, plan, tool call/update, post-tool text, usage.
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Inspect workspace', priority: 'high', status: 'completed' },
            { content: 'Run checks', priority: 'high', status: 'in_progress' },
          ],
        },
      },
    });
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '正在' },
        },
      },
    });
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '检查代码' },
        },
      },
    });
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Run tests',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'npm test' },
        },
      },
    });
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          rawOutput: { stdout: 'all green', exitCode: 0 },
        },
      },
    });
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `完成：${text}` },
        },
      },
    });
    send({
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 4200,
          size: 200000,
        },
      },
    });
    send({
      id: promptId,
      result: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 3500,
          outputTokens: 700,
          cachedReadTokens: 1200,
          thoughtTokens: 200,
          totalTokens: 4200,
        },
      },
    });
  }
});
