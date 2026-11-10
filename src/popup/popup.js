import {
  clearClipboard,
  copyText,
  formatDateTime,
  makeToast,
  send,
} from '../lib/client.js';
import {
  hostFromUrl,
  isHostIsolated,
  normalizeHost,
  normalizePort,
  parseHttpUrl,
  suggestBaseDomain,
} from '../lib/domain.js';
import { generatePassword } from '../lib/generator.js';
import { passwordStrength } from '../lib/crypto.js';

const $ = (id) => document.getElementById(id);
const toast = makeToast($('toast'));

const ICON = {
  key: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.5 3a6.5 6.5 0 0 0-6.2 8.5L3 16.8V21h4.2l1.2-1.2v-2.3h2.3l1.2-1.2V15l1.4-.7A6.5 6.5 0 1 0 14.5 3Zm2.4 4.6a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 3h9a3 3 0 0 1 3 3v11h-2V6a1 1 0 0 0-1-1H8V3Zm-2 4h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm0 2v10h9V9H6Z"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.2 0-7.5 2.1-7.5 4.8V21h15v-2.2C19.5 16.1 16.2 14 12 14Z"/></svg>',
};

const state = {
  host: '',
  port: '',
  tabId: null,
  initialized: false,
  locked: true,
  settings: {},
  matches: [],
  pending: [],
  siteKey: '',
  isolated: false,
  stats: null,
};

const views = {
  loading: $('loadingView'),
  setup: $('setupView'),
  locked: $('lockedView'),
  vault: $('vaultView'),
};

function setView(name) {
  for (const [key, element] of Object.entries(views)) {
    element.hidden = key !== name;
  }
  document.body.dataset.view = name;
  document.querySelector('.app')?.classList.toggle('is-vault', name === 'vault');
}

function applyTheme(theme = 'system') {
  const value = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  if (value === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = value;
  }
}

function applyMaterial(material = 'solid') {
  document.documentElement.dataset.material = ['solid', 'glass', 'liquid'].includes(material)
    ? material
    : 'solid';
}

function setError(element, message) {
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

function scoreColor(score) {
  return ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#15803d'][score] || '#94a3b8';
}

function updateStrength(input, bar, text) {
  if (!input || !bar || !text) return;
  const value = input.value;
  if (!value) {
    bar.style.width = '0%';
    text.textContent = '未输入';
    return;
  }
  const result = passwordStrength(value);
  bar.style.width = `${[10, 30, 55, 78, 100][result.score]}%`;
  bar.style.background = scoreColor(result.score);
  text.textContent = result.label;
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label || '处理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

async function init() {
  bindEvents();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  state.tabId = tab?.id ?? null;
  state.host = hostFromUrl(tab?.url || '');
  try {
    state.port = new URL(tab?.url || '').port || '';
  } catch {
    state.port = '';
  }
  await refresh();
}

async function refresh() {
  setView('loading');
  const result = await send('SV_POPUP_STATE', { host: state.host, port: state.port });
  if (!result.ok) {
    state.initialized = true;
    state.locked = true;
    setView('locked');
    $('lockBtn').hidden = true;
    setError($('unlockError'), result.error || '无法读取密码库');
    return;
  }

  state.initialized = Boolean(result.initialized);
  state.locked = Boolean(result.locked);
  state.settings = result.settings || {};
  applyTheme(state.settings.theme);
  applyMaterial(state.settings.material);

  if (!state.initialized) {
    $('lockBtn').hidden = true;
    setView('setup');
    $('syncImportPrompt').hidden = true;
    $('syncImportForm').hidden = true;
    $('setupForm').hidden = true;
    void detectPopupImport();
    return;
  }

  if (state.locked) {
    $('lockBtn').hidden = true;
    setView('locked');
    const minutes = Number(state.settings.autoLockMinutes);
    $('autoLockHint').textContent =
      Number.isFinite(minutes) && minutes > 0
        ? `空闲 ${minutes} 分钟后自动锁定；主密码只在本机使用。`
        : '浏览器关闭前保持解锁；主密码只在本机使用。';
    setError($('unlockError'), '');
    $('unlockPassword').focus();
    return;
  }

  $('lockBtn').hidden = false;
  state.matches = Array.isArray(result.matches) ? result.matches : [];
  state.pending = Array.isArray(result.pending) ? result.pending : [];
  state.siteKey = result.siteKey || '';
  state.isolated = Boolean(result.isolated);
  state.stats = result.stats || null;
  renderVault();
  setView('vault');
}

async function detectPopupImport() {
  const status = await send('SV_SYNC_STATUS');
  if (state.initialized) return;
  if (status.ok && status.exists) {
    $('syncImportPrompt').hidden = false;
    $('setupForm').hidden = true;
    $('syncImportChoose').focus();
    return;
  }
  $('setupForm').hidden = false;
  $('setupPassword').focus();
}

function setSyncPromptDismissed(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ syncPromptDismissed: Boolean(value) }, resolve);
  });
}

