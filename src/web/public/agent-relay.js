const labels = {
  report_pending: '正在生成任务报告',
  awaiting_confirmation: '等待确认',
  activating: '正在交接',
  awaiting_input: '已交接，等待首次输入',
  submitting: '正在提交交接资料',
  submitted: '交接输入已记录提交',
  failed: '失败',
  unconfirmed: '提交结果待核对',
  cancelled: '已取消',
  active: '已启用',
  ended: '已结束',
  preparing: '准备中',
  active: '已启用',
  ended: '已结束',
  preparing: '准备中',
  ready: '已就绪',
  running: '生成中',
  pending: '待生成',
};
const element = (tag, text) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};
export function relayKey(crypto = globalThis.crypto) {
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (!crypto?.getRandomValues) throw Error('浏览器无法生成请求编号，请使用 HTTPS 或更换浏览器');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function showAgentRelay(api, sessionId, agents, onChange = () => {}) {
  const agentNames = Object.fromEntries(agents.map((a) => [a.id, a.name]));
  const dialog = element('dialog'),
    title = element('h2', 'Agent 接力与执行阶段'),
    note = element(
      'p',
      '同一个任务与 Session，每次接力使用新的原生上下文。报告就绪并确认后才交给目标 Agent。',
    ),
    error = element('p'),
    form = element('form'),
    list = element('div'),
    documentPanel = element('div'),
    agent = element('select'),
    model = element('select'),
    effort = element('select'),
    approval = element('select'),
    approvalNote = element('p'),
    instructions = element('textarea'),
    continueTask = element('input'),
    prepare = element('button', '生成接力预览'),
    refresh = element('button', '刷新状态'),
    close = element('button', '关闭面板');
  dialog.className = 'relay-dialog';
  error.className = 'form-error';
  approvalNote.className = 'relay-approval-note';
  approvalNote.className = 'relay-approval-note';
  error.setAttribute('role', 'alert');
  const label = (text, input) => {
    const l = element('label', text);
    if (input === instructions) l.className = 'relay-instructions';
    if (input === continueTask) l.className = 'relay-check';
    l.append(input);
    return l;
  };
  for (const a of agents) {
    const o = element('option', a.name);
    o.value = a.id;
    agent.append(o);
  }
  continueTask.type = 'checkbox';
  instructions.maxLength = 8000;
  instructions.rows = 3;
  instructions.placeholder = '可选：明确下一位 Agent 应优先处理的工作';
  prepare.type = 'submit';
  close.type = refresh.type = 'button';
  let models = [],
    generation = 0,
    busy = false,
    loading = false,
    stateSignature = '',
    timer;
  const control = (text, fn, readOnly = false) => {
    const b = element('button', text);
    b.type = 'button';
    b.onclick = () =>
      readOnly
        ? Promise.resolve()
            .then(fn)
            .catch((e) => {
              error.textContent = e.message;
            })
        : perform(fn);
    return b;
  };
  const perform = async (fn) => {
    if (busy) return;
    busy = true;
    error.textContent = '';
    prepare.disabled = true;
    try {
      await fn();
      await reload();
      onChange();
    } catch (e) {
      error.textContent = e.message;
    } finally {
      busy = false;
      prepare.disabled = false;
    }
  };
  const post = (data) => api(`/sessions/${sessionId}/relay`, data);
  const drawEffort = () => {
    effort.replaceChildren(element('option', '沿用目标 Agent 默认'));
    effort.firstElementChild.value = '';
    const m = model.value === '' ? undefined : models[Number(model.value)];
    for (const e of m?.efforts || []) {
      const o = element('option', e.label);
      o.value = e.id;
      effort.append(o);
    }
    effort.disabled = !m?.efforts?.length;
  };
  const loadModels = async () => {
    const current = ++generation;
    prepare.disabled = true;
    error.textContent = '';
    approval.replaceChildren(element('option', '沿用目标 Agent 默认'));
    approval.firstElementChild.value = '';
    approval.disabled = true;
    approvalNote.textContent = '';
    model.replaceChildren(element('option', '正在读取目标模型…'));
    model.disabled = true;
    try {
      const data = await api(
        `/sessions/${sessionId}/relay-models?agent=${encodeURIComponent(agent.value)}`,
      );
      if (current !== generation || !dialog.open) return;
      models = data.models;
      approval.replaceChildren();
      for (const mode of data.approvalModes || []) {
        const option = element('option', mode.label);
        option.value = mode.id;
        option.dataset.description = mode.description;
        approval.append(option);
      }
      approval.value = data.defaultApprovalPolicy || 'native';
      approval.disabled = false;
      approval.onchange();
      model.replaceChildren(element('option', '沿用目标 Agent 默认'));
      model.firstElementChild.value = '';
      for (const [i, m] of models.entries()) {
        const o = element('option', m.label);
        o.value = String(i);
        model.append(o);
      }
      model.disabled = false;
      drawEffort();
    } catch (e) {
      if (current === generation) {
        error.textContent = e.message;
        model.replaceChildren(element('option', '模型读取失败'));
      }
    } finally {
      if (current === generation) prepare.disabled = busy;
    }
  };
  async function reload() {
    if (loading || !dialog.open) return;
    loading = true;
    try {
      const data = await api(`/sessions/${sessionId}/relay`);
      if (!dialog.open) return;
      const signature = JSON.stringify(data);
      if (signature === stateSignature) return;
      stateSignature = signature;
      list.replaceChildren();
      for (const stage of data.stages) {
        const section = element('section'),
          t = stage.transition;
        section.className = 'relay-stage';
        section.append(
          element(
            'h3',
            `阶段 ${stage.ordinal} · ${agentNames[stage.agent] || stage.agent}${stage.id === data.currentStageId ? ' · 当前' : ''}`,
          ),
          element(
            'p',
            `${labels[t?.phase] || stage.state} · ${stage.nativeId ? '原生上下文 ' + stage.nativeId : '原生上下文尚未启动'}`,
          ),
        );
        if (t?.error) section.append(element('p', t.error));
        if (stage.state === 'preparing' && stage.approval)
          section.append(
            element(
              'p',
              `目标审批：${stage.approval.label}。${stage.approval.description} 旧阶段授权不继承。`,
            ),
          );
        if (t?.inputReceipt)
          section.append(
            element(
              'p',
              `原生已受理交接输入 · ${t.inputReceipt.evidence} · ${new Date(t.inputReceipt.at).toLocaleString()}`,
            ),
          );
        else if (t?.phase === 'submitted')
          section.append(element('p', '此历史提交记录没有原生受理回执。'));
        if (t?.reportRead)
          section.append(
            element(
              'p',
              `报告全文已由框架提供 · v${t.reportRead.version} · 运行 ${t.reportRead.runId}；不代表模型已正确理解。`,
            ),
          );
        if (stage.stale) section.append(element('p', '预览后任务状态已变化，请取消并重新生成。'));
        if (stage.report) {
          const r = stage.report;
          section.append(element('p', `任务报告 v${r.version} · ${labels[r.state] || r.state}`));
          if (r.body) section.append(element('p', r.body.summary));
          if (r.warning) section.append(element('p', r.warning));
          if (r.state === 'ready')
            section.append(
              control(
                '查看完整任务报告',
                async () => {
                  const doc = await api(`/sessions/${sessionId}/reports/${r.id}/document`);
                  const details = element('details'),
                    summary = element('summary', `完整任务报告 · v${r.version}`),
                    pre = element('pre', doc.content);
                  details.open = true;
                  details.append(summary, pre);
                  documentPanel.replaceChildren(details);
                },
                true,
              ),
            );
        }
        if (stage.state === 'preparing') {
          const facts = element('input');
          facts.type = 'checkbox';
          if (stage.report?.quality === 'recorded_facts')
            section.append(label('我已核对事实版报告，接受资料缺失与未验证项', facts));
          const confirm = control(
            t?.continueTask ? '确认接力并继续任务' : '确认接力后等待输入',
            async () => {
              if (stage.report.quality !== 'generated' && !facts.checked)
                throw Error('请先核对并确认事实版报告');
              await post({ action: 'confirm', stageId: stage.id, acceptFacts: facts.checked });
            },
          );
          confirm.disabled = data.locked || stage.stale || stage.report?.state !== 'ready';
          section.append(
            confirm,
            control('取消接力预览', () => post({ action: 'cancel', stageId: stage.id })),
          );
        }
        if (stage.id === data.currentStageId && t?.phase === 'unconfirmed') {
          section.append(
            control('已核对原生历史：Agent 已收到资料', () =>
              post({ action: 'acknowledge-input', stageId: stage.id }),
            ),
            control('确认允许下一轮重新提交资料', async () => {
              if (
                window.confirm('重新提交可能重复发送交接资料。确认已核对原生历史，允许下一轮重试？')
              )
                await post({ action: 'retry-input', stageId: stage.id });
            }),
          );
        }
        if (t?.queue?.length) {
          const q = element('details');
          q.append(
            element(
              'summary',
              `接力队列：${t.queue.length} 条；${t.queue.filter((q) => q.state === 'unconfirmed').length} 条待核对`,
            ),
          );
          for (const item of t.queue)
            q.append(element('p', `${item.state} · ${item.message.text || '附件消息'}`));
          if (!data.locked)
            q.append(
              control('将未执行消息交给当前 Agent', () =>
                post({ action: 'resume-queue', stageId: stage.id }),
              ),
              control('核对后重试未知消息', async () => {
                if (
                  window.confirm(
                    '消息可能已执行过，重试可能重复操作。确认已核对记录，并交给当前 Agent？',
                  )
                )
                  await post({ action: 'retry-queue', stageId: stage.id });
              }),
              control('清理此队列', async () => {
                if (window.confirm('确认清理队列，不再执行这些消息？'))
                  await post({ action: 'dismiss-queue', stageId: stage.id });
              }),
            );
          section.append(q);
        }
        list.append(section);
      }
    } catch (e) {
      error.textContent = e.message;
    } finally {
      loading = false;
    }
  }
  form.append(
    label('目标 Agent', agent),
    label('模型', model),
    label('思考深度', effort),
    label('目标审批策略', approval),
    approvalNote,
    label('接续要求', instructions),
    label('报告确认后立即继续任务（不选则等待输入）', continueTask),
    prepare,
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    void perform(async () => {
      const m = model.value === '' ? undefined : models[Number(model.value)];
      await post({
        action: 'prepare',
        agent: agent.value,
        key: relayKey(),
        continueTask: continueTask.checked,
        instructions: instructions.value,
        ...(approval.value ? { approvalPolicy: approval.value } : {}),
        ...(m
          ? {
              settings: {
                model: m.id,
                ...(m.provider ? { provider: m.provider } : {}),
                ...(effort.value ? { effort: effort.value } : {}),
              },
            }
          : {}),
      });
    });
  };
  agent.onchange = () => void loadModels();
  approval.onchange = () => {
    approvalNote.textContent = approval.selectedOptions[0]?.dataset.description || '';
  };
  model.onchange = drawEffort;
  close.onclick = () => dialog.close();
  refresh.onclick = () => void reload();
  dialog.append(
    title,
    note,
    element('p', `Session：${sessionId}`),
    error,
    form,
    refresh,
    list,
    documentPanel,
    close,
  );
  document.body.append(dialog);
  dialog.showModal();
  void loadModels();
  void reload();
  timer = setInterval(() => void reload(), 1200);
  dialog.addEventListener(
    'close',
    () => {
      clearInterval(timer);
      generation++;
      dialog.remove();
    },
    { once: true },
  );
  return dialog;
}
