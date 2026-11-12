#!/usr/bin/env node
import QRCode from 'qrcode';
import type { ManagementResult } from './core/management-api.js';
import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DEFAULT_DATA_DIRECTORY, defaultConfigFile, loadConfig } from './config.js';
import { migrateTaskDatabase } from './core/task-migration.js';
import { SLOGAN } from './brand.js';
import { serve, credentialKeys, lockDirectory } from './runtime.js';
import { agentEnvironment } from './agents/environment.js';
import { sessionName } from './core/session-title.js';
import { type Session, errorMessage } from './core/types.js';
import { runWizard } from './setup/wizard.js';
import { credentialResolver } from './setup/storage.js';
import { confirm } from '@inquirer/prompts';

const program = new Command()
  .name('tab-ai')
  .description(SLOGAN)
  .version('0.3.0')
  .option('-c, --config <path>', '配置文件', defaultConfigFile());
const config = () => loadConfig(resolve(program.opts<{ config: string }>().config));
function ensureConfig(): string {
  const file = resolve(program.opts<{ config: string }>().config);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      JSON.stringify(
        {
          dataDir: DEFAULT_DATA_DIRECTORY,
          port: 4317,
          defaultAgent: 'codex',
          defaultWorkspace: 'default',
          workspaces: { default: process.cwd() },
          channels: [],
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.log(`已创建 ${file}`);
  }
  return file;
}
async function api(path: string, method = 'GET', data?: unknown) {
  const c = config();
  const token = readFileSync(join(c.dataDir, 'token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${c.port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error((value as { error: string }).error);
  return value;
}

program
  .command('init')
  .description('初始化并按提示接入机器人')
  .option('--local', '只创建本地配置，不进入交互向导')
  .action(async (options: { local?: boolean }) => {
    if (!options.local && (!process.stdin.isTTY || !process.stdout.isTTY))
      throw new Error(
        '请在 SSH / 本机交互终端运行 init；自动化脚本用 init --local，随后在网页中接入机器人。',
      );
    const file = ensureConfig();
    if (!options.local && (await confirm({ message: '现在接入聊天机器人？', default: true })))
      await runWizard(file);
    console.log('启动服务：tab-ai serve\n网页向导：tab-ai dashboard --setup');
  });
program
  .command('setup')
  .description('按提示接入机器人；支持已运行的服务')
  .action(async () => {
    await runWizard(ensureConfig());
  });
program
  .command('serve')
  .description('启动本地管理界面与聊天连接')
  .action(async () => {
    const file = ensureConfig();
    const close = await serve(config(), file);
    const stop = () => {
      void close().then(
        () => process.exit(0),
        (error) => {
          console.error(errorMessage(error));
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
program
  .command('dashboard')
  .description('显示带访问令牌的本地管理页面地址')
  .option('--setup', '打开机器人接入向导')
  .action((options: { setup?: boolean }) => {
    const c = config();
    const token = readFileSync(join(c.dataDir, 'token'), 'utf8').trim();
    console.log(
      `http://${c.dashboardLanHost || '127.0.0.1'}:${c.port}/${options.setup || !c.channels.length ? 'setup' : ''}#token=${encodeURIComponent(token)}`,
    );
  });
program
  .command('migrate-tasks')
  .description('预览统一任务全量回填；--apply 在停服后备份并执行')
  .option('--apply', '备份后执行，默认只读预览')
  .action(async (options: { apply?: boolean }) => {
    const c = config();
    if (options.apply && existsSync(join(c.dataDir, 'daemon.lock'))) {
      const pid = Number(readFileSync(join(c.dataDir, 'daemon.lock'), 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) throw Error('服务锁无效，请先核对服务状态');
      try {
        process.kill(pid, 0);
        throw Error('请先停止服务，再执行任务回填；不会中断正在运行的会话');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    console.log(
      JSON.stringify(
        await migrateTaskDatabase(join(c.dataDir, 'state.sqlite'), !!options.apply),
        null,
        2,
      ),
    );
  });
program
  .command('doctor')
  .description('检查配置、原生 CLI 与平台凭证（不执行模型任务）')
  .action(() => {
    const c = config();
    console.log(`Node ${process.version}; workspaces: ${Object.keys(c.workspaces).join(', ')}`);
    for (const [agent, command] of [
      ['codex', c.agents.codex.command],
      ['claude', c.agents.claude.command ?? 'claude'],
      ['opencode', c.agents.opencode.command],
    ]) {
      const result = spawnSync(command!, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        env: agentEnvironment(credentialKeys(c)),
      });
      console.log(
        `${agent}: ${result.status === 0 ? result.stdout.trim() : agent === 'claude' && !c.agents.claude.command ? 'CLI 未安装；桥接可使用 SDK 自带运行时，原生终端恢复需要安装 claude' : '不可用，请安装/检查 command 配置'}`,
      );
    }
    const resolveSecret = credentialResolver(c);
    for (const channel of c.channels) {
      const keys = Object.entries(channel)
        .filter(([key]) => key.endsWith('Env'))
        .map(([, value]) => String(value));
      const missing = keys.filter((key) => {
        try {
          resolveSecret(key);
          return false;
        } catch {
          return true;
        }
      });
      console.log(
        `${channel.id} (${channel.type}): ${missing.length ? '缺少 ' + missing.join(', ') : '凭证可读取；需要复测收发时请向机器人发送 /tab status'}`,
      );
    }
  });
program
  .command('bot-role <bot> <role>')
  .description('设置 BOT 权限：manager 或 scoped；立即生效并保存')
  .action(async (id: string, role: string) => {
    if (!['manager', 'scoped'].includes(role)) throw new Error('角色必须是 manager 或 scoped');
    await api(`/channels/${encodeURIComponent(id)}/role`, 'POST', { manager: role === 'manager' });
    console.log(`${id}: ${role}（已保存并生效）`);
  });
program
  .command('group-mode <bot> <chat> [mode]')
  .description('飞书群模式：mention、context、auto；不填 mode 则查询')
  .action(async (id: string, chat: string, mode?: string) => {
    if (mode !== undefined && !['mention', 'context', 'auto'].includes(mode))
      throw new Error('模式必须是 mention、context 或 auto');
    const result = (await api('/management', 'POST', {
      intent: mode === undefined ? 'group_mode.get' : 'group_mode.set',
      parameters: { botId: id, chatId: chat, ...(mode === undefined ? {} : { mode }) },
    })) as ManagementResult;
    console.log(`${id} / ${chat}: ${result.mode}`);
    if (result.permission) {
      console.log(result.permission.message);
      if (result.permission.status !== 'ready' && result.permission.url) {
        console.log(`权限申请链接：${result.permission.url}`);
        console.log(
          await QRCode.toString(result.permission.url, { type: 'terminal', small: true }),
        );
      }
    }
  });
program
  .command('bots')
  .description('列出已接入 BOT 及管理权限')
  .action(async () => {
    const state = (await api('/state')) as {
      channels: { id: string; type: string; manager: boolean }[];
    };
    console.table(
      state.channels.map((c) => ({
        id: c.id,
        platform: c.type,
        role: c.manager ? 'manager' : 'scoped',
      })),
    );
  });
program
  .command('list')
  .description('列出运行实例中的会话')
  .action(async () => {
    const state = (await api('/state')) as { sessions: Session[] };
    console.table(
      state.sessions.map((s) => ({
        name: sessionName(s),
        managementId: s.id,
        nativeId: s.nativeId ?? '未启动',
        agent: s.agent,
        status: s.status,
        workspace: s.workspace,
      })),
    );
  });
program
  .command('stop <session>')
  .description('中断指定会话')
  .action(async (id: string) => {
    await api(`/sessions/${encodeURIComponent(id)}/stop`, 'POST');
    console.log('Stop requested');
  });
program
  .command('native <session>')
  .description('释放桥接会话并在原生 CLI 中继续；退出时交回')
  .action(async (id: string) => {
    const c = config();
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的会话 ID');
    const unlock = lockDirectory(join(c.dataDir, 'native', id));
    let detached = false;
    try {
      const result = (await api(`/sessions/${encodeURIComponent(id)}/detach`, 'POST')) as {
        command: string[];
        cwd: string;
      };
      detached = true;
      console.log(`Resuming native session in ${result.cwd}`);
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(result.command[0]!, result.command.slice(1), {
          cwd: result.cwd,
          env: agentEnvironment(credentialKeys(c)),
          stdio: 'inherit',
          shell: false,
        });
        const interrupt = () => child.kill('SIGINT');
        const terminate = () => child.kill('SIGTERM');
        const cleanup = () => {
          process.removeListener('SIGINT', interrupt);
          process.removeListener('SIGTERM', terminate);
        };
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        child.once('error', (error) => {
          cleanup();
          reject(error);
        });
        child.once('exit', (code, signal) => {
          cleanup();
          resolve(code ?? (signal ? 130 : 0));
        });
      });
      process.exitCode = code;
    } finally {
      try {
        if (detached) await api(`/sessions/${encodeURIComponent(id)}/attach`, 'POST');
      } finally {
        unlock();
      }
    }
  });
program.parseAsync().catch((error) => {
  console.error(
    `tab-ai: ${error instanceof Error && ['ExitPromptError', 'AbortPromptError', 'AbortError'].includes(error.name) ? '已取消向导。' : errorMessage(error)}`,
  );
  process.exitCode = 1;
});