async function importPopupVault() {
  const password = $('syncImportPassword').value;
  if (!password) {
    setError($('syncImportError'), '请输入已有密码库的主密码');
    return;
  }
  const button = $('syncImportConfirm');
  setBusy(button, true, '导入中…');
  const result = await send('SV_SYNC_IMPORT', { password });
  setBusy(button, false);
  if (!result.ok) {
    setError($('syncImportError'), result.error || '导入失败');
    return;
  }
  await setSyncPromptDismissed(false);
  $('syncImportPassword').value = '';
  await refresh();
}

async function refreshPopupSync() {
  const banner = $('syncBanner');
  if (!banner) return;
  if (!state.stats) {
    banner.hidden = true;
    return;
  }
  const dismissed = await new Promise((resolve) => {
    chrome.storage.local.get('syncPromptDismissed', (value) =>
      resolve(Boolean(value?.syncPromptDismissed)),
    );
  });
  if (dismissed) {
    banner.hidden = true;
    return;
  }
  const result = await send('SV_SYNC_STATUS');
  banner.hidden = !result.ok || !result.exists || Number(state.stats.total) > 0;
}

async function syncPopupExisting() {
  const password = window.prompt(
    '检测到本机已有 SubVault 密码库。\n同步会使用已有密码库的主密码；当前新密码库为空，同步后当前主密码将被替换。\n请输入浏览器 A 的主密码：',
  );
  if (!password) return;
  const button = $('syncPullBtn');
  setBusy(button, true, '同步中…');
  const result = await send('SV_SYNC_PULL', { password });
  setBusy(button, false);
  if (!result.ok) {
    window.alert(result.error || '同步失败');
    return;
  }
  await refresh();
}

function renderVault() {
  const host = state.host;
  const displayHost = state.port ? `${host}:${state.port}` : host;
  $('siteHost').textContent = host ? displayHost : '当前页面不支持填充';
  $('siteAvatar').textContent = host ? host.charAt(0).toUpperCase() : '—';
  void refreshPopupSync();

  if (!host) {
    $('siteMode').textContent = '打开 http/https 网页后可使用自动填充';
  } else if (state.isolated) {
    $('siteMode').textContent = `独立子域 · ${displayHost} 的账号不与其他子域共享`;
  } else {
    $('siteMode').textContent = `主域共享 · ${
      state.siteKey || suggestBaseDomain(host)
    } 下所有子域共用`;
  }

  $('matchCount').textContent = host ? `${state.matches.length} 个账号` : '';
  renderPending();
  renderMatches();
}

function renderPending() {
  const container = $('pendingList');
  container.replaceChildren();
  for (const item of state.pending) {
    const card = document.createElement('div');
    card.className = 'pending-card';

    const title = document.createElement('div');
    title.className = 'pending-title';
    title.textContent = item.existing ? '要更新这次登录的密码吗？' : '保存这次登录？';

    const sub = document.createElement('div');
    sub.className = 'pending-sub';
    sub.textContent = `${item.username || '无用户名'} · ${item.host}${
      item.createdAt ? ` · ${formatDateTime(item.createdAt)}` : ''
    }`;

    const actions = document.createElement('div');
    actions.className = 'pending-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn primary';
    save.textContent = '保存';
    save.addEventListener('click', () => void savePending(item.id, save));
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn';
    dismiss.textContent = '忽略';
    dismiss.addEventListener('click', () => void dismissPending(item.id));
    actions.append(save, dismiss);

    card.append(title, sub, actions);
    container.appendChild(card);
  }
}

