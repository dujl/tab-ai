import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming, until } from './helpers.js';
import { autoApprovalChoice, approvalChoices } from '../src/core/approval-decisions.js';
import { nativeApprovalPolicy, nativeApprovalReviewer } from '../src/core/approval-policy.js';
import { executionRecords } from '../src/core/execution-records.js';
import { CardRegistry } from '../src/channels/cards.js';
import { larkCard, larkCardAction } from '../src/channels/lark-cards.js';
import { wecomCard } from '../src/channels/wecom-cards.js';
import { CodexAdapter } from '../src/agents/codex.js';
import type { Interaction, Answer } from '../src/core/types.js';

const request = () => ({
  kind: 'approval' as const,
  approvalAutomation: 'codex-command-file' as const,
  title: 'Command',
  detail: 'echo example',
  approvalOptions: approvalChoices(false, true).filter((o) => o.id !== 'deny'),
});

test('one explicit auto choice handles current, already pending and later requests in the same turn; questions and other sessions still wait', async () => {
  const f = fixture(),
    answers: Answer[] = [];
  f.agent.handler = async (run) => {
    if (run.text === 'other') {
      answers.push(await run.hooks.ask(request(), run.signal));
      return;
    }
    const first = run.hooks.ask(request(), run.signal),
      second = run.hooks.ask(request(), run.signal);
    answers.push(...(await Promise.all([first, second])));
    answers.push(await run.hooks.ask(request(), run.signal));
    answers.push(
      await run.hooks.ask(
        {
          kind: 'question',
          title: 'Which input?',
          detail: '',
          questions: [{ id: 'q', question: 'Choose', options: ['one'] }],
        },
        run.signal,
      ),
    );
  };
  try {
    const original = incoming('main');
    await f.manager.receive(original);
    await until(() => f.manager.interactions().length === 2);
    const first = f.manager.interactions()[0]!;
    assert.deepEqual(
      first.approvalOptions?.map((o) => o.id),
      ['allow', 'auto', 'cancel'],
    );
    assert.ok(
      first.approvalOptions
        ?.find((o) => o.id === 'auto')
        ?.description?.includes(first.sessionId.slice(0, 8)),
    );
    assert.throws(
      () => f.manager.answer('foreign-session', first.id, { allow: true, scope: 'auto' }),
      /不属于/,
    );
    f.manager.answer(first.sessionId, first.id, { allow: true, scope: 'auto' });
    await until(
      () => answers.length === 3 && f.manager.interactions().some((r) => r.kind === 'question'),
    );
    assert.deepEqual(answers, [{ allow: true }, { allow: true }, { allow: true }]);
    assert.equal(f.store.get(first.sessionId)?.approvalPolicy, 'auto-allow');
    const question = f.manager.interactions().find((r) => r.kind === 'question')!;
    assert.equal(question.approvalOptions, undefined);
    await f.manager.receive(incoming('other', 'alice', 'other-topic'));
    await until(() => f.manager.interactions().length === 2);
    const other = f.manager.interactions().find((r) => r.kind === 'approval')!;
    assert.notEqual(other.sessionId, first.sessionId);
    assert.notEqual(f.store.get(other.sessionId)?.approvalPolicy, 'auto-allow');
    const records = executionRecords(
      f.store,
      first.sessionId,
      { kind: 'approvals', limit: 20, q: '' },
      f.manager.interactions(),
    );
    const approved = records.items.filter((r: any) => r.status === 'allowed');
    assert.equal(approved.length, 3);
    assert.equal(approved.filter((r: any) => r.automatic).length, 2);
    assert.ok(approved.every((r: any) => r.answer.scope === 'auto'));
    f.manager.answer(other.sessionId, other.id, { allow: true });
    f.manager.answer(question.sessionId, question.id, { answers: { q: ['one'] } });
    await f.manager.idle();
  } finally {
    await f.cleanup();
  }
});

test('automatic mode can be revoked while a turn is running, then the next request asks again', async () => {
  const f = fixture();
  let resume!: () => void;
  f.agent.handler = async (run) => {
    await run.hooks.ask(request(), run.signal);
    await new Promise<void>((r) => (resume = r));
    await run.hooks.ask(request(), run.signal);
  };
  try {
    await f.manager.receive(incoming('work'));
    await until(() => f.manager.interactions().length === 1);
    const first = f.manager.interactions()[0]!;
    f.manager.answer(first.sessionId, first.id, { allow: true, scope: 'auto' });
    await until(() => !!resume);
    await f.manager.setApprovalPolicy(
      first.sessionId,
      'on-request',
      f.manager.approvalPolicyInfo(first.sessionId).revision,
    );
    resume();
    await until(() => f.manager.interactions().length === 1);
    const next = f.manager.interactions()[0]!;
    assert.equal(f.store.get(first.sessionId)?.approvalPolicy, 'on-request');
    f.manager.answer(next.sessionId, next.id, { allow: true });
    await f.manager.idle();
  } finally {
    resume?.();
    await f.cleanup();
  }
});

