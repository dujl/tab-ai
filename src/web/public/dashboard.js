export function showReportDocument(doc) {
  const element = (tag, text) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const dialog = element('dialog'),
    content = element('pre', doc.content),
    actions = element('div'),
    close = element('button', '关闭'),
    download = element('button', '下载 Markdown');
  dialog.className = 'handoff-document';
  actions.className = 'dialog-actions';
  close.onclick = () => dialog.close();
  download.onclick = () => {
    const url = URL.createObjectURL(
        new Blob([doc.content], { type: 'text/markdown;charset=utf-8' }),
      ),
      a = element('a');
    a.href = url;
    a.download = doc.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  actions.append(download, close);
  dialog.append(element('h2', doc.filename), content, actions);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}
// Rank actionable native requests, independently of tree ancestry/execution state.
export function taskInbox(tree, interactions = [], opened = {}, now = Date.now()) {
  const pending = new Map();
  for (const r of interactions) {
    if (Number.isFinite(r.expiresAt) && r.expiresAt <= now) continue;
    const n = [...tree.nodes.values()].find((n) => n.session?.id === r.sessionId);
    if (!n || ['closed', 'detached'].includes(n.session.status)) continue;
    const entry = pending.get(n.key) || {
      node: n,
      requests: [],
      deadline: Infinity,
      createdAt: Infinity,
    };
    entry.requests.push(r);
    entry.deadline = Math.min(entry.deadline, r.expiresAt || Infinity);
    entry.createdAt = Math.min(entry.createdAt, r.createdAt || now);
    pending.set(n.key, entry);
  }
  const attention = [...pending.values()]
    .sort(
      (a, b) =>
        a.deadline - b.deadline ||
        a.createdAt - b.createdAt ||
        a.node.key.localeCompare(b.node.key),
    )
    .map((e) => {
      const approvals = e.requests.filter((r) => r.kind === 'approval').length,
        questions = e.requests.length - approvals;
      return {
        ...e,
        label: [approvals ? `待审批 ${approvals}` : '', questions ? `待回答 ${questions}` : '']
          .filter(Boolean)
          .join(' · '),
        tab: 'records',
      };
    });
  const preparation = [];
  for (const n of tree.nodes.values()) {
    if (
      pending.has(n.key) ||
      !n.session ||
      n.session.status !== 'idle' ||
      n.session.operation ||
      ['cancelled', 'completed', 'paused'].includes(n.task?.state)
    )
      continue;
    if (n.session.pendingInitialTask)
      preparation.push({ node: n, label: '待初始化 · 确认并开始', tab: 'conversation' });
    else if (
      !n.record?.objective?.trim() &&
      !n.session.nativeId &&
      (n.task || n.session.creationKey)
    )
      preparation.push({ node: n, label: '待补充目标', tab: 'conversation' });
  }
  const recent = [...tree.nodes.values()]
    .filter((n) => n.session?.status !== 'closed' && n.task?.state !== 'cancelled')
    .sort((a, b) => recentAt(b, opened) - recentAt(a, opened) || a.key.localeCompare(b.key));
  preparation.sort(
    (a, b) =>
      recentAt(b.node, opened) - recentAt(a.node, opened) || a.node.key.localeCompare(b.node.key),
  );
  return { attention, preparation, recent };
}
export function recentAt(n, opened = {}) {
  return Math.max(
    Number(n.record?.lastUserAt) || 0,
    Number(opened[n.key]) || 0,
    Number(n.session?.createdAt || n.task?.createdAt) || 0,
  );
}
export function readRecentOpened(raw, now = Date.now()) {
  try {
    return Object.fromEntries(
      Object.entries(JSON.parse(raw) || {})
        .filter(
          ([key, at]) => /^(session|task):/.test(key) && Number.isFinite(at) && at > 0 && at <= now,
        )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100),
    );
  } catch {
    return {};
  }
}

import { taskPath, taskRoot, isInBranch, taskColumns, outlineRows } from './task-structure.js';
const $ = (id) => document.getElementById(id);
const taskLabels = {
  provisioning: '创建中',
  queued: '排队',
  running: '执行中',
  waiting: '等待结果 / 补充',
  review: '待验收',
  completed: '已完成',
  blocked: '需处理',
  paused: '已暂停',
  cancelled: '已取消',
};
const sessionLabels = {
  idle: '空闲',
  running: '运行中',
  waiting: '待确认',
  interrupted: '已中断',
  error: '发生错误',
  detached: '原生终端中',
  closed: '已关闭',
};
const platforms = {
  local: '本地',
  lark: '飞书',
  wechat: '微信',
  wecom: '企业微信',
  dingtalk: '钉钉',
};
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (text, fn, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = fn;
  return b;
};
const badge = (t) => el('span', `task-badge ${t.state}`, taskLabels[t.state] || t.state);
const field = (label, value) => {
  const row = el('div', 'detail-field');
  row.append(el('dt', '', label), el('dd', '', value || '—'));
  return row;
};
const parentSessionId = (s) => s.parentSessionId ?? s.topicParentId;
const sameScope = (a, b) =>
  ['platform', 'account', 'conversation', 'sender'].every((k) => a.route[k] === b.route[k]);
export const sessionDisplayTitle = (s) =>
  /^【(?:tab-ai|GenesisBot) (?:话题交付摘要|话题阶段汇报)/.test(s.title || '')
    ? '群主任务'
    : s.title || `${s.agent} 任务`;

// A read-only navigation projection: a task and its session share one node.
export function buildSessionTree(state) {
  const sessions = new Map((state.sessions || []).map((s) => [s.id, s]));
  const bound = new Set(),
    nodes = new Map();
  const byTask = new Map((state.tasks || []).map((t) => [t.id, t])),
    taskKey = (t) => (t.originSession ? `session:${t.sessionId}` : `task:${t.id}`);
  for (const task of state.tasks || []) {
    if (task.sessionId) bound.add(task.sessionId);
    const session = sessions.get(task.sessionId),
      key = taskKey(task);
    const source = task.sourceSessionId && sessions.get(task.sourceSessionId);
    const parentKey = task.parentId
      ? byTask.has(task.parentId)
        ? taskKey(byTask.get(task.parentId))
        : `task:${task.parentId}`
      : source && !source.taskId && sameScope(source, task)
        ? `session:${source.id}`
        : undefined;
    nodes.set(key, {
      key,
      task,
      session,
      title: task.title,
      route: task.route,
      agent: task.agent,
      updatedAt: Math.max(task.updatedAt || 0, session?.updatedAt || 0),
      parentKey,
      children: [],
    });
  }
  for (const session of sessions.values())
    if (!bound.has(session.id)) {
      const key = `session:${session.id}`;
      const parent = parentSessionId(session),
        target = parent && sessions.get(parent);
      const valid =
        target &&
        (!target.taskId || byTask.get(target.taskId)?.originSession) &&
        sameScope(session, target);
      nodes.set(key, {
        key,
        session,
        title: sessionDisplayTitle(session),
        route: session.route,
        agent: session.agent,
        updatedAt: session.updatedAt || 0,
        parentKey: valid ? `session:${parent}` : undefined,
        anomaly: !!parent && !valid,
        children: [],
      });
    }
  // Keep orphaned and cyclic records inspectable, without inventing ancestry.
  for (const n of nodes.values()) {
    let parent = n.parentKey;
    const seen = new Set([n.key]);
    while (parent) {
      if (seen.has(parent) || !nodes.has(parent)) {
        n.anomaly = true;
        n.parentKey = undefined;
        break;
      }
      seen.add(parent);
      parent = nodes.get(parent).parentKey;
    }
  }
  const roots = [];
  for (const n of nodes.values()) {
    if (n.parentKey) nodes.get(n.parentKey).children.push(n);
    else roots.push(n);
  }
  const sort = (items) => {
    items.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    for (const n of items) sort(n.children);
  };
  sort(roots);
  return { nodes, roots };
}
export function filterSessionTree(tree, { query = '', kind = '', bot = '', status = '' } = {}) {
  const visible = new Set(),
    matches = new Set();
  query = query.trim().toLowerCase();
  for (const n of tree.nodes.values()) {
    if ((kind === 'plain' && n.task) || (kind === 'tasks' && !n.task)) continue;
    if (bot && n.route.account !== bot) continue;
    if (
      status &&
      (status.startsWith('task:')
        ? n.task?.state !== status.slice(5)
        : n.session?.status !== status)
    )
      continue;
    if (
      query &&
      !`${n.title} ${n.task?.objective || n.session?.topicObjective || ''} ${n.task?.id || ''} ${n.session?.id || ''}`
        .toLowerCase()
        .includes(query)
    )
      continue;
    matches.add(n.key);
    let p = n;
    while (p && !visible.has(p.key)) {
      visible.add(p.key);
      p = tree.nodes.get(p.parentKey);
    }
  }
  return { visible, matches };
}