function renderMatches() {
  const container = $('matchList');
  container.replaceChildren();
  $('emptyMatches').hidden = state.matches.length > 0 || !state.host;

  for (const entry of state.matches) {
    const row = document.createElement('div');
    row.className = 'entry-row';

    const avatar = document.createElement('div');
    avatar.className = 'entry-avatar';
    avatar.textContent = (entry.title || entry.host || '?').trim().charAt(0).toUpperCase() || '?';

    const body = document.createElement('div');
    body.className = 'entry-body';
    const title = document.createElement('div');
    title.className = 'entry-title';
    title.textContent = entry.title || entry.host;
    const user = document.createElement('div');
    user.className = 'entry-user';
    user.textContent = entry.username || '无用户名';
    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    const bits = [`记录于 ${formatDateTime(entry.passwordChangedAt)}`];
    if (entry.host !== state.host) bits.push(`来自 ${entry.host}`);
    meta.textContent = bits.join(' · ');
    body.append(title, user, meta);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const fill = iconButton(ICON.key, '填充到当前页面', 'fill');
    fill.disabled = !state.tabId || !state.host;
    fill.addEventListener('click', () => void fillEntry(entry.id));
    const copyUser = iconButton(ICON.user, '复制用户名');
    copyUser.addEventListener('click', () => void copyValue(entry.username, '用户名已复制'));
    const copyPasswordButton = iconButton(ICON.copy, '复制密码');
    copyPasswordButton.addEventListener('click', () => {
      try {
        void copyEntryPassword(entry.id).catch((error) => {
          toast(error?.message || '复制密码失败', { error: true });
        });
      } catch (error) {
        toast(error?.message || '复制密码失败', { error: true });
      }
    });
    actions.append(fill, copyUser, copyPasswordButton);

    row.append(avatar, body, actions);
    container.appendChild(row);
  }
}

