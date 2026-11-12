// Native-provider integration check. Classifies fixed samples without creating work sessions or executing tasks.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  [
    '新开一个话题，使用 Codex。系统提示词：你是一位文学编辑，始终用中文回复。首个任务：写一篇海边散文。',
    'new_topic',
    'Codex',
    '你是一位文学编辑，始终用中文回复。',
    '写一篇海边散文。',
  ],
  [
    '另起一个 session，让 OpenCode 扮演资深编辑，始终用中文回答。先帮我润色这段文字。',
    'new_topic',
    'OpenCode',
    '扮演资深编辑，始终用中文回答。',
    '先帮我润色这段文字。',
  ],
  [
    '单独开一个会话，用 Claude Code。系统提示词：你是一位翻译。\n  只输出译文。\n首个任务：把 hello 翻译成中文。',
    'new_topic',
    'Claude Code',
    '你是一位翻译。\n  只输出译文。',
    '把 hello 翻译成中文。',
  ],
  [
    '开个新会话，系统提示词是「你是一名翻译，只输出译文。」',
    'new_topic',
    null,
    '你是一名翻译，只输出译文。',
    null,
  ],
  [
    '新建一个话题，帮我写一份文学编辑的系统提示词。',
    'new_topic',
    null,
    null,
    '帮我写一份文学编辑的系统提示词。',
  ],
  ['不用新开会话，你现在就作为文学编辑帮我改文章。', 'continue', null, null, null],
  ['解释一下“新开会话，系统提示词：你是一位编辑”这句话的作用。', 'continue', null, null, null],
  ['新开一个话题，使用 opencode 进行文学创作。', 'new_topic', 'opencode', null, '进行文学创作。'],
  [
    'Start a fresh session with Codex. System prompt: You are a patient tutor. First task: Explain fractions.',
    'new_topic',
    'Codex',
    'You are a patient tutor.',
    'Explain fractions.',
  ],
  ['新建一个会话，使用上次那份系统提示词。', 'clarify', null, null, null, ['你是一位编辑。']],
];
const results = [],
  controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  for (const [text, action, agent, instructions, task, recentUserMessages = []] of samples) {
    const started = Date.now();
    let result;
    try {
      const actual = await router.classify({ text, recentUserMessages }, controller.signal);
      result = {
        text,
        expected: { action, agent, instructions, task },
        actual,
        pass:
          actual.action === action &&
          actual.agent === agent &&
          actual.instructions === instructions &&
          actual.task === task,
        elapsedMs: Date.now() - started,
      };
    } catch {
      result = {
        text,
        pass: false,
        error: 'classification unavailable',
        elapsedMs: Date.now() - started,
      };
    }
    results.push(result);
    console.log(JSON.stringify(result));
    writeFileSync(
      join(config.dataDir, 'topic-instructions-eval.json'),
      JSON.stringify(
        { at: new Date().toISOString(), agent: kind, total: samples.length, results },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (controller.signal.aborted) break;
  }
} finally {
  await router.close();
}
if (results.length !== samples.length || results.some((r) => !r.pass)) process.exitCode = 1;
