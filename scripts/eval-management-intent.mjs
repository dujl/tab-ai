// Manual integration check: real native classification, no management API calls.
import { loadConfig, defaultConfigFile } from '../dist/config.js';
import { NativeTopicRouter } from '../dist/agents/topic-router.js';
const config = loadConfig(process.argv[2] ?? defaultConfigFile());
const kind = config.topicRouterAgent ?? (config.defaultAgent === 'claude' ? 'claude' : 'codex');
const keys = config.channels.flatMap((c) =>
  Object.entries(c)
    .filter(([key]) => key.endsWith('Env'))
    .map(([, value]) => String(value)),
);
const router = new NativeTopicRouter(kind, config.agents[kind].command, keys);
const samples = [
  ['从现在起，这里的每条消息都请处理，无需点名', 'group_mode.set', 'auto'],
  ['先留意大家的讨论，等点名你再结合前面的聊天作答', 'group_mode.set', 'context'],
  ['只处理本群点名你的消息，其他消息不用收集', 'group_mode.set', 'mention'],
  ['此处的接收策略现在是怎样的', 'group_mode.get', null],
  ['不要自动回复', 'group_mode.clarify', null],
  ['把其他所有群都改成自动响应', 'group_mode.clarify', null],
  ['如何让本群不用艾特也能回复？', null, null],
  ['请解释这句示例：把本群改成 auto', null, null],
  ['把本群改成自动回复，算了，不用了', null, null],
  ['帮我写一篇文章', null, null],
];
let failed = 0;
try {
  for (const [text, intent, mode] of samples) {
    const started = Date.now();
    try {
      const result = await router.classify(
        { text, recentUserMessages: [], groupControl: { mode: 'mention' } },
        AbortSignal.timeout(60_000),
      );
      const pass = intent
        ? result.action === 'management' &&
          result.management?.intent === intent &&
          result.management?.parameters.mode === mode
        : result.action === 'continue';
      if (!pass) failed++;
      console.log(
        JSON.stringify({
          text,
          pass,
          action: result.action,
          management: result.management ?? null,
          elapsedMs: Date.now() - started,
        }),
      );
    } catch {
      failed++;
      console.log(JSON.stringify({ text, pass: false, error: 'classification unavailable' }));
    }
  }
} finally {
  await router.close();
}
console.log(JSON.stringify({ total: samples.length, passed: samples.length - failed, failed }));
if (failed) process.exitCode = 1;