function iconButton(svg, title, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-btn ${extraClass}`.trim();
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = svg;
  return button;
}

async function savePending(id, button) {
  const pending = state.pending.find((item) => item.id === id);
  setBusy(button, true, '保存中…');
  const result = await send('SV_SAVE_PENDING', { id });
  if (!result.ok) {
    setBusy(button, false);
    toast(result.error || '保存失败', { error: true });
    return;
  }
  const account = pending?.username || '当前账号';
  const action = result.updated ? '更新' : '新增';
  toast(account, `已${action}账号 · ${pending?.host || state.host}`);
  await refresh();
}

async function dismissPending(id) {
  const result = await send('SV_DISMISS_PENDING', { id });
  if (!result.ok) toast(result.error || '操作失败', { error: true });
  await refresh();
}

async function fillEntry(id) {
  if (!state.tabId) {
    toast('当前页面不支持填充');
    return;
  }
  try {
    const result = await new Promise((resolve) => {
      chrome.tabs.sendMessage(state.tabId, { type: 'SV_FILL_BY_ID', id }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });
    if (!result.ok) {
      toast(result.error || '填充失败，请刷新页面后重试', { error: true });
      return;
    }
    const entry = state.matches.find((item) => item.id === id);
    toast(entry?.username || entry?.title || '当前账号', '已填入账号');
    setTimeout(() => window.close(), 320);
  } catch (error) {
    toast(error?.message || '填充失败', { error: true });
  }
}

async function copyEntryPassword(id) {
  try {
    const result = await send('SV_GET_SECRET', { id });
    if (!result.ok) {
      toast(result.error || '无法读取密码', { error: true });
      return;
    }
    await copyValue(result.password, '密码已复制');
  } catch (error) {
    toast(error?.message || '复制密码失败', { error: true });
  }
}

async function copyValue(value, message) {
  if (!value) {
    toast('内容为空');
    return;
  }
  try {
    const ok = await copyText(value, {
      clearAfterSeconds: Number(state.settings.clipboardClearSeconds) || 0,
    });
    toast(ok ? message : '复制失败，请手动选择', { error: !ok });
  } catch (error) {
    toast(error?.message || '复制失败，请手动选择', { error: true });
  }
}

function updateEntryPolicyHint() {
  const host = normalizeHost($('entryHost').value);
  const hint = $('entryPolicyHint');
  if (!host) {
    hint.textContent = '输入完整域名后显示匹配规则';
    return;
  }
  const isolatedDomains = Array.isArray(state.settings?.isolatedDomains)
    ? state.settings.isolatedDomains
    : [];
  if (isHostIsolated(host, isolatedDomains)) {
    hint.textContent = `独立子域：账号只匹配 ${host}，不会与同主域的其他子域共享。`;
  } else {
    hint.textContent = `主域共享：${suggestBaseDomain(host)} 下的所有子域共用这个账号。`;
  }
}

function openEntryDialog() {
  setError($('entryError'), '');
  $('entryHost').value = state.host
    ? `${state.host}${state.port ? `:${state.port}` : ''}`
    : '';
  $('entryTitle').value = '';
  $('entryUsername').value = '';
  $('entryPassword').value = '';
  $('entryPassword').type = 'password';
  $('entryReveal').textContent = '显示';
  $('entryNotes').value = '';
  updateStrength($('entryPassword'), $('entryStrengthBar'), $('entryStrengthText'));
  updateEntryPolicyHint();
  $('entryDialog').showModal();
  setTimeout(() => {
    if (state.host) $('entryUsername').focus();
    else $('entryHost').focus();
  }, 40);
}

async function saveEntry() {
  setError($('entryError'), '');
  const rawHost = $('entryHost').value.trim();
  const parsedHost = parseHttpUrl(rawHost) || parseHttpUrl(`https://${rawHost}`);
  const host = normalizeHost(parsedHost?.hostname || rawHost);
  if (!host) {
    setError($('entryError'), '请输入有效的网站域名，例如 example.com');
    return;
  }
  const port = normalizePort(parsedHost?.port || '');
  const password = $('entryPassword').value;
  if (!password) {
    setError($('entryError'), '密码不能为空');
    return;
  }
  const button = $('entrySave');
  setBusy(button, true, '保存中…');
  const result = await send('SV_ADD_ENTRY', {
    entry: {
      host,
      port,
      title: $('entryTitle').value.trim(),
      username: $('entryUsername').value.trim(),
      password,
      notes: $('entryNotes').value,
      url: parsedHost?.href || `https://${host}${port ? `:${port}` : ''}/`,
    },
  });
  setBusy(button, false);
  if (!result.ok) {
    setError($('entryError'), result.error || '保存失败');
    return;
  }
  $('entryDialog').close();
  toast(result.updated ? '已更新现有账号' : '账号已保存');
  await refresh();
}

async function setupVault() {
  setError($('setupError'), '');
  const password = $('setupPassword').value;
  const confirm = $('setupConfirm').value;
  if (password.length < 10) {
    setError($('setupError'), '主密码至少需要 10 个字符');
    return;
  }
  if (password !== confirm) {
    setError($('setupError'), '两次输入的主密码不一致');
    return;
  }
  if (!$('setupAck').checked) {
    setError($('setupError'), '请确认你已了解主密码无法找回');
    return;
  }
  const button = $('setupBtn');
  setBusy(button, true, '正在创建加密密码库…');
  const result = await send('SV_SETUP', { password });
  setBusy(button, false);
  if (!result.ok) {
    setError($('setupError'), result.error || '创建失败');
    return;
  }
  $('setupPassword').value = '';
  $('setupConfirm').value = '';
  updateStrength($('setupPassword'), $('setupStrengthBar'), $('setupStrengthText'));
  toast('密码库已创建，数据仅保存在本机');
  await refresh();
}

