import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dingManagementMarkdown,
  dingMarkdownParts,
  hasDingMarkdown,
} from '../src/channels/dingtalk-markdown.js';
import type { ManagementView } from '../src/core/types.js';

const view: ManagementView = {
  action: 'menu',
  title: '本会话设置',
  text: '只管理当前会话 <at id=all>。',
  buttons: [
    { label: '会话状态', command: '/tab status' },
    { label: '压缩会话', command: '/tab compact', disabledReason: '正在执行' },
  ],
  information: {
    name: '测试*会话',
    status: '执行中',
    fields: [
      { label: 'Agent', value: 'Codex' },
      { label: '模型', value: '沿用原生，实际值未上报', shortValue: '原生默认（未上报）' },
      { label: '工作目录', value: '/test/project' },
      { label: 'Token 消耗', value: '100' },
    ],
    details: [{ label: '原生会话', value: 'native-test' }],
  },
};

test('DingTalk menus use compact native Markdown sections with literal values and exact commands', () => {
  const text = dingManagementMarkdown(view);
  assert.ok(text.startsWith('### 本会话设置\n'));
  assert.ok(text.includes('测试\\*会话'));
  assert.ok(text.includes('原生默认（未上报）'));
  assert.doesNotMatch(text, /native-test|Token 消耗|^> /m);
  assert.match(text, /\/tab status/);
  assert.match(text, /暂不可用：正在执行/);
  const rendered = dingMarkdownParts(text)
    .map((p) => p.markdown)
    .join('');
  assert.doesNotMatch(rendered, /<at/);
  assert.match(rendered, /&lt;at id=all&gt;/);
  const status = dingManagementMarkdown({ ...view, action: 'status' });
  assert.match(status, /Token 消耗/);
  assert.match(status, /native-test/);
});

test('DingTalk budgets escaped Markdown by bytes and retains exact source for per-part fallback', () => {
  const source = '&<>🙂中文\n'.repeat(700);
  const parts = dingMarkdownParts(source);
  assert.ok(parts.length > 1);
  assert.equal(parts.map((p) => p.plain).join(''), source);
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part.markdown) <= 5000);
    assert.doesNotMatch(part.markdown, /\uFFFD|<|>/);
    assert.doesNotMatch(part.markdown, /&(?!amp;|lt;|gt;)/);
  }
  for (const text of ['普通回答', 'C++ 和 foo_bar', '🙂中文\n'])
    assert.equal(hasDingMarkdown(text), false);
  for (const text of [
    '**重点**',
    '## 标题',
    '- 第一项',
    '1. 第一步',
    '[来源](https://example.test/)',
  ])
    assert.equal(hasDingMarkdown(text), true);
});
