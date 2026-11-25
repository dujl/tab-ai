import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming } from './helpers.js';
import { Store } from '../src/core/store.js';
import { collectedUsage } from '../src/core/usage-ledger.js';
import {
  usageInformation,
  usageBreakdown,
  compactTokens,
  archiveSessionUsage,
  computeSubtreeUsageMap,
} from '../src/core/token-usage.js';
import { claudeUsage } from '../src/agents/token-usage.js';
import type { AgentUsage, Session, TokenBreakdown } from '../src/core/types.js';

const breakdown = (input: number, output = 10): TokenBreakdown => ({
  inputTokens: input,
  cachedInputTokens: input / 2,
  cacheWriteInputTokens: 5,
  outputTokens: output,
});
const native = (input: number, output = 10): AgentUsage => ({
  source: 'codex',
  total: breakdown(input, output),
  totalScope: 'session',
});
function begin(store: Store, session: Session, id: string, baseline?: AgentUsage) {
  store.atomic(() => {
    store.usage.begin(session, id, 'turn', baseline);
    store.save(session);
  });
}
function record(store: Store, session: Session, id: string, value: AgentUsage) {
  store.atomic(() => {
    store.usage.record(session, value, id);
    store.save(session);
  });
}
function finish(
  store: Store,
  session: Session,
  id: string,
  status: 'completed' | 'interrupted' = 'completed',
) {
  store.atomic(() => {
    store.usage.finish(session, id, status);
    store.save(session);
  });
}

test('native snapshots replace within a turn and only their difference contributes to collected cumulative usage', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    begin(f.store, s, 'one');
    s.nativeId = 'own';
    record(f.store, s, 'one', native(100));
    record(f.store, s, 'one', native(100));
    record(f.store, s, 'one', native(200, 20));
    finish(f.store, s, 'one');
    begin(f.store, s, 'two', native(200, 20));
    record(f.store, s, 'two', native(260, 30));
    record(f.store, s, 'two', native(260, 30));
    finish(f.store, s, 'two');
    assert.equal(s.tokenLedger!.current.value?.inputTokens, 60);
    assert.equal(s.tokenLedger!.current.value?.outputTokens, 10);
    assert.equal(collectedUsage(s.tokenLedger!)!.inputTokens, 260);
    assert.equal(collectedUsage(s.tokenLedger!)!.cacheWriteInputTokens, 5);
    assert.equal(usageInformation(s).cumulative.input, '265');
    assert.equal(usageInformation(s).currentRound.input, '60');
    assert.equal(f.store.usage.list(s.id).runs.length, 2);
    record(f.store, s, 'two', native(900));
    assert.equal(
      s.tokenLedger!.native!.inputTokens,
      260,
      'late data cannot reopen a finalized run',
    );
  } finally {
    await f.cleanup();
  }
});

test('message replay and corrected message snapshots are deduplicated, and final query totals replace message subtotals', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'opencode', f.dir);
    begin(f.store, s, 'one');
    s.nativeId = 'own';
    const message = (id: string, input: number): AgentUsage => ({
      source: 'opencode',
      last: breakdown(input),
      sampleId: id,
    });
    for (const value of [
      message('a', 100),
      message('a', 100),
      message('a', 120),
      message('b', 200),
    ])
      record(f.store, s, 'one', value);
    assert.equal(s.tokenLedger!.current.value!.inputTokens, 320);
    const final: AgentUsage = {
      source: 'opencode',
      total: breakdown(350, 50),
      totalScope: 'query',
      complete: true,
    };
    record(f.store, s, 'one', final);
    record(f.store, s, 'one', final);
    record(f.store, s, 'one', message('late', 900));
    finish(f.store, s, 'one');
    assert.equal(collectedUsage(s.tokenLedger!)!.inputTokens, 350);
    assert.equal(s.tokenLedger!.current.partial, false);
    assert.equal(s.tokenLedger!.current.reason, undefined);
    begin(f.store, s, 'two');
    assert.match(usageInformation(s).round, /等待/);
    assert.equal(usageInformation(s).cumulative.input, '355');
    record(f.store, s, 'two', { ...final, total: breakdown(100, 10) });
    finish(f.store, s, 'two');
    assert.equal(collectedUsage(s.tokenLedger!)!.inputTokens, 450);
    const page = f.store.usage.list(s.id, undefined, 1);
    assert.equal(page.runs[0]!.runId, 'two');
    assert.equal(f.store.usage.list(s.id, page.nextBefore, 1).runs[0]!.runId, 'one');
  } finally {
    await f.cleanup();
  }
});

