import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeAdapter } from '../src/agents/opencode.js';
import { OpenCodeServer } from '../src/agents/opencode-server.js';
import { type AgentRun, type Interaction, type Session } from '../src/core/types.js';
import { sessionIdentity } from '../src/core/session-identity.js';

function fixture(mode = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'tab-ai-opencode-')),
    log = join(dir, 'requests.jsonl');
  const adapter = new OpenCodeAdapter('opencode', [], (cwd, signal) =>
    OpenCodeServer.start(
      process.execPath,
      cwd,
      { ...process.env, TEST_OPENCODE_MODE: mode, TEST_OPENCODE_LOG: log },
      signal,
      [resolve('test/fixtures/fake-opencode.mjs')],
    ),
  );
  const session: Session = {
    id: 'manager',
    routeKey: 'local',
    route: {
      platform: 'local',
      account: 'dashboard',
      sender: 'local-owner',
      conversation: 'main',
      thread: '',
    },
    agent: 'opencode',
    workspace: dir,
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
  };
  const texts: string[] = [],
    asks: Omit<Interaction, 'id' | 'sessionId' | 'createdAt'>[] = [],
    controller = new AbortController();
  const run: AgentRun = {
    session,
    text: '  原始任务\n保留换行  ',
    signal: controller.signal,
    hooks: {
      nativeId: (id) => {
        session.nativeId = id;
      },
      text: (text) => texts.push(text),
      activity() {},
      async ask(q) {
        asks.push(q);
        return q.kind === 'approval' ? { allow: true } : { answers: { '1': ['B', 'A'] } };
      },
    },
  };
  return {
    adapter,
    session,
    run,
    texts,
    asks,
    controller,
    requests: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test('OpenCode starts its native server, creates/resumes native IDs and sends only the exact task and explicit native settings', async () => {
  const f = fixture();
  try {
    await f.adapter.run(f.run);
    assert.equal(f.session.nativeId, 'ses_created');
    assert.deepEqual(f.texts, ['OpenCode answer']);
    let requests = f.requests();
    assert.deepEqual(requests.find((r) => r.path?.endsWith('/message')).body, {
      parts: [{ type: 'text', text: f.run.text }],
    });
    assert.deepEqual(requests.find((r) => r.path === '/session').body, {});
    assert.ok(requests.every((r) => r.directory === f.session.workspace));
    f.session.settings = { model: 'native/m/sub', effort: 'high' };
    await f.adapter.run(f.run);
    requests = f.requests();
    assert.equal(requests.filter((r) => r.path === '/session').length, 1);
    assert.ok(requests.some((r) => r.path === '/session/ses_created' && r.method === 'GET'));
    assert.deepEqual(requests.filter((r) => r.path?.endsWith('/message')).at(-1).body, {
      parts: [{ type: 'text', text: f.run.text }],
      model: { providerID: 'native', modelID: 'm/sub' },
      variant: 'high',
    });
    assert.deepEqual(f.adapter.resumeCommand(f.session), [
      'opencode',
      '--session',
      'ses_created',
      '--model',
      'native/m/sub',
    ]);
    assert.match(sessionIdentity(f.session), /OpenCode 原生 ID：ses_created/);
    assert.match(sessionIdentity(f.session), /思考档位请在终端中确认/);
  } finally {
    f.cleanup();
  }
});
test('OpenCode bridges native approvals/questions, deduplicates requests, handles child sessions and ignores unrelated sessions', async () => {
  const f = fixture('interact');
  try {
    await f.adapter.run(f.run);
    assert.equal(f.asks.length, 2);
    assert.deepEqual(f.texts, ['OpenCode answer']);
    const q = f.asks.find((q) => q.kind === 'question')!;
    assert.equal(q.questions![0]!.multiSelect, true);
    assert.equal(q.questions![0]!.allowOther, false);
    const replies = f.requests().filter((r) => r.path.endsWith('/reply'));
    assert.deepEqual(replies.find((r) => r.path.includes('per_1')).body, { reply: 'once' });
    assert.deepEqual(replies.find((r) => r.path.includes('que_1')).body, { answers: [['B', 'A']] });
    assert.equal(replies.length, 2);
  } finally {
    f.cleanup();
  }
});
test('OpenCode catalogs only connected native providers and their model variants without starting a session', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.adapter.models(f.session, f.controller.signal), [
      {
        id: 'native/m/sub',
        label: 'Native model (native)',
        efforts: [
          { id: 'low', label: 'low' },
          { id: 'high', label: 'high' },
        ],
      },
    ]);
    assert.deepEqual(
      f.requests().map((r) => r.path),
      ['/provider'],
    );
  } finally {
    f.cleanup();
  }
});
test('OpenCode missing resume and provider failures never create substitute sessions or report success', async () => {
  const f = fixture();
  try {
    f.session.nativeId = 'ses_missing';
    await assert.rejects(f.adapter.run(f.run), /HTTP 404/);
    assert.deepEqual(
      f.requests().map((r) => r.path),
      ['/path', '/session/ses_missing'],
    );
    assert.deepEqual(f.texts, []);
  } finally {
    f.cleanup();
  }
  const g = fixture('error');
  try {
    await assert.rejects(g.adapter.run(g.run), /sign in/);
    assert.deepEqual(g.texts, []);
    assert.ok(g.requests().some((r) => r.aborted));
  } finally {
    g.cleanup();
  }
});
test('OpenCode cancellation and broken event connections abort the native task without replay', async () => {
  for (const mode of ['wait', 'disconnect']) {
    const f = fixture(mode);
    try {
      const pending = f.adapter.run(f.run);
      if (mode === 'wait') {
        const timer = setInterval(() => {
          try {
            if (f.requests().some((r) => r.path?.endsWith('/message'))) {
              clearInterval(timer);
              f.controller.abort(new Error('cancelled'));
            }
          } catch {}
        }, 10);
        timer.unref();
      }
      await assert.rejects(pending, mode === 'wait' ? /cancelled/ : /事件连接/);
      const requests = f.requests();
      assert.ok(requests.some((r) => r.aborted));
      assert.equal(requests.filter((r) => r.path?.endsWith('/message')).length, 1);
    } finally {
      f.cleanup();
    }
  }
});

