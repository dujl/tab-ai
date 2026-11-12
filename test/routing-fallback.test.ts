import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, incoming } from './helpers.js';
import { fallbackDecision, needsExplicitManagement } from '../src/core/routing-fallback.js';
test('classifier outage preserves ordinary IM input, native session and default Agent without repetitive retries', async () => {
  let calls = 0;
  const f = fixture({
    async classify() {
      calls++;
      throw Error('sensitive provider details');
    },
  });
  try {
    const first = incoming('请分析今年的研究思路', 'alice', '');
    const s = f.store.create(first.route, 'claude', f.dir);
    s.nativeId = 'native-before';
    f.store.save(s);
    f.agent.handler = async (r) => {
      assert.equal(r.session.id, s.id);
      assert.equal(r.session.nativeId, 'native-before');
      assert.equal(r.session.agent, 'claude');
      r.hooks.text('正常工作结果');
    };
    for (const text of [first.text, '继续分析具体的风险', '比较一下两种方法']) {
      await f.manager.receive(incoming(text, 'alice', ''));
      await f.manager.idle();
    }
    assert.deepEqual(
      f.agent.inputs.map((r) => r.text),
      [first.text, '继续分析具体的风险', '比较一下两种方法'],
    );
    assert.equal(calls, 1);
    assert.equal(f.store.list().length, 1);
    assert.ok(
      !f.channel.sent.some((m) => m.text.includes('sensitive') || m.text.includes('无法判断')),
    );
  } finally {
    await f.cleanup();
  }
});
test('fallback holds ambiguous management but allows first ordinary request to create its normal session', async () => {
  const f = fixture({
    async classify() {
      throw Error('unavailable');
    },
  });
  try {
    await f.manager.receive(incoming('单独建个话题，让 Gemini CLI 执行', 'alice', ''));
    assert.equal(f.store.list().length, 0);
    await f.manager.receive(incoming('请给出一个调研提纲', 'alice', ''));
    await f.manager.idle();
    assert.equal(f.agent.inputs.length, 1);
    assert.equal(f.store.list().length, 1);
  } finally {
    await f.cleanup();
  }
});
test('degraded routing recognizes explicit attachment work and respects negation and development questions', () => {
  assert.equal(fallbackDecision('对这个文件的信息进行深入的分析。').action, 'attachment_request');
  assert.equal(fallbackDecision('请把这个附件转成在线文档').action, 'attachment_request');
  for (const text of ['不要下载这个文件', '如何实现附件下载功能', '修复图片分析功能'])
    assert.equal(fallbackDecision(text).action, 'continue');
  for (const text of ['新开一个会话', '切换工作目录到 /tmp', '单独建个话题', 'start a new session'])
    assert.equal(needsExplicitManagement(text), true);
  assert.equal(needsExplicitManagement('修复新建会话功能'), false);
});

test('invalid native structured decisions remain rejected rather than treated as provider outages', async () => {
  const { NativeTopicRouter } = await import('../src/agents/topic-router.js');
  const { InvalidTopicDecisionError } = await import('../src/core/topic-router.js');
  const router = new NativeTopicRouter('codex');
  router.generate = async () => ({ action: 'not-a-valid-action' });
  await assert.rejects(
    router.classify({ text: '继续研究', recentUserMessages: [] }, new AbortController().signal),
    InvalidTopicDecisionError,
  );
  const f = fixture(router);
  try {
    await f.manager.receive(incoming('继续研究', 'alice', ''));
    assert.equal(f.agent.inputs.length, 0);
    assert.ok(f.channel.sent.some((m) => m.text.includes('无法判断管理意图')));
  } finally {
    await f.cleanup();
  }
});