test('missing native baseline preserves cumulative totals without inventing a turn delta; counter resets preserve prior confirmed segments', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.nativeId = 'old';
    begin(f.store, s, 'one');
    record(f.store, s, 'one', native(1000, 100));
    finish(f.store, s, 'one');
    assert.equal(s.tokenLedger!.current.value, undefined);
    assert.match(usageInformation(s).currentRound.reason!, /基线/);
    assert.equal(usageInformation(s).cumulative.input, '1,005');
    begin(f.store, s, 'two', native(1000, 100));
    record(f.store, s, 'two', native(50, 5));
    assert.equal(s.tokenLedger!.current.partial, true);
    assert.equal(s.tokenLedger!.current.value, undefined);
    assert.equal(s.tokenLedger!.native!.inputTokens, 1000);
    assert.equal(s.tokenLedger!.segments, 2);
    record(f.store, s, 'two', native(50, 5));
    assert.equal(s.tokenLedger!.segments, 2);
    assert.equal(s.tokenLedger!.native!.inputTokens, 1000);
    record(f.store, s, 'two', native(90, 9));
    assert.equal(s.tokenLedger!.native!.inputTokens, 1040);
    assert.match(usageInformation(s).cumulative.scope, /分段.*部分/);
    assert.equal(usageInformation({ ...s, nativeId: 'foreign' }).cumulative.total, '未上报');
    assert.equal(usageInformation({ ...s, agent: 'claude' }).cumulative.total, '未上报');
  } finally {
    await f.cleanup();
  }
});

test('restart retains counters, marks in-flight usage partial, and does not replay the completed contribution', async () => {
  const f = fixture();
  let restarted: Store | undefined;
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    begin(f.store, s, 'one');
    s.nativeId = 'own';
    record(f.store, s, 'one', native(100));
    restarted = new Store(f.config.dataDir);
    const recovered = restarted.get(s.id)!;
    assert.equal(recovered.tokenLedger!.current.status, 'interrupted');
    assert.equal(recovered.tokenLedger!.current.partial, true);
    assert.equal(collectedUsage(recovered.tokenLedger!)!.inputTokens, 100);
    record(restarted, recovered, 'one', native(100));
    assert.equal(collectedUsage(recovered.tokenLedger!)!.inputTokens, 100);
    begin(restarted, recovered, 'two', native(100));
    record(restarted, recovered, 'two', native(140, 20));
    finish(restarted, recovered, 'two');
    assert.equal(collectedUsage(recovered.tokenLedger!)!.inputTokens, 140);
  } finally {
    restarted?.close();
    await f.cleanup();
  }
});

test('Claude resumed pipeline totals are differenced, including error usage, and startup zeroes do not destroy confirmed totals', async () => {
  const f = fixture();
  try {
    const result = (input: number, success = true) =>
      claudeUsage({
        type: 'result',
        subtype: success ? 'success' : 'error_max_turns',
        is_error: !success,
        modelUsage: {
          model: {
            inputTokens: input,
            outputTokens: input / 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      })!;
    const s = f.store.create(incoming('').route, 'claude', f.dir);
    begin(f.store, s, 'one');
    s.nativeId = 'own';
    record(f.store, s, 'one', result(100));
    finish(f.store, s, 'one');
    begin(f.store, s, 'two', result(100));
    record(f.store, s, 'two', result(250, false));
    finish(f.store, s, 'two');
    assert.equal(collectedUsage(s.tokenLedger!)!.inputTokens, 250);
    assert.equal(s.tokenLedger!.current.value!.inputTokens, 150);
    assert.equal(s.tokenLedger!.current.partial, true);
    assert.match(usageInformation(s).cumulative.scope, /流水线/);
    begin(f.store, s, 'three', result(250));
    record(f.store, s, 'three', result(0, false));
    assert.equal(s.tokenLedger!.native!.inputTokens, 250);
    assert.equal(s.tokenLedger!.segments, 1);
  } finally {
    await f.cleanup();
  }
});

test('optional cache fields stay unknown, zero remains zero, and display totals include cache writes and reasoning once', () => {
  const v = usageBreakdown({
    inputTokens: 100,
    outputTokens: 30,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 5,
    reasoningOutputTokens: 10,
  });
  assert.equal(v.input, '105');
  assert.equal(v.total, '135');
  assert.equal(v.output, '30');
  assert.equal(v.cacheRatio, '76.2%');
  const missing = usageBreakdown({ inputTokens: 100, outputTokens: 30 });
  assert.equal(missing.cacheRead, '未上报');
  assert.equal(missing.cacheWrite, '未上报');
  assert.equal(missing.input, '≥100');
  assert.equal(missing.total, '≥130');
  assert.equal(usageBreakdown(breakdown(0, 0)).cacheRead, '0');
  assert.equal(
    claudeUsage({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 30 } } })
      ?.last?.cachedInputTokens,
    undefined,
  );
});