test('OpenCode sends optional system additions on every resumed turn without changing user parts or permissions', async () => {
  const f = fixture();
  try {
    f.session.instructions = '  Be a literary editor.\nPreserve this text.  ';
    await f.adapter.run(f.run);
    await f.adapter.run(f.run);
    const messages = f.requests().filter((r) => r.path?.endsWith('/message'));
    assert.equal(messages.length, 2);
    for (const message of messages)
      assert.deepEqual(message.body, {
        parts: [{ type: 'text', text: f.run.text }],
        system: f.session.instructions,
      });
    assert.ok(!sessionIdentity(f.session).includes('本机原生恢复：opencode'));
  } finally {
    f.cleanup();
  }
});
test('OpenCode forwards owned tool lifecycle from SSE and excludes unrelated session tools', async () => {
  const f = fixture('tools'),
    tools: any[] = [];
  f.run.hooks.tool = (t) => tools.push(t);
  try {
    await f.adapter.run(f.run);
    assert.deepEqual(
      tools.map((t) => [t.id, t.status]),
      [
        ['ses_created:cmd', 'running'],
        ['ses_created:cmd', 'completed'],
      ],
    );
    assert.equal(tools[1].output, 'done');
  } finally {
    f.cleanup();
  }
});

test('OpenCode resumes history from another creation directory but verifies the actual server cwd', async () => {
  const f = fixture('old-directory');
  try {
    f.session.nativeId = 'ses_created';
    await f.adapter.run(f.run);
    assert.equal(f.session.nativeId, 'ses_created');
    assert.deepEqual(f.texts, ['OpenCode answer']);
    assert.ok(!f.requests().some((r) => r.path === '/session'));
    assert.ok(f.requests().every((r) => r.directory === f.session.workspace));
  } finally {
    f.cleanup();
  }
  for (const mode of ['wrong-cwd', 'wrong-id']) {
    const g = fixture(mode);
    try {
      g.session.nativeId = 'ses_created';
      await assert.rejects(g.adapter.run(g.run), /不匹配/);
      assert.equal(g.session.nativeId, 'ses_created');
      assert.deepEqual(g.texts, []);
      assert.ok(!g.requests().some((r) => r.path.endsWith('/message') || r.path === '/session'));
    } finally {
      g.cleanup();
    }
  }
});

test(
  'OpenCode shutdown terminates the owned native process behind a launcher',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tab-ai-opencode-launcher-')),
      pidFile = join(dir, 'native.pid');
    let server: OpenCodeServer | undefined;
    try {
      server = await OpenCodeServer.start(
        process.execPath,
        dir,
        {
          ...process.env,
          TEST_OPENCODE_LOG: join(dir, 'requests.jsonl'),
          TEST_OPENCODE_NATIVE_PID: pidFile,
        },
        AbortSignal.timeout(5000),
        [resolve('test/fixtures/fake-opencode-launcher.mjs')],
      );
      const nativePid = Number(readFileSync(pidFile, 'utf8'));
      await server.close();
      // Pipe closure and OS process reaping are asynchronous. A terminated zombie
      // can still pass kill(pid, 0), especially under the Linux CI init process.
      const running = () => {
        try {
          process.kill(nativePid, 0);
          return !execFileSync('ps', ['-o', 'stat=', '-p', String(nativePid)], {
            encoding: 'utf8',
          })
            .trim()
            .startsWith('Z');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          if ((error as { status?: number }).status === 1) return false;
          throw error;
        }
      };
      const deadline = Date.now() + 2000;
      while (running() && Date.now() < deadline) await delay(20);
      assert.equal(running(), false, 'launcher descendants must not remain as orphan servers');
    } finally {
      await server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('OpenCode remembers only exact ranges inside one framework session and never writes native project-wide always grants', async () => {
  const f = fixture('interact');
  let approvals = 0;
  f.run.hooks.ask = async (q) => {
    if (q.kind === 'approval') {
      approvals++;
      return { allow: true, scope: 'session' };
    }
    return { answers: { '1': ['B', 'A'] } };
  };
  try {
    await f.adapter.run(f.run);
    await f.adapter.run(f.run);
    assert.equal(approvals, 1);
    const other = { ...f.session, id: 'another-framework-session' };
    await f.adapter.run({ ...f.run, session: other });
    assert.equal(approvals, 2);
    await f.adapter.release(f.session.id);
    await f.adapter.run(f.run);
    assert.equal(approvals, 3);
    assert.ok(
      f
        .requests()
        .filter((r) => r.path.includes('/permission/') && r.path.endsWith('/reply'))
        .every((r) => r.body.reply === 'once'),
    );
  } finally {
    await f.adapter.close();
    f.cleanup();
  }
});