// LAN HTTP pages have getRandomValues but may not expose randomUUID.
function taskCreationKey() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (!crypto?.getRandomValues)
    throw Error('浏览器无法生成任务编号，请更换浏览器或使用 HTTPS 后重试。');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createConsole({ api, refresh, selectSession, showError }) {
  const initial = new URLSearchParams(location.search),
    normalizeTab = (value) =>
      value === 'children'
        ? 'structure'
        : ['conversation', 'results', 'structure', 'records', 'todos'].includes(value)
          ? value
          : 'structure';
  let state,
    tree = { nodes: new Map(), roots: [] },
    view = initial.get('view') || 'tasks',
    selectedKey = initial.get('node') || '',
    focusKey = initial.get('focus') || '',
    tab = normalizeTab(initial.get('tab')),
    mode = initial.get('tree') === 'outline' ? 'outline' : 'columns';
  if (view === 'sessions') view = 'tasks';
  if (!['tasks', 'overview', 'agents', 'bots'].includes(view)) view = 'tasks';
  let pendingKey = '',
    query = '',
    botFilter = '',
    statusFilter = '',
    treeSignature = '',
    detailSignature = '',
    botSignature = '',
    agentSignature = '';
  let listScope = 'all';
  try {
    if (localStorage.getItem('tab-ai-task-list-scope') === 'roots') listScope = 'roots';
  } catch {}
  let opened = {};
  try {
    opened = readRecentOpened(localStorage.getItem('tab-ai-recent-opened'));
  } catch {}
  const collapsed = new Set(),
    run = (fn) => async () => {
      try {
        await fn();
        $('error').hidden = true;
      } catch (e) {
        showError(e);
      }
    };
  const goalLabels = { needs_goal: '待明确目标', active: '进行中', ...taskLabels };
  const nav = [
    ['tasks', 'Tasks · 任务', '01'],
    ['agents', 'Agents', '02'],
    ['bots', 'Bots', '03'],
    ['overview', '总览', '04'],
  ];
  for (const [key, label, number] of nav) {
    const b = button(label, () => show(key));
    b.dataset.view = key;
    b.prepend(el('span', 'nav-number', number));
    $('navigation').append(b);
  }
  const filters = $('session-filters'),
    search = el('input'),
    bot = el('select'),
    status = el('select');
  search.type = 'search';
  search.placeholder = '搜索任务、目标或 ID';
  search.setAttribute('aria-label', '搜索任务');
  bot.setAttribute('aria-label', '按 BOT 筛选');
  status.setAttribute('aria-label', '按状态筛选');
  status.append(
    new Option('全部状态', ''),
    ...Object.entries(goalLabels).map(([k, v]) => new Option(`目标 · ${v}`, 'goal:' + k)),
    ...Object.entries(sessionLabels).map(([k, v]) => new Option(`执行 · ${v}`, k)),
  );
  search.oninput = () => {
    query = search.value;
    render();
  };
  bot.onchange = () => {
    botFilter = bot.value;
    render();
  };
  status.onchange = () => {
    statusFilter = status.value;
    render();
  };
  const selects = el('div', 'filter-selects');
  selects.append(bot, status);
  filters.append(search, selects);
  const scopeSwitch = el('div', 'task-list-scope');
  scopeSwitch.setAttribute('role', 'group');
  scopeSwitch.setAttribute('aria-label', '展示范围');
  for (const [value, label] of [
    ['roots', '顶层任务'],
    ['all', '全部任务'],
  ]) {
    const b = button(label, () => {
      listScope = value;
      try {
        localStorage.setItem('tab-ai-task-list-scope', value);
      } catch {}
      treeSignature = '';
      render();
    });
    b.dataset.scope = value;
    scopeSwitch.append(b);
  }
  filters.prepend(el('p', 'task-scope-label', '展示范围'), scopeSwitch);
  $('new').onclick = () => openTaskForm();
  $('empty-new').onclick = () => openTaskForm();
  $('overview-create-task').onclick = () => openTaskForm();
  $('task-cancel-form').onclick = () => $('task-dialog').close();
  $('bot-cancel-form').onclick = () => $('bot-dialog').close();
  $('confirm-no').onclick = () => $('confirm-dialog').close();
  $('toggle-browser').onclick = () => {
    const closed = $('session-browser').classList.toggle('mobile-collapsed');
    $('toggle-browser').setAttribute('aria-expanded', String(!closed));
  };
  for (const [key, label] of [
    ['structure', '任务结构'],
    ['conversation', '对话'],
    ['todos', 'Agent 待办'],
    ['records', '审批与执行'],
    ['results', '交付与经验'],
  ]) {
    const b = button(label, () => {
      tab = key;
      remember(true);
      render();
      if (['conversation', 'records', 'todos'].includes(key)) void refresh();
    });
    b.dataset.tab = key;
    $('task-tabs').append(b);
  }
  function remember(push = false) {
    const url = new URL(location.href);
    url.searchParams.set('view', view);
    if (selectedKey) url.searchParams.set('node', selectedKey);
    if (focusKey) url.searchParams.set('focus', focusKey);
    url.searchParams.set('tab', tab);
    url.searchParams.set('tree', mode);
    if (url.pathname + url.search !== location.pathname + location.search)
      history[push ? 'pushState' : 'replaceState'](null, '', url.pathname + url.search);
  }
  function show(next) {
    view = next === 'sessions' ? 'tasks' : next;
    remember(true);
    render();
    if (view === 'tasks') void refresh();
  }
  function activate(id, taskId, options = {}) {
    const n = taskId
      ? [...tree.nodes.values()].find((n) => n.task?.id === taskId)
      : [...tree.nodes.values()].find((n) => n.session?.id === id);
    selectedKey = n?.key || (taskId ? `task:${taskId}` : `session:${id}`);
    opened = readRecentOpened(JSON.stringify({ ...opened, [selectedKey]: Date.now() }));
    try {
      localStorage.setItem('tab-ai-recent-opened', JSON.stringify(opened));
    } catch {}
    pendingKey = n ? '' : selectedKey;
    tab = normalizeTab(options.tab || 'conversation');
    focusKey =
      options.focus && isInBranch(tree, selectedKey, options.focus)
        ? options.focus
        : focusKey && isInBranch(tree, selectedKey, focusKey)
          ? focusKey
          : taskRoot(tree, selectedKey)?.key || selectedKey;
    for (const p of taskPath(tree, selectedKey)) collapsed.delete(p.key);
    view = 'tasks';
    treeSignature = '';
    detailSignature = '';
    remember(true);
    $('session-browser').classList.add('mobile-collapsed');
    $('toggle-browser').setAttribute('aria-expanded', 'false');
    render();
  }
  function choose(n, open = false) {
    if (!n) return;
    selectSession(n.session?.id, n.task?.id, {
      tab: open ? 'conversation' : 'structure',
      focus: focusKey,
    });
  }
  function focus(n) {
    if (!n) return;
    focusKey = n.key;
    choose(n);
  }
  function sync(next) {
    state = next;
    tree = buildSessionTree(state);
    const catalog = new Map((state.taskNodes || []).map((n) => [n.key, n]));
    for (const n of tree.nodes.values()) {
      n.record = catalog.get(n.key) || {
        title: n.title,
        objective: n.task?.objective || n.session?.topicObjective || '',
        criteria: n.task?.criteria || n.session?.topicCriteria || '',
        goalState:
          n.task?.state ||
          (!n.session?.topicObjective
            ? 'needs_goal'
            : n.session?.topicCompleted
              ? 'completed'
              : 'active'),
      };
      n.title = n.record.title || n.title;
    }
    if (tree.nodes.has(pendingKey)) pendingKey = '';
    if (!tree.nodes.has(selectedKey) && !pendingKey) selectedKey = tree.roots[0]?.key || '';
    if (!tree.nodes.has(focusKey) || !isInBranch(tree, selectedKey, focusKey))
      focusKey = taskRoot(tree, selectedKey)?.key || selectedKey;
    return tree.nodes.get(selectedKey)?.session?.id;
  }
  function filtered() {
    const result = filterSessionTree(tree, {
      query,
      bot: botFilter,
      status: statusFilter.startsWith('goal:') ? '' : statusFilter,
    });
    if (statusFilter.startsWith('goal:')) {
      for (const key of result.matches)
        if (tree.nodes.get(key).record.goalState !== statusFilter.slice(5))
          result.matches.delete(key);
      result.visible.clear();
      for (const key of result.matches)
        for (const p of taskPath(tree, key)) result.visible.add(p.key);
    }
    return result;
  }
  function render(next) {
    if (next) state = next;
    if (!state) return;
    for (const b of $('navigation').children) {
      b.classList.toggle('active', b.dataset.view === view);
      b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
    }
    for (const name of ['overview', 'agents', 'bots']) $(`${name}-page`).hidden = view !== name;
    const n = tree.nodes.get(selectedKey),
      isTaskView = view === 'tasks';
    const plansAvailable =
      !!state.agentPlans && !!n?.session && !!state.sessionCapabilities?.[n.session.id]?.plans;
    if (tab === 'todos' && !plansAvailable) {
      tab = 'conversation';
      remember();
    }
    $('agent-plans-panel').hidden = !isTaskView || !plansAvailable || tab !== 'todos';
    $('workspace').hidden = !isTaskView || tab !== 'conversation' || !n?.session;
    $('empty').hidden = !isTaskView || !!n;
    $('task-context').hidden = !isTaskView || !n;
    $('task-detail').hidden =
      !isTaskView || !n || ['conversation', 'records', 'todos'].includes(tab);
    $('records-panel').hidden = !isTaskView || !n?.session || tab !== 'records';
    $('token-usage-panel').hidden = !isTaskView || !n?.session || !state.tokenUsage;
    $('session-pending').hidden = !isTaskView || tab !== 'conversation' || !!n?.session;
    $('create-child-session').hidden = !n?.session;
    $('create-child-session').disabled = !!n?.anomaly || n?.task?.state === 'cancelled';
    $('create-child-session').textContent = '＋ 新增子任务';
    $('create-child-session').onclick = () => openTaskForm(n);
    for (const b of $('task-tabs').children) {
      b.hidden = b.dataset.tab === 'todos' && !plansAvailable;
      b.classList.toggle('active', b.dataset.tab === tab);
      b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
      b.disabled = b.dataset.tab === 'records' && !state.executionRecords;
      b.title = b.disabled ? '记录服务将在空闲更新后启用' : '';
    }
    if (isTaskView && n) {
      $('title').textContent = n.title;
      $('subtitle').textContent = n.record.objective || '目标待明确，可在对话中补充。';
    } else {
      $('title').textContent = {
        tasks: '所有任务，一个入口。',
        agents: 'Agents · 原生执行者',
        bots: 'Bots · 连接与投递',
        overview: '工作全貌，一目了然。',
      }[view];
      $('subtitle').textContent =
        view === 'agents'
          ? '保留各 Agent 的原生配置、模型与上下文。'
          : view === 'bots'
            ? '管理机器人接入、授权与群行为模式。'
            : '统一任务，独立对话，逐层推进。';
    }
    $('page-eyebrow').textContent = `TAB-AI / ${view.toUpperCase()}`;
    const options = JSON.stringify(state.channels.map((c) => [c.id, c.displayName]));
    if (bot.dataset.signature !== options) {
      bot.dataset.signature = options;
      bot.replaceChildren(
        new Option('全部 BOT', ''),
        new Option('本地', 'dashboard'),
        ...state.channels.map((c) => new Option(c.displayName || c.id, c.id)),
      );
      bot.value = botFilter;
    }
    $('approval-policy-open').disabled = !state.scopedApprovals;
    renderSidebar();
    renderOverview();
    renderAgents();
    renderBots();
    if (n) renderDetails(n);
  }
  function nodeState(n) {
    return goalLabels[n.record.goalState] || n.record.goalState || '进行中';
  }
  function nodeButton(n, cls = '', onSelect = () => choose(n)) {
    const b = button('', onSelect, cls);
    b.dataset.nodeKey = n.key;
    b.dataset.status = n.session?.status || 'idle';
    b.setAttribute('aria-selected', String(n.key === selectedKey));
    b.append(el('strong', '', n.title));
    const meta = el('small', 'session-meta');
    meta.append(
      el('span', '', nodeState(n)),
      el(
        'span',
        'session-status',
        state.interactions.some((r) => r.sessionId === n.session?.id)
          ? '待确认'
          : n.session
            ? sessionLabels[n.session.status]
            : '创建中',
      ),
    );
    b.append(meta);
    const usage = state.sessionUsage?.[n.session?.id];
    if (usage) {
      if (
        !usage.cumulative?.hasValue &&
        !usage.taskCumulative?.hasValue &&
        !usage.subtree?.total?.hasValue &&
        usage.context === '未上报'
      ) {
        b.append(
          el(
            'small',
            'session-usage is-empty',
            usage.subtree
              ? `含 ${usage.subtree.descendantCount} 子任务 · 用量未上报`
              : '用量未上报',
          ),
        );
      } else {
        const cum = usage.cumulative;
        const taskCum = usage.taskCumulative;
        const sub = usage.subtree;
        const summary = el(
          'small',
          'session-usage',
          sub
            ? `总计 ${sub.total.short?.total ?? sub.total.total} · 自身 ${taskCum?.short?.total ?? cum.short?.total ?? cum.total}`
            : (usage.resets ?? 0) > 0 && taskCum
              ? `任务 ${taskCum.short?.total ?? taskCum.total} · 会话 ${cum.hasValue ? (cum.short?.total ?? cum.total) : '未上报'}`
              : `累计 ${cum.short?.total ?? cum.total} · 入 ${cum.short?.input ?? cum.input} / 出 ${cum.short?.output ?? cum.output}`,
        );
        summary.title = sub
          ? `含 ${sub.descendantCount} 个子任务总计：${sub.total.total} tokens；本任务累计：${taskCum?.total ?? cum.total}${(usage.resets ?? 0) > 0 ? `（含 ${usage.resets} 次重置，当前会话 ${cum.total}）` : ''}；上下文 ${usage.context}`
          : (usage.resets ?? 0) > 0 && taskCum
            ? `本任务累计（含 ${usage.resets} 次重置${usage.compactions ? ` · ${usage.compactions} 次压缩` : ''}）：${taskCum.total} tokens；当前会话：${cum.total}；上下文 ${usage.context}`
            : `${cum.scope}（精确：累计 ${cum.total} · 入 ${cum.input} / 出 ${cum.output}）；上下文 ${usage.context}`;
        b.append(summary);
        if (usage.context !== '未上报') {
          const ctxLine = el(
            'small',
            'session-usage',
            `上下文 ${usage.contextShort ?? usage.context}`,
          );
          ctxLine.title = usage.context;
          b.append(ctxLine);
          if (typeof usage.contextPercent === 'number') {
            const pct = Math.min(100, Math.max(0, usage.contextPercent));
            const bar = el('div', 'session-ctx-bar');
            const fill = el(
              'div',
              `session-ctx-fill${pct >= 90 ? ' danger' : pct >= 75 ? ' warn' : ''}`,
            );
            if (fill.style) fill.style.width = `${pct.toFixed(1)}%`;
            bar.append(fill);
            b.append(bar);
          }
        }
      }
    }
    if (n.children.length)
      b.append(el('small', 'node-child-count', `${n.children.length} 个直接子任务`));
    if (n.anomaly) b.append(el('small', 'danger', '关系异常'));
    return b;
  }
  function renderSidebar() {
    const { matches } = filtered(),
      filtering = !!query || !!botFilter || !!statusFilter,
      inbox = taskInbox(tree, state.interactions, opened),
      used = new Set(),
      rootsOnly = listScope === 'roots';
    for (const b of scopeSwitch.children)
      b.setAttribute('aria-pressed', String(b.dataset.scope === listScope));
    const signature = JSON.stringify([
      state.taskNodes,
      state.tasks,
      state.sessions,
      state.sessionUsage,
      state.interactions,
      selectedKey,
      query,
      botFilter,
      statusFilter,
      opened,
      listScope,
      inbox.attention.map((e) => e.node.key),
    ]);
    if (signature === treeSignature) return;
    treeSignature = signature;
    const scroll = $('sessions').scrollTop,
      list = [];
    const project = (entries) => {
      const groups = new Map();
      for (const e of entries) {
        if (!matches.has(e.node.key)) continue;
        const n = rootsOnly ? taskRoot(tree, e.node.key) : e.node;
        if (!n) continue;
        const old = groups.get(n.key);
        if (old) {
          if (e.requests) old.requests.push(...e.requests);
          continue;
        }
        groups.set(n.key, {
          ...e,
          node: n,
          target: e.node,
          requests: e.requests ? [...e.requests] : undefined,
        });
      }
      return [...groups.values()].map((e) => {
        if (rootsOnly && e.requests) {
          const approvals = e.requests.filter((r) => r.kind === 'approval').length,
            questions = e.requests.length - approvals;
          e.label = [approvals ? `待审批 ${approvals}` : '', questions ? `待回答 ${questions}` : '']
            .filter(Boolean)
            .join(' · ');
          if (
            e.target.key !== e.node.key ||
            e.requests.some((r) => r.sessionId !== e.node.session?.id)
          )
            e.label = '含下级 · ' + e.label;
        } else if (rootsOnly && e.label && e.target.key !== e.node.key)
          e.label = '下级 · ' + e.label;
        return e;
      });
    };
    const add = (label, entries) => {
      entries = project(entries).filter((e) => !used.has(e.node.key));
      if (!entries.length) return;
      list.push(el('p', 'task-list-label', label));
      for (const { node: n, target, label: reason, tab: targetTab } of entries) {
        used.add(n.key);
        const pick = nodeButton(
          n,
          `session${n.key === selectedKey || (rootsOnly && taskRoot(tree, selectedKey)?.key === n.key) ? ' active' : ''}`,
          () => {
            focusKey = taskRoot(tree, n.key)?.key || n.key;
            if (targetTab)
              selectSession(target.session?.id, target.task?.id, {
                tab: targetTab,
                focus: focusKey,
              });
            else choose(n);
          },
        );
        if (reason) {
          pick.dataset.attention = targetTab === 'records' ? 'pending' : 'preparation';
          pick.append(el('small', 'inbox-reason', reason));
          if (target.key !== n.key)
            pick.append(el('small', 'task-list-path', `前往：${target.title}`));
        }
        const path = taskPath(tree, n.key)
          .slice(0, -1)
          .map((p) => p.title)
          .join(' / ');
        if (path) pick.append(el('small', 'task-list-path', path));
        list.push(pick);
      }
    };
    add('待你处理', inbox.attention);
    add('待补充 / 初始化', inbox.preparation);
    if (filtering)
      add(
        '搜索与筛选结果',
        inbox.recent.concat([...tree.nodes.values()]).map((node) => ({ node })),
      );
    else {
      add(
        '最近使用',
        project(inbox.recent.map((node) => ({ node })))
          .filter((e) => !used.has(e.node.key))
          .slice(0, 6),
      );
      add(
        rootsOnly ? '其他顶层任务' : '其他任务',
        [...tree.nodes.values()].map((node) => ({ node })),
      );
    }
    if (!list.length)
      list.push(
        el(
          'p',
          'empty-inline',
          tree.nodes.size ? '没有匹配的任务。' : '还没有任务，点击上方新建。',
        ),
      );
    $('sessions').replaceChildren(...list);
    $('sessions').scrollTop = scroll;
    const total = rootsOnly ? tree.roots.length : tree.nodes.size,
      matched = rootsOnly
        ? new Set([...matches].map((k) => taskRoot(tree, k)?.key)).size
        : matches.size;
    $('count').textContent = filtering
      ? `${matched} / ${total}`
      : rootsOnly
        ? `${total} 顶层 / ${tree.nodes.size} 项`
        : String(total);
  }
  $('sessions').onkeydown = (e) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const picks = [...$('sessions').querySelectorAll('[data-node-key]')],
      i = picks.indexOf(e.target.closest('[data-node-key]')),
      next =
        e.key === 'Home'
          ? picks[0]
          : e.key === 'End'
            ? picks.at(-1)
            : picks[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  function renderDetails(n) {
    const path = taskPath(tree, n.key);
    $('task-breadcrumbs').replaceChildren();
    for (const [i, p] of path.entries()) {
      if (i) $('task-breadcrumbs').append(el('span', '', '/'));
      $('task-breadcrumbs').append(button(p.title, () => focus(p)));
    }
    $('task-states').replaceChildren(
      el('span', 'task-badge', nodeState(n)),
      el(
        'span',
        'muted',
        `执行：${n.session ? sessionLabels[n.session.status] : '创建中'} · ${n.agent} · ${platforms[n.route.platform]}`,
      ),
    );
    const signature = JSON.stringify([
      state.taskNodes,
      state.tasks,
      state.sessions,
      state.sessionReportStates,
      state.interactions,
      selectedKey,
      focusKey,
      tab,
      mode,
      query,
      botFilter,
      statusFilter,
      [...collapsed],
    ]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    const panel = $('task-detail');
    panel.replaceChildren();
    if (tab === 'structure') renderStructure(panel, n);
    else if (tab === 'results') renderResults(panel, n);
  }
  function renderStructure(panel, n) {
    const scope = tree.nodes.get(focusKey) || taskRoot(tree, n.key) || n,
      { visible } = filtered(),
      filtering = !!query || !!botFilter || !!statusFilter;
    const toolbar = el('div', 'structure-toolbar'),
      modes = el('div', 'structure-modes'),
      actions = el('div', 'task-actions');
    for (const [key, label] of [
      ['columns', '分层导航'],
      ['outline', '可折叠大纲'],
    ]) {
      const b = button(label, () => {
        mode = key;
        remember(true);
        detailSignature = '';
        render();
      });
      b.setAttribute('aria-pressed', String(mode === key));
      modes.append(b);
    }
    const back = button('返回上级', () => focus(tree.nodes.get(scope.parentKey)));
    back.disabled = !scope.parentKey;
    actions.append(
      back,
      button('查看整棵树', () => focus(taskRoot(tree, n.key))),
    );
    toolbar.append(modes, actions);
    panel.append(
      toolbar,
      el(
        'p',
        'structure-scope',
        `当前分支：${scope.title} · ${scope.children.length} 个直接子任务`,
      ),
    );
    if (mode === 'columns') {
      const columns = el('div', 'structure-columns'),
        path = taskPath(tree, n.key);
      for (const { parent, children } of taskColumns(
        tree,
        scope.key,
        n.key,
        filtering ? visible : undefined,
      )) {
        const column = el('section', 'structure-column'),
          head = button(
            `${parent.title} · ${children.length}`,
            () => focus(parent),
            'structure-column-title',
          );
        column.append(head);
        for (const child of children) {
          const card = nodeButton(child, 'structure-node');
          card.classList.toggle(
            'path-selected',
            path.some((p) => p.key === child.key),
          );
          column.append(card);
        }
        if (!children.length)
          column.append(
            el(
              'p',
              'empty-inline',
              filtering ? '该分支无匹配任务。' : '尚未拆分，可直接执行或新增子任务。',
            ),
          );
        columns.append(column);
      }
      columns.dataset.columns = String(columns.children.length);
      columns.style.setProperty('--columns', String(Math.max(1, columns.children.length)));
      panel.append(columns);
    } else {
      const outline = el('div', 'structure-outline');
      outline.setAttribute('role', 'tree');
      outline.setAttribute('aria-label', '任务结构');
      for (const { node: child, depth } of outlineRows(
        tree,
        scope.key,
        filtering ? new Set() : collapsed,
        filtering ? visible : undefined,
      )) {
        const row = el('div', 'structure-outline-row');
        row.style.setProperty('--depth', String(depth));
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(depth + 1));
        row.setAttribute('aria-selected', String(child.key === n.key));
        if (child.children.length)
          row.setAttribute('aria-expanded', String(filtering || !collapsed.has(child.key)));
        const toggle = button(
          child.children.length ? (collapsed.has(child.key) ? '›' : '⌄') : '·',
          () => {
            if (collapsed.has(child.key)) collapsed.delete(child.key);
            else collapsed.add(child.key);
            detailSignature = '';
            render();
          },
          'node-toggle',
        );
        toggle.disabled = !child.children.length;
        toggle.setAttribute(
          'aria-label',
          `${collapsed.has(child.key) ? '展开' : '折叠'} ${child.title}`,
        );
        row.append(toggle, nodeButton(child, 'structure-outline-pick'));
        outline.append(row);
      }
      panel.append(outline);
    }
    const detail = el('section', 'structure-selected'),
      copy = el('div'),
      controls = el('div', 'task-actions');
    copy.append(
      el('h2', '', n.title),
      el(
        'p',
        'muted',
        taskPath(tree, n.key)
          .map((p) => p.title)
          .join(' / '),
      ),
      el('p', 'task-objective', n.record.objective || '目标待明确，可在对话中补充。'),
    );
    const add = button('新增子任务', () => openTaskForm(n));
    add.disabled = !n.session || !!n.anomaly || n.task?.state === 'cancelled';
    const open = button('打开对话', () => choose(n, true), 'primary');
    open.disabled = !n.session;
    controls.append(
      button('聚焦此任务', () => focus(n)),
      add,
      open,
    );
    detail.append(copy, controls);
    panel.append(detail);
  }
  function renderResults(panel, n) {
    panel.append(
      el('h2', '', '目标与成果'),
      el('p', 'task-objective', n.record.objective || '目标待明确'),
      el('p', 'muted', `验收条件：${n.record.criteria || '尚未指定'}`),
    );
    const report = n.task?.result || n.session?.topicReport?.result;
    if (report) {
      panel.append(
        el(
          'h3',
          '',
          n.task
            ? '已提交成果'
            : n.session.topicReport.reason === 'completed'
              ? '整体完成报告'
              : n.session.topicReport.reason === 'requested'
                ? '按需汇报'
                : '历史报告 · 未确认整体完成',
        ),
        el('p', 'task-objective', report.summary),
      );
      for (const [key, label] of [
        ['artifacts', '产物'],
        ['checks', '验证'],
        ['issues', '遗留问题'],
        ['remainingWork', '待完成'],
      ])
        if (report[key]?.length) {
          panel.append(el('h4', '', label));
          const list = el('ul');
          for (const text of report[key]) list.append(el('li', '', text));
          panel.append(list);
        }
    } else
      panel.append(el('p', 'empty-inline', '尚未提交成果。执行空闲或关闭对话不代表目标完成。'));
    if (n.task && n.task.executionMode !== 'interactive') {
      const task = n.task,
        actions = el('div', 'task-actions');
      if (task.state !== 'cancelled') {
        actions.append(
          button(
            ['paused', 'blocked'].includes(task.state) ? '继续任务' : '暂停子树',
            run(async () => {
              await api(
                `/tasks/${task.id}/${['paused', 'blocked'].includes(task.state) ? 'resume' : 'pause'}`,
                {},
              );
              await refresh();
            }),
          ),
        );
        actions.append(
          button(
            '取消子树',
            () => {
              const dialog = $('confirm-dialog');
              $('confirm-text').textContent =
                `取消「${task.title}」及所有下级任务？运行会停止，历史保留；取消后不能恢复。`;
              $('confirm-yes').onclick = run(async () => {
                await api(`/tasks/${task.id}/cancel`, {});
                dialog.close();
                await refresh();
              });
              dialog.showModal();
            },
            'danger',
          ),
        );
      }
      if (task.link && /^https:\/\/applink\.(feishu\.cn|larksuite\.com)\//.test(task.link)) {
        const a = el('a', 'button-link', '进入飞书话题 ↗');
        a.href = task.link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        actions.append(a);
      }
      panel.append(actions);
      if (task.error) panel.append(el('p', 'error', task.error));
    }
    if (n.session) renderHandoffs(panel, n);
    const details = el('details', 'task-settings'),
      meta = el('dl', 'task-metadata');
    details.append(el('summary', '', '执行与关联信息'));
    meta.append(
      field('任务 ID', n.record.id || n.key),
      field('直接父级', tree.nodes.get(n.parentKey)?.title),
      field('Agent', n.agent),
      field(
        'BOT / 平台',
        `${state.channels.find((c) => c.id === n.route.account)?.displayName || n.route.account} · ${platforms[n.route.platform]}`,
      ),
      field('工作目录', n.session?.workspace || n.task?.workspace),
      field('对话 ID', n.session?.id),
      field('原生 ID', n.session?.nativeId),
    );
    details.append(meta);
    panel.append(details);
  }
  function renderHandoffs(panel, n) {
    const section = el('section', 'task-result'),
      list = el('div'),
      note = el('p', 'muted', '正在读取版本化报告…');
    section.append(el('h2', '', '交付报告与可复用经验'), note, list);
    panel.append(section);
    const labels = {
        completed: '目标已完成',
        submitted: '已提交，待验收',
        incomplete: '尚未确认完成',
        cancelled: '已取消',
        unknown: '状态待核对',
      },
      status = { pending: '等待整理', running: '正在总结', ready: '可供接续', failed: '整理失败' };
    const received = el('section', 'task-result');
    received.append(
      el('h3', '', '收到的子任务交接资料'),
      el('p', 'footnote', '这些是已登记的资料；Agent 是否已获得它们，请查看对话中该轮的实际输入。'),
    );
    section.append(received);
    void api(`/sessions/${n.session.id}/reports/received`)
      .then((data) => {
        if (!section.isConnected) return;
        if (!data.handoffs.length) received.append(el('p', 'muted', '暂无关联交接资料。'));
        for (const h of data.handoffs) {
          const item = el('details', 'task-settings');
          item.append(
            el(
              'summary',
              '',
              `${h.sourceTitle} · v${h.version} · ${labels[h.outcome] || h.outcome}`,
            ),
            el('p', '', h.summary),
          );
          item.append(
            button(
              '查看交接文档 ↗',
              run(async () =>
                showReportDocument(
                  await api(`/sessions/${n.session.id}/reports/${h.reportId}/document`),
                ),
              ),
            ),
          );
          received.append(item);
        }
      })
      .catch(() => {
        received.append(el('p', 'form-error', '交接资料读取失败。'));
      });
    const generate = button(
      '生成 / 重新总结',
      run(async () => {
        generate.disabled = true;
        try {
          await api(`/sessions/${n.session.id}/reports`, { key: taskCreationKey() });
          await refresh();
        } finally {
          generate.disabled = false;
        }
      }),
    );
    section.append(generate);
    let before;
    const load = async (more = false) => {
      try {
        const data = await api(
          `/sessions/${n.session.id}/reports${before ? `?before=${before}` : ''}`,
        );
        if (!section.isConnected) return;
        if (!more) list.replaceChildren();
        note.textContent = data.reports.length
          ? '报告记录了交付依据；关闭会话不代表目标完成。'
          : '尚无报告。关闭会话或提交任务成果后会自动整理，也可主动生成。';
        for (const r of data.reports) {
          const item = el('details', 'task-settings');
          item.dataset.reportId = r.id;
          item.open = list.childElementCount === 0;
          item.append(
            el(
              'summary',
              '',
              `v${r.version} · ${status[r.state] || r.state} · ${labels[r.outcome] || r.outcome}`,
            ),
            el(
              'p',
              'muted',
              `报告 ID：${r.id} · ${r.quality === 'generated' ? '执行记录总结' : '已记录事实'} · 来源：${r.trigger}`,
            ),
          );
          if (r.warning) item.append(el('p', 'error', r.warning));
          if (r.state === 'ready' && r.trigger === 'close' && !r.notifications) {
            const notify = button(
              '发送报告通知',
              run(async () => {
                notify.disabled = true;
                try {
                  await api(`/sessions/${n.session.id}/reports/${r.id}/notifications`, {});
                  await refresh();
                } finally {
                  notify.disabled = false;
                }
              }),
            );
            item.append(notify);
          }
          for (const n of r.notifications ?? []) {
            const states = {
              pending: '待发送',
              sending: '发送中',
              delivered: '已送达',
              unconfirmed: '结果未确认，未自动重发',
              skipped: '未发送',
            };
            item.append(
              el(
                'p',
                n.state === 'unconfirmed' ? 'error' : 'muted',
                `${n.role === 'source' ? '原会话' : '直接父会话'}通知：${states[n.state] || n.state}${n.detail ? `（${n.detail}）` : ''}`,
              ),
            );
          }
          const b = r.body;
          if (b) {
            item.append(el('p', 'task-objective', b.summary));
            for (const [key, label] of [
              ['deliverables', '交付产物'],
              ['specifications', '接续规格 / 接口 / 研究口径'],
              ['validation', '验证记录'],
              ['risks', '风险与限制'],
              ['remainingWork', '遗留事项'],
              ['nextSteps', '下一步'],
              ['lessons', '可复用经验'],
            ]) {
              if (!b[key]?.length) continue;
              item.append(el('h3', '', label));
              for (const value of b[key]) {
                const text =
                  typeof value === 'string'
                    ? value
                    : Object.entries(value)
                        .map(
                          ([k, v]) =>
                            `${{ name: '名称', kind: '类型', location: '位置', description: '说明', content: '规格', result: '结果', evidence: '依据', summary: '经验', appliesWhen: '适用条件', practice: '做法', cautions: '限制' }[k] || k}：${Array.isArray(v) ? v.join('、') : v}`,
                        )
                        .join('\n');
                item.append(el('p', 'task-objective', text));
              }
            }
          }
          list.append(item);
        }
        before = data.reports.at(-1)?.version;
        moreButton.hidden = data.reports.length < 20;
      } catch (error) {
        if (section.isConnected) note.textContent = error.message;
      }
    };
    const moreButton = button('加载更早报告', () => void load(true));
    moreButton.hidden = true;
    section.append(moreButton);
    void load();
  }
  function renderOverview() {
    const metrics = [
      ['已接入 BOT', state.channels.length, '各通道保持独立授权'],
      ['任务', tree.nodes.size, `${tree.roots.length} 个顶层任务`],
      ['执行中', state.sessions.filter((s) => s.status === 'running').length, '保留原生上下文'],
      ['等待确认', state.interactions.length, '问题与工具审批'],
    ];
    $('metrics').replaceChildren(
      ...metrics.map(([label, value, note]) => {
        const card = el('div', 'metric');
        card.append(
          el('span', 'eyebrow', label),
          el('strong', '', String(value)),
          el('small', '', note),
        );
        return card;
      }),
    );
    $('recent-tasks').replaceChildren(
      ...(tree.roots.length
        ? tree.roots.slice(0, 6).map((n) => {
            const b = button('', () => focus(n), 'root-card');
            b.append(
              el('span', 'task-badge', nodeState(n)),
              el('h3', '', n.title),
              el('p', '', n.record.objective || '目标待明确'),
              el('small', '', `${n.children.length} 个直接子任务 · ${n.agent}`),
            );
            return b;
          })
        : [el('p', 'empty-inline', '还没有任务，创建后可以直接对话或逐层拆分。')]),
    );
    const inbox = taskInbox(tree, state.interactions, opened);
    $('attention').replaceChildren(
      ...(inbox.attention.length
        ? inbox.attention.map((e) => {
            const b = button(
              '',
              () => selectSession(e.node.session.id, e.node.task?.id, { tab: 'records' }),
              'attention-item',
            );
            b.append(
              el('strong', '', e.label),
              el(
                'small',
                '',
                taskPath(tree, e.node.key)
                  .map((n) => n.title)
                  .join(' / '),
              ),
            );
            return b;
          })
        : [el('p', 'empty-inline', '当前没有等待处理的问题或审批。')]),
    );
  }
  function renderAgents() {
    const agents =
        state.agentCatalog ||
        ['codex', 'claude', 'opencode', 'traecli', 'agy'].map((id) => ({
          id,
          name: {
            codex: 'Codex',
            claude: 'Claude Code',
            opencode: 'OpenCode',
            traecli: 'TRAE CLI',
            agy: 'Antigravity CLI',
          }[id],
        })),
      signature = JSON.stringify([agents, state.sessions]);
    if (signature === agentSignature) return;
    agentSignature = signature;
    $('agents').replaceChildren(
      ...agents.map((a) => {
        const card = el('article', 'bot-card'),
          sessions = state.sessions.filter((s) => s.agent === a.id);
        card.append(
          el('span', 'eyebrow', 'NATIVE AGENT'),
          el('h2', '', a.name),
          el(
            'p',
            '',
            `${sessions.length} 个任务对话 · ${sessions.filter((s) => s.status === 'running').length} 个执行中${a.default ? ' · 默认 Agent' : ''}`,
          ),
          el('p', 'muted', '使用本机原生登录和配置，工具审批仍由实际执行请求决定。'),
        );
        const capabilities = [
          a.canCompact ? '原生压缩' : null,
          a.supportsWorkspaceSwitch ? '保留上下文切目录' : null,
          a.canControlLoops ? '原生循环管理' : null,
        ].filter(Boolean);
        if (capabilities.length) card.append(el('small', 'muted', capabilities.join(' · ')));
        const actions = el('div', 'task-actions');
        actions.append(
          button('用此 Agent 新建任务', () => openTaskForm(undefined, a.id), 'primary'),
        );
        card.append(actions);
        return card;
      }),
    );
  }
  function openTaskForm(parent, agent) {
    if (!state) {
      showError(Error('页面尚未连接，请稍后重试。'));
      return;
    }
    let key;
    try {
      key = taskCreationKey();
    } catch (error) {
      showError(error);
      return;
    }
    const target = parent?.key;
    $('task-form-title').textContent = parent ? '新增子任务' : '新建任务';
    $('task-title-input').value = '';
    $('task-objective-input').value = '';
    $('task-objective-input').required = false;
    $('task-criteria-input').value = '按目标完成并提供可核验成果';
    $('task-source-label').hidden = !!parent;
    $('task-workspace-label').hidden = false;
    $('task-context-label').hidden = true;
    $('task-context-input').value = '';
    $('task-start-now').checked = false;
    $('task-source').onchange = () => {
      if (!parent) {
        const source = state.sessions.find((s) => s.id === $('task-source').value);
        $('task-workspace-input').value = source?.workspace || state.defaultWorkspace;
      }
    };
    $('task-start-now').onchange = () => {
      $('task-objective-input').required = $('task-start-now').checked;
    };
    $('task-form-note').textContent = parent
      ? `直接父任务：${parent.title} · ${parent.record.id || parent.key}。新任务具有独立对话，默认等待输入。工作目录默认继承当前父任务，也可显式修改。`
      : '任务可以先建立、后补充目标。选择 IM 来源后网页与该 IM 共用会话；仅网页任务不自动关联 IM。勾选立即执行后才开始推进。';
    $('task-source').replaceChildren(
      new Option('仅网页（不关联 IM）', ''),
      ...state.sessions
        .filter((s) => s.route.platform !== 'local' && s.status !== 'closed')
        .map(
          (s) =>
            new Option(
              `${sessionDisplayTitle(s)} · ${platforms[s.route.platform]} · ${s.id.slice(0, 8)}`,
              s.id,
            ),
        ),
    );
    $('task-agent').value = agent || parent?.agent || state.defaultAgent;
    $('task-workspace-input').value =
      parent?.session?.workspace || parent?.workspace || state.defaultWorkspace;
    $('task-form-error').textContent = '';
    $('task-save').disabled = false;
    $('task-save').textContent = '创建任务';
    $('task-dialog').showModal();
    $('task-form').onsubmit = (e) => {
      e.preventDefault();
      void (async () => {
        const save = $('task-save');
        save.disabled = true;
        try {
          const workspace = $('task-workspace-input').value.trim(),
            source = $('task-source').value,
            input = {
              key,
              title: $('task-title-input').value,
              objective: $('task-objective-input').value,
              criteria: $('task-criteria-input').value,
              agent: $('task-agent').value,
              start: $('task-start-now').checked,
              ...(workspace ? { workspace } : {}),
              ...(!target && source ? { sourceSessionId: source } : {}),
            };
          const node = await api(target ? `/task-nodes/${target}/children` : '/task-nodes', input);
          $('task-dialog').close();
          await refresh();
          selectSession(node.sessionId, node.taskId, {
            tab: 'structure',
            focus: target || node.key,
          });
        } catch (error) {
          $('task-form-error').textContent = error.message;
        } finally {
          save.disabled = false;
        }
      })();
    };
  }
  window.addEventListener('popstate', () => {
    const url = new URLSearchParams(location.search);
    view = url.get('view') === 'sessions' ? 'tasks' : url.get('view') || 'tasks';
    selectedKey = url.get('node') || '';
    focusKey = url.get('focus') || '';
    tab = normalizeTab(url.get('tab'));
    mode = url.get('tree') === 'outline' ? 'outline' : 'columns';
    treeSignature = '';
    detailSignature = '';
    void refresh();
  });
  function renderBots() {
    const counts = state.channels.map((c) => [
      c.id,
      state.sessions.filter((s) => s.route.account === c.id).length,
      (state.tasks || []).filter((t) => t.route.account === c.id).length,
    ]);
    const signature = JSON.stringify([state.channels, counts]);
    if (signature === botSignature) return;
    botSignature = signature;
    $('channels').replaceChildren(
      ...(state.channels.length
        ? state.channels.map((c) => {
            const card = el('article', 'bot-card'),
              sessions = state.sessions.filter((s) => s.route.account === c.id),
              tasks = (state.tasks || []).filter((t) => t.route.account === c.id);
            card.append(
              el('span', 'eyebrow', platforms[c.type]),
              el('h2', '', c.displayName || c.id),
              el('code', '', c.id),
              el(
                'p',
                '',
                `${[...tree.nodes.values()].filter((n) => n.route.account === c.id).length} 个任务 · ${c.allowedUserCount ?? '—'} 位授权用户`,
              ),
              el('small', 'muted', c.defaultWorkspace || '使用实例默认工作区'),
            );
            const label = el('label', '', 'BOT 角色'),
              role = el('select');
            role.append(
              new Option('普通 BOT · 自身范围', 'scoped'),
              new Option('Manager · 全局管理', 'manager'),
            );
            role.value = c.manager ? 'manager' : 'scoped';
            role.setAttribute('aria-label', `${c.displayName || c.id} 角色`);
            role.onchange = run(async () => {
              role.disabled = true;
              try {
                await api(`/channels/${encodeURIComponent(c.id)}/role`, {
                  manager: role.value === 'manager',
                });
                await refresh();
              } catch (e) {
                role.value = c.manager ? 'manager' : 'scoped';
                throw e;
              } finally {
                role.disabled = false;
              }
            });
            label.append(role);
            card.append(label);
            const actions = el('div', 'task-actions');
            actions.append(
              button('编辑名称 / 目录', () => openBotForm(c)),
              button('查看任务', () => {
                botFilter = c.id;
                bot.value = c.id;
                treeSignature = '';
                show('tasks');
              }),
            );
            card.append(actions);
            if (c.connection)
              card.append(
                el(
                  'p',
                  c.connection.state === 'error' ? 'form-error' : 'footnote',
                  `${{ starting: '连接中', ready: '连接已启动', error: '连接异常' }[c.connection.state] || c.connection.state} · ${c.connection.detail}`,
                ),
              );
            if (c.type === 'lark') {
              const d = el('details', 'group-mode-controls');
              d.append(el('summary', '', '群行为模式'));
              const configured = el('div');
              for (const [chat, mode] of Object.entries(c.groupModes || {}))
                configured.append(el('p', '', `${chat} · ${mode}`));
              d.append(configured);
              const form = el('form'),
                chat = el('input'),
                mode = el('select'),
                save = el('button', '', '保存群模式');
              chat.placeholder = '群 chat_id（oc_…）';
              chat.setAttribute('aria-label', '群 ID');
              chat.required = true;
              chat.pattern = 'oc_[A-Za-z0-9_-]{1,128}';
              mode.setAttribute('aria-label', '群行为模式');
              mode.append(
                new Option('仅 @ 触发', 'mention'),
                new Option('收集参考，仅 @ 回复', 'context'),
                new Option('自动响应', 'auto'),
              );
              save.type = 'submit';
              form.append(chat, mode, save);
              form.onsubmit = (e) => {
                e.preventDefault();
                void run(async () => {
                  save.disabled = true;
                  try {
                    const result = await api(`/channels/${encodeURIComponent(c.id)}/group-mode`, {
                      chatId: chat.value.trim(),
                      mode: mode.value,
                    });
                    await refresh();
                    showGroupPermission(result);
                  } finally {
                    save.disabled = false;
                  }
                })();
              };
              d.append(
                form,
                el(
                  'p',
                  'footnote',
                  '全量模式需要平台的 im:message.group_msg 权限；仅授权用户可以触发任务。',
                ),
              );
              card.append(d);
            }
            if (c.type === 'wecom')
              card.append(
                el(
                  'p',
                  'footnote',
                  c.contextGroups?.length
                    ? `群聊补读：已启用 ${c.contextGroups.length} 个群。触发时通过官方 CLI 补读近 24 小时最多 20 条参考，普通消息不单独唤醒 Agent。`
                    : '群聊补读：未启用。可在配置中设置 contextGroups，并为同一机器人授权官方 CLI。',
                ),
              );
            return card;
          })
        : [el('p', 'empty-inline', '尚未接入机器人，点击右上角开始接入。')]),
    );
  }
  function showGroupPermission(result) {
    if (!result.permission || result.permission.status === 'ready') return;
    const dialog = el('dialog'),
      heading = el('h2', '', '群消息权限待确认'),
      message = el('p'),
      links = el('div'),
      actions = el('div', 'dialog-actions');
    const update = (r) => {
      result = r;
      const p = r.permission;
      heading.textContent =
        p?.status === 'ready'
          ? '群消息权限已验证'
          : p?.status === 'missing'
            ? '申请群消息权限'
            : '群消息权限待确认';
      message.textContent = `已保存 ${r.mode} 模式。${p?.message || '请重新检查权限。'}`;
      links.replaceChildren();
      if (p?.url && p.status !== 'ready') {
        const a = el('a', '', '打开权限申请入口 ↗');
        a.href = p.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        links.append(a);
        if (p.qrDataUrl) {
          const image = el('img');
          image.src = p.qrDataUrl;
          image.alt = '群消息权限申请二维码';
          image.width = 240;
          image.height = 240;
          image.style.display = 'block';
          image.style.maxWidth = '100%';
          links.append(image);
        }
        links.append(
          el(
            'p',
            'footnote',
            '由应用开发者／管理员申请、发布并完成审核后，再检查权限。群模式配置不会代替平台授权。',
          ),
        );
      }
    };
    const check = button('重新检查权限', () => {
      void run(async () => {
        check.disabled = true;
        try {
          update(
            await api('/management', {
              intent: 'group_mode.get',
              parameters: { botId: result.id, chatId: result.chatId },
            }),
          );
        } finally {
          check.disabled = false;
        }
      })();
    });
    actions.append(
      button('关闭', () => dialog.close()),
      check,
    );
    dialog.append(heading, message, links, actions);
    document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    update(result);
    dialog.showModal();
  }
  function openBotForm(c) {
    $('bot-name').value = c.displayName || c.id;
    $('bot-workspace').value = c.defaultWorkspace || state.defaultWorkspace;
    $('bot-form-error').textContent = '';
    $('bot-dialog').showModal();
    $('bot-form').onsubmit = (e) => {
      e.preventDefault();
      void (async () => {
        const save = $('bot-save');
        save.disabled = true;
        try {
          await api(`/channels/${encodeURIComponent(c.id)}/details`, {
            displayName: $('bot-name').value,
            defaultWorkspace: $('bot-workspace').value,
          });
          $('bot-dialog').close();
          await refresh();
        } catch (error) {
          $('bot-form-error').textContent = error.message;
        } finally {
          save.disabled = false;
        }
      })();
    };
  }
  return { render, show, sync, activate };
}

export function createExecutionRecords({ api, showError }) {
  const $ = (id) => document.getElementById(id);
  const labels = {
    pending: '等待审批',
    allowed: '已允许',
    denied: '已拒绝',
    timed_out: '审批超时',
    cancelled: '已结束，未批准',
    ended_unknown: '已结束，结果未记录',
    answered: '已回答',
    running: '执行中',
    completed: '执行成功',
    failed: '执行失败',
    interrupted: '已中断',
    unknown: '结果未上报',
  };
  const element = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = String(text);
    return e;
  };

  let session,
    kind = 'approvals',
    query = '',
    items = [],
    cursor,
    signature = '',
    generation = 0,
    loading = false,
    loadedOlder = false,
    searchTimer;
  const list = $('records-list'),
    search = $('records-search'),
    more = $('records-more'),
    refresh = $('records-refresh');
  const expanded = new Set();
  const note = (text) => {
    $('records-note').textContent = text;
  };
  function render() {
    list.replaceChildren(
      ...items.map((record) => {
        const request = record.request,
          status = record.status,
          identifier = request?.id || `${record.runId}:${record.id}`,
          key = String(record.eventId);
        const item = element('details', 'record-item');
        item.dataset.recordId = identifier;
        item.open = expanded.has(key);
        item.ontoggle = () => {
          if (item.open) expanded.add(key);
          else expanded.delete(key);
        };
        const summary = element('summary'),
          badge = element('span', 'record-status ' + status, labels[status] || status);
        summary.append(
          badge,
          element(
            'strong',
            '',
            request?.approvalSummary?.operation || request?.title || record.name,
          ),
          element('time', '', new Date(record.at).toLocaleString()),
        );
        item.append(summary);
        const meta = element('dl', 'record-facts');
        for (const [name, value] of request
          ? [
              ['审批 ID', request.id],
              ['请求时间', new Date(request.createdAt).toLocaleString()],
              [
                '截止时间',
                request.expiresAt ? new Date(request.expiresAt).toLocaleString() : '未记录',
              ],
              [
                '处理时间',
                record.settledAt ? new Date(record.settledAt).toLocaleString() : '未记录',
              ],
            ]
          : [
              ['轮次 ID', record.runId],
              ['工具 ID', record.id],
              ['数据库事件 ID', record.eventId],
              ['退出码', record.exitCode ?? '未上报'],
            ]) {
          meta.append(element('dt', '', name), element('dd', '', value));
        }
        item.append(meta);
        if (request) {
          if (request.approvalSummary?.facts)
            for (const f of request.approvalSummary.facts)
              item.append(element('p', '', `${f.label}：${f.value}`));
          item.append(element('strong', '', '原始审批请求'), element('pre', '', request.detail));
          if (record.answer?.scope)
            item.append(
              element(
                'p',
                '',
                `授权范围：${record.answer.scope === 'auto' ? '本会话自动允许命令及文件审批' : record.answer.scope === 'session' ? '仅此会话（当时的原生授权范围）' : '仅本次'}${record.automatic ? ' · 自动批准' : ''}`,
              ),
            );
          if (record.answer)
            item.append(
              element('strong', '', '审批决定'),
              element('pre', '', JSON.stringify(record.answer, null, 2)),
            );
          item.append(
            element(
              'p',
              'footnote',
              '审批允许仅表示授权；实际执行结果请切换“工具执行”。历史记录不能重复授权。',
            ),
          );
        } else {
          if (record.input)
            item.append(element('strong', '', '调用内容'), element('pre', '', record.input));
          if (record.output)
            item.append(element('strong', '', '执行结果'), element('pre', '', record.output));
          if (!record.output) item.append(element('p', 'footnote', '原生 Agent 未上报输出。'));
        }
        return item;
      }),
    );
    if (!items.length)
      list.append(
        element(
          'p',
          'empty-inline',
          query
            ? '没有匹配记录，请尝试审批 ID、轮次 ID、工具 ID 或关键词。'
            : kind === 'approvals'
              ? '本任务暂无工具审批记录。'
              : '本任务暂无工具执行记录。',
        ),
      );
    more.hidden = !cursor;
    more.disabled = loading;
    for (const b of $('records-kinds').children)
      b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
  }
  async function load(append = false) {
    if (!session) return;
    const id = session,
      version = ++generation;
    loading = true;
    refresh.disabled = true;
    more.disabled = true;
    try {
      const params = new URLSearchParams({ kind, q: query, limit: '30' });
      if (append && cursor) params.set('before', String(cursor));
      const data = await api(`/sessions/${id}/records?${params}`);
      if (version !== generation || id !== session) return;
      const incoming = append ? [...items, ...data.items] : data.items,
        unique = [
          ...new Map(
            incoming.map((r) => [r.kind === 'tool' ? `${r.runId}:${r.id}` : r.request.id, r]),
          ).values(),
        ];
      if (append) loadedOlder = true;
      cursor = data.nextBefore;
      const next = JSON.stringify(unique);
      if (next !== signature) {
        items = unique;
        signature = next;
        render();
      } else {
        more.hidden = !cursor;
      }
      const token = data.tokenInformation;
      const recordsUsage = $('records-usage');
      if (token) {
        const parts = [
          `上下文 ${token.contextShort ?? token.context}`,
          `当前会话 ${token.totalShort ?? token.total}`,
        ];
        if ((token.resets ?? 0) > 0 && token.taskCumulative)
          parts.push(`任务累计 ${token.taskCumulative.short?.total ?? token.taskCumulative.total}`);
        if (token.subtree)
          parts.push(
            `含子任务总计 ${token.subtree.total.short?.total ?? token.subtree.total.total}`,
          );
        parts.push(`${token.currentRound?.label ?? '本轮'} ${token.roundShort ?? token.round}`);
        recordsUsage.textContent = parts.join(' · ');
        recordsUsage.title = `上下文：${token.context} · 消耗：${token.total}。${token.details.map((f) => `${f.label}：${f.value}`).join('；')}`;
      } else {
        recordsUsage.textContent = '原生 Agent 尚未上报本会话的 token 用量。';
        recordsUsage.title = '';
      }
      note(
        `已展示 ${unique.length} 项${cursor ? '，可加载更早记录' : ''}。${loadedOlder ? '点击刷新返回最新列表。' : '自动刷新最新记录。'}按本任务查询；聊天卡片仅为摘要，原生输出可能已截断。`,
      );
    } catch (error) {
      if (version === generation) {
        note('记录加载失败，可点击刷新重试。');
        showError(error);
      }
    } finally {
      if (version === generation) {
        loading = false;
        refresh.disabled = false;
        more.disabled = false;
      }
    }
  }
  function reset() {
    generation++;
    items = [];
    cursor = undefined;
    loadedOlder = false;
    signature = '';
    expanded.clear();
    $('records-usage').textContent = '';
    render();
    void load();
  }
  for (const [value, label] of [
    ['approvals', '审批记录'],
    ['tools', '工具执行'],
  ]) {
    const b = element('button', '', label);
    b.type = 'button';
    b.dataset.kind = value;
    b.onclick = () => {
      kind = value;
      reset();
    };
    $('records-kinds').append(b);
  }
  search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = search.value.trim();
      reset();
    }, 250);
  };
  refresh.onclick = () => {
    reset();
  };
  more.onclick = () => void load(true);
  return {
    refresh(id) {
      if (id !== session) {
        session = id;
        query = '';
        search.value = '';
        reset();
      } else if (!loading && !loadedOlder) void load();
    },
    hide() {
      if (loading) {
        generation++;
        loading = false;
        refresh.disabled = false;
      }
    },
  };
}