test('compactTokens formats K/M/B units cleanly while preserving exact breakdowns and partial prefixes', () => {
  const cases: [number, string][] = [
    [0, '0'],
    [105, '105'],
    [999, '999'],
    [1000, '1K'],
    [1250, '1.3K'],
    [64000, '64K'],
    [64500, '64.5K'],
    [102000, '102K'],
    [999500, '1M'],
    [1050000, '1.05M'],
    [1200000, '1.20M'],
    [12500000, '12.5M'],
    [1000000000, '1B'],
  ];
  for (const [value, expected] of cases) assert.equal(compactTokens(value), expected);

  const large = usageBreakdown({
    inputTokens: 1_000_000,
    cachedInputTokens: 840_000,
    cacheWriteInputTokens: 50_000,
    outputTokens: 150_000,
  });
  assert.equal(large.input, '1,050,000');
  assert.equal(large.short.input, '1.05M');
  assert.equal(large.short.output, '150K');
  assert.equal(large.short.cacheRead, '840K');
  assert.equal(large.short.cacheWrite, '50K');
  assert.equal(large.short.total, '1.20M');

  const partial = usageBreakdown({ inputTokens: 2500, outputTokens: 400 }, 'claude');
  assert.equal(partial.short.input, '≥2.5K');
  assert.equal(partial.short.total, '≥2.9K');
  assert.equal(partial.short.cacheWrite, '未上报');

  const info = usageInformation({
    id: 'compact-info',
    agent: 'codex',
    nativeId: 'own',
    tokenUsage: {
      nativeId: 'own',
      at: 1000,
      value: {
        source: 'codex',
        contextTokens: 64_000,
        modelContextWindow: 200_000,
        totalScope: 'session',
        total: {
          inputTokens: 1_000_000,
          cachedInputTokens: 840_000,
          cacheWriteInputTokens: 50_000,
          outputTokens: 150_000,
        },
      },
    },
  } as Session);
  assert.equal(info.contextShort, '64K / 200K · 32.0%');
  assert.equal(info.totalShort, '1.20M');
  assert.equal(info.totalScopeShort, '原生会话累计');
  assert.equal(info.roundShort, '历史未采集');
});

test('task cumulative usage preserves totals across multiple resets and compactions while current session restarts fresh', async () => {
  const f = fixture();
  try {
    const s = f.store.create(incoming('').route, 'codex', f.dir);
    s.taskId = s.id;
    s.nativeId = 'ctx-1';
    begin(f.store, s, 'run-1');
    record(f.store, s, 'run-1', native(1000, 100));
    finish(f.store, s, 'run-1');
    f.store.atomic(() => {
      f.store.usage.begin(s, 'cmp-1', 'compact', {
        source: 'codex',
        total: breakdown(1000, 100),
        totalScope: 'session',
      });
      f.store.usage.record(s, native(1200, 120), 'cmp-1');
      f.store.usage.finish(s, 'cmp-1', 'completed');
      f.store.save(s);
    });

    // First reset: archive Context 1 (input 1200+5=1205, output 120, total 1325, 1 compaction)
    s.archivedTokenUsage = archiveSessionUsage(s);
    delete s.nativeId;
    delete s.tokenUsage;
    delete s.tokenLedger;
    f.store.save(s);

    const afterReset1 = usageInformation(s);
    assert.equal(afterReset1.resets, 1);
    assert.equal(afterReset1.compactions, 1);
    assert.equal(afterReset1.cumulative.hasValue, false);
    assert.equal(afterReset1.taskCumulative.input, '1,205');
    assert.equal(afterReset1.taskCumulative.output, '120');
    assert.equal(afterReset1.taskCumulative.total, '1,325');
    assert.equal(afterReset1.taskCumulative.partial, false);

    // Double reset before starting a new native context should not mark partial
    s.archivedTokenUsage = archiveSessionUsage(s);
    f.store.save(s);
    assert.equal(usageInformation(s).resets, 2);
    assert.equal(usageInformation(s).taskCumulative.partial, false);

    // Context 2 runs
    s.nativeId = 'ctx-2';
    begin(f.store, s, 'run-2');
    record(f.store, s, 'run-2', native(300, 50));
    finish(f.store, s, 'run-2');

    const withCtx2 = usageInformation(s);
    assert.equal(withCtx2.cumulative.input, '305');
    assert.equal(withCtx2.cumulative.total, '355');
    assert.equal(withCtx2.taskCumulative.input, '1,510');
    assert.equal(withCtx2.taskCumulative.output, '170');
    assert.equal(withCtx2.taskCumulative.total, '1,680');
    assert.equal(withCtx2.taskCumulative.archivedTotal, '1,325');
    assert.match(withCtx2.taskCumulative.scope, /含 2 次重置 · 1 次压缩/);
  } finally {
    await f.cleanup();
  }
});

