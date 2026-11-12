// Manual integration check: uses the configured native provider and its quota.
// Runs classification only; creates no chat messages, work sessions or tasks.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, defaultConfigFile } from '../dist/config.js';
import { NativeTopicRouter } from '../dist/agents/topic-router.js';
const config = loadConfig(process.argv[2] ?? defaultConfigFile());
const routerAgent =
  config.topicRouterAgent ?? (config.defaultAgent === 'claude' ? 'claude' : 'codex');
const router = new NativeTopicRouter(
  routerAgent,
  config.agents[routerAgent].command,
  config.channels.flatMap((c) =>
    Object.entries(c)
      .filter(([key]) => key.endsWith('Env'))
      .map(([, value]) => String(value)),
  ),
);
const samples = [
  ['新开一个话题，使用 opencode 这个 Agent 检查 README', 'new_topic', [], 'opencode'],
  ['另起个 session，让 Claude Code 检查 README', 'new_topic', [], 'Claude Code'],
  ['新开话题，用 Codex 研究 OpenCode 的工作原理', 'new_topic', [], 'Codex'],
  ['新开会话，使用 Gemini CLI 检查 README', 'new_topic', [], 'Gemini CLI'],
  ['另起个会话', 'new_topic'],
  ['能不能单独开个 session 帮我做社交媒体视频？', 'new_topic'],
  ['这件事放到一个全新的独立对话里处理：制作三十秒短视频', 'new_topic'],
  ['请给视频制作单开一个上下文', 'new_topic'],
  ['新开一个话题，用于社交媒体视频 生成', 'new_topic'],
  ['Start a fresh thread for social media video production.', 'new_topic'],
  ['请不要新开会话，就在这里做视频', 'continue'],
  ['解释一下“新开一个 session”是什么意思', 'continue'],
  ['帮我在代码里创建一个 session 对象', 'continue'],
  ['新开一个话题，算了，别开了，就在当前会话聊', 'continue'],
  ['今天聊聊旅游', 'continue'],
  ['把刚才那个任务放到单独的上下文里做吧', 'new_topic', ['生成一个三十秒的旅游短视频']],
];
const results = [];
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
for (let i = 0; i < samples.length; i += 2) {
  if (controller.signal.aborted) break;
  const batch = await Promise.all(
    samples.slice(i, i + 2).map(async ([text, expected, recentUserMessages = [], agent = null]) => {
      const started = Date.now();
      try {
        const decision = await router.classify({ text, recentUserMessages }, controller.signal);
        return {
          text,
          expected,
          decision,
          pass: decision.action === expected && decision.agent === agent,
          elapsedMs: Date.now() - started,
        };
      } catch {
        return {
          text,
          expected,
          pass: false,
          error: 'classification unavailable',
          elapsedMs: Date.now() - started,
        };
      }
    }),
  );
  results.push(...batch);
  for (const result of batch) console.log(JSON.stringify(result));
  writeFileSync(
    join(config.dataDir, 'topic-routing-eval.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        agent: routerAgent,
        total: samples.length,
        complete: results.length === samples.length,
        results,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
await router.close();
if (results.some((r) => !r.pass)) process.exitCode = 1;
