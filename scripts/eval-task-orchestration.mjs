// Real native Agent integration in an isolated local task tree. No chat sends.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, defaultConfigFile } from '../dist/config.js';
import { Store } from '../dist/core/store.js';
import { Manager } from '../dist/core/manager.js';
import { CodexAdapter } from '../dist/agents/codex.js';
const original = loadConfig(defaultConfigFile());
const dir = mkdtempSync(join(tmpdir(), 'tab-ai-task-eval-'));
const config = {
  ...original,
  dataDir: join(dir, 'state'),
  workspaces: { default: dir },
  defaultWorkspace: 'default',
  channels: [],
  maxConcurrentRuns: 3,
  turnTimeoutMs: 180000,
};
const store = new Store(config.dataDir),
  agent = new CodexAdapter(original.agents.codex.command);
const manager = new Manager(
  config,
  store,
  { codex: agent, claude: agent, opencode: agent },
  new Map(),
);
const source = store.create(
  {
    platform: 'local',
    account: 'dashboard',
    conversation: 'test',
    thread: '',
    sender: 'local-owner',
  },
  'codex',
  dir,
);
store.event(source.id, 'user', 'UNRELATED_PARENT_HISTORY_MUST_NOT_COPY');
let task,
  passed = false;
try {
  task = await manager.createTask({
    sourceSessionId: source.id,
    key: 'native-eval',
    title: '编排集成验证',
    objective:
      '仅使用 tab_ai_tasks 的 task_create/list/review/report 工具，不使用 shell、web、文件工具，也不要读取文件。创建两个独立子任务：一个计算 17+25，另一个给出英文 tree 的中文含义。子任务使用 Codex，context 明确只做文字回答并用 task_report 提交，不能创建更下级任务。创建后结束当前轮等待结果；收到结果后逐个 task_review 验收，全部验收后 task_report 汇总。不要只口头声称已创建。',
    criteria: '两个子任务分别给出 42、树；主任务验收并完成。',
    workspace: 'default',
  });
  const deadline = Date.now() + 360000;
  let previous = '';
  while (Date.now() < deadline) {
    const tree = manager.tasks.tree(task),
      status = tree.map((t) => ({
        id: t.id,
        title: t.title,
        state: t.state,
        error: t.error,
        sessionId: t.sessionId,
      }));
    const signature = JSON.stringify(status);
    if (signature !== previous) {
      console.log(signature);
      previous = signature;
    }
    if (store.taskRecord(task.id)?.state === 'completed') {
      passed = tree.length === 3 && tree.every((t) => t.state === 'completed');
      await manager.idle();
      break;
    }
    if (tree.some((t) => t.state === 'blocked')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tree = manager.tasks.tree(task);
  const evidence = {
    passed,
    dir,
    tree,
    events: tree.map((t) => ({ taskId: t.id, events: store.events(t.sessionId, 1000) })),
  };
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      passed,
      evidence: join(dir, 'evidence.json'),
      states: tree.map((t) => t.state),
    }),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await manager.close();
  store.close();
}