test('computeSubtreeUsageMap aggregates mixed-agent descendants without losing cache writes and handles cycles safely', async () => {
  const f = fixture();
  try {
    const parent = f.store.create(incoming('').route, 'codex', f.dir);
    parent.nativeId = 'p-native';
    parent.archivedTokenUsage = {
      resets: 1,
      compactions: 1,
      recordedContexts: 1,
      partial: false,
      aggregate: { input: 500, output: 100, total: 600, partialInput: false, partialTotal: false },
      lastResetAt: 1000,
    };
    parent.tokenUsage = {
      nativeId: 'p-native',
      at: 2000,
      value: {
        source: 'codex',
        totalScope: 'session',
        total: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400 },
      },
    };

    const child = f.store.create(incoming('').route, 'claude', f.dir);
    child.nativeId = 'c-native';
    child.tokenUsage = {
      nativeId: 'c-native',
      at: 3000,
      value: {
        source: 'claude',
        totalScope: 'pipeline',
        total: {
          inputTokens: 2000,
          cachedInputTokens: 1000,
          cacheWriteInputTokens: 500,
          outputTokens: 300,
        },
      },
    };

    const grand = f.store.create(incoming('').route, 'opencode', f.dir);
    grand.nativeId = 'g-native';
    begin(f.store, grand, 'g-1');
    record(f.store, grand, 'g-1', {
      source: 'opencode',
      totalScope: 'query',
      complete: true,
      total: { inputTokens: 300, outputTokens: 50 },
    });
    finish(f.store, grand, 'g-1');

    const map = computeSubtreeUsageMap(
      [
        { key: 'p', sessionId: parent.id, title: '父任务', agent: 'codex' },
        { key: 'c', sessionId: child.id, parentKey: 'p', title: '子任务', agent: 'claude' },
        { key: 'g', sessionId: grand.id, parentKey: 'c', title: '孙任务', agent: 'opencode' },
        { key: 'cyc', sessionId: 'none', parentKey: 'cyc', title: '环', agent: 'codex' },
      ],
      new Map([
        [parent.id, parent],
        [child.id, child],
        [grand.id, grand],
      ]),
      true,
    );

    const pSub = map.get(parent.id)!;
    assert.equal(pSub.descendantCount, 2);
    assert.equal(pSub.recordedDescendants, 2);
    assert.equal(pSub.resets, 1);
    assert.equal(pSub.compactions, 1);
    // parent task: 1500 in / 300 out / 1800 total; child: 2500 in / 300 out / 2800 total; grand: ≥300 in / 50 out / ≥350 total
    assert.equal(pSub.total.input, '≥4,300');
    assert.equal(pSub.total.output, '650');
    assert.equal(pSub.total.total, '≥4,950');
    // Claude cacheWrite (500) must be preserved as ≥500, not dropped!
    assert.equal(pSub.total.cacheWrite, '≥500');
    assert.equal(pSub.childrenTotal.input, '≥2,800');
    assert.equal(pSub.childrenTotal.output, '350');
    assert.equal(pSub.children?.length, 2);
    assert.equal(pSub.children?.[0]?.depth, 1);
    assert.equal(pSub.children?.[1]?.depth, 2);
    assert.equal(map.get(grand.id), undefined);
  } finally {
    await f.cleanup();
  }
});
