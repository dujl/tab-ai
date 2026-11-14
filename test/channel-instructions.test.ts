import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  channelInstructions,
  agentInstructions,
  codexInstructions,
} from '../src/core/channel-instructions.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter, type ClaudeQuery } from '../src/agents/claude.js';
import { OpenCodeAdapter } from '../src/agents/opencode.js';
import { OpenCodeServer } from '../src/agents/opencode-server.js';
import { Store } from '../src/core/store.js';
import type { AgentRun, Platform, Session } from '../src/core/types.js';
import { fixture, incoming } from './helpers.js';

const hooks = (session: Session): AgentRun['hooks'] => ({
  nativeId(id) {
    session.nativeId = id;
  },
  text() {},
  activity() {},
  async ask() {
    return { allow: false };
  },
});
const route = (platform: Platform) => ({
  platform,
  account: `bot-${platform}`,
  conversation: 'group',
  thread: '',
  sender: 'alice',
});

test('each messaging platform supplies its own default document semantics without inventing capabilities', async () => {
  const f = fixture();
  try {
    for (const [platform, expected] of [
      ['lark', '飞书'],
      ['wecom', '企业微信'],
      ['dingtalk', '钉钉'],
      ['wechat', '个人微信'],
    ] as const) {
      const s = f.store.create(
        route(platform),
        'codex',
        f.dir,
        '  仅创建用户指定的 Google 文档\n保持此原文  ',
      );
      s.channelContext = { conversationType: 'group', botName: '助手名称' };
      const text = agentInstructions(s)!;
      assert.match(text, new RegExp(expected));
      assert.match(text, /群聊/);
      assert.match(text, /用户本轮明确指定/);
      assert.match(text, /通道接入本身不代表具备文档权限/);
      assert.ok(text.endsWith(s.instructions!));
      assert.equal(text.split('【tab-ai 通道背景】').length, 2);
      assert.match(text, /"botAccount":"bot-/);
      assert.ok(!text.includes('appSecret'));
    }
    const wechat = channelInstructions(f.store.create(route('wechat'), 'claude', f.dir))!;
    assert.match(wechat, /先询问目标文档平台/);
    const local = f.store.create(route('local'), 'codex', f.dir);
    assert.equal(agentInstructions(local), undefined);
    local.instructions = '  Custom\n';
    assert.equal(agentInstructions(local), local.instructions);
    const lark = f.store.create(route('lark'), 'codex', f.dir);
    lark.channelContext = { domain: 'lark' };
    assert.match(channelInstructions(lark)!, /Lark（飞书国际版）/);
    assert.match(channelInstructions(lark)!, /聊天类型未确认/);
  } finally {
    await f.cleanup();
  }
});

test('Manager records bot/domain and DM/group metadata, preserves custom instructions and restores it across reset and restart', async () => {
  const f = fixture();
  try {
    f.config.channels[0]!.displayName = '飞书助理';
    await f.manager.receive({
      ...incoming('/tab init codex --instructions 我的角色', 'alice', ''),
      direct: true,
    });
    const main = f.store.current(incoming('', 'alice', '').route)!;
    assert.deepEqual(main.channelContext, {
      conversationType: 'direct',
      botName: '飞书助理',
      domain: 'feishu',
    });
    await f.manager.receive({ ...incoming('创建在线文档', 'alice', ''), direct: true });
    await f.manager.idle();
    const s = f.store.get(main.id)!;
    assert.equal(s.instructions, '我的角色');
    assert.equal(f.agent.inputs[0]!.text, '创建在线文档');
    assert.match(agentInstructions(s)!, /单聊/);
    const group = { ...incoming('群里创建在线文档', 'alice', 'other-topic'), direct: false };
    await f.manager.receive(group);
    await f.manager.idle();
    assert.match(agentInstructions(f.store.current(group.route)!)!, /群聊/);
    const fresh = f.store.resetSession(s);
    assert.deepEqual(fresh.channelContext, s.channelContext);
    const restored = new Store(f.config.dataDir);
    try {
      assert.equal(agentInstructions(restored.get(fresh.id)!), agentInstructions(fresh));
    } finally {
      restored.close();
    }
    await f.manager.receive(incoming('/tab instructions', 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /我的角色/);
    assert.match(f.channel.sent.at(-1)!.text, /通道背景/);
  } finally {
    await f.cleanup();
  }
});

test('Codex adds platform context on start/resume/compact and terminal handoff while preserving native snapshot and exact user input', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new CodexAdapter(executable),
      s = f.store.create(route('wecom'), 'codex', f.dir, 'Custom role');
    const input = {
      session: s,
      text: '创建在线文档',
      signal: AbortSignal.timeout(10000),
      hooks: hooks(s),
    };
    await adapter.run(input);
    await adapter.run(input);
    await adapter.compact(s, input.signal);
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      s.codexDeveloperInstructions,
      'Native configured developer instructions\n\nCustom role',
    );
    assert.equal(trace.filter((m) => m.method === 'config/read').length, 1);
    for (const m of trace.filter((m) => ['thread/start', 'thread/resume'].includes(m.method))) {
      assert.equal(m.params.developerInstructions, codexInstructions(s));
      assert.equal(m.params.baseInstructions, undefined);
      assert.match(m.params.developerInstructions, /企业微信/);
      assert.match(m.params.developerInstructions, /Custom role/);
      assert.equal(m.params.developerInstructions.split('【tab-ai 通道背景】').length, 2);
    }
    assert.ok(
      trace
        .filter((m) => m.method === 'turn/start')
        .every((m) => m.params.input[0].text === input.text),
    );
    assert.ok(
      adapter
        .resumeCommand(s)
        .includes(`developer_instructions=${JSON.stringify(codexInstructions(s))}`),
    );
    // A saved native/custom snapshot is preserved across configuration reads.
    s.codexDeveloperInstructions = 'Saved native\n\nCustom role';
    await adapter.run(input);
    assert.equal(s.codexDeveloperInstructions, 'Saved native\n\nCustom role');
    const again = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(again.filter((m) => m.method === 'config/read').length, 1);
    assert.match(
      again.filter((m) => m.method === 'thread/resume').at(-1).params.developerInstructions,
      /Saved native/,
    );
  } finally {
    await f.cleanup();
  }
});

