import { executionRecords } from '../core/execution-records.js';
import { agentPlans } from '../core/agent-plans.js';
import { groupModeInput, groupModePermissionHint } from '../core/group-mode.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Manager } from '../core/manager.js';
import { errorMessage } from '../core/types.js';
import { type SetupService } from '../setup/service.js';
import { GUIDES } from '../setup/providers.js';
import { agentSettingsSchema } from '../core/session-settings.js';
import { instructionsSchema } from '../core/session-instructions.js';

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const data of request) {
    size += data.length;
    if (size > 300_000) throw new Error('请求过大');
    chunks.push(Buffer.from(data));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function json(response: ServerResponse, status: number, data: unknown): void {
  if (status === 200 && response.req.method === 'GET' && response.req.url === '/api/state') {
    const etag = '\"' + createHash('sha256').update(JSON.stringify(data)).digest('hex') + '\"';
    response.setHeader('ETag', etag);
    if (response.req.headers['if-none-match'] === etag) {
      response.writeHead(304);
      response.end();
      return;
    }
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}
const answerSchema = z.union([
  z
    .object({
      allow: z.boolean(),
      scope: z.enum(['once', 'session']).optional(),
      cancel: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      answers: z.record(z.string(), z.array(z.string())),
      action: z.enum(['accept', 'decline', 'cancel']).optional(),
    })
    .strict(),
]);

export function createDashboard(manager: Manager, token: string, setup?: SetupService) {
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      const port =
        typeof server.address() === 'object'
          ? (server.address() as { port: number })?.port
          : manager.config.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (manager.config.dashboardLanHost) hosts.push(`${manager.config.dashboardLanHost}:${port}`);
      if (!hosts.includes(request.headers.host ?? ''))
        return json(response, 403, { error: 'Invalid host' });
      if (
        request.headers.origin &&
        !hosts.map((h) => `http://${h}`).includes(request.headers.origin)
      )
        return json(response, 403, { error: 'Invalid origin' });
      const path = new URL(request.url ?? '/', `http://${hosts[0]}`).pathname;
      if (
        request.method === 'GET' &&
        [
          '/',
          '/app.js',
          '/style.css',
          '/setup',
          '/setup.js',
          '/dashboard.js',
          '/task-structure.js',
        ].includes(path)
      ) {
        const file = path === '/' ? 'index.html' : path === '/setup' ? 'setup.html' : path.slice(1);
        response.setHeader(
          'Content-Type',
          file.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : file.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'text/css; charset=utf-8',
        );
        return response.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
      }
      const provided = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const expected = Buffer.from(token);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
        return json(response, 401, { error: '需要本地访问令牌' });
      if (path.startsWith('/api/setup')) {
        if (!setup)
          return json(response, 503, { error: '此实例未启用接入向导，请使用 tab-ai serve 启动。' });
        if (path === '/api/setup' && request.method === 'GET')
          return json(response, 200, {
            guides: GUIDES,
            current: setup.current(),
            drafts: setup.storage.drafts(),
          });
        if (path === '/api/setup/start' && request.method === 'POST')
          return json(response, 202, setup.start(await body(request)));
        const setupMatch = /^\/api\/setup\/([0-9a-f-]{36})(?:\/(confirm|cancel|verify))?$/.exec(
          path,
        );
        if (setupMatch && request.method === 'GET' && !setupMatch[2])
          return json(response, 200, setup.status(setupMatch[1]!));
        if (setupMatch && request.method === 'POST' && setupMatch[2] === 'verify')
          return json(response, 200, setup.verify(setupMatch[1]!, await body(request)));
        if (setupMatch && request.method === 'POST' && setupMatch[2] === 'confirm')
          return json(response, 200, await setup.confirm(setupMatch[1]!));
        if (setupMatch && request.method === 'POST' && setupMatch[2] === 'cancel')
          return json(response, 200, await setup.cancel(setupMatch[1]!));
        return json(response, 404, { error: 'Not found' });
      }
      const reportMatch = /^\/api\/sessions\/([0-9a-f-]{36})\/reports$/.exec(path);
      if (reportMatch) {
        const id = reportMatch[1]!;
        if (!manager.store.get(id)) return json(response, 404, { error: '会话不存在' });
        if (request.method === 'GET') {
          const query = new URL(request.url!, `http://${hosts[0]}`).searchParams,
            before = query.get('before');
          return json(response, 200, {
            reports: manager.store.reports.list(
              id,
              20,
              before ? z.coerce.number().int().positive().parse(before) : undefined,
            ),
          });
        }
        if (request.method === 'POST') {
          const data = z
            .object({ key: z.string().uuid().optional() })
            .strict()
            .parse(await body(request));
          return json(response, 202, {
            report: manager.reports.request(
              id,
              'manual',
              data.key ? `manual:${id}:${data.key}` : undefined,
            ),
          });
        }
      }
      if (path === '/api/experiences' && request.method === 'GET') {
        const query = new URL(request.url!, `http://${hosts[0]}`).searchParams,
          sessionId = query.get('sessionId');
        const session = sessionId ? manager.store.get(sessionId) : undefined;
        if (sessionId && !session) return json(response, 404, { error: '会话不存在' });
        return json(response, 200, {
          experiences: session
            ? manager.reports.experiences(session, query.get('q') ?? '')
            : manager.store.reports.experiences(undefined, query.get('q') ?? ''),
        });
      }
      const groupModeMatch = /^\/api\/channels\/([^/]+)\/group-mode$/.exec(path);
      if (path === '/api/management' && request.method === 'POST') {
        const result = await manager.executeManagement(
          await body(request),
          { kind: 'local' },
          setup ? (id, chat, mode) => setup.storage.setGroupMode(id, chat, mode) : undefined,
        );
        return json(response, 200, { ...result, hint: groupModePermissionHint });
      }
      if (groupModeMatch && request.method === 'POST') {
        if (!setup) throw new Error('未配置持久化接入服务');
        const data = groupModeInput.parse(await body(request));
        const result = await manager.executeManagement(
          {
            intent: 'group_mode.set',
            parameters: { botId: decodeURIComponent(groupModeMatch[1]!), ...data },
          },
          { kind: 'local' },
          (id, chat, mode) => setup.storage.setGroupMode(id, chat, mode),
        );
        return json(response, 200, { ...result, hint: groupModePermissionHint });
      }
      const roleMatch = /^\/api\/channels\/([^/]+)\/role$/.exec(path);
      if (roleMatch && request.method === 'POST') {
        if (!setup) throw new Error('未配置持久化接入服务');
        const data = z
          .object({ manager: z.boolean() })
          .strict()
          .parse(await body(request));
        const channel = manager.setBotRole(
          decodeURIComponent(roleMatch[1]!),
          data.manager,
          (id, role) => setup.storage.setManager(id, role),
        );
        return json(response, 200, { id: channel.id, manager: channel.manager });
      }
      const detailsMatch = /^\/api\/channels\/([^/]+)\/details$/.exec(path);
      if (detailsMatch && request.method === 'POST') {
        if (!setup) throw new Error('未配置持久化接入服务');
        const channel = manager.config.channels.find(
          (c) => c.id === decodeURIComponent(detailsMatch[1]!),
        );
        if (!channel) return json(response, 404, { error: '机器人不存在' });
        const details = setup.storage.setDetails(channel.id, await body(request));
        Object.assign(channel, details);
        return json(response, 200, { id: channel.id, ...details });
      }
      const sessionChildMatch = /^\/api\/sessions\/([0-9a-f-]{36})\/children$/.exec(path);
      if (path === '/api/task-nodes' && request.method === 'GET')
        return json(response, 200, { tasks: manager.taskCatalog() });
      if (path === '/api/task-nodes' && request.method === 'POST')
        return json(response, 201, await manager.createDashboardTask(await body(request)));
      const nodeChildMatch = /^\/api\/task-nodes\/((?:session|task):[0-9a-f-]{36})\/children$/.exec(
        path,
      );
      if (nodeChildMatch && request.method === 'POST')
        return json(
          response,
          201,
          await manager.createDashboardTask(await body(request), nodeChildMatch[1]!),
        );
      if (sessionChildMatch && request.method === 'POST')
        return json(
          response,
          201,
          await manager.createChildSession(sessionChildMatch[1]!, await body(request)),
        );
      const childMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/children$/.exec(path);
      if (childMatch && request.method === 'POST') {
        const parent = manager.store.taskRecord(childMatch[1]!);
        if (!parent?.sessionId) return json(response, 404, { error: '父任务会话不存在' });
        const input = await body(request);
        manager.tasks.adoptSession(parent.sessionId);
        return json(response, 201, await manager.tasks.createChild(parent.sessionId, input));
      }
      if (path === '/api/tasks' && request.method === 'GET')
        return json(response, 200, { tasks: manager.store.taskRecords() });
      if (path === '/api/tasks' && request.method === 'POST')
        return json(response, 201, await manager.createTask(await body(request)));
      const taskMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/(message|pause|resume|cancel)$/.exec(path);
      if (taskMatch && request.method === 'POST') {
        const task = manager.store.taskRecord(taskMatch[1]!);
        if (!task) return json(response, 404, { error: '任务不存在' });
        const operation = taskMatch[2];
        if (operation === 'message') {
          const data = z
            .object({ text: z.string().min(1).max(16000), key: z.string().min(1).max(200) })
            .strict()
            .parse(await body(request));
          if (!task.sessionId) throw new Error('任务尚未创建会话');
          if (task.executionMode === 'interactive') manager.submit(task.sessionId, data.text);
          else manager.tasks.enqueueUser(task.sessionId, data.text, data.key);
        } else if (operation === 'pause') manager.tasks.pause(task.id);
        else if (operation === 'resume') manager.tasks.resume(task.id);
        else manager.tasks.cancel(task.id);
        return json(response, 200, { task: manager.store.taskRecord(task.id) });
      }
      if (request.method === 'GET' && path === '/api/state')
        return json(response, 200, {
          sessions: manager.store.list(),
          tasks: manager.store.taskRecords(),
          interactions: manager.interactions(),
          sessionReportStates: manager.store.reports.statuses(),
          unifiedTaskModel: manager.store.taskModelUnified(),
          taskNodes: manager.taskCatalog(),
          agentCatalog: manager.agentCatalog(),
          executionRecords: true,
          scopedApprovals: true,
          mcpElicitation: true,
          dualEntryTasks: true,
          agentPlans: true,
          sessionCapabilities: manager.sessionCapabilities(),
          workspaces: Object.keys(manager.config.workspaces),
          defaultWorkspace: manager.config.defaultWorkspace,
          defaultAgent: manager.config.defaultAgent,
          defaultInstructions: manager.config.defaultInstructions ?? '',
          channels: manager.config.channels.map((c) => ({
            id: c.id,
            type: c.type,
            displayName: c.displayName ?? c.id,
            allowedUserCount: c.allowedUsers.length,
            connection: manager.channelStates.get(c.id),
            manager: c.manager === true,
            ...(c.type === 'lark' ? { groupModes: c.groupModes ?? {} } : {}),
            ...(c.type === 'wecom' ? { contextGroups: c.contextGroups ?? [] } : {}),
            ...(c.defaultWorkspace ? { defaultWorkspace: c.defaultWorkspace } : {}),
          })),
        });
      if (request.method === 'POST' && path === '/api/sessions') {
        const data = z
          .object({
            agent: z.enum(['codex', 'claude', 'opencode']),
            workspace: z.string(),
            instructions: instructionsSchema.optional(),
          })
          .strict()
          .parse(await body(request));
        const workspace = manager.config.workspaces[data.workspace];
        if (!workspace) throw new Error('未知工作区');
        const session = manager.store.create(
          {
            platform: 'local',
            account: 'dashboard',
            conversation: crypto.randomUUID(),
            thread: '',
            sender: 'local-owner',
          },
          data.agent,
          workspace,
          data.instructions ?? manager.config.defaultInstructions,
        );
        return json(response, 201, session);
      }
      const match =
        /^\/api\/sessions\/([^/]+)\/(events|records|todos|approval-policy|messages|begin|stop|answer|detach|attach|close|open|settings|replace-workspace|maintenance|compact|loops|loop-stop|reset|im-entry)$/.exec(
          path,
        );
      if (match) {
        const id = match[1]!;
        if (!manager.store.get(id)) return json(response, 404, { error: '会话不存在' });
        const action = match[2];
        if (request.method === 'GET' && action === 'todos') {
          const params = new URL(request.url!, 'http://localhost').searchParams,
            query = z
              .object({
                limit: z.coerce.number().int().min(1).max(50).default(10),
                before: z.coerce.number().int().positive().optional(),
              })
              .parse(Object.fromEntries(params));
          const supported = manager.agentPlansSupported(id);
          return json(response, 200, {
            supported,
            ...(supported
              ? agentPlans(manager.store, manager.store.get(id)!, query)
              : { plans: [] }),
          });
        }
        if (action === 'im-entry') {
          const session = manager.store.get(id)!;
          if (request.method === 'GET')
            return json(response, 200, {
              entry: session.imEntry,
              revision: manager.maintenanceInfo(id).revision,
            });
          if (request.method === 'POST') {
            const input = z
              .object({ revision: z.string().min(1), confirmedUnknown: z.boolean().default(false) })
              .strict()
              .parse(await body(request));
            return json(
              response,
              200,
              await manager.publishTaskEntry(id, input.revision, input.confirmedUnknown),
            );
          }
        }
        if (action === 'reset') {
          if (request.method === 'GET') return json(response, 200, manager.resetInfo(id));
          if (request.method === 'POST') {
            const data = z
              .object({ revision: z.string().min(1) })
              .strict()
              .parse(await body(request));
            return json(response, 201, await manager.resetSession(id, data.revision));
          }
        }
        if (action === 'approval-policy') {
          if (request.method === 'GET') return json(response, 200, manager.approvalPolicyInfo(id));
          if (request.method === 'POST') {
            const data = z
              .object({
                mode: z.string().min(1).max(80),
                revision: z.string().min(1),
                revoke: z.boolean().default(false),
              })
              .strict()
              .parse(await body(request));
            return json(
              response,
              200,
              await manager.setApprovalPolicy(id, data.mode, data.revision, data.revoke),
            );
          }
        }
        if (request.method === 'GET' && action === 'records') {
          const params = new URL(request.url!, 'http://localhost').searchParams;
          const query = z
            .object({
              kind: z.enum(['approvals', 'tools']).default('approvals'),
              before: z.coerce.number().int().positive().optional(),
              limit: z.coerce.number().int().min(1).max(50).default(30),
              q: z.string().max(200).default(''),
            })
            .parse(Object.fromEntries(params));
          return json(
            response,
            200,
            executionRecords(
              manager.store,
              id,
              query,
              manager.interactions(),
              manager.usageSession(id),
            ),
          );
        }
        if (request.method === 'GET' && action === 'maintenance')
          return json(response, 200, manager.maintenanceInfo(id));
        if (request.method === 'GET' && action === 'loops')
          return json(response, 200, await manager.loopInfo(id));
        if (request.method === 'GET' && action === 'settings') {
          await manager.settings.load(id);
          const session = manager.store.get(id)!;
          return json(response, 200, {
            settings: session.settings,
            revision: session.settingsRevision ?? 0,
            capabilities: manager.settings.snapshot(id),
          });
        }
        if (request.method === 'GET' && action === 'events')
          return json(response, 200, manager.store.events(id));
        if (request.method === 'POST') {
          if (action === 'compact') {
            const data = z
              .object({ revision: z.string().min(1) })
              .strict()
              .parse(await body(request));
            if (data.revision !== manager.maintenanceInfo(id).revision)
              throw new Error('会话状态已变化，请重新打开压缩面板。');
            return json(response, 202, manager.startCompaction(id));
          }
          if (action === 'loop-stop') {
            const data = z
              .object({ loopId: z.string().min(1).max(300), revision: z.string().min(1) })
              .strict()
              .parse(await body(request));
            if (data.revision !== manager.maintenanceInfo(id).revision)
              throw new Error('会话状态已变化，请刷新循环列表。');
            await manager.stopLoop(id, data.loopId);
            return json(response, 200, { ok: true });
          }
          if (action === 'replace-workspace') {
            const data = z
              .object({ workspace: z.string().min(1).max(4096) })
              .strict()
              .parse(await body(request));
            return json(response, 201, manager.replaceMainWorkspace(id, data.workspace));
          }
          if (action === 'settings') {
            const data = z
              .object({ settings: agentSettingsSchema, revision: z.number().int().min(0) })
              .strict()
              .parse(await body(request));
            manager.settings.save(id, data.settings, data.revision);
          } else if (action === 'messages')
            manager.submit(id, z.object({ text: z.string() }).parse(await body(request)).text);
          else if (action === 'begin') manager.startInitial(id);
          else if (action === 'stop') manager.stop(id);
          else if (action === 'close') manager.closeSession(id);
          else if (action === 'open') manager.openSession(id);
          else if (action === 'answer') {
            const data = z
              .object({ id: z.string(), answer: answerSchema })
              .parse(await body(request));
            manager.answer(id, data.id, data.answer);
          } else if (action === 'detach') return json(response, 200, manager.detach(id));
          else if (action === 'attach') manager.attach(id);
          else return json(response, 405, { error: 'Method not allowed' });
          return json(response, 200, { ok: true });
        }
      }
      json(response, 404, { error: 'Not found' });
    })().catch((error) => {
      if (!response.headersSent) json(response, 400, { error: errorMessage(error) });
      else response.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