const planStatusLabels = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};
const planRunLabels = {
  running: '执行中',
  completed: '本轮已结束',
  failed: '本轮失败',
  interrupted: '本轮已中断',
  unknown: '状态未确认',
};
export const filterPlanSteps = (steps, status) =>
  status === 'all' ? steps : steps.filter((step) => step.status === status);
export function createAgentPlans({ api }) {
  const $ = (id) => document.getElementById(id),
    el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
  let session,
    generation = 0,
    loading = false,
    plans = [],
    currentRun,
    cursor,
    older = false,
    filter = 'all',
    signature = '';
  const expanded = new Map();
  const refresh = $('agent-plans-refresh'),
    more = $('agent-plans-more'),
    note = $('agent-plans-note'),
    list = $('agent-plans-list'),
    filters = $('agent-plans-filters');
  function render() {
    for (const b of filters.children)
      b.setAttribute('aria-pressed', String(b.dataset.status === filter));
    const cards = [];
    if (currentRun && !plans.some((p) => p.runId === currentRun.runId))
      cards.push(
        el(
          'p',
          'empty-inline',
          currentRun.status === 'running'
            ? 'Agent 正在执行，当前轮次尚未生成待办。'
            : '最近一轮未生成待办；下方可查看此前计划。',
        ),
      );
    for (const plan of plans) {
      const steps = filterPlanSteps(plan.steps, filter);
      if (filter !== 'all' && !steps.length) continue;
      const card = el('details', 'agent-plan');
      card.open = filter !== 'all' || (expanded.get(plan.runId) ?? plan.current);
      card.ontoggle = () => expanded.set(plan.runId, card.open);
      const summary = el('summary'),
        heading = el('strong', '', plan.title),
        badge = el(
          'span',
          'record-status ' +
            (plan.runStatus === 'completed'
              ? 'completed'
              : plan.runStatus === 'running'
                ? 'running'
                : 'unknown'),
          planRunLabels[plan.runStatus] || plan.runStatus,
        );
      summary.append(
        heading,
        badge,
        el('span', 'muted', `${plan.counts.completed}/${plan.steps.length} 项已完成`),
        el('time', 'muted', new Date(plan.at).toLocaleString()),
      );
      card.append(summary);
      card.append(
        el(
          'p',
          'footnote',
          `${plan.current ? '最近一轮' : '历史轮次'} · ${{ codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', traecli: 'TRAE CLI', agy: 'Antigravity CLI' }[plan.source]}${plan.archived ? ' · 重置前历史' : ''}`,
        ),
      );
      if (plan.explanation) card.append(el('p', 'agent-plan-explanation', plan.explanation));
      const items = el('ol', 'agent-plan-steps');
      for (const step of steps) {
        const stale = step.status === 'in_progress' && plan.runStatus !== 'running',
          item = el('li', `agent-plan-step ${step.status}${stale ? ' stale' : ''}`);
        item.append(
          el('span', 'plan-step-status', stale ? '上次进行中' : planStatusLabels[step.status]),
          el('span', 'plan-step-text', step.text),
        );
        items.append(item);
      }
      card.append(items);
      if (!plan.steps.length) card.append(el('p', 'footnote', 'Agent 已清空此轮待办。'));
      if (plan.runStatus === 'completed' && (plan.counts.pending || plan.counts.in_progress))
        card.append(el('p', 'footnote', '本轮已结束，列表仍有未完成步骤；未自动改为已完成。'));
      cards.push(card);
    }
    if (!cards.length)
      cards.push(
        el(
          'p',
          'empty-inline',
          plans.length
            ? '当前筛选下没有待办。'
            : '尚无已采集的待办。Agent 上报执行计划后会自动显示；旧版未采集的列表不会自动补回。',
        ),
      );
    list.replaceChildren(...cards);
    more.hidden = !cursor;
  }
  async function load(append = false) {
    if (!session || loading) return;
    loading = true;
    const id = session,
      version = generation;
    refresh.disabled = true;
    more.disabled = true;
    try {
      const data = await api(
        `/sessions/${id}/todos?limit=10${append && cursor ? `&before=${cursor}` : ''}`,
      );
      if (version !== generation || id !== session) return;
      if (!data.supported) {
        note.textContent = '当前 Agent 未提供待办能力。';
        plans = [];
        currentRun = undefined;
        cursor = undefined;
        render();
        return;
      }
      const merged = new Map((append || older ? plans : []).map((p) => [p.runId, p]));
      for (const plan of data.plans) merged.set(plan.runId, plan);
      plans = [...merged.values()].sort((a, b) => b.eventId - a.eventId);
      currentRun = data.currentRun;
      if (append || !older) cursor = data.nextBefore;
      if (append) older = true;
      const next = JSON.stringify([plans, currentRun, filter, cursor]);
      if (next !== signature) {
        signature = next;
        render();
      }
      note.textContent = data.note || '';
    } catch {
      if (version === generation)
        note.textContent = '待办加载失败，已保留现有列表。请点击刷新重试。';
    } finally {
      if (version === generation) {
        loading = false;
        refresh.disabled = false;
        more.disabled = false;
      }
    }
  }
  for (const [value, label] of [
    ['all', '全部'],
    ['in_progress', '进行中'],
    ['pending', '待处理'],
    ['completed', '已完成'],
    ['cancelled', '已取消'],
  ]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.status = value;
    b.onclick = () => {
      filter = value;
      signature = '';
      render();
    };
    filters.append(b);
  }
  refresh.onclick = () => void load();
  more.onclick = () => void load(true);
  return {
    refresh(id) {
      if (session !== id) {
        generation++;
        session = id;
        loading = false;
        plans = [];
        currentRun = undefined;
        cursor = undefined;
        older = false;
        filter = 'all';
        signature = '';
        expanded.clear();
        note.textContent = '正在读取待办…';
        render();
      }
      void load();
    },
    hide() {
      generation++;
      session = undefined;
      loading = false;
    },
  };
}

