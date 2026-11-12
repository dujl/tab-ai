import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, incoming, until } from './helpers.js';
import { codexUsage, claudeUsage, openCodeUsage } from '../src/agents/token-usage.js';
import { currentUsage, usageInformation, compactionTokensText } from '../src/core/token-usage.js';
import { sessionInformation } from '../src/core/session-information.js';
import { managementView, managementText } from '../src/core/management-view.js';
import { executionRecords } from '../src/core/execution-records.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter, type ClaudeQuery } from '../src/agents/claude.js';
import type { AgentAdapter, AgentUsage } from '../src/core/types.js';
const usage = (context = 100000, total = 200000): AgentUsage => ({
  source: 'codex',
  last: {
    inputTokens: context - 100,
    outputTokens: 100,
    cachedInputTokens: 500,
    totalTokens: context,
  },
  total: {
    inputTokens: total - 1000,
    outputTokens: 1000,
    cachedInputTokens: 50000,
    totalTokens: total,
  },
  totalScope: 'session',
  contextTokens: context,
  contextKind: 'native',
  modelContextWindow: 200000,
});
function seed(f: ReturnType<typeof fixture>) {
  const s = f.store.create(incoming('').route, 'codex', f.dir);
  s.nativeId = 'native-1';
  s.tokenUsage = { nativeId: s.nativeId, at: Date.now(), value: usage() };
  f.store.save(s);
  return s;
}
test('native usage normalization preserves context, billing scope and cache/reasoning inclusions without double counting', () => {
  const v = usage();
  const result = codexUsage(
    { threadId: 'own', tokenUsage: { last: v.last, total: v.total, modelContextWindow: 200000 } },
    'own',
  );
  assert.deepEqual(result, v);
  assert.equal(codexUsage({ threadId: 'other', tokenUsage: v }, 'own'), undefined);
  assert.equal(
    codexUsage(
      { threadId: 'own', tokenUsage: { ...v, last: { ...v.last, inputTokens: -1 } } },
      'own',
    ),
    undefined,
  );
  const old = codexUsage(
    {
      threadId: 'own',
      tokenUsage: {
        last: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 },
        total: v.total,
      },
    },
    'own',
  );
  assert.equal(old?.contextTokens, undefined);
  const claude = claudeUsage({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
        output_tokens: 50,
      },
    },
  });
  assert.equal(claude?.contextTokens, 1150);
  assert.equal(claude?.last?.inputTokens, 900);
  assert.equal(
    claudeUsage({ type: 'assistant', parent_tool_use_id: 'child', message: { usage: {} } }),
    undefined,
  );
  const oc = openCodeUsage({
    tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 800, write: 200 } },
  });
  assert.equal(oc?.contextTokens, 1170);
  assert.equal(oc?.last?.outputTokens, 70);
  assert.equal(oc?.total, undefined);
});
test('Codex compaction captures restored baseline and final native usage, ignoring a foreign thread update', async () => {
  const f = fixture();
  try {
    const file = join(f.dir, 'codex.mjs');
    copyFileSync(new URL('./fixtures/fake-codex.mjs', import.meta.url), file);
    chmodSync(file, 0o755);
    writeFileSync(join(f.dir, 'compact-mode'), 'usage');
    const s = seed(f);
    s.nativeId = 'native-test-1';
    const result = await new CodexAdapter(file).compact(s, AbortSignal.timeout(3000));
    assert.equal(result.contextBefore, 100000);
    assert.equal(result.usage?.contextTokens, 20000);
    assert.equal(result.usage?.total?.totalTokens, 305000);
  } finally {
    await f.cleanup();
  }
});
test('Claude compaction uses native boundary counts and preserves query pipeline totals without inventing a session sum', async () => {
  const f = fixture();
  try {
    const runtime: ClaudeQuery = () => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'compact_boundary',
          session_id: 'claude-native',
          compact_metadata: { trigger: 'manual', pre_tokens: 80000, post_tokens: 12000 },
        } as any;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-native',
          is_error: false,
          result: '',
          modelUsage: {
            model: {
              inputTokens: 2000,
              outputTokens: 500,
              cacheReadInputTokens: 78000,
              cacheCreationInputTokens: 0,
              contextWindow: 200000,
            },
          },
        } as any;
      },
    });
    const s = f.store.create(incoming('').route, 'claude', f.dir);
    s.nativeId = 'claude-native';
    const result = await new ClaudeAdapter(undefined, [], runtime).compact(
      s,
      AbortSignal.timeout(3000),
    );
    assert.equal(result.contextBefore, 80000);
    assert.equal(result.usage?.contextTokens, 12000);
    assert.equal(result.usage?.total?.inputTokens, 80000);
    assert.equal(result.usage?.totalScope, 'query');
  } finally {
    await f.cleanup();
  }
});
test('usage survives run finalization, is scoped to native identity, and is shared by chat and web records', async () => {
  const f = fixture();
  try {
    f.agent.handler = async ({ hooks }) => {
      hooks.nativeId('native-1');
      hooks.usage?.(usage());
      hooks.usage?.({ ...usage(5000), source: 'claude' });
      hooks.usage?.({ ...usage(), contextTokens: -1 });
      hooks.text('done');
    };
    await f.manager.receive(incoming('研究一个问题'));
    await f.manager.idle();
    const s = f.store.current(incoming('').route)!;
    assert.equal(currentUsage(s)?.contextTokens, 100000);
    assert.match(usageInformation(s).context, /100,000 \/ 200,000 · 50.0%/);
    const text = managementText(managementView('menu', '', s, [], false));
    assert.match(text, /Token 消耗：200,000/);
    const records = executionRecords(f.store, s.id, { kind: 'tools', limit: 30, q: '' }, []);
    assert.equal(records.usage?.contextTokens, 100000);
    assert.ok(f.store.latestEvent(s.id, 'usage')?.text.includes('native-1'));
    assert.ok(sessionInformation(s).details.some((x) => x.label === '用量采样时间'));
    const other = { ...s, nativeId: 'new-native' };
    assert.equal(currentUsage(other), undefined);
    assert.equal(usageInformation(other).context, '未上报');
    other.nativeId = s.nativeId;
    other.agent = 'claude';
    assert.equal(currentUsage(other), undefined);
  } finally {
    await f.cleanup();
  }
});
test('successful compaction persists actual before/after counts while cumulative usage increases', async () => {
  const f = fixture();
  try {
    const s = seed(f);
    (f.agent as AgentAdapter).compact = async () => ({
      compacted: true,
      usage: usage(20000, 305000),
    });
    f.manager.startCompaction(s.id);
    await f.manager.idle();
    const after = f.store.get(s.id)!;
    assert.equal(currentUsage(after)?.contextTokens, 20000);
    assert.equal(currentUsage(after)?.total?.totalTokens, 305000);
    assert.deepEqual(
      after.lastCompactionTokens && [
        after.lastCompactionTokens.before,
        after.lastCompactionTokens.after,
      ],
      [100000, 20000],
    );
    assert.match(
      usageInformation(after).details.find((x) => x.label === '最近压缩对比')!.value,
      /减少 80,000 · 80.0%/,
    );
    assert.match(f.manager.maintenanceInfo(s.id).lastCompaction!.detail, /压缩已完成/);
    assert.equal(f.manager.maintenanceInfo(s.id).lastCompaction!.tokens?.after, 20000);
  } finally {
    await f.cleanup();
  }
});
test('missing post-compaction counts hide stale context until a new native observation arrives', async () => {
  const f = fixture();
  try {
    const s = seed(f);
    (f.agent as AgentAdapter).compact = async () => ({ compacted: true });
    f.manager.startCompaction(s.id);
    await f.manager.idle();
    assert.match(usageInformation(f.store.get(s.id)!).context, /待原生更新/);
    assert.match(usageInformation(f.store.get(s.id)!).total, /200,000/);
    f.agent.handler = async ({ hooks }) => {
      hooks.nativeId('native-1');
      hooks.usage?.(usage(12000, 320000));
    };
    await f.manager.receive(incoming('继续研究'));
    await f.manager.idle();
    assert.match(usageInformation(f.store.get(s.id)!).context, /12,000/);
  } finally {
    await f.cleanup();
  }
});
test('cancelled compaction does not claim a successful delta or keep a stale current occupancy', async () => {
  const f = fixture();
  try {
    const s = seed(f);
    let started = false;
    (f.agent as AgentAdapter).compact = async (_s, signal) => {
      started = true;
      await new Promise<void>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      return { compacted: true };
    };
    f.manager.startCompaction(s.id);
    await until(() => started);
    f.manager.stop(s.id);
    await f.manager.idle();
    assert.equal(f.manager.maintenanceInfo(s.id).lastCompaction!.phase, 'unconfirmed');
    assert.equal(f.store.get(s.id)!.lastCompactionTokens, undefined);
    assert.match(usageInformation(f.store.get(s.id)!).context, /待原生更新/);
    assert.equal(f.store.get(s.id)!.nativeId, s.nativeId);
  } finally {
    await f.cleanup();
  }
});
test('reset does not carry token usage or compression comparisons into the fresh native context', async () => {
  const f = fixture();
  try {
    const s = seed(f);
    const fresh = await f.manager.resetSession(s.id, f.manager.resetInfo(s.id).revision);
    assert.equal(currentUsage(fresh), undefined);
    assert.equal(fresh.tokenUsage, undefined);
    assert.equal(fresh.lastCompactionTokens, undefined);
    assert.match(compactionTokensText(0, 20), /增加 20/);
    assert.ok(!compactionTokensText(0, 20).includes('Infinity'));
    assert.match(compactionTokensText(), /未上报 → 待原生更新/);
  } finally {
    await f.cleanup();
  }
});