test('existing Codex session without custom additions receives background without changing its native ID', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const s = f.store.create(route('dingtalk'), 'codex', f.dir);
    s.nativeId = 'native-test-1';
    assert.throws(() => new CodexAdapter(executable).resumeCommand(s), /原生指令快照/);
    await new CodexAdapter(executable).run({
      session: s,
      text: '继续',
      signal: AbortSignal.timeout(5000),
      hooks: hooks(s),
    });
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(!trace.some((m) => m.method === 'thread/start'));
    assert.match(
      trace.find((m) => m.method === 'thread/resume').params.developerInstructions,
      /钉钉/,
    );
    assert.equal(s.instructions, undefined);
    assert.equal(s.nativeId, 'native-test-1');
  } finally {
    await f.cleanup();
  }
});

test('compacting a legacy Codex session first loads its native developer settings, and failed handoff leaves it attached', async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, 'codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), executable);
    chmodSync(executable, 0o755);
    const adapter = new CodexAdapter(executable),
      s = f.store.create(route('wecom'), 'codex', f.dir);
    s.nativeId = 'native-test-1';
    f.store.save(s);
    f.agent.resumeCommand = (session) => adapter.resumeCommand(session);
    assert.throws(() => f.manager.detach(s.id), /原生指令快照/);
    assert.equal(f.store.get(s.id)!.status, 'idle');
    await adapter.compact(s, AbortSignal.timeout(5000));
    const trace = readFileSync(join(f.dir, 'rpc-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(trace.filter((m) => m.method === 'config/read').length, 1);
    assert.match(
      trace.find((m) => m.method === 'thread/resume').params.developerInstructions,
      /Native configured developer instructions/,
    );
    assert.match(
      trace.find((m) => m.method === 'thread/resume').params.developerInstructions,
      /企业微信/,
    );
    assert.equal(s.nativeId, 'native-test-1');
  } finally {
    await f.cleanup();
  }
});

