const $ = (id) => document.getElementById(id);
const done = new Set(['complete', 'cancelled', 'expired', 'error']);
let token =
  new URLSearchParams(location.hash.slice(1)).get('token') ||
  sessionStorage.getItem('tab-ai-token') ||
  '';
if (location.hash) history.replaceState(null, '', location.pathname);
if (token) sessionStorage.setItem('tab-ai-token', token);
let info,
  current,
  polling = false,
  starting = false;
const textNode = (tag, text) => {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
};
function error(value) {
  $('setup-error').textContent = value.message || String(value);
  $('setup-error').hidden = false;
}
const safe =
  (fn) =>
  (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch(error);
async function api(path = '', data) {
  const response = await fetch(`/api/setup${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (response.status === 401 && !$('auth-dialog').open) $('auth-dialog').showModal();
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '连接失败');
  return value;
}
function form() {
  const type = $('platform').value,
    mode = $('method').value,
    manual = mode === 'manual';
  $('domain-label').hidden = type !== 'lark' || mode.startsWith('draft:');
  $('manual-fields').hidden = !manual;
  $('qr-intro').hidden = mode !== 'qr';
  $('qr-intro').textContent =
    type === 'wechat'
      ? '使用微信扫描二维码，在手机确认登录；如要求验证码，按向导输入即可。无需填写 App ID 或 Secret。'
      : type === 'wecom'
        ? '使用企业微信扫码并在手机确认，自动获取 Bot ID 和 Secret；无需手工复制。授权后私聊机器人完成收发验证。'
        : '使用飞书官方授权流程创建新应用。下一步会显示二维码和链接，在手机或电脑上确认即可取得凭证。';
  $('credential-id').required = manual;
  $('credential-secret').required = manual;
  $('card-template-label').hidden = type !== 'dingtalk';
  $('credential-id-label').textContent =
    type === 'wecom' ? 'Bot ID' : type === 'dingtalk' ? 'Client ID / AppKey' : 'App ID';
  $('credential-secret-label').textContent =
    type === 'wecom' ? 'Secret' : type === 'dingtalk' ? 'Client Secret / AppSecret' : 'App Secret';
  $('begin').textContent =
    mode === 'qr'
      ? type === 'wechat'
        ? '微信扫码登录 ↗'
        : '扫码创建并接入 ↗'
      : mode.startsWith('draft:')
        ? '继续未完成配置 ↗'
        : '验证并接入 ↗';
  if (info) {
    $('guide-steps').replaceChildren(
      ...info.guides[type].steps.map((step) => textNode('li', step)),
    );
    $('platform-link').href =
      type === 'lark' && $('domain').value === 'lark'
        ? 'https://open.larksuite.com/app'
        : info.guides[type].url;
  }
}
function methods() {
  const type = $('platform').value;
  const choices = [];
  for (const draft of info?.drafts || [])
    if (draft.type === type)
      choices.push([`draft:${draft.id}`, `继续未完成配置 · ${draft.credentialId}`]);
  if (type === 'wecom') choices.push(['qr', '企业微信扫码创建 / 授权（推荐）']);
  if (type === 'lark') choices.push(['qr', '扫码创建新机器人（推荐）']);
  if (type === 'wechat') choices.push(['qr', '微信扫码登录']);
  else choices.push(['manual', '已有机器人，填写凭证']);
  $('method').replaceChildren(
    ...choices.map(([value, label]) => {
      const e = textNode('option', label);
      e.value = value;
      return e;
    }),
  );
  form();
}
function render() {
  if (!current) return;
  const finished = done.has(current.phase),
    pairing = ['pairing', 'testing', 'paired', 'saving', 'complete'].includes(current.phase);
  $('setup-form-section').hidden = true;
  $('setup-progress').hidden = false;
  $('step-one').className = '';
  $('step-two').className = pairing ? '' : 'current';
  $('step-three').className = pairing ? 'current' : '';
  $('phase').textContent = finished
    ? 'CONNECTION STATUS'
    : pairing
      ? 'PAIR YOUR ACCOUNT'
      : 'AUTHORIZE & CONNECT';
  const titles = {
    authorizing: '在手机上确认授权',
    checking: '正在验证机器人',
    pairing: '连接你的聊天账号',
    testing: '正在验证回传消息',
    paired: '双向收发验证成功',
    saving: '正在保存',
    complete: '机器人已接入',
    cancelled: '接入已取消',
    expired: '接入已超时',
    error: '接入尚未完成',
  };
  $('progress-title').textContent = titles[current.phase];
  $('progress-message').textContent = current.message;
  $('authorization').hidden = !current.url;
  if (current.url) $('authorization-link').href = current.url;
  $('auth-qr').hidden = !current.qrDataUrl;
  if (current.qrDataUrl) $('auth-qr').src = current.qrDataUrl;
  else $('auth-qr').removeAttribute('src');
  $('setup-permission').hidden = !current.permission;
  if (current.permission) {
    $('setup-permission-link').href = current.permission.url;
    $('setup-permission-qr').src = current.permission.qrDataUrl;
  }
  $('verify-form').hidden = !current.needsVerifyCode;
  $('pairing').hidden = current.phase !== 'pairing' || !current.pairCommand;
  $('pair-command').textContent = current.pairCommand || '';
  $('identity').hidden = current.phase !== 'paired';
  $('paired-user').textContent = current.candidate
    ? `机器人：${current.name || current.type}\n绑定账号：${current.candidate.sender}`
    : '';
  $('deadline').textContent = finished
    ? ''
    : `本次步骤有效期至 ${new Date(current.expiresAt).toLocaleTimeString()}`;
  $('cancel-setup').hidden = finished;
  $('restart-setup').hidden = !finished || current.phase === 'complete';
  $('finish-setup').hidden = current.phase !== 'complete';
}
async function bootstrap() {
  info = await api();
  methods();
  if (info.current && !done.has(info.current.phase)) {
    current = info.current;
    render();
  }
}
$('platform').onchange = () => {
  $('credential-id').value = '';
  $('credential-secret').value = '';
  methods();
};
$('method').onchange = form;
$('domain').onchange = form;
$('setup-form').onsubmit = (event) => {
  event.preventDefault();
  void safe(async () => {
    if (starting) return;
    starting = true;
    $('begin').disabled = true;
    $('setup-error').hidden = true;
    try {
      const method = $('method').value;
      let data = {
        manager: $('bot-role').value === 'manager',
        type: $('platform').value,
        domain: $('domain').value,
        mode: method,
      };
      if (method.startsWith('draft:')) data = { ...data, mode: 'draft', draftId: method.slice(6) };
      if (method === 'manual')
        data = {
          ...data,
          credentialId: $('credential-id').value,
          credentialSecret: $('credential-secret').value,
        };
      if (method === 'manual' && data.type === 'dingtalk' && $('card-template-id').value.trim())
        data.cardTemplateId = $('card-template-id').value.trim();
      current = await api('/start', data);
      $('credential-secret').value = '';
      render();
    } finally {
      starting = false;
      $('begin').disabled = false;
    }
  })();
};
$('verify-form').onsubmit = (event) => {
  event.preventDefault();
  void safe(async () => {
    $('submit-verify').disabled = true;
    try {
      current = await api(`/${current.id}/verify`, { code: $('verify-code').value.trim() });
      $('verify-code').value = '';
      render();
    } finally {
      $('submit-verify').disabled = false;
    }
  })();
};
$('confirm-pair').onclick = safe(async () => {
  $('confirm-pair').disabled = true;
  try {
    current = await api(`/${current.id}/confirm`, {});
    render();
  } finally {
    $('confirm-pair').disabled = false;
  }
});
$('cancel-setup').onclick = safe(async () => {
  current = await api(`/${current.id}/cancel`, {});
  render();
});
$('restart-setup').onclick = safe(async () => {
  current = undefined;
  info = await api();
  methods();
  $('setup-form-section').hidden = false;
  $('setup-progress').hidden = true;
  $('setup-error').hidden = true;
  $('step-one').className = 'current';
  $('step-two').className = '';
  $('step-three').className = '';
});
$('copy-pair').onclick = safe(async () => {
  await navigator.clipboard.writeText(current.pairCommand);
  $('copy-pair').textContent = '已复制';
});
$('auth-form').onsubmit = (event) => {
  event.preventDefault();
  token = $('token-input').value.trim();
  sessionStorage.setItem('tab-ai-token', token);
  $('auth-dialog').close();
  $('setup-error').hidden = true;
  void safe(bootstrap)();
};
if (token) void safe(bootstrap)();
else $('auth-dialog').showModal();
setInterval(() => {
  if (!current || done.has(current.phase) || polling || document.hidden) return;
  polling = true;
  void api(`/${current.id}`)
    .then((value) => {
      current = value;
      render();
    })
    .catch(error)
    .finally(() => {
      polling = false;
    });
}, 1200);
