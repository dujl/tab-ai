import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming, until } from './helpers.js';
import {
  type TopicInput,
  type TopicDecision,
  validateTopicDecision,
} from '../src/core/topic-router.js';

test('semantic router runs before closed check, extracts literal task and preserves main/native contexts', async () => {
  const seen: TopicInput[] = [];
  const f = fixture({
    async classify(input) {
      seen.push(input);
      return {
        action: 'new_topic',
        workspace: null,
        instructions: null,
        agent: null,
        task: '生成视频',
      };
    },
  });
  try {
    const route = incoming('', 'alice', '').route;
    const main = f.store.create(route, 'codex', f.dir);
    main.nativeId = 'old-native';
    f.store.save(main);
    f.manager.closeSession(main.id);
    const input = incoming('这事咱们放到另外一个干净的上下文里吧：生成视频', 'alice', '');
    await f.manager.receive(input);
    await f.manager.idle();
    const child = f.agent.inputs[0]!.session;
    assert.notEqual(child.id, main.id);
    assert.equal(child.route.thread, input.id);
    assert.equal(f.agent.inputs[0]!.text, '生成视频');
    assert.equal(f.store.get(main.id)!.status, 'closed');
    assert.equal(f.store.get(main.id)!.nativeId, 'old-native');
    assert.equal(f.store.current(route)!.id, main.id);
    assert.equal(seen[0]!.text, input.text);
    await f.manager.receive(input);
    assert.equal(seen.length, 1);
    assert.equal(f.agent.inputs.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('ordinary messages retain exact text; router context contains only same-session recent user words', async () => {
  const seen: TopicInput[] = [];
  const f = fixture({
    async classify(input) {
      seen.push(input);
      return { action: 'continue', workspace: null, instructions: null, agent: null, task: null };
    },
  });
  try {
    const other = f.store.create(incoming('', 'bob', '').route, 'codex', f.dir);
    f.store.event(other.id, 'user', 'private');
    const text = '  不另开了，就在这里做\n保留原文  ';
    await f.manager.receive(incoming(text, 'alice', ''));
    await f.manager.idle();
    await f.manager.receive(incoming('继续', 'alice', ''));
    await f.manager.idle();
    assert.equal(f.agent.inputs[0]!.text, text);
    assert.equal(f.agent.inputs[1]!.text, '继续');
    assert.deepEqual(seen[1]!.recentUserMessages, [text]);
    assert.ok(!JSON.stringify(seen).includes('private'));
    assert.equal(f.agent.inputs[0]!.session.id, f.agent.inputs[1]!.session.id);
  } finally {
    await f.cleanup();
  }
});

test('clarification, classifier failures and fabricated tasks do not create sessions or execute anything', async () => {
  for (const mode of ['clarify', 'failure', 'fabricated']) {
    const f = fixture({
      async classify() {
        if (mode === 'failure') throw new Error('secret upstream detail');
        return mode === 'clarify'
          ? { action: 'clarify', workspace: null, instructions: null, agent: null, task: null }
          : {
              action: 'new_topic',
              workspace: null,
              instructions: null,
              agent: null,
              task: 'invented command',
            };
      },
    });
    try {
      await f.manager.receive(incoming('换个地方处理吧', 'alice', ''));
      assert.equal(f.store.list().length, 0);
      assert.equal(f.agent.inputs.length, 0);
      assert.match(f.channel.sent.at(-1)!.text, mode === 'clarify' ? /独立话题/ : /暂时无法判断/);
      assert.ok(!f.channel.sent.at(-1)!.text.includes('secret'));
    } finally {
      await f.cleanup();
    }
  }
});

test('routing serializes same-route inputs while commands stay responsive; shutdown cancels classification', async () => {
  let release!: (value: TopicDecision) => void;
  const seen: string[] = [];
  const f = fixture({
    async classify(input, signal) {
      seen.push(input.text);
      return new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  try {
    const first = f.manager.receive(incoming('第一条', 'alice', ''));
    const second = f.manager.receive(incoming('第二条', 'alice', ''));
    await until(() => seen.length === 1);
    await f.manager.receive(incoming('/tab status', 'alice', ''));
    assert.match(f.channel.sent.at(-1)!.text, /尚未绑定会话/);
    release({ action: 'continue', workspace: null, instructions: null, agent: null, task: null });
    await first;
    await f.manager.idle();
    await until(() => seen.length === 2);
    await f.manager.close();
    await second;
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.agent.inputs[0]!.text, '第一条');
  } finally {
    await f.cleanup();
  }
});

test('semantic decision validates task grounding including explicitly referenced previous user text', () => {
  const input = { text: '这事单独弄个会话做吧', recentUserMessages: ['做一个三十秒视频'] };
  assert.deepEqual(
    validateTopicDecision(
      {
        action: 'new_topic',
        workspace: null,
        instructions: null,
        agent: null,
        task: '做一个三十秒视频',
      },
      input,
    ),
    {
      action: 'new_topic',
      workspace: null,
      instructions: null,
      agent: null,
      task: '做一个三十秒视频',
    },
  );
  for (const value of [
    { action: 'new_topic', workspace: null, instructions: null, agent: null, task: 'delete files' },
    { action: 'continue', workspace: null, instructions: null, agent: null, task: '会话' },
    { action: 'unknown', task: null },
    {
      action: 'new_topic',
      workspace: null,
      instructions: null,
      agent: null,
      task: '',
      injected: true,
    },
  ])
    assert.throws(() => validateTopicDecision(value, input));
});

test('explicit semantic Agent selection survives new-topic creation and dispatch, even from a closed Codex main', async () => {
  const { Manager } = await import('../src/core/manager.js');
  const { FakeAgent } = await import('./helpers.js');
  for (const [name, kind] of [
    ['OpenCode', 'opencode'],
    ['open code', 'opencode'],
    ['Claude Code', 'claude'],
    ['Codex', 'codex'],
  ] as const) {
    const f = fixture(),
      agents = { codex: new FakeAgent(), claude: new FakeAgent(), opencode: new FakeAgent() };
    const manager = new Manager(f.config, f.store, agents, new Map([[f.channel.id, f.channel]]), {
      async classify() {
        return {
          action: 'new_topic',
          workspace: null,
          instructions: null,
          agent: name,
          task: '生成视频',
        };
      },
    });
    try {
      const route = incoming('', 'alice', '').route;
      const main = f.store.create(route, 'codex', f.dir);
      main.nativeId = 'old-codex';
      f.store.save(main);
      manager.closeSession(main.id);
      const input = incoming(`另外开个 session，让 ${name} 生成视频`, 'alice', '');
      await manager.receive(input);
      await manager.idle();
      assert.equal(agents[kind].inputs.length, 1);
      for (const other of ['codex', 'claude', 'opencode'] as const)
        if (other !== kind) assert.equal(agents[other].inputs.length, 0);
      const child = agents[kind].inputs[0]!;
      assert.equal(child.session.agent, kind);
      assert.equal(child.session.route.thread, input.id);
      assert.equal(child.text, '生成视频');
      assert.equal(f.store.current(route)!.id, main.id);
      assert.equal(f.store.get(main.id)!.status, 'closed');
      assert.equal(f.store.get(main.id)!.nativeId, 'old-codex');
    } finally {
      await manager.close();
      await f.cleanup();
    }
  }
});
test('unselected Agent uses the configured default; unsupported or fabricated explicit Agent never falls back', async () => {
  for (const selected of [null, 'Gemini CLI', 'invented'] as const) {
    const f = fixture({
      async classify() {
        return {
          action: 'new_topic',
          workspace: null,
          instructions: null,
          agent: selected,
          task: '生成视频',
        };
      },
    });
    try {
      f.config.defaultAgent = 'claude';
      await f.manager.receive(
        incoming(
          selected === null ? '单独建个话题生成视频' : '单独建个话题，让 Gemini CLI 生成视频',
          'alice',
          '',
        ),
      );
      await f.manager.idle();
      if (selected === null) {
        assert.equal(f.agent.inputs[0]!.session.agent, 'claude');
      } else {
        assert.equal(f.store.list().length, 0);
        assert.equal(f.agent.inputs.length, 0);
        assert.match(
          f.channel.sent.at(-1)!.text,
          selected === 'invented' ? /无法判断/ : /不支持指定的 Agent/,
        );
      }
    } finally {
      await f.cleanup();
    }
  }
  assert.throws(() =>
    validateTopicDecision(
      { action: 'new_topic', workspace: null, instructions: null, task: null },
      { text: 'new session', recentUserMessages: [] },
    ),
  );
  assert.throws(() =>
    validateTopicDecision(
      { action: 'continue', workspace: null, instructions: null, agent: 'opencode', task: null },
      { text: 'explain opencode', recentUserMessages: [] },
    ),
  );
});
test('explicit /tab new opencode bypasses classification and unsupported commands create no topic', async () => {
  const f = fixture({
    async classify() {
      throw new Error('should not classify');
    },
  });
  try {
    await f.manager.receive(incoming('/tab new opencode', 'alice', ''));
    const child = f.store.list()[0]!;
    assert.equal(child.agent, 'opencode');
    assert.ok(child.route.thread);
    assert.equal(f.agent.inputs.length, 0);
    await f.manager.receive(incoming('execute exactly this', 'alice', child.route.thread)); // classifier fails safely, no alternate Agent
    await f.manager.receive(incoming('/tab new Gemini', 'alice', ''));
    assert.equal(f.store.list().length, 1);
    assert.match(f.channel.sent.at(-1)!.text, /不支持指定的 Agent/);
  } finally {
    await f.cleanup();
  }
});

test('natural creation saves literal role separately from the first task and preserves it on later turns and reopen', async () => {
  const role = '你是一位文学编辑。\n  始终用中文回复。',
    task = '写一篇海边散文。';
  for (const agent of ['codex', 'claude', 'opencode'] as const) {
    const f = fixture({
      async classify({ text }) {
        return text.startsWith('另起')
          ? { action: 'new_topic', workspace: null, agent, instructions: role, task }
          : { action: 'continue', workspace: null, agent: null, instructions: null, task: null };
      },
    });
    try {
      f.config.defaultInstructions = 'default role';
      const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir, 'main role');
      main.nativeId = 'original-main';
      f.store.save(main);
      f.manager.closeSession(main.id);
      const request = incoming(
        `另起一个会话，用 ${agent}。系统提示词：${role}\n首个任务：${task}`,
        'alice',
        '',
      );
      await f.manager.receive(request);
      await f.manager.idle();
      const child = f.store.current({ ...request.route, thread: request.id })!;
      assert.equal(child.agent, agent);
      assert.equal(child.instructions, role);
      assert.equal(f.agent.inputs[0]!.text, task);
      assert.equal(f.agent.inputs[0]!.session.instructions, role);
      assert.deepEqual(
        f.store
          .events(child.id)
          .filter((e) => e.type === 'user')
          .map((e) => e.text),
        [task],
      );
      assert.equal(f.store.current(main.route)!.id, main.id);
      assert.equal(f.store.get(main.id)!.status, 'closed');
      assert.equal(f.store.get(main.id)!.nativeId, 'original-main');
      assert.equal(f.store.get(main.id)!.instructions, 'main role');
      f.manager.closeSession(child.id);
      f.manager.openSession(child.id);
      f.config.defaultInstructions = 'changed default';
      await f.manager.receive(incoming('继续润色', 'alice', child.route.thread));
      await f.manager.idle();
      assert.equal(f.agent.inputs[1]!.session.id, child.id);
      assert.equal(f.agent.inputs[1]!.session.instructions, role);
      const { Store } = await import('../src/core/store.js');
      const restored = new Store(f.config.dataDir);
      try {
        assert.equal(restored.get(child.id)!.instructions, role);
      } finally {
        restored.close();
      }
    } finally {
      await f.cleanup();
    }
  }
});

test('natural role-only creation waits for a task; omitted instructions copy defaults instead of the parent role', async () => {
  for (const role of ['你是一位编辑。', null]) {
    const f = fixture({
      async classify() {
        return {
          action: 'new_topic',
          workspace: null,
          agent: null,
          instructions: role,
          task: null,
        };
      },
    });
    try {
      f.config.defaultInstructions = 'global default';
      const parent = f.store.create(
        incoming('', 'alice', '').route,
        'codex',
        f.dir,
        'parent-specific role',
      );
      const request = incoming(
        role ? `另开会话，系统提示词：${role}` : '另开一个会话',
        'alice',
        '',
      );
      await f.manager.receive(request);
      const child = f.store.current({ ...request.route, thread: request.id })!;
      assert.equal(child.instructions, role ?? 'global default');
      assert.equal(child.status, 'idle');
      assert.equal(f.agent.inputs.length, 0);
      assert.deepEqual(f.store.events(child.id), []);
      assert.equal(f.store.get(parent.id)!.instructions, 'parent-specific role');
      await f.manager.receive(incoming('/tab instructions', 'alice', child.route.thread));
      assert.ok(f.channel.sent.at(-1)!.text.includes(role ?? 'global default'));
    } finally {
      await f.cleanup();
    }
  }
});

test('semantic instructions reject fabrication, history promotion, malformed values and non-new actions before creating topics', async () => {
  const text = '新开会话，系统提示词：你是一位编辑。',
    input = { text, recentUserMessages: ['past user request'] };
  for (const instructions of [
    'invented role',
    'past user request',
    '',
    '   ',
    'x'.repeat(16001),
    'bad\0role',
  ]) {
    assert.throws(() =>
      validateTopicDecision(
        { action: 'new_topic', workspace: null, agent: null, task: null, instructions },
        input,
      ),
    );
    const f = fixture({
      async classify() {
        return { action: 'new_topic', workspace: null, agent: null, task: null, instructions };
      },
    });
    try {
      await f.manager.receive(incoming(text, 'alice', ''));
      assert.equal(f.store.list().length, 0);
      assert.equal(f.agent.inputs.length, 0);
      assert.match(f.channel.sent.at(-1)!.text, /无法判断/);
    } finally {
      await f.cleanup();
    }
  }
  for (const action of ['continue', 'clarify', 'session_query'])
    assert.throws(() =>
      validateTopicDecision(
        { action, agent: null, task: null, instructions: '你是一位编辑。' },
        input,
      ),
    );
  assert.throws(() =>
    validateTopicDecision({ action: 'new_topic', workspace: null, agent: null, task: null }, input),
  );
  assert.throws(() =>
    validateTopicDecision(
      {
        action: 'new_topic',
        workspace: null,
        agent: null,
        task: null,
        instructions: 'x'.repeat(16001),
      },
      { text: 'x'.repeat(16001), recentUserMessages: [] },
    ),
  );
});

test('explicit natural-language workspace is saved before topic creation and used by the selected agent', async () => {
  const { mkdirSync, realpathSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const agent of ['codex', 'claude', 'opencode'] as const) {
    let path = '';
    const f = fixture({
      async classify() {
        return {
          action: 'new_topic',
          workspace: path,
          agent,
          task: '分析行情',
          instructions: '只用中文',
        };
      },
    });
    try {
      path = join(f.dir, '中文 project');
      mkdirSync(path);
      const main = f.store.create(incoming('', 'alice', '').route, 'codex', f.dir);
      main.nativeId = 'preserve-main';
      f.store.save(main);
      const before = f.store.get(main.id);
      const msg = incoming(
        `新建一个会话，使用 ${agent}，工作目录“${path}”。系统提示词：只用中文。任务：分析行情`,
        'alice',
        '',
      );
      await f.manager.receive(msg);
      await f.manager.idle();
      const run = f.agent.inputs[0]!;
      assert.equal(run.session.workspace, realpathSync(path));
      assert.equal(run.session.agent, agent);
      assert.equal(run.text, '分析行情');
      assert.equal(run.session.instructions, '只用中文');
      assert.equal(run.session.route.thread, msg.id);
      assert.deepEqual(f.store.get(main.id), before);
      assert.equal(f.store.current(main.route)!.id, main.id);
      assert.deepEqual(Object.keys(f.config.workspaces), ['default']);
    } finally {
      await f.cleanup();
    }
  }
});

test('unknown or missing explicitly requested workspace fails before making a topic, without default fallback', async () => {
  for (const path of [
    '/path/that/does/not/exist/tab-ai',
    'missing-preset',
    '../relative',
    '__proto__',
  ]) {
    const f = fixture({
      async classify() {
        return {
          action: 'new_topic',
          workspace: path,
          agent: null,
          instructions: null,
          task: null,
        };
      },
    });
    let topics = 0;
    f.channel.createTopic = async (m) => {
      topics++;
      return m;
    };
    try {
      await f.manager.receive(incoming(`新开会话，工作目录 ${path}`, 'alice', ''));
      assert.equal(topics, 0);
      assert.equal(f.store.list().length, 0);
      assert.equal(f.agent.inputs.length, 0);
      assert.match(f.channel.sent.at(-1)!.text, /工作区不存在|工作目录不存在/);
    } finally {
      await f.cleanup();
    }
  }
});

test('workspace extraction cannot invent a path or borrow it from history, and is valid only when creating', () => {
  const input = { text: '新开会话，使用 /tmp/exact', recentUserMessages: ['以前用 /tmp/previous'] };
  const base = {
    action: 'new_topic',
    workspace: '/tmp/exact',
    agent: null,
    instructions: null,
    task: null,
  };
  assert.equal(validateTopicDecision(base, input).workspace, '/tmp/exact');
  for (const value of [
    { ...base, workspace: '/tmp/previous' },
    { ...base, workspace: '/tmp/invented' },
    { ...base, action: 'continue' },
    { ...base, action: 'session_query' },
  ])
    assert.throws(() => validateTopicDecision(value, input));
});

test('explicit preset or home path starts the supplied task without initialization blocking', async () => {
  const { homedir } = await import('node:os');
  const { realpathSync } = await import('node:fs');
  for (const [selection] of [
    ['research', true],
    ['~/', false],
  ] as const) {
    const f = fixture({
      async classify() {
        return {
          action: 'new_topic',
          workspace: selection,
          agent: null,
          instructions: null,
          task: '检查文件',
        };
      },
    });
    const views: any[] = [];
    Object.assign(f.channel, {
      async sendSessionCard(view: any) {
        views.push(view);
        return 'om_init';
      },
      async updateSessionCard(view: any) {
        views.push(view);
      },
    });
    try {
      f.config.workspaces.research = realpathSync(homedir());
      const msg = incoming(`新开话题，使用工作目录 ${selection}，检查文件`, 'alice', '');
      await f.manager.receive(msg);
      await f.manager.idle();
      await f.manager.controls.drain();
      const s = f.store.current({ ...msg.route, thread: msg.id })!;
      assert.equal(s.workspace, realpathSync(homedir()));
      assert.equal(s.pendingInitialTask, undefined);
      assert.equal(f.agent.inputs.length, 1);
      assert.equal(views.at(-1).session.workspace, s.workspace);
      assert.equal(f.agent.inputs[0]!.session.workspace, s.workspace);
      assert.equal(f.agent.inputs[0]!.text, '检查文件');
    } finally {
      await f.cleanup();
    }
  }
});

test('explicit workspace without a task stays idle; capacity failure preserves the supplied task for begin', async () => {
  let task: string | null = null,
    path = '';
  const f = fixture({
    async classify() {
      return { action: 'new_topic', workspace: path, agent: null, instructions: null, task };
    },
  });
  Object.assign(f.channel, {
    async sendSessionCard() {
      return 'om_card';
    },
    async updateSessionCard() {},
  });
  try {
    path = f.dir;
    await f.manager.receive(incoming(`新建会话，工作目录 ${path}`, 'alice', ''));
    await f.manager.controls.drain();
    assert.equal(f.agent.inputs.length, 0);
    assert.equal(f.store.list()[0]!.pendingInitialTask, undefined);
    f.config.maxConcurrentRuns = 1;
    f.agent.handler = async (run) => {
      await new Promise<void>((resolve) =>
        run.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    f.manager.submit(f.store.list()[0]!.id, 'occupy capacity');
    await until(() => f.agent.inputs.length === 1);
    task = '准备新任务';
    const msg = incoming(`新建会话，工作目录 ${path}，准备新任务`, 'alice', '');
    await f.manager.receive(msg);
    const created = f.store.current({ ...msg.route, thread: msg.id })!;
    assert.equal(created.pendingInitialTask, task);
    assert.equal(f.agent.inputs.length, 1);
    assert.match(f.channel.sent.at(-1)!.text, /首个任务已保留/);
    f.manager.stop(f.agent.inputs[0]!.session.id);
    await f.manager.idle();
    f.agent.handler = async (run) => {
      run.hooks.nativeId('native-next');
    };
    f.manager.startInitial(created.id);
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 2);
    assert.equal(f.agent.inputs[1]!.text, task);
  } finally {
    await f.cleanup();
  }
});