test('auto scope cannot be forged on an unsupported or expired request; close clears the policy', async () => {
  const f = fixture();
  f.agent.handler = async (run) => {
    await run.hooks.ask(
      { kind: 'approval', title: 'Unsupported', detail: '', approvalOptions: approvalChoices() },
      run.signal,
    );
  };
  try {
    await f.manager.receive(incoming('work'));
    await until(() => f.manager.interactions().length === 1);
    const r = f.manager.interactions()[0]!;
    assert.throws(
      () => f.manager.answer(r.sessionId, r.id, { allow: true, scope: 'auto' }),
      /不支持/,
    );
    assert.equal(f.store.get(r.sessionId)?.approvalPolicy, undefined);
    const expires = r.expiresAt;
    r.expiresAt = Date.now() - 1;
    assert.throws(
      () => f.manager.answer(r.sessionId, r.id, { allow: true, scope: 'auto' }),
      /过期/,
    );
    r.expiresAt = expires;
    f.manager.answer(r.sessionId, r.id, { allow: true });
    await f.manager.idle();
    await f.manager.setApprovalPolicy(
      r.sessionId,
      'auto-allow',
      f.manager.approvalPolicyInfo(r.sessionId).revision,
    );
    assert.equal(nativeApprovalPolicy(f.store.get(r.sessionId)!), 'on-request');
    assert.equal(nativeApprovalReviewer(f.store.get(r.sessionId)!), 'user');
    f.manager.closeSession(r.sessionId);
    assert.equal(f.store.get(r.sessionId)?.approvalPolicy, 'on-request');
  } finally {
    await f.cleanup();
  }
});

test('Feishu and WeCom offer explicit auto action; foreign/stale callbacks cannot enable it and Feishu rows stay bounded', () => {
  const registry = new CardRegistry(),
    answers: Answer[] = [];
  const r: Interaction = {
    ...request(),
    id: randomUUID(),
    sessionId: randomUUID(),
    createdAt: Date.now(),
    approvalOptions: [...approvalChoices(true, true), autoApprovalChoice],
  };
  const p = registry.open(incoming(''), r, (_sender, answer) => answers.push(answer)).cards[0]!;
  p.messageId = 'om_card';
  const card = larkCard(p);
  assert.ok(
    card.elements.filter((e: any) => e.tag === 'action').every((e: any) => e.actions.length <= 3),
  );
  assert.match(JSON.stringify(card), /开启本会话自动允许/);
  assert.match(JSON.stringify(wecomCard(p)), /本会话自动允许/);
  const raw = {
    operator: { open_id: 'alice' },
    context: { open_chat_id: 'chat-1', open_message_id: 'om_card' },
    action: { value: { id: p.id, action: 'auto' } },
  };
  assert.equal(
    larkCardAction(registry, { ...raw, operator: { open_id: 'stranger' } }).toast.type,
    'error',
  );
  assert.equal(larkCardAction(registry, raw).toast.type, 'success');
  assert.deepEqual(answers, [{ allow: true, scope: 'auto' }]);
  assert.equal(larkCardAction(registry, raw).toast.type, 'error');
  assert.equal(larkCard(p).header.template, 'green');
});

test('a native Codex approval carries the server-issued automation capability and receives only native accept', async () => {
  const f = fixture(),
    command = join(f.dir, 'codex-scopes.mjs');
  copyFileSync(new URL('./fixtures/fake-codex-scopes.mjs', import.meta.url), command);
  chmodSync(command, 0o755);
  const adapter = new CodexAdapter(command);
  (f.manager as any).agents.codex = adapter;
  try {
    await f.manager.receive(incoming('once-only'));
    await until(() => f.manager.interactions().length === 1);
    const r = f.manager.interactions()[0]!;
    assert.equal(r.approvalAutomation, 'codex-command-file');
    assert.ok(r.approvalOptions?.some((o) => o.id === 'auto'));
    f.manager.answer(r.sessionId, r.id, { allow: true, scope: 'auto' });
    await f.manager.idle();
    const trace = readFileSync(join(f.dir, 'scope-trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    assert.ok(trace.some((m) => m.result?.decision === 'accept'));
    assert.ok(!trace.some((m) => m.result?.decision === 'auto'));
    assert.equal(f.store.get(r.sessionId)?.approvalPolicy, 'auto-allow');
  } finally {
    await adapter.close();
    await f.cleanup();
  }
});
