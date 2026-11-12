import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../src/agents/codex.js';
import { LarkChannel } from '../src/channels/lark.js';
import { larkCardAction } from '../src/channels/lark-cards.js';
import { createDashboard } from '../src/web/server.js';
import { elicitationQuestions, elicitationContent } from '../src/core/mcp-elicitation.js';
import { validateAnswer, interactionText } from '../src/core/interactions.js';
import { fixture, incoming as original, until } from './helpers.js';
const incoming = (text: string) => original(text, 'alice', 'om_topic');
const form = {
  mode: 'form',
  message: '请确认访问 Chrome，仅本次',
  requestedSchema: { type: 'object', properties: {} },
};
const fields = {
  mode: 'form',
  message: '选择研究范围',
  requestedSchema: {
    type: 'object',
    properties: {
      allow: { type: 'boolean' },
      days: { type: 'integer', minimum: 1, maximum: 10 },
      market: {
        type: 'string',
        oneOf: [
          { const: 'cn', title: '中国' },
          { const: 'us', title: '美国' },
        ],
      },
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: 'a', title: '甲' },
            { const: 'b', title: '乙' },
          ],
        },
      },
      note: { type: 'string', maxLength: 8 },
    },
    required: ['allow', 'days', 'market', 'tags'],
  },
};
async function setup(request: unknown) {
  const f = fixture();
  f.config.interactionTimeoutMs = 10000;
  f.config.turnTimeoutMs = 10000;
  const executable = join(f.dir, 'fake-codex.mjs');
  copyFileSync(new URL('./fixtures/fake-codex-elicitation.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  writeFileSync(join(f.dir, 'elicitation-request.json'), JSON.stringify(request));
  const adapter = new CodexAdapter(executable);
  f.agent.handler = (run) => adapter.run(run);
  const lark = new LarkChannel(f.config.channels[0] as any, () => 'fixture'),
    cards: any[] = [],
    patches: any[] = [];
  Object.assign(lark, {
    client: {
      im: {
        message: {
          reply: async (args: any) => {
            cards.push(args);
            return { code: 0, data: { message_id: `om_card_${cards.length}` } };
          },
          patch: async (args: any) => {
            patches.push(args);
            return { code: 0 };
          },
        },
      },
    },
  });
  Object.assign(f.channel, { sendInteraction: lark.sendInteraction.bind(lark) });
  const trace = () =>
    readFileSync(join(f.dir, 'elicitation-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  return {
    ...f,
    cards,
    patches,
    trace,
    lark,
    async cleanup() {
      await f.cleanup();
      await adapter.close();
      await lark.stop();
    },
  };
}
function click(f: Awaited<ReturnType<typeof setup>>, action: string, index = 0) {
  const card = JSON.parse(f.cards[index].data.content),
    value = card.elements
      .flatMap((e: any) => (e.tag === 'action' ? e.actions : []))
      .find((a: any) => a.value?.action === action)?.value;
  assert.ok(value);
  return larkCardAction((f.lark as any).cards, {
    operator: { open_id: 'alice' },
    context: { open_chat_id: 'chat-1', open_message_id: `om_card_${index + 1}` },
    action: { value },
  });
}

test('MCP form conversion preserves typed values, optional omission, constraints and explicit decisions', () => {
  const q = elicitationQuestions(fields.requestedSchema),
    answers = {
      allow: ['否（false）'],
      days: ['3'],
      market: ['中国 — cn'],
      tags: ['甲 — a', '乙 — b'],
      note: [],
    };
  assert.deepEqual(elicitationContent(q, answers), {
    allow: false,
    days: 3,
    market: 'cn',
    tags: ['a', 'b'],
  });
  assert.throws(() => elicitationContent(q, { ...answers, days: ['11'] }), /不符合/);
  assert.throws(() => elicitationContent(q, { ...answers, allow: [] }), /不符合/);
  const request: any = {
    kind: 'question',
    questions: q,
    elicitation: { serverName: 'mcp', mode: 'form' },
  };
  assert.doesNotThrow(() => validateAnswer(request, { answers: {}, action: 'decline' }));
  assert.throws(
    () => validateAnswer({ ...request, elicitation: undefined }, { answers: {}, action: 'cancel' }),
    /不支持/,
  );
  assert.throws(
    () => validateAnswer(request, { answers: { days: ['1'] }, action: 'cancel' }),
    /不能附带/,
  );
  assert.match(
    interactionText({ ...request, id: 'i', title: 't', detail: '说明' }),
    /\/tab answer i cancel/,
  );
  for (const properties of [
    { password: { type: 'string' } },
    { nested: { type: 'object', properties: {} } },
    { name: { type: 'string', pattern: 'a+' } },
    { value: { type: 'number', minimum: 2, maximum: 1 } },
  ])
    assert.throws(() => elicitationQuestions({ type: 'object', properties }));
});

for (const [action, native, color] of [
  ['allow', 'accept', 'green'],
  ['deny', 'decline', 'red'],
  ['cancel', 'cancel', 'grey'],
])
  test(`MCP confirmation round-trips Feishu ${action} to native ${native} and keeps the turn alive`, async () => {
    const f = await setup(form);
    try {
      await f.manager.receive(incoming('normal'));
      await until(() => f.cards.length === 1);
      assert.equal(f.manager.interactions()[0]!.kind, 'approval');
      const result = click(f, action);
      assert.equal(result.toast.type, 'success');
      await f.manager.idle();
      await until(() => f.patches.length === 1);
      const reply = f.trace().find((m) => m.id === 'mcp-request-1');
      assert.deepEqual(reply.result, {
        action: native,
        content: native === 'accept' ? {} : null,
        _meta: null,
      });
      assert.equal(f.store.list()[0]!.status, 'idle');
      const card = JSON.parse(f.patches[0].data.content);
      assert.equal(card.header.template, color);
      assert.ok(!card.elements.some((e: any) => e.tag === 'action'));
      assert.ok(!JSON.stringify(f.cards).includes('acceptForSession'));
    } finally {
      await f.cleanup();
    }
  });

test('Dashboard typed form validates before settling and returns accepted content to the same native thread', async () => {
  const f = await setup(fields),
    server = createDashboard(f.manager, 'token');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await f.manager.receive(incoming('duplicate'));
    await until(() => f.cards.length === 5);
    const p = f.manager.interactions()[0]!,
      url = `http://127.0.0.1:${(server.address() as any).port}/api/sessions/${p.sessionId}/answer`,
      answer = {
        answers: {
          allow: ['是（true）'],
          days: ['3'],
          market: ['中国 — cn'],
          tags: ['甲 — a'],
          note: [],
        },
      },
      post = (a: unknown) =>
        fetch(url, {
          method: 'POST',
          headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: p.id, answer: a }),
        });
    assert.equal(
      (await post({ ...answer, answers: { ...answer.answers, days: ['99'] } })).status,
      400,
    );
    assert.equal(f.manager.interactions().length, 1);
    assert.equal((await post(answer)).status, 200);
    await f.manager.idle();
    await until(() => f.patches.length === 5);
    assert.deepEqual(f.trace().find((m) => m.id === 'mcp-request-1').result, {
      action: 'accept',
      content: { allow: true, days: 3, market: 'cn', tags: ['a'] },
      _meta: null,
    });
    assert.equal(f.trace().filter((m) => m.id === 'mcp-request-1').length, 1);
    assert.equal(f.store.list()[0]!.nativeId, 'native-mcp-test');
    assert.equal(f.store.list()[0]!.status, 'idle');
  } finally {
    await f.cleanup();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

for (const action of ['deny', 'cancel'])
  test(`MCP field form can ${action} from a Feishu card without submitting any field`, async () => {
    const f = await setup(fields);
    try {
      await f.manager.receive(incoming('normal'));
      await until(() => f.cards.length === 5);
      assert.equal(click(f, action).toast.type, 'success');
      await f.manager.idle();
      assert.deepEqual(f.trace().find((m) => m.id === 'mcp-request-1').result, {
        action: action === 'deny' ? 'decline' : 'cancel',
        content: null,
        _meta: null,
      });
      assert.equal(f.store.list()[0]!.status, 'idle');
    } finally {
      await f.cleanup();
    }
  });

test('MCP URL flow requires explicit confirmation and exposes a link without opening or granting automatically', async () => {
  const f = await setup({
    mode: 'url',
    message: '请完成授权',
    url: 'https://example.com/authorize?state=test',
    elicitationId: 'auth-1',
  });
  try {
    await f.manager.receive(incoming('normal'));
    await until(() => f.cards.length === 1);
    const c = JSON.parse(f.cards[0].data.content);
    assert.ok(
      c.elements.some((e: any) =>
        e.actions?.some((a: any) => a.url === 'https://example.com/authorize?state=test'),
      ),
    );
    assert.equal(f.trace().filter((m) => m.id === 'mcp-request-1').length, 0);
    click(f, 'allow');
    await f.manager.idle();
    assert.deepEqual(f.trace().find((m) => m.id === 'mcp-request-1').result, {
      action: 'accept',
      content: null,
      _meta: null,
    });
  } finally {
    await f.cleanup();
  }
});

for (const request of [
  { ...form, requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } },
  { ...form, requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } },
  {
    mode: 'openai/userVerification',
    challenge: 'private-challenge',
    title: 'Verify',
    description: 'private details',
  },
  { mode: 'url', message: 'invalid', url: 'javascript:alert(1)', elicitationId: 'x' },
])
  test(`unsupported MCP interaction is cancelled safely, mode=${request.mode}`, async () => {
    const f = await setup(request);
    try {
      await f.manager.receive(incoming('normal'));
      await f.manager.idle();
      assert.equal(f.cards.length, 0);
      assert.equal(f.store.list()[0]!.status, 'idle');
      assert.deepEqual(f.trace().find((m) => m.id === 'mcp-request-1').result, {
        action: 'cancel',
        content: null,
        _meta: null,
      });
      assert.ok(
        !JSON.stringify(f.store.events(f.store.list()[0]!.id)).includes('private-challenge'),
      );
      assert.ok(f.channel.sent.some((m) => m.text.includes('已取消该请求')));
    } finally {
      await f.cleanup();
    }
  });

for (const scope of [{ threadId: 'foreign-thread' }, { turnId: 'foreign-turn' }])
  test('foreign MCP context never prompts or authorizes the current session', async () => {
    const f = await setup({ ...form, ...scope });
    try {
      await f.manager.receive(incoming('normal'));
      await f.manager.idle();
      assert.equal(f.cards.length, 0);
      assert.equal(f.trace().find((m) => m.id === 'mcp-request-1').error.code, -32602);
      assert.equal(f.store.list()[0]!.status, 'idle');
    } finally {
      await f.cleanup();
    }
  });

test('MCP timeout sends cancel to the tool and the same turn completes normally', async () => {
  const f = await setup(form);
  f.config.interactionTimeoutMs = 50;
  try {
    await f.manager.receive(incoming('normal'));
    await f.manager.idle();
    assert.equal(f.store.list()[0]!.status, 'idle');
    assert.deepEqual(f.trace().find((m) => m.id === 'mcp-request-1').result, {
      action: 'cancel',
      content: null,
      _meta: null,
    });
    assert.equal(f.manager.interactions().length, 0);
    assert.equal(click(f, 'allow').toast.type, 'error');
  } finally {
    await f.cleanup();
  }
});

for (const mode of ['resolved', 'completed-with-pending'])
  test(`native ${mode} invalidates MCP cards without replying late or failing the turn`, async () => {
    const f = await setup(form);
    try {
      await f.manager.receive(incoming(mode));
      await until(() => f.cards.length === 1);
      await f.manager.idle();
      await until(() => f.manager.interactions().length === 0);
      assert.equal(f.store.list()[0]!.status, 'idle');
      assert.equal(f.trace().filter((m) => m.id === 'mcp-request-1').length, 0);
      assert.equal(click(f, 'allow').toast.type, 'error');
    } finally {
      await f.cleanup();
    }
  });

test('foreign serverRequest/resolved does not cancel a legitimate MCP prompt', async () => {
  const f = await setup(form);
  try {
    await f.manager.receive(incoming('foreign-resolved'));
    await until(() => f.cards.length === 1);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(f.manager.interactions().length, 1);
    click(f, 'deny');
    await f.manager.idle();
    assert.equal(f.trace().find((m) => m.id === 'mcp-request-1').result.action, 'decline');
  } finally {
    await f.cleanup();
  }
});

test('Feishu typed form cards collect all fields once, retain valid answers and allow an invalid field to be corrected', async () => {
  const f = await setup(fields);
  try {
    await f.manager.receive(incoming('normal'));
    await until(() => f.cards.length === 5);
    const submit = (i: number, value: unknown) => {
      const card = JSON.parse(f.cards[i].data.content),
        form = card.elements.find((e: any) => e.tag === 'form'),
        button = form.elements.find((e: any) => e.tag === 'button');
      return larkCardAction((f.lark as any).cards, {
        operator: { open_id: 'alice' },
        context: { open_chat_id: 'chat-1', open_message_id: `om_card_${i + 1}` },
        action: { value: button.value, form_value: value },
      });
    };
    assert.equal(submit(0, { selection: '1' }).toast.type, 'success');
    assert.equal(submit(1, { other: '99' }).toast.type, 'error');
    assert.equal(f.trace().filter((m) => m.id === 'mcp-request-1').length, 0);
    assert.equal(submit(1, { other: '4' }).toast.type, 'success');
    assert.equal(submit(2, { selection: '0' }).toast.type, 'success');
    assert.equal(submit(3, { selection: ['0', '1'] }).toast.type, 'success');
    assert.equal(submit(4, {}).toast.type, 'success');
    await f.manager.idle();
    assert.deepEqual(f.trace().find((m) => m.id === 'mcp-request-1').result.content, {
      allow: false,
      days: 4,
      market: 'cn',
      tags: ['a', 'b'],
    });
    assert.equal(f.trace().filter((m) => m.id === 'mcp-request-1').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('explicit stop invalidates a pending MCP form and does not send an accepted response', async () => {
  const f = await setup(fields);
  try {
    await f.manager.receive(incoming('normal'));
    await until(() => f.cards.length === 5);
    const id = f.store.list()[0]!.id;
    f.manager.stop(id);
    await f.manager.idle();
    assert.equal(f.manager.interactions().length, 0);
    assert.equal(f.store.get(id)!.status, 'interrupted');
    assert.ok(!f.trace().some((m) => m.id === 'mcp-request-1' && m.result?.action === 'accept'));
    assert.equal(click(f, 'deny').toast.type, 'error');
  } finally {
    await f.cleanup();
  }
});
