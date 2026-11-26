import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usageInformation,
  computeSubtreeUsageMap,
  archiveSessionUsage,
} from '../src/core/token-usage.js';
import { until } from './helpers.js';
import type { Session } from '../src/core/types.js';
const { createTokenUsage } = await import(
  new URL('../src/web/public/dashboard.js', import.meta.url).href
);

class Element {
  children: Element[] = [];
  value = '';
  hidden = false;
  open = false;
  className = '';
  title = '';
  style: Record<string, string> = {};
  onclick?: () => void;
  setAttribute() {}
  set textContent(value: string) {
    this.value = value;
    this.children = [];
  }
  get textContent(): string {
    return this.value + this.children.map((c) => c.textContent).join(' ');
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.value = '';
    this.children = children;
  }
}
test('usage panel discards stale session responses and restores statistics after a transient failure without leaking another session', async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { getElementById: get, createElement: () => new Element() },
  });
  const pending: {
    path: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  try {
    const panel = createTokenUsage({
      api: (path: string) =>
        new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
    });
    const info = usageInformation({
      id: 'sample',
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
    panel.refresh('first');
    panel.refresh('second');
    assert.equal(pending.length, 2);
    pending[1]!.resolve({
      tokenInformation: {
        ...info,
        context: 'second context',
        contextShort: 'second context',
        contextKindLabel: undefined,
      },
      runs: [],
    });
    await until(() => get('token-usage-context').textContent.includes('second context'));
    pending[0]!.resolve({
      tokenInformation: {
        ...info,
        context: 'private first context',
        contextShort: 'private first context',
        contextKindLabel: undefined,
      },
      runs: [],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(get('token-usage-context').textContent, '当前上下文：second context');
    assert.match(get('token-usage-summary').textContent, /1\.05M/);
    assert.match(get('token-usage-summary').textContent, /840K/);
    assert.match(get('token-usage-table').textContent, /1,050,000/);
    assert.equal(get('token-usage-progress').hidden, false);
    assert.equal(get('token-usage-progress').children[0]!.style.width, '32.0%');
    assert.equal(get('token-usage-detail').children[0]!.className, 'usage-facts');
    assert.ok(!get('token-usage-detail').children[0]!.textContent.includes('；'));
    assert.equal(get('token-usage-detail').children[1]!.className, 'usage-caliber');
    assert.match(get('token-usage-detail').textContent, /口径说明：/);
    panel.refresh('second');
    pending[2]!.reject(new Error('temporary'));
    await until(() => get('token-usage-note').textContent.includes('读取失败'));
    panel.refresh('second');
    pending[3]!.resolve({
      tokenInformation: {
        ...info,
        context: 'second context',
        contextShort: 'second context',
        contextKindLabel: undefined,
      },
      runs: [],
    });
    await until(() => !get('token-usage-note').textContent.includes('读取失败'));
    assert.ok(![...elements.values()].some((e) => e.textContent.includes('private first context')));

    // Render a parent task with reset history and subtask breakdown
    const parentSession = {
      id: 'parent-1',
      agent: 'codex',
      nativeId: 'native-2',
      tokenUsage: {
        nativeId: 'native-2',
        at: 2000,
        value: {
          source: 'codex',
          contextTokens: 32_000,
          modelContextWindow: 200_000,
          totalScope: 'session',
          total: { inputTokens: 500_000, cachedInputTokens: 400_000, outputTokens: 100_000 },
        },
      },
    } as Session;
    parentSession.archivedTokenUsage = archiveSessionUsage({
      ...parentSession,
      nativeId: 'native-1',
      tokenUsage: {
        nativeId: 'native-1',
        at: 1000,
        value: {
          source: 'codex',
          totalScope: 'session',
          total: { inputTokens: 300_000, cachedInputTokens: 200_000, outputTokens: 50_000 },
        },
      },
    } as Session);
    const childSession = {
      id: 'child-1',
      agent: 'claude',
      nativeId: 'child-native',
      tokenUsage: {
        nativeId: 'child-native',
        at: 2500,
        value: {
          source: 'claude',
          totalScope: 'pipeline',
          total: {
            inputTokens: 200_000,
            cachedInputTokens: 100_000,
            cacheWriteInputTokens: 50_000,
            outputTokens: 50_000,
          },
        },
      },
    } as Session;
    const subMap = computeSubtreeUsageMap(
      [
        { key: 'p', sessionId: 'parent-1', title: '主任务', agent: 'codex' },
        { key: 'c', sessionId: 'child-1', parentKey: 'p', title: '子任务 A', agent: 'claude' },
      ],
      new Map([
        ['parent-1', parentSession],
        ['child-1', childSession],
      ]),
      true,
    );
    const richInfo = usageInformation(parentSession, subMap.get('parent-1'));
    panel.refresh('parent-1');
    pending[4]!.resolve({ tokenInformation: richInfo, runs: [] });
    await until(() => get('token-usage-summary').textContent.includes('含子任务总计'));
    assert.match(get('token-usage-lifecycle').textContent, /重置 1 次 · 含 1 个子任务/);
    assert.match(get('token-usage-summary').textContent, /本任务累计/);
    assert.match(get('token-usage-summary').textContent, /当前会话/);
    assert.match(get('token-usage-summary').textContent, /1\.25M/);
    assert.match(get('token-usage-table').textContent, /950,000/);
    assert.match(get('token-usage-table').textContent, /1,250,000/);
    assert.match(get('token-usage-children').textContent, /子任务 A/);
    assert.match(get('token-usage-children').textContent, /300K/);
  } finally {
    if (old) Object.defineProperty(globalThis, 'document', old);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