test('Claude retains its native preset and appends the same channel and session instructions during resume, compaction and handoff', async () => {
  const f = fixture(),
    calls: Parameters<ClaudeQuery>[0][] = [];
  const runtime: ClaudeQuery = (input) => {
    calls.push(input);
    return Object.assign(
      (async function* () {
        if (input.prompt === '/compact')
          yield {
            type: 'system',
            subtype: 'compact_boundary',
            session_id: 'native-claude',
          } as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'native-claude',
          is_error: false,
          result: 'done',
        } as SDKMessage;
      })(),
      { close() {} },
    );
  };
  try {
    const s = f.store.create(route('lark'), 'claude', f.dir, '角色原文');
    s.channelContext = { conversationType: 'direct' };
    const adapter = new ClaudeAdapter(undefined, [], runtime),
      input = {
        session: s,
        text: '创建在线文档',
        signal: AbortSignal.timeout(5000),
        hooks: hooks(s),
      };
    await adapter.run(input);
    await adapter.run(input);
    await adapter.compact(s, input.signal);
    for (const call of calls)
      assert.deepEqual(call.options!.systemPrompt, {
        type: 'preset',
        preset: 'claude_code',
        append: agentInstructions(s),
      });
    assert.equal(calls[0]!.prompt, input.text);
    assert.equal(calls[1]!.options!.resume, 'native-claude');
    assert.ok(adapter.resumeCommand(s).includes(agentInstructions(s)!));
  } finally {
    await f.cleanup();
  }
});

test('OpenCode appends background each turn independently of user text and rejects terminal handoff that would discard it', async () => {
  const f = fixture();
  try {
    const log = join(f.dir, 'requests.jsonl');
    const adapter = new OpenCodeAdapter('opencode', [], (cwd, signal) =>
      OpenCodeServer.start(
        process.execPath,
        cwd,
        { ...process.env, TEST_OPENCODE_LOG: log },
        signal,
        [resolve('test/fixtures/fake-opencode.mjs')],
      ),
    );
    const s = f.store.create(route('wecom'), 'opencode', f.dir, '用户角色');
    const input = {
      session: s,
      text: '创建在线文档',
      signal: AbortSignal.timeout(10000),
      hooks: hooks(s),
    };
    await adapter.run(input);
    await adapter.run(input);
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((r) => r.path?.endsWith('/message'));
    assert.equal(calls.length, 2);
    for (const call of calls)
      assert.deepEqual(call.body, {
        parts: [{ type: 'text', text: input.text }],
        system: agentInstructions(s),
      });
    s.instructions = undefined;
    f.store.save(s);
    assert.throws(() => f.manager.detach(s.id), /通道背景/);
  } finally {
    await f.cleanup();
  }
});

test('task sessions inherit source platform and conversation metadata without copying the main chat transcript', async () => {
  const f = fixture();
  f.agent.handler = async () => {};
  try {
    await f.manager.receive({ ...incoming('原单聊', 'alice', ''), direct: true });
    await f.manager.idle();
    const source = f.store.current(incoming('', 'alice', '').route)!;
    const task = await f.manager.createTask({
      sourceSessionId: source.id,
      key: 'channel-test',
      title: '文档',
      objective: '创建在线文档',
      workspace: 'default',
    });
    await f.manager.idle();
    const s = f.store.get(task.sessionId!)!;
    assert.equal(s.route.platform, 'lark');
    assert.equal(s.channelContext?.conversationType, 'direct');
    assert.match(agentInstructions(s)!, /飞书/);
    assert.ok(
      f.agent.inputs.filter((r) => r.session.id === s.id).every((r) => !r.text.includes('原单聊')),
    );
  } finally {
    await f.cleanup();
  }
});
