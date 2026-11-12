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
        ['codex', 'claude', 'opencode'].map((id) => ({
          id,
          name: { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }[id],
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
    $('task-workspace-label').hidden = !!parent;
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
      ? `直接父任务：${parent.title} · ${parent.record.id || parent.key}。新任务具有独立对话，默认等待输入。工作目录继承当前父任务。`
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
    $('task-workspace-input').value = parent?.session?.workspace || state.defaultWorkspace;
    $('task-form-error').textContent = '';
    $('task-save').disabled = false;
    $('task-save').textContent = '创建任务';
    $('task-dialog').showModal();
    $('task-source').onchange = () => {
      const s = state.sessions.find((s) => s.id === $('task-source').value);
      $('task-workspace-input').value = s?.workspace || state.defaultWorkspace;
    };
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
              ...(parent?.task ? {} : workspace ? { workspace } : {}),
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
                `授权范围：${record.answer.scope === 'session' ? '仅此会话（当时的原生授权范围）' : '仅本次'}`,
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
      $('records-usage').textContent = token
        ? `上下文：${token.context} · 消耗：${token.total}。${token.details.map((f) => `${f.label}：${f.value}`).join('；')}`
        : '原生 Agent 尚未上报本会话的 token 用量。';
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
          `${plan.current ? '最近一轮' : '历史轮次'} · ${{ codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }[plan.source]}${plan.archived ? ' · 重置前历史' : ''}`,
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
