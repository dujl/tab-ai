import {
  createConsole,
  sessionDisplayTitle,
  createExecutionRecords,
  createAgentPlans,
} from '/dashboard.js';
const $ = (id) => document.getElementById(id);
const labels = {
  idle: '空闲',
  running: '运行中',
  waiting: '等待确认',
  interrupted: '已中断',
  error: '发生错误',
  detached: '原生终端中',
  closed: '已关闭',
};
const platformNames = {
  local: '本地',
  lark: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信',
  wechat: '微信',
};
let token =
  new URLSearchParams(location.hash.slice(1)).get('token') ||
  sessionStorage.getItem('tab-ai-token') ||
  '';
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
if (token) sessionStorage.setItem('tab-ai-token', token);
let state,
  selected,
  eventSignature = '',
  interactionSignature = '',
  polling = false;
let settingsTarget,
  settingsData,
  settingsLoading = false,
  workspaceTarget;
let maintenanceTarget,
  maintenanceRevision,
  maintenanceMode,
  maintenanceGeneration = 0;
const drafts = new Map(),
  sending = new Set();

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
}
let stateCache;
async function api(path, data) {
  const response = await fetch(`/api${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(path === '/state' && data === undefined && stateCache?.token === token
        ? { 'If-None-Match': stateCache.etag }
        : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (response.status === 401) {
    if (!$('auth-dialog').open) $('auth-dialog').showModal();
    throw new Error('访问令牌无效，请从本机终端获取。');
  }
  if (response.status === 304 && path === '/state' && stateCache?.token === token)
    return stateCache.value;
  const result = await response.json();
  if (path === '/state' && response.ok)
    stateCache = { token, etag: response.headers.get('etag'), value: result };
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function safe(fn) {
  return (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch(showError);
}
function setSelected(id) {
  if (selected === id) return;
  if (selected) drafts.set(selected, $('prompt').value);
  selected = id;
  $('prompt').value = drafts.get(id) || '';
  eventSignature = '';
  interactionSignature = '';
  $('messages').replaceChildren();
  $('interactions').replaceChildren();
  $('native-info').hidden = true;
}
function select(id, taskId, options) {
  setSelected(id);
  consoleUI.activate(id, taskId, options);
  if (state) {
    renderState();
    renderInteractions();
    consoleUI.render(state);
  }
  void refresh();
}
function renderState() {
  const session = state.sessions.find((s) => s.id === selected);
  $('empty').hidden = !!session;
  $('workspace').hidden = !session;
  if (!session) return;
  $('title').textContent =
    `${session.title || { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' }[session.agent]} / ${session.id.slice(0, 8)}`;
  $('subtitle').textContent = session.workspace;
  $('agent').textContent = { codex: 'CODEX', claude: 'CLAUDE CODE', opencode: 'OPENCODE' }[
    session.agent
  ];
  $('status').textContent = session.operation === 'compact' ? '压缩中' : labels[session.status];
  $('status').className = `status ${session.status}`;
  $('im-entry-status').hidden = !session.imEntry;
  $('im-entry-note').textContent = session.imEntry?.detail || '';
  $('source').textContent =
    `${platformNames[session.route.platform]} · ${session.nativeId?.slice(0, 16) || '等待首次启动'}`;
  $('session-settings-summary').textContent = session.settings
    ? `${session.settings.model} · ${session.settings.effort || '无可选思考档位'}`
    : '沿用原生会话 / 本机配置';
  $('instructions-text').textContent = session.instructions || '未设置，沿用原生指令。';
  const task = (state.tasks || []).find((t) => t.sessionId === session.id),
    busy = !!session.operation || ['running', 'waiting'].includes(session.status);
  $('initial-task').hidden = !session.pendingInitialTask || session.status === 'closed';
  $('initial-task-text').textContent = session.pendingInitialTask || '';
  $('begin-session').disabled = busy || session.status !== 'idle';
  $('compose-target').textContent =
    `发送给：${task?.title || sessionDisplayTitle(session)} · ${session.id.slice(0, 8)}`;
  $('reset-session').hidden = !state.dualEntryTasks;
  $('reset-session').disabled = busy || session.status === 'detached';
  $('workspace-settings').disabled = busy || session.status === 'detached';
  $('workspace-settings').title =
    '仅修改本节点；已存在的子任务保持原目录。Agent 不支持保留上下文时会明确提示。';
  $('compact-session').disabled = busy || !session.nativeId || session.status === 'detached';
  $('session-loops').disabled = session.status === 'detached';
  $('stop').textContent = session.operation === 'compact' ? '停止压缩' : '停止当前轮';
  $('stop').disabled = !busy;
  $('native').disabled = busy || !session.nativeId || session.status === 'closed';
  $('attach').hidden = session.status !== 'detached';
  $('open-session').hidden = session.status !== 'closed';
  $('close-session').hidden = session.status === 'closed';
  $('close-session').disabled = session.status === 'detached';
  $('send').disabled =
    sending.has(session.id) ||
    (!task && busy) ||
    ['detached', 'closed'].includes(session.status) ||
    task?.state === 'cancelled';
  $('compose-hint').textContent =
    task?.state === 'cancelled'
      ? '任务已取消 · 历史记录保留'
      : session.status === 'closed'
        ? '会话已关闭 · 点击“打开 / 恢复”后继续'
        : busy
          ? task
            ? '运行中 · 补充将排队'
            : '运行中 · 等待完成或停止后继续'
          : session.route.platform === 'local'
            ? '原文发送 · 不附加管理提示词'
            : `原文发送 · 结果将回传${platformNames[session.route.platform]}会话`;
}
function renderEvents(events) {
  const signature = JSON.stringify(events);
  if (signature === eventSignature) return;
  eventSignature = signature;
  const container = $('messages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
  const expanded = new Set(
    [...container.querySelectorAll('details[open]')].map((e) => e.dataset.key),
  );
  const groups = new Map(),
    visible = [];
  for (const event of events) {
    if (event.type === 'tool') {
      try {
        const tool = JSON.parse(event.text);
        if (!tool.runId || !tool.id) continue;
        if (!groups.has(tool.runId)) {
          const group = { type: 'tools', id: tool.runId, tools: new Map() };
          groups.set(tool.runId, group);
          visible.push(group);
        }
        groups.get(tool.runId).tools.set(tool.id, tool);
      } catch {}
    } else if (
      ['user', 'assistant', 'error', 'delivery_error', 'activity', 'system', 'decision'].includes(
        event.type,
      )
    )
      visible.push(event);
  }
  container.replaceChildren(
    ...visible.map((event) => {
      if (event.type === 'tools') {
        const names = {
          running: '执行中',
          completed: '已完成',
          failed: '失败',
          interrupted: '已中断',
          unknown: '结果未上报',
        };
        const group = node('details', 'tool-run');
        group.dataset.key = event.id;
        group.open = expanded.has(event.id);
        const tools = [...event.tools.values()],
          running = tools.filter((t) => t.status === 'running').length;
        group.append(
          node(
            'summary',
            '',
            `tab-ai 执行记录 · 已调用 ${tools.length} 次工具${running ? ' · ' + running + ' 项执行中' : ''}`,
          ),
        );
        for (const tool of tools) {
          const item = node('details', 'tool-item');
          item.dataset.key = event.id + ':' + tool.id;
          item.open = expanded.has(item.dataset.key);
          item.append(
            node(
              'summary',
              '',
              `${names[tool.status] || tool.status} · ${tool.name} · ${(tool.input || '').replace(/\s+/g, ' ').slice(0, 100)}`,
            ),
          );
          if (tool.input) item.append(node('strong', '', '调用内容'), node('pre', '', tool.input));
          if (tool.output)
            item.append(node('strong', '', '执行结果'), node('pre', '', tool.output));
          if (tool.exitCode !== undefined)
            item.append(node('small', '', `退出码：${tool.exitCode}`));
          group.append(item);
        }
        return group;
      }
      if (event.type === 'activity') return node('div', 'activity', `↳ ${event.text}`);
      const message = node('article', `message ${event.type}`),
        meta = node('div', 'meta');
      meta.append(
        node(
          'span',
          'role',
          event.type === 'user'
            ? 'YOU'
            : event.type === 'assistant'
              ? 'AGENT'
              : event.type === 'decision'
                ? 'DECISION'
                : 'SYSTEM',
        ),
        node(
          'span',
          '',
          new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ),
      );
      message.append(meta, node('div', 'body', event.text));
      return message;
    }),
  );
  if (!visible.length)
    container.append(
      node('p', 'empty-messages', '会话已就绪。发送第一条消息，让 Agent 开始工作。'),
    );
  if (nearBottom) container.scrollTop = container.scrollHeight;
}
function renderInteractions() {
  const currentTask = (state.tasks || []).find((t) => t.sessionId === selected);
  const pending = state.interactions.filter(
      (i) =>
        i.sessionId === selected ||
        (currentTask &&
          !currentTask.parentId &&
          (state.tasks || []).some(
            (t) => t.rootId === currentTask.id && t.sessionId === i.sessionId,
          )),
    ),
    signature = JSON.stringify(pending);
  if (signature === interactionSignature) return;
  interactionSignature = signature;
  $('interactions').replaceChildren(
    ...pending.map((request) => {
      const card = node('div', 'interaction');
      card.append(node('h3', '', request.title));
      const origin = state.sessions.find((s) => s.id === request.sessionId);
      card.append(
        node(
          'p',
          'footnote',
          `来自：${origin?.title || request.sessionId} · ${request.sessionId.slice(0, 8)}`,
        ),
      );
      const decide = safe(async (answer) => {
        const buttons = [...card.querySelectorAll('button')];
        buttons.forEach((b) => (b.disabled = true));
        try {
          await api(`/sessions/${request.sessionId}/answer`, { id: request.id, answer });
          $('error').hidden = true;
          await refresh();
        } finally {
          buttons.forEach((b) => (b.disabled = false));
        }
      });
      if (request.elicitation) {
        if (request.kind === 'question')
          card.append(node('p', 'elicitation-detail', request.detail));
        if (request.elicitation.url) {
          try {
            const url = new URL(request.elicitation.url);
            if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
              const link = node('a', 'button-link', '打开授权页面 ↗');
              link.href = url.href;
              link.target = '_blank';
              link.rel = 'noopener noreferrer';
              card.append(link);
            }
          } catch {}
        }
      }
      if (request.kind === 'approval') {
        const summary = request.approvalSummary;
        card.append(node('p', 'approval-operation', summary?.operation || '原生工具请求'));
        if (summary) {
          const facts = node('dl', 'approval-facts');
          for (const fact of summary.facts) {
            facts.append(node('dt', '', fact.label), node('dd', '', fact.value));
          }
          card.append(facts);
          if (summary.caution) card.append(node('p', 'approval-caution', summary.caution));
        }
        const detail = node('details', 'approval-detail');
        detail.append(node('summary', '', '查看完整请求'), node('pre', '', request.detail));
        card.append(
          detail,
          node(
            'p',
            'footnote',
            '摘要由程序提取，不能代表完整影响范围。授权范围以所选选项为准，仅此会话；超时不会自动批准。',
          ),
        );
        const actions = node('div', 'answers');
        if (request.approvalContext)
          card.append(
            node(
              'p',
              'footnote',
              `审批策略：${request.approvalContext.label}。${request.approvalContext.description}`,
            ),
          );
        const options = request.approvalOptions || [
          { id: 'allow', label: '允许本次' },
          { id: 'deny', label: '拒绝' },
        ];
        for (const option of options) {
          if (option.description)
            card.append(node('p', 'footnote', `${option.label}：${option.description}`));
          const b = node(
            'button',
            option.id === 'allow' || option.id === 'session' ? 'primary' : '',
            option.label,
          );
          b.title = option.description || '';
          b.onclick = () =>
            decide(
              option.id === 'session'
                ? { allow: true, scope: 'session' }
                : option.id === 'cancel'
                  ? { allow: false, cancel: true }
                  : { allow: option.id === 'allow' },
            );
          actions.append(b);
        }
        if (!options.some((o) => o.id === 'session'))
          card.append(node('p', 'footnote', '本次未提供会话内授权，不能扩大为“允许所有”。'));
        card.append(actions);
      } else {
        const inputs = new Map();
        for (const question of request.questions || []) {
          const group = node('fieldset', 'question');
          group.append(node('legend', '', question.question));
          const choices = [];
          let other;
          for (const [index, option] of (question.options || []).entries()) {
            const label = node('label', 'choice'),
              input = node('input');
            input.type = question.multiSelect ? 'checkbox' : 'radio';
            input.name = `${request.id}:${question.id}`;
            input.value = option;
            input.onchange = () => {
              if (input.checked && other) other.value = '';
            };
            const detail = node('span', '', option);
            if (question.descriptions?.[index])
              detail.append(node('small', '', question.descriptions[index]));
            label.append(input, detail);
            group.append(label);
            choices.push(input);
          }
          if (!choices.length || question.allowOther !== false) {
            const label = node('label', '', choices.length ? '自定义回答（与选项二选一）' : '回答');
            other = node('input');
            other.placeholder = '输入回答';
            other.maxLength = 8000;
            other.oninput = () => {
              if (other.value) choices.forEach((c) => (c.checked = false));
            };
            label.append(other);
            group.append(label);
          }
          if (question.multiSelect) group.append(node('small', '', '可选择多项。'));
          inputs.set(question.id, () =>
            other?.value.trim()
              ? [other.value]
              : choices.filter((c) => c.checked).map((c) => c.value),
          );
          card.append(group);
        }
        const actions = node('div', 'answers');
        if (request.elicitation)
          for (const [action, label] of [
            ['decline', '拒绝本次请求'],
            ['cancel', '取消本次请求'],
          ]) {
            const b = node('button', '', label);
            b.onclick = () => decide({ answers: {}, action });
            actions.append(b);
          }
        const submit = node('button', 'primary', '提交全部回答');
        submit.onclick = () =>
          decide({
            answers: Object.fromEntries([...inputs].map(([id, values]) => [id, values()])),
          });
        actions.append(submit);
        card.append(actions);
      }
      return card;
    }),
  );
}
let approvalPolicyTarget, approvalPolicyData;
function showApprovalPolicyDescription() {
  const mode = approvalPolicyData?.modes.find((m) => m.id === $('approval-policy-mode').value);
  $('approval-policy-description').textContent =
    mode?.description || '由原生 Agent 的权限规则决定。';
}
$('approval-policy-mode').onchange = showApprovalPolicyDescription;
const openApprovalPolicy = safe(async () => {
  approvalPolicyTarget = selected;
  const target = approvalPolicyTarget;
  approvalPolicyData = await api(`/sessions/${target}/approval-policy`);
  $('approval-policy-target').textContent =
    `目标：${state.sessions.find((s) => s.id === target)?.title || target}${approvalPolicyData.defaulted && approvalPolicyData.mode === 'on-request' ? ' · 框架默认：按需审批' : ''}`;
  $('approval-policy-mode').replaceChildren(
    ...approvalPolicyData.modes.map((m) => new Option(m.label, m.id)),
  );
  $('approval-policy-mode').value = approvalPolicyData.mode;
  showApprovalPolicyDescription();
  $('approval-policy-error').textContent = '';
  $('approval-policy-dialog').showModal();
});
$('approval-policy-open').onclick = openApprovalPolicy;
$('approval-policy-quick').onclick = openApprovalPolicy;
$('approval-policy-cancel').onclick = () => $('approval-policy-dialog').close();
async function saveApprovalPolicy(revoke = false) {
  const target = approvalPolicyTarget,
    data = approvalPolicyData;
  if (!target || !data) return;
  const buttons = [...$('approval-policy-dialog').querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api(`/sessions/${target}/approval-policy`, {
      mode: revoke ? data.mode : $('approval-policy-mode').value,
      revision: data.revision,
      revoke,
    });
    $('approval-policy-dialog').close();
    await refresh();
  } catch (error) {
    $('approval-policy-error').textContent = error.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
$('approval-policy-form').onsubmit = (e) => {
  e.preventDefault();
  void saveApprovalPolicy();
};
$('approval-policy-revoke').onclick = () => void saveApprovalPolicy(true);
const executionRecordsUI = createExecutionRecords({ api, showError });
const agentPlansUI = createAgentPlans({ api });
async function refresh() {
  if (!token || polling) return;
  polling = true;
  try {
    state = await api('/state');
    setSelected(consoleUI.sync(state));
    renderState();
    renderInteractions();
    consoleUI.render(state);
    if (!$('agent-plans-panel').hidden) agentPlansUI.refresh(selected);
    else agentPlansUI.hide();
    const recordsVisible = !$('records-panel').hidden;
    $(recordsVisible ? 'records-pending' : 'conversation-interactions').append($('interactions'));
    if (recordsVisible && state.executionRecords) executionRecordsUI.refresh(selected);
    else {
      executionRecordsUI.hide();
      if (recordsVisible)
        $('records-note').textContent = '记录服务正在等待空闲更新；当前审批仍可在上方处理。';
    }
    if (selected && !$('workspace').hidden) {
      const id = selected;
      const events = await api(`/sessions/${id}/events`);
      if (id === selected) renderEvents(events);
    }
    $('connection-dot').className = '';
    $('connection-label').textContent = '本地已连接';
  } catch (error) {
    $('connection-dot').className = 'off';
    $('connection-label').textContent = '连接断开';
    showError(error);
  } finally {
    polling = false;
  }
}
$('auth-form').onsubmit = (event) => {
  event.preventDefault();
  token = $('token-input').value.trim();
  sessionStorage.setItem('tab-ai-token', token);
  $('auth-dialog').close();
  $('error').hidden = true;
  void refresh();
};
$('composer').onsubmit = (event) => {
  event.preventDefault();
  void safe(async () => {
    const id = selected,
      text = $('prompt').value;
    if (!id || !text.trim() || sending.has(id)) return;
    sending.add(id);
    renderState();
    try {
      await api(`/sessions/${id}/messages`, { text });
      if (selected === id && $('prompt').value === text) {
        $('prompt').value = '';
        drafts.delete(id);
      } else if (selected !== id && drafts.get(id) === text) drafts.delete(id);
      $('error').hidden = true;
      await refresh();
    } finally {
      sending.delete(id);
      if (state) {
        renderState();
        consoleUI.render(state);
      }
    }
  })();
};
$('stop').onclick = safe(async () => {
  await api(`/sessions/${selected}/stop`, {});
  await refresh();
});
$('begin-session').onclick = safe(async () => {
  const id = selected;
  await api(`/sessions/${id}/begin`, {});
  await refresh();
});
$('close-session').onclick = safe(async () => {
  await api(`/sessions/${selected}/close`, {});
  await refresh();
});
$('open-session').onclick = safe(async () => {
  await api(`/sessions/${selected}/open`, {});
  await refresh();
});
$('native').onclick = safe(async () => {
  await api(`/sessions/${selected}/detach`, {});
  $('native-info').textContent =
    `在本机终端执行：\ntab-ai native ${selected}\n\n退出后自动交回。手动启动原生 CLI 时，退出后点击“已退出终端，交回”。`;
  $('native-info').hidden = false;
  await refresh();
});
$('attach').onclick = safe(async () => {
  await api(`/sessions/${selected}/attach`, {});
  $('native-info').hidden = true;
  await refresh();
});
function settingsOptions(element, options, selectedValue) {
  element.replaceChildren(
    ...[{ id: '', label: '请选择' }, ...options].map((o) => {
      const option = node('option', '', o.label);
      option.value = o.id;
      return option;
    }),
  );
  element.value = options.some((o) => o.id === selectedValue) ? selectedValue : '';
}
function settingsEfforts(value) {
  const model = settingsData?.capabilities.models.find((m) => m.id === $('settings-model').value);
  settingsOptions(
    $('settings-effort'),
    model?.efforts.map((e) => ({ id: e.id, label: `${e.id} · ${e.label}` })) || [],
    value,
  );
  $('settings-effort-label').hidden = !model?.efforts.length;
  $('settings-effort').required = !!model?.efforts.length;
}
async function loadMaintenance() {
  const target = maintenanceTarget,
    mode = maintenanceMode,
    generation = ++maintenanceGeneration;
  if (!target) return;
  $('maintenance-start').disabled = true;
  $('maintenance-error').textContent = '';
  $('maintenance-items').replaceChildren(node('p', 'footnote', '正在读取…'));
  try {
    const data = await api(`/sessions/${target}/${mode === 'compact' ? 'maintenance' : 'loops'}`);
    if (
      target !== maintenanceTarget ||
      mode !== maintenanceMode ||
      generation !== maintenanceGeneration ||
      !$('maintenance-dialog').open
    )
      return;
    maintenanceRevision = data.revision;
    $('maintenance-items').replaceChildren();
    if (mode === 'compact') {
      const can =
        data.canCompact &&
        data.hasNativeHistory &&
        !data.busy &&
        !['running', 'waiting', 'detached'].includes(data.status);
      $('maintenance-start').disabled = !can;
      $('maintenance-items').append(
        node(
          'p',
          '',
          !data.canCompact
            ? '此后端未接入原生压缩。'
            : !data.hasNativeHistory
              ? '尚无原生历史可压缩。'
              : data.operation === 'compact'
                ? '正在压缩，可关闭面板后点击“停止压缩”。'
                : can
                  ? '可以开始原生压缩。'
                  : '请先结束当前任务或审批，并交回原生终端。',
        ),
      );
      const token = data.tokenInformation;
      if (token)
        $('maintenance-items').append(
          node('p', '', `上下文：${token.context}`),
          node('p', 'footnote', `消耗：${token.total}。累计消耗不会因压缩减少。`),
        );
      const last = data.lastCompaction;
      if (last) {
        const label =
          {
            accepted: '已受理，尚未调用原生压缩',
            running: '原生压缩执行中',
            completed: '已完成',
            noop: '未执行压缩',
            failed: '失败',
            unconfirmed: '结果未确认',
          }[last.phase] || last.phase;
        const item = node('section', 'maintenance-item');
        item.append(
          node('strong', '', '最近压缩：' + label),
          node(
            'p',
            ['failed', 'unconfirmed'].includes(last.phase) ? 'form-error' : '',
            last.detail,
          ),
          node(
            'p',
            'footnote',
            `操作 ID：${last.id}${last.code ? ' · 诊断：' + last.code : ''}${last.rpcCode !== undefined ? ' · 原生错误码：' + last.rpcCode : ''}`,
          ),
        );
        if (last.tokens) {
          const before = last.tokens.before,
            after = last.tokens.after;
          item.append(
            node(
              'p',
              '',
              `上下文 tokens：${before === undefined ? '未上报' : before.toLocaleString('en-US')} → ${after === undefined ? '待原生更新' : after.toLocaleString('en-US')}`,
            ),
          );
        }
        $('maintenance-items').append(item);
      } else
        $('maintenance-items').append(
          node('p', 'footnote', '尚无压缩执行记录；打开面板不会开始压缩。'),
        );
    } else {
      for (const loop of data.entries) {
        const item = node('section', 'maintenance-item');
        item.append(
          node('strong', '', loop.label),
          node(
            'p',
            '',
            {
              active: '运行中',
              paused: '已暂停',
              blocked: '受阻',
              running: '执行中',
              queued: '排队中',
              waiting: '等待继续',
              review: '等待验收',
              usageLimited: '已达用量限制',
              budgetLimited: '已达预算限制',
            }[loop.status] || loop.status,
          ),
          node('p', '', loop.detail),
        );
        const stop = node('button', 'danger', '停止此项');
        stop.onclick = safe(async () => {
          stop.disabled = true;
          try {
            await api(`/sessions/${target}/loop-stop`, {
              loopId: loop.id,
              revision: data.revision,
            });
            if (maintenanceTarget === target) await loadMaintenance();
            await refresh();
          } finally {
            stop.disabled = false;
          }
        });
        item.append(stop);
        $('maintenance-items').append(item);
      }
      if (!data.entries.length)
        $('maintenance-items').append(node('p', '', '未发现已接通、尚未结束的自动继续项。'));
      if (!data.nativeSupported)
        $('maintenance-items').append(
          node('p', 'footnote', '此后端未接入原生 loop 取消；请在原生终端管理。'),
        );
      if (data.nativeError)
        $('maintenance-items').append(node('p', 'form-error', data.nativeError));
      $('maintenance-items').append(node('p', 'footnote', data.note));
    }
  } catch (error) {
    if (generation === maintenanceGeneration) $('maintenance-error').textContent = error.message;
  }
}
function openMaintenance(mode) {
  const session = state.sessions.find((s) => s.id === selected);
  if (!session) return;
  maintenanceTarget = session.id;
  maintenanceMode = mode;
  maintenanceRevision = undefined;
  $('maintenance-title').textContent = mode === 'compact' ? '压缩当前会话' : '循环管理';
  $('maintenance-target').textContent =
    `目标：${session.title || session.agent} · ${session.id.slice(0, 8)}`;
  $('maintenance-description').textContent =
    mode === 'compact'
      ? '原生 Agent 会调用模型总结较早内容，部分细节可能省略；保留同一原生会话、目录和设置，框架聊天记录不会删除。'
      : '停止所选调度 / 持续目标。停止当前一轮不会自动取消后续触发；未接通的脚本或插件循环须在其原生入口管理。';
  $('maintenance-start').hidden = mode !== 'compact';
  $('maintenance-dialog').showModal();
  void loadMaintenance();
}
let entryTarget,
  entryRevision,
  entryUnknown,
  entryGeneration = 0;
$('im-entry-open').onclick = safe(async () => {
  const session = state.sessions.find((s) => s.id === selected);
  if (!session?.imEntry) return;
  entryTarget = session.id;
  entryRevision = undefined;
  const generation = ++entryGeneration;
  $('im-entry-target').textContent =
    `任务：${session.title || session.id} · ${session.route.account}`;
  $('im-entry-error').textContent = '';
  $('im-entry-check').checked = false;
  $('im-entry-confirm').disabled = true;
  $('im-entry-dialog').showModal();
  const data = await api(`/sessions/${entryTarget}/im-entry`);
  if (generation !== entryGeneration || !$('im-entry-dialog').open) return;
  entryRevision = data.revision;
  entryUnknown = data.entry?.state === 'unknown';
  $('im-entry-check-label').hidden = !entryUnknown;
  $('im-entry-confirm').disabled = entryUnknown;
});
$('im-entry-check').onchange = () => {
  $('im-entry-confirm').disabled = entryUnknown && !$('im-entry-check').checked;
};
$('im-entry-cancel').onclick = () => {
  $('im-entry-dialog').close();
  entryGeneration++;
};
$('im-entry-confirm').onclick = safe(async () => {
  if (!entryTarget || !entryRevision) return;
  $('im-entry-confirm').disabled = true;
  try {
    await api(`/sessions/${entryTarget}/im-entry`, {
      revision: entryRevision,
      confirmedUnknown: entryUnknown && $('im-entry-check').checked,
    });
    $('im-entry-dialog').close();
    entryGeneration++;
    await refresh();
  } catch (error) {
    $('im-entry-error').textContent = error.message;
  }
});
let resetTarget,
  resetRevision,
  resetGeneration = 0;
$('reset-session').onclick = safe(async () => {
  const session = state.sessions.find((s) => s.id === selected);
  if (!session) return;
  resetTarget = session.id;
  resetRevision = undefined;
  const generation = ++resetGeneration;
  $('reset-target').textContent =
    `目标：${session.title || session.agent} · ${session.id.slice(0, 8)}${session.taskId ? ' · 保留任务及 Session ID，仅清空原生上下文' : ' · 创建新上下文，旧会话关闭并保留历史'}`;
  $('reset-error').textContent = '';
  $('reset-confirm').disabled = true;
  $('reset-dialog').showModal();
  const info = await api(`/sessions/${session.id}/reset`);
  if (generation !== resetGeneration || !$('reset-dialog').open) return;
  resetRevision = info.revision;
  $('reset-confirm').disabled = !info.canReset;
  $('reset-error').textContent = info.reason || '';
});
$('reset-cancel').onclick = () => {
  $('reset-dialog').close();
  resetGeneration++;
};
$('reset-confirm').onclick = safe(async () => {
  const target = resetTarget,
    revision = resetRevision;
  if (!target || !revision) return;
  $('reset-confirm').disabled = true;
  try {
    const fresh = await api(`/sessions/${target}/reset`, { revision });
    $('reset-dialog').close();
    resetGeneration++;
    await refresh();
    select(fresh.id);
  } catch (error) {
    $('reset-error').textContent = error.message;
  }
});
$('compact-session').onclick = () => openMaintenance('compact');
$('session-loops').onclick = () => openMaintenance('loops');
$('maintenance-refresh').onclick = () => void loadMaintenance();
$('maintenance-close').onclick = () => {
  $('maintenance-dialog').close();
  maintenanceGeneration++;
};
$('maintenance-start').onclick = safe(async () => {
  const target = maintenanceTarget,
    revision = maintenanceRevision,
    generation = maintenanceGeneration;
  if (!target || !revision) return;
  $('maintenance-start').disabled = true;
  try {
    await api(`/sessions/${target}/compact`, { revision });
    if (
      maintenanceTarget === target &&
      maintenanceMode === 'compact' &&
      maintenanceGeneration === generation
    )
      await loadMaintenance();
    await refresh();
  } catch (error) {
    if (maintenanceTarget === target && maintenanceGeneration === generation)
      $('maintenance-error').textContent = error.message;
    else showError(error);
  } finally {
    if (maintenanceTarget === target && maintenanceGeneration === generation)
      $('maintenance-start').disabled = false;
  }
});
$('workspace-settings').onclick = () => {
  const session = state.sessions.find((s) => s.id === selected);
  if (!session) return;
  workspaceTarget = session.id;
  $('workspace-path').value = session.workspace;
  $('workspace-target').textContent =
    `目标：${session.title || session.agent} · ${platformNames[session.route.platform]} · ${session.id.slice(0, 8)}`;
  $('workspace-error').textContent = '';
  $('workspace-dialog').showModal();
};
$('workspace-cancel').onclick = () => $('workspace-dialog').close();
$('workspace-form').onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    const target = workspaceTarget;
    if (!target) return;
    $('workspace-save').disabled = true;
    try {
      const session = await api(`/sessions/${target}/replace-workspace`, {
        workspace: $('workspace-path').value,
      });
      $('workspace-dialog').close();
      if (selected === target) select(session.id);
      else await refresh();
    } catch (error) {
      $('workspace-error').textContent = error.message;
    } finally {
      $('workspace-save').disabled = false;
    }
  })();
};
$('session-settings').onclick = safe(async () => {
  if (settingsLoading) return;
  settingsTarget = selected;
  const target = settingsTarget;
  settingsLoading = true;
  settingsData = undefined;
  $('settings-target').textContent =
    `${state.sessions.find((s) => s.id === target)?.agent} / ${target}`;
  $('settings-message').textContent = '正在读取 Agent 模型能力…';
  $('settings-save').disabled = true;
  settingsOptions($('settings-model'), []);
  settingsEfforts();
  $('settings-dialog').showModal();
  try {
    const data = await api(`/sessions/${target}/settings`);
    if (settingsTarget !== target || !$('settings-dialog').open) return;
    settingsData = data;
    if (data.capabilities.state !== 'ready')
      throw new Error(data.capabilities.error || '模型能力暂不可用，请重新打开设置。');
    settingsOptions($('settings-model'), data.capabilities.models, data.settings?.model);
    settingsEfforts(data.settings?.effort);
    $('settings-message').textContent = '选项来自当前 Agent；任务结束或退出原生终端后可保存。';
    $('settings-save').disabled = false;
  } catch (error) {
    $('settings-message').textContent = error.message;
  } finally {
    settingsLoading = false;
  }
});
$('settings-model').onchange = () =>
  settingsEfforts(
    settingsData?.capabilities.models.find((m) => m.id === $('settings-model').value)
      ?.defaultEffort,
  );
$('settings-cancel').onclick = () => $('settings-dialog').close();
$('settings-form').onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    if (!settingsData || !settingsTarget) return;
    $('settings-save').disabled = true;
    try {
      const effort = $('settings-effort').value;
      await api(`/sessions/${settingsTarget}/settings`, {
        revision: settingsData.revision,
        settings: { model: $('settings-model').value, ...(effort ? { effort } : {}) },
      });
      $('settings-dialog').close();
      await refresh();
    } catch (error) {
      $('settings-message').textContent = error.message;
    } finally {
      $('settings-save').disabled = false;
    }
  })();
};
const consoleUI = createConsole({ api, refresh, selectSession: select, showError });
if (!token) $('auth-dialog').showModal();
else void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 1500);
