import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { larkSessionCard } from '../src/channels/lark-session-card.js';
import { CodexUsageHistory } from '../src/agents/codex-usage-history.js';
import { SessionUsage } from '../src/core/session-usage.js';
import { fixture, incoming } from './helpers.js';
import { executionRecords } from '../src/core/execution-records.js';
import { createDashboard } from '../src/web/server.js';
import type { AgentAdapter, ManagementView, Session } from '../src/core/types.js';
const id = '11111111-1111-4111-8111-111111111111';
const at = Date.parse('2025-01-15T12:00:00.000Z');
const meta = (nativeId = id) =>
  JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n';
const compact = (time = at - 4) =>
  JSON.stringify({ type: 'compacted', timestamp: new Date(time).toISOString(), payload: {} }) +
  '\n';
const count = (context = 20000, time = at) =>
  JSON.stringify({
    type: 'event_msg',
    timestamp: new Date(time).toISOString(),
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100000,
          cached_input_tokens: 80000,
          cache_write_input_tokens: 0,
          output_tokens: 2000,
          reasoning_output_tokens: 500,
          total_tokens: 102000,
        },
        last_token_usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: context,
        },
        model_context_window: 200000,
      },
    },
  }) + '\n';
function native(f: ReturnType<typeof fixture>, indexed = false, archived = false) {
  const home = join(f.dir, 'native-home'),
    dir = join(home, archived ? 'archived_sessions' : 'sessions', '2025', '01', '15');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-example-${id}.jsonl`);
  writeFileSync(file, meta() + compact() + count());
  if (indexed) {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES (?,?)').run(id, file);
    db.close();
  }
  const session = f.store.create(incoming('').route, 'codex', f.dir);
  session.nativeId = id;
  f.store.save(session);
  return { home, file, session, reader: new CodexUsageHistory(home) };
}
test('old native usage is read by indexed identity, including post-compaction context when input/output counters are zero', async () => {
  const f = fixture();
  try {
    const n = native(f, true),
      before = f.store.get(n.session.id),
      oldFile = (await import('node:fs')).readFileSync(n.file);
    const snapshot = n.reader.read(n.session)!;
    assert.equal(snapshot.nativeId, id);
    assert.equal(snapshot.at, at);
    assert.equal(snapshot.value.contextTokens, 20000);
    assert.equal(snapshot.value.total?.totalTokens, 102000);
    assert.equal(snapshot.value.modelContextWindow, 200000);
    assert.equal(snapshot.origin, 'native-history');
    assert.deepEqual(f.store.get(n.session.id), before);
    assert.deepEqual((await import('node:fs')).readFileSync(n.file), oldFile);
  } finally {
    await f.cleanup();
  }
});
test('archive fallback refreshes cached native counts and invalidates pre-compaction occupancy without discarding cumulative usage', async () => {
  const f = fixture();
  try {
    const n = native(f, false, true);
    assert.equal(n.reader.read(n.session)?.value.contextTokens, 20000);
    appendFileSync(n.file, compact(at + 1000));
    const interrupted = n.reader.read(n.session)!;
    assert.equal(interrupted.value.contextTokens, undefined);
    assert.equal(interrupted.contextInvalidated, true);
    assert.equal(interrupted.value.total?.totalTokens, 102000);
    appendFileSync(n.file, count(11000, at + 1001) + '{"unfinished":');
    assert.equal(n.reader.read(n.session)?.value.contextTokens, 11000);
  } finally {
    await f.cleanup();
  }
});
test('mismatched native metadata, escaped database paths, bad counts and missing history do not leak or break menus', async () => {
  const f = fixture();
  try {
    const n = native(f, true);
    writeFileSync(n.file, meta('other-native') + count());
    assert.equal(n.reader.read(n.session), undefined);
    writeFileSync(n.file, meta() + count(-1));
    assert.equal(n.reader.read(n.session), undefined);
    const outside = join(f.dir, 'outside.jsonl');
    writeFileSync(outside, meta() + count());
    const db = new DatabaseSync(join(n.home, 'state_5.sqlite'));
    db.prepare('UPDATE threads SET rollout_path=?').run(outside);
    db.close();
    assert.equal(new CodexUsageHistory(n.home).read(n.session), undefined);
    assert.equal(n.reader.read({ ...n.session, nativeId: '../escape' }), undefined);
    assert.equal(new CodexUsageHistory(join(f.dir, 'missing')).read(n.session), undefined);
  } finally {
    await f.cleanup();
  }
});
test('bounded history reads find late token samples in large files without parsing old tool content', async () => {
  const f = fixture();
  try {
    const n = native(f);
    writeFileSync(
      n.file,
      meta() +
        JSON.stringify({ type: 'irrelevant', payload: 'x'.repeat(5 * 1024 * 1024) }) +
        '\n' +
        compact() +
        count(),
    );
    assert.equal(n.reader.read(n.session)?.value.contextTokens, 20000);
  } finally {
    await f.cleanup();
  }
});
test('presentation enrichment respects fresher live samples, reset identity and unconfirmed compaction freshness', async () => {
  const f = fixture();
  try {
    const n = native(f),
      adapter = f.agent as AgentAdapter;
    adapter.historicalUsage = (s) => n.reader.read(s);
    const service = new SessionUsage(f.store, {
      codex: adapter,
      claude: adapter,
      opencode: adapter,
    });
    const historical = service.enrich(n.session);
    assert.equal(historical.tokenUsage?.value.contextTokens, 20000);
    assert.equal(n.session.tokenUsage, undefined);
    const live: Session = {
      ...n.session,
      tokenUsage: {
        nativeId: id,
        at: at + 100,
        value: { ...historical.tokenUsage!.value, contextTokens: 22000 },
      },
    };
    assert.equal(service.enrich(live).tokenUsage?.value.contextTokens, 22000);
    assert.equal(service.enrich({ ...n.session, nativeId: 'new' }).tokenUsage, undefined);
    const invalid = { ...n.session, contextUsageInvalidated: true };
    f.store.event(
      n.session.id,
      'compaction',
      JSON.stringify({
        id: 'later',
        phase: 'unconfirmed',
        startedAt: at + 100,
        updatedAt: at + 200,
        detail: 'aborted',
      }),
    );
    assert.equal(service.enrich(invalid).contextUsageInvalidated, true);
    appendFileSync(n.file, compact(at + 300) + count(12000, at + 301));
    assert.equal(service.enrich(invalid).contextUsageInvalidated, undefined);
    assert.equal(
      service.enrich({ ...invalid, operation: 'compact' }).contextUsageInvalidated,
      true,
    );
  } finally {
    await f.cleanup();
  }
});
test('old-session menu and web maintenance/records show native usage without model calls or changing management revisions/data', async () => {
  const f = fixture();
  let server: ReturnType<typeof createDashboard> | undefined;
  try {
    const n = native(f, true);
    (f.agent as AgentAdapter).historicalUsage = (s) => n.reader.read(s);
    let view: ManagementView | undefined;
    Object.assign(f.channel, {
      async sendManagement(_message: unknown, value: ManagementView) {
        view = value;
      },
    });
    f.manager.registerChannel(f.channel);
    const before = f.store.get(n.session.id),
      eventsBefore = f.store.events(n.session.id).length;
    const revision = f.manager.maintenanceInfo(n.session.id).revision;
    await f.manager.receive(incoming('/tab menu'));
    assert.match(view!.information!.fields.find((x) => x.label === 'Token 消耗')!.value, /102,000/);
    assert.match(
      view!.information!.fields.find((x) => x.label === '上下文占用')!.value,
      /20,000 \/ 200,000 · 10.0%/,
    );
    const records = executionRecords(
      f.store,
      n.session.id,
      { kind: 'tools', limit: 30, q: '' },
      [],
      f.manager.usageSession(n.session.id),
    );
    assert.equal(records.usage?.contextTokens, 20000);
    server = createDashboard(f.manager, 'test-token');
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const address = server.address() as any,
      headers = { Authorization: 'Bearer test-token' },
      base = `http://127.0.0.1:${address.port}/api/sessions/${n.session.id}`;
    for (const endpoint of ['/maintenance', '/records?kind=tools']) {
      const response = await fetch(base + endpoint, { headers });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.match(data.tokenInformation.context, /20,000/);
      assert.match(data.tokenInformation.total, /102,000/);
    }
    const nativeCard = larkSessionCard(
      f.manager.controls.snapshot({
        id: 'card',
        sessionId: n.session.id,
        revision: 1,
        delivery: 'sent',
        view: 'status',
      }),
    );
    assert.match(JSON.stringify(nativeCard), /102,000/);
    assert.equal(f.manager.maintenanceInfo(n.session.id).revision, revision);
    assert.deepEqual(f.store.get(n.session.id), before);
    assert.equal(f.store.events(n.session.id).length, eventsBefore);
    assert.equal(f.agent.inputs.length, 0);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await f.cleanup();
  }
});