async function unlockVault() {
  setError($('unlockError'), '');
  const password = $('unlockPassword').value;
  if (!password) {
    setError($('unlockError'), '请输入主密码');
    return;
  }
  const button = $('unlockBtn');
  setBusy(button, true, '正在解锁…');
  const result = await send('SV_UNLOCK', { password });
  setBusy(button, false);
  if (!result.ok) {
    setError($('unlockError'), result.error || '解锁失败');
    $('unlockPassword').select();
    return;
  }
  $('unlockPassword').value = '';
  await refresh();
}

function bindRevealButtons() {
  document.querySelectorAll('.reveal[data-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = $(button.dataset.target);
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.textContent = reveal ? '隐藏' : '显示';
    });
  });
}

function bindEvents() {
  bindRevealButtons();

  $('unlockBtn').addEventListener('click', () => void unlockVault());
  $('unlockPassword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void unlockVault();
  });

  $('setupBtn').addEventListener('click', () => void setupVault());
  $('syncImportChoose').addEventListener('click', () => {
    $('syncImportPrompt').hidden = true;
    $('syncImportForm').hidden = false;
    setError($('syncImportError'), '');
    $('syncImportPassword').focus();
  });
  $('syncNewInstall').addEventListener('click', async () => {
    await setSyncPromptDismissed(true);
    $('syncImportPrompt').hidden = true;
    $('syncImportForm').hidden = true;
    $('setupForm').hidden = false;
    $('setupPassword').focus();
  });
  $('syncImportBack').addEventListener('click', () => {
    $('syncImportForm').hidden = true;
    $('syncImportPrompt').hidden = false;
    setError($('syncImportError'), '');
  });
  $('syncImportConfirm').addEventListener('click', () => void importPopupVault());
  $('syncPullBtn').addEventListener('click', () => void syncPopupExisting());
  $('setupPassword').addEventListener('input', () => {
    updateStrength($('setupPassword'), $('setupStrengthBar'), $('setupStrengthText'));
  });
  $('setupPassword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void setupVault();
  });
  $('setupConfirm').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void setupVault();
  });

  $('lockBtn').addEventListener('click', async () => {
    await send('SV_LOCK');
    toast('密码库已锁定');
    await refresh();
  });

  $('settingsBtn').addEventListener('click', () => openOptions());
  $('manageBtn').addEventListener('click', () => openOptions());
  $('siteSettingsBtn').addEventListener('click', () => openOptions('#domains'));
  $('addBtn').addEventListener('click', openEntryDialog);
  $('clearClipboardBtn').addEventListener('click', async () => {
    const ok = await clearClipboard();
    toast(ok ? '剪贴板已清空' : '无法清空剪贴板，请手动覆盖', { error: !ok });
  });

  $('entryClose').addEventListener('click', () => $('entryDialog').close());
  $('entryCancel').addEventListener('click', () => $('entryDialog').close());
  $('entryDialog').addEventListener('click', (event) => {
    if (event.target === $('entryDialog')) $('entryDialog').close();
  });
  $('entryDialog').addEventListener('close', () => {
    $('entryPassword').value = '';
    $('entryNotes').value = '';
    $('entryPassword').type = 'password';
    $('entryReveal').textContent = '显示';
  });
  $('entrySave').addEventListener('click', () => void saveEntry());
  $('entryHost').addEventListener('input', updateEntryPolicyHint);
  $('entryPassword').addEventListener('input', () => {
    updateStrength($('entryPassword'), $('entryStrengthBar'), $('entryStrengthText'));
  });
  $('entryGenerate').addEventListener('click', () => {
    $('entryPassword').value = generatePassword({ length: 20 });
    $('entryPassword').type = 'text';
    $('entryReveal').textContent = '隐藏';
    updateStrength($('entryPassword'), $('entryStrengthBar'), $('entryStrengthText'));
  });
  $('entryReveal').addEventListener('click', () => {
    const input = $('entryPassword');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('entryReveal').textContent = reveal ? '隐藏' : '显示';
  });
  $('entryDialog').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
      event.preventDefault();
      void saveEntry();
    }
  });
}

function openOptions(hash = '') {
  const url = chrome.runtime.getURL(`src/options/options.html${hash}`);
  chrome.tabs.create({ url });
  window.close();
}

void init();