// The same backend presentation is used by chat cards and this panel. Render
// every value as text, including model names and historical source metadata.
export function createTokenUsage({ api }) {
  const $ = (id) => document.getElementById(id);
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  let target,
    generation = 0,
    loading = false,
    cursor,
    signature = '',
    runs = [],
    older = false,
    currentNativeId,
    resets = 0;
  const time = (at) => (at === undefined ? '未上报' : new Date(at).toLocaleString());
  const shortTime = (at) => {
    if (at === undefined) return '未上报';
    const d = new Date(at),
      now = new Date(),
      pad = (n) => String(n).padStart(2, '0');
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    )
      return clock;
    const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
  };
  const status = (run) =>
    ({ running: '执行中', completed: '已完成', interrupted: '已中断', failed: '失败' })[run.status];
  const metricItem = (label, shortVal, exactVal, titlePrefix = '') => {
    const item = element('div', undefined, 'usage-kv');
    item.append(element('span', label));
    const strong = element('strong', shortVal, shortVal === '未上报' ? 'is-empty' : undefined);
    if (exactVal && exactVal !== '未上报') strong.title = `${titlePrefix}${exactVal}`;
    item.append(strong);
    return item;
  };
  const buildCard = ({
    title,
    badgeText,
    badgeClass,
    totalText,
    totalExact,
    empty,
    primary,
    breakdown,
    hint,
  }) => {
    const card = element('section', undefined, `usage-card${primary ? ' is-primary' : ''}`);
    const head = element('div', undefined, 'usage-card-head');
    const titleBox = element('div', undefined, 'usage-card-title');
    titleBox.append(element('span', title));
    if (badgeText) titleBox.append(element('span', badgeText, badgeClass));
    const totalEl = element('strong', totalText, `usage-total${empty ? ' is-empty' : ''}`);
    if (totalExact && totalExact !== '未上报') totalEl.title = `精确值：${totalExact} tokens`;
    head.append(titleBox, totalEl);
    card.append(head);

    const grid = element('div', undefined, 'usage-grid');
    const s = breakdown.short ?? breakdown;
    const cacheReadText =
      s.cacheRead !== '未上报' && breakdown.cacheRatio && breakdown.cacheRatio !== '未上报'
        ? `${s.cacheRead} (${breakdown.cacheRatio})`
        : s.cacheRead;
    grid.append(
      metricItem('输入', s.input, breakdown.input, '精确输入（含缓存）：'),
      metricItem('输出', s.output, breakdown.output, '精确输出（含思考）：'),
      metricItem('缓存读取', cacheReadText, breakdown.cacheRead, '精确缓存读取：'),
      metricItem('缓存写入', s.cacheWrite, breakdown.cacheWrite, '精确缓存写入：'),
    );
    if (s.reasoning && s.reasoning !== '未上报')
      grid.append(
        metricItem('思考明细', s.reasoning, breakdown.reasoning, '精确思考（已含于输出）：'),
      );
    card.append(grid);
    if (hint) card.append(element('p', hint, 'usage-hint'));
    return card;
  };
  const draw = (info) => {
    currentNativeId = info.currentNativeId;
    resets = info.resets ?? 0;
    const compactions = info.compactions ?? 0;
    const sub = info.subtree;
    const scopeEl = $('token-usage-scope');
    if (scopeEl) {
      scopeEl.textContent = info.totalScopeShort ?? info.cumulative.scope;
      scopeEl.className = `usage-badge${info.cumulative.partial ? ' is-warn' : ''}`;
      scopeEl.title = info.cumulative.scope;
      scopeEl.hidden = false;
    }
    const lifecycleEl = $('token-usage-lifecycle');
    if (lifecycleEl) {
      const tags = [
        resets > 0 ? `重置 ${resets} 次` : '',
        compactions > 0 ? `压缩 ${compactions} 次` : '',
        sub ? `含 ${sub.descendantCount} 个子任务` : '',
      ].filter(Boolean);
      if (tags.length) {
        lifecycleEl.textContent = tags.join(' · ');
        lifecycleEl.className = 'usage-badge is-muted';
        lifecycleEl.hidden = false;
      } else {
        lifecycleEl.textContent = '';
        lifecycleEl.hidden = true;
      }
    }
    const ctxText = info.contextShort
      ? `${info.contextShort}${info.contextKindLabel ? `（${info.contextKindLabel}）` : ''}`
      : info.context;
    const ctxEl = $('token-usage-context');
    ctxEl.textContent = `当前上下文：${ctxText}`;
    ctxEl.title = info.context;
    const ctxMeta = $('token-usage-context-meta');
    if (ctxMeta) {
      ctxMeta.textContent = info.contextAt === undefined ? '' : `采样 ${shortTime(info.contextAt)}`;
      ctxMeta.title = info.contextAt === undefined ? '' : time(info.contextAt);
    }
    const progressEl = $('token-usage-progress');
    if (progressEl) {
      if (typeof info.contextPercent === 'number') {
        const pct = Math.min(100, Math.max(0, info.contextPercent));
        const fill = element(
          'div',
          undefined,
          `usage-bar-fill${pct >= 90 ? ' danger' : pct >= 75 ? ' warn' : ''}`,
        );
        if (fill.style) fill.style.width = `${pct.toFixed(1)}%`;
        progressEl.replaceChildren(fill);
        progressEl.hidden = false;
      } else {
        progressEl.replaceChildren();
        progressEl.hidden = true;
      }
    }
    const noteEl = $('token-usage-note');
    const latestAt = info.taskCumulative?.at ?? info.cumulative.at ?? info.contextAt;
    noteEl.textContent =
      latestAt !== undefined
        ? `更新于 ${shortTime(latestAt)}${info.since ? ` · 自 ${shortTime(info.since)} 起采集` : ''}`
        : info.since
          ? `自 ${shortTime(info.since)} 起采集`
          : info.cumulative.scope;
    noteEl.title = `上下文采样 ${time(info.contextAt)} · ${info.cumulative.scope} · 累计采样 ${time(info.cumulative.at)}${info.since ? ` · 自 ${time(info.since)} 起采集` : ''}`;

    const roundTotalText = info.currentRound.hasValue
      ? (info.currentRound.short?.total ?? info.currentRound.total)
      : info.currentRound.status === 'running'
        ? '等待上报'
        : '历史未采集';
    const roundBadge = info.currentRound.runId
      ? info.currentRound.status === 'running'
        ? '执行中'
        : info.currentRound.partial
          ? '部分统计'
          : '已确认'
      : undefined;
    const roundBadgeClass = info.currentRound.runId
      ? `record-status ${info.currentRound.status === 'running' ? 'running' : info.currentRound.partial ? 'pending' : 'completed'}`
      : undefined;
    const taskCum = info.taskCumulative ?? info.cumulative;
    const cards = element('div', undefined, 'usage-cards');
    const sessionCard = buildCard({
      title: resets > 0 || sub ? '当前会话' : '会话累计',
      badgeText:
        resets > 0
          ? '当前原生上下文'
          : info.cumulative.partial
            ? '部分统计'
            : compactions > 0
              ? `已压缩 ${compactions} 次`
              : undefined,
      badgeClass:
        resets > 0
          ? 'usage-badge is-muted'
          : info.cumulative.partial
            ? 'record-status pending'
            : 'usage-badge is-muted',
      totalText: info.cumulative.hasValue
        ? (info.cumulative.short?.total ?? info.cumulative.total)
        : '未上报',
      totalExact: info.cumulative.total,
      empty: !info.cumulative.hasValue,
      breakdown: info.cumulative,
      hint: info.cumulative.note,
    });
    const roundCard = buildCard({
      title: info.currentRound.label,
      badgeText: roundBadge,
      badgeClass: roundBadgeClass,
      totalText: roundTotalText,
      totalExact: info.currentRound.total,
      empty: !info.currentRound.hasValue,
      breakdown: info.currentRound,
      hint: info.currentRound.reason ?? info.currentRound.note,
    });
    if (sub) {
      const subBadge = `含 ${sub.descendantCount} 个子任务${sub.recordedDescendants < sub.descendantCount ? `（${sub.recordedDescendants}/${sub.descendantCount} 已采集）` : ''}`;
      const subHint = [
        `本任务 ${taskCum.short?.total ?? taskCum.total} + 子任务 ${sub.childrenTotal.short?.total ?? sub.childrenTotal.total}`,
        sub.total.note,
      ]
        .filter(Boolean)
        .join('；');
      const taskHint =
        resets > 0
          ? [
              `当前会话 ${info.cumulative.hasValue ? (info.cumulative.short?.total ?? info.cumulative.total) : '未上报'} + 历史重置 ${taskCum.archivedShort ?? taskCum.archivedTotal}`,
              taskCum.note,
            ]
              .filter(Boolean)
              .join('；')
          : taskCum.note;
      cards.append(
        buildCard({
          title: '含子任务总计',
          badgeText: subBadge,
          badgeClass: sub.partial ? 'record-status pending' : 'usage-badge',
          totalText: sub.total.hasValue ? (sub.total.short?.total ?? sub.total.total) : '未上报',
          totalExact: sub.total.total,
          empty: !sub.total.hasValue,
          primary: true,
          breakdown: sub.total,
          hint: subHint,
        }),
        buildCard({
          title: resets > 0 ? '本任务累计' : '本任务自身',
          badgeText:
            resets > 0
              ? `含 ${resets} 次重置`
              : compactions > 0
                ? `已压缩 ${compactions} 次`
                : taskCum.partial
                  ? '部分统计'
                  : undefined,
          badgeClass: taskCum.partial ? 'record-status pending' : 'usage-badge is-muted',
          totalText: taskCum.hasValue ? (taskCum.short?.total ?? taskCum.total) : '未上报',
          totalExact: taskCum.total,
          empty: !taskCum.hasValue,
          breakdown: taskCum,
          hint: taskHint,
        }),
      );
      if (resets > 0) cards.append(sessionCard);
      cards.append(roundCard);
    } else if (resets > 0) {
      const taskHint = [
        `当前会话 ${info.cumulative.hasValue ? (info.cumulative.short?.total ?? info.cumulative.total) : '未上报'} + 历史重置 ${taskCum.archivedShort ?? taskCum.archivedTotal}`,
        taskCum.note,
      ]
        .filter(Boolean)
        .join('；');
      cards.append(
        buildCard({
          title: '本任务累计',
          badgeText: `含 ${resets} 次重置${compactions > 0 ? ` · ${compactions} 次压缩` : ''}`,
          badgeClass: taskCum.partial ? 'record-status pending' : 'usage-badge',
          totalText: taskCum.hasValue ? (taskCum.short?.total ?? taskCum.total) : '未上报',
          totalExact: taskCum.total,
          empty: !taskCum.hasValue,
          primary: true,
          breakdown: taskCum,
          hint: taskHint,
        }),
        sessionCard,
        roundCard,
      );
    } else {
      cards.append(sessionCard, roundCard);
    }
    $('token-usage-summary').replaceChildren(cards);

    const cols = [
      { title: info.currentRound.label, data: info.currentRound },
      { title: '当前会话', data: info.cumulative },
    ];
    if (resets > 0) cols.push({ title: '本任务累计', data: taskCum });
    if (sub) cols.push({ title: '含子任务总计', data: sub.total });
    const table = element('table', undefined, 'usage-table');
    const header = element('thead'),
      row = element('tr');
    for (const title of ['指标（精确值）', ...cols.map((c) => c.title)])
      row.append(element('th', title));
    header.append(row);
    table.append(header);
    const body = element('tbody');
    for (const [label, key] of [
      ['合计', 'total'],
      ['输入（含缓存）', 'input'],
      ['输出（含思考）', 'output'],
      ['缓存读取', 'cacheRead'],
      ['缓存写入', 'cacheWrite'],
      ['思考明细', 'reasoning'],
      ['缓存读取占输入', 'cacheRatio'],
    ]) {
      const tr = element('tr');
      tr.append(element('th', label));
      for (const col of cols) {
        const val = col.data[key];
        tr.append(element('td', val, val === '未上报' ? 'is-empty' : undefined));
      }
      body.append(tr);
    }
    const foot = element('tr');
    foot.append(
      element('th', '统计状态'),
      element(
        'td',
        info.currentRound.runId
          ? `${info.currentRound.status === 'running' ? '执行中' : '已结束'} · ${info.currentRound.partial ? '部分统计 / 等待确认' : '已确认'}${info.currentRound.reason ? ` · ${info.currentRound.reason}` : ''}`
          : '历史未采集',
      ),
      element('td', info.cumulative.scope),
    );
    if (resets > 0) foot.append(element('td', taskCum.scope));
    if (sub)
      foot.append(
        element(
          'td',
          `含 ${sub.descendantCount} 子任务（${sub.recordedDescendants}/${sub.descendantCount} 已采集）`,
        ),
      );
    body.append(foot);
    table.append(body);
    const tableWrap = $('token-usage-table');
    if (tableWrap) tableWrap.replaceChildren(table);

    const childrenEl = $('token-usage-children');
    if (childrenEl) {
      if (sub?.children?.length) {
        const wrap = element('div', undefined, 'usage-children');
        wrap.append(
          element(
            'p',
            `子任务消耗明细（${sub.descendantCount} 个子任务，子任务合计 ${sub.childrenTotal.short?.total ?? sub.childrenTotal.total}）`,
            'usage-children-title',
          ),
        );
        for (const child of sub.children) {
          const item = element('div', undefined, 'usage-child-row');
          if (item.style && child.depth > 1)
            item.style.paddingLeft = `${Math.min(child.depth - 1, 4) * 14}px`;
          const head = element('div', undefined, 'usage-child-head');
          const titleBox = element('div', undefined, 'usage-child-title');
          titleBox.append(element('strong', child.title), element('span', child.agent, 'tag'));
          if (child.resets > 0)
            titleBox.append(element('span', `重置 ${child.resets} 次`, 'usage-badge is-muted'));
          if (child.compactions > 0)
            titleBox.append(
              element('span', `压缩 ${child.compactions} 次`, 'usage-badge is-muted'),
            );
          if (child.partial) titleBox.append(element('span', '部分统计', 'usage-badge is-warn'));
          const totalEl = element(
            'span',
            child.task.hasValue ? (child.task.short?.total ?? child.task.total) : '未上报',
            `usage-child-total${child.task.hasValue ? '' : ' is-empty'}`,
          );
          if (child.task.hasValue) totalEl.title = `精确合计：${child.task.total} tokens`;
          head.append(titleBox, totalEl);
          item.append(head);
          const metaText = child.task.hasValue
            ? `入 ${child.task.short?.input ?? child.task.input} / 出 ${child.task.short?.output ?? child.task.output}${child.resets > 0 ? ` · 当前会话 ${child.session.hasValue ? (child.session.short?.total ?? child.session.total) : '未上报'}` : ''}`
            : '尚未采集用量';
          const metaEl = element('p', metaText, 'usage-child-meta');
          if (child.task.hasValue)
            metaEl.title = `精确：输入 ${child.task.input} · 输出 ${child.task.output} · 缓存读取 ${child.task.cacheRead} · 缓存写入 ${child.task.cacheWrite}`;
          item.append(metaEl);
          wrap.append(item);
        }
        childrenEl.replaceChildren(wrap);
      } else {
        childrenEl.replaceChildren();
      }
    }

    const dl = element('dl', undefined, 'usage-facts');
    let caliber;
    for (const f of info.details) {
      if (f.label === '用量口径') {
        caliber = f.value;
        continue;
      }
      dl.append(element('dt', f.label), element('dd', f.value));
    }
    const detailNodes = [dl];
    if (caliber) detailNodes.push(element('p', `口径说明：${caliber}`, 'usage-caliber'));
    $('token-usage-detail').replaceChildren(...detailNodes);
  };
  const drawRuns = () => {
    const nodes = runs.map((run) => {
      const item = element('section', undefined, 'usage-run');
      const head = element('div', undefined, 'usage-run-head');
      const titleBox = element('div', undefined, 'usage-run-title');
      titleBox.append(
        element('strong', run.kind === 'compact' ? '压缩' : '对话轮次'),
        element(
          'span',
          status(run),
          `record-status ${run.status === 'interrupted' ? 'pending' : run.status}`,
        ),
      );
      if (run.partial) titleBox.append(element('span', '部分统计', 'usage-badge is-warn'));
      if (
        (run.nativeId && currentNativeId && run.nativeId !== currentNativeId) ||
        (resets > 0 && !currentNativeId && run.nativeId)
      )
        titleBox.append(element('span', '已重置上下文', 'usage-badge is-muted'));
      titleBox.append(element('span', shortTime(run.sampledAt ?? run.startedAt), 'footnote'));
      head.append(titleBox);
      if (run.information) {
        const totalEl = element(
          'span',
          run.information.short?.total ?? run.information.total,
          'usage-run-total',
        );
        totalEl.title = `精确合计：${run.information.total}`;
        head.append(totalEl);
      }
      item.append(head);
      if (run.information) {
        const s = run.information.short ?? run.information;
        const metrics = element('div', undefined, 'usage-run-metrics');
        const chip = (label, val, exact) => {
          const span = element(
            'span',
            undefined,
            `usage-chip${val === '未上报' ? ' is-empty' : ''}`,
          );
          span.append(element('span', label), element('strong', val));
          if (exact && exact !== '未上报') span.title = `精确：${exact}`;
          return span;
        };
        metrics.append(
          chip('输入', s.input, run.information.input),
          chip('输出', s.output, run.information.output),
          chip('缓存读', s.cacheRead, run.information.cacheRead),
          chip('缓存写', s.cacheWrite, run.information.cacheWrite),
        );
        if (s.reasoning && s.reasoning !== '未上报')
          metrics.append(chip('思考', s.reasoning, run.information.reasoning));
        item.append(metrics);
      } else {
        item.append(
          element(
            'p',
            run.status === 'running' ? '等待本轮上报' : '未采集到可靠用量',
            'usage-hint is-empty',
          ),
        );
      }
      const metaParts = [
        run.actualModel ? `模型 ${run.actualModel}` : undefined,
        run.reason,
        `轮次 ${run.runId.slice(0, 8)}`,
      ].filter(Boolean);
      const meta = element('p', metaParts.join(' · '), 'usage-run-meta');
      meta.title = `轮次 ${run.runId}${run.nativeId ? ` · 原生会话 ${run.nativeId}` : ''}`;
      item.append(meta);
      return item;
    });
    $('token-usage-runs').replaceChildren(
      ...(nodes.length ? nodes : [element('p', '历史逐轮用量尚未采集', 'footnote')]),
    );
    $('token-usage-more').hidden = !cursor;
  };
  const load = async (append = false) => {
    if (!target || loading) return;
    const id = target,
      version = generation;
    loading = true;
    try {
      const data = await api(
        `/sessions/${id}/usage?limit=20${append && cursor ? `&before=${cursor}` : ''}`,
      );
      if (id !== target || version !== generation) return;
      const next = JSON.stringify(data.tokenInformation);
      if (next !== signature) {
        signature = next;
        draw(data.tokenInformation);
      }
      runs = append
        ? [...runs, ...data.runs]
        : older
          ? [...new Map([...runs, ...data.runs].map((r) => [r.runId, r])).values()].sort(
              (a, b) => b.cursor - a.cursor,
            )
          : data.runs;
      if (append) older = true;
      if (!older || append) cursor = data.nextBefore;
      drawRuns();
    } catch (error) {
      if (id === target && version === generation) {
        signature = '';
        $('token-usage-note').textContent = `用量读取失败：${error.message}`;
      }
    } finally {
      if (version === generation) loading = false;
    }
  };
  $('token-usage-refresh').onclick = () => {
    older = false;
    void load();
  };
  $('token-usage-more').onclick = () => void load(true);
  return {
    refresh(id) {
      if (id !== target) {
        target = id;
        generation++;
        loading = false;
        cursor = undefined;
        runs = [];
        older = false;
        signature = '';
        currentNativeId = undefined;
        resets = 0;
        $('token-usage-context').textContent = '正在读取当前会话用量…';
        $('token-usage-context').title = '';
        const ctxMeta = $('token-usage-context-meta');
        if (ctxMeta) {
          ctxMeta.textContent = '';
          ctxMeta.title = '';
        }
        const scopeEl = $('token-usage-scope');
        if (scopeEl) {
          scopeEl.textContent = '';
          scopeEl.hidden = true;
        }
        const lifecycleEl = $('token-usage-lifecycle');
        if (lifecycleEl) {
          lifecycleEl.textContent = '';
          lifecycleEl.hidden = true;
        }
        const progressEl = $('token-usage-progress');
        if (progressEl) {
          progressEl.replaceChildren();
          progressEl.hidden = true;
        }
        $('token-usage-note').textContent = '';
        $('token-usage-note').title = '';
        $('token-usage-summary').replaceChildren();
        const tableWrap = $('token-usage-table');
        if (tableWrap) tableWrap.replaceChildren();
        const childrenEl = $('token-usage-children');
        if (childrenEl) childrenEl.replaceChildren();
        $('token-usage-runs').replaceChildren();
        $('token-usage-detail').replaceChildren();
        $('token-usage-more').hidden = true;
        $('token-usage-history').open = false;
      }
      if (id) void load();
    },
  };
}
