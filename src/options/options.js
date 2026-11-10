import {
  clearClipboard,
  copyText,
  downloadText,
  formatDateTime,
  formatRelative,
  isLockedError,
  makeToast,
  send,
} from '../lib/client.js';
import {
  isHostIsolated,
  isValidHost,
  normalizeHost,
  normalizePort,
  parseHttpUrl,
  siteKeyFor,
  suggestBaseDomain,
} from '../lib/domain.js';
import { generatePassword } from '../lib/generator.js';
import { passwordStrength } from '../lib/crypto.js';

const $ = (id) => document.getElementById(id);
const toast = makeToast($('toast'));

const PAGE_META = {
  vault: ['密码库', '管理本机保存的登录账号与密码。'],
  transfer: ['导入与导出', '从浏览器迁移密码，或创建加密备份。'],
  domains: ['子域规则', '默认按主域共享；可指定独立主域，让每个子域完全隔离。'],
  security: ['安全与接管', '自动锁定、Chrome 密码管理器接管与主密码管理。'],
  about: ['关于', 'SubVault 的本地安全模型与权限说明。'],
};

const state = {
  initialized: false,
  locked: true,
  loaded: false,
  loadingAll: false,
  entries: [],
  stats: null,
  settings: {
    autoLockMinutes: 15,
    autoFill: false,
    autoOpenOnFocus: false,
    savePrompt: true,
    savePromptPosition: 'top-right',
    theme: 'system',
    material: 'solid',
    showIcon: true,
    takeoverMode: true,
    clearNativeAutofill: true,
    disableChromeSavePrompt: false,
    isolatedDomains: [],
    siteExceptions: {},
    portIsolation: false,
  },
  takeover: null,
  usage: null,
  section: 'vault',
  search: '',
  filter: 'all',
  sort: 'host',
  limit: 200,
  editingId: null,
  backupText: '',
  backupName: '',
  pendingImport: null,
  dangerMode: '',
  revealTimers: new Map(),
};

function div(className, text) {
  const element = document.createElement('div');
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function span(className, text) {
  const element = document.createElement('span');
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setError(element, message) {
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
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

function scoreColor(score) {
  return ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#15803d'][score] || '#94a3b8';
}

function updateStrength(input, bar, text) {
  if (!input || !bar || !text) return;
  if (!input.value) {
    bar.style.width = '0%';
    text.textContent = '未输入';
    return;
  }
  const result = passwordStrength(input.value);
  bar.style.width = `${[10, 30, 55, 78, 100][result.score]}%`;
  bar.style.background = scoreColor(result.score);
  text.textContent = result.label;
}

function updateLockUi() {
  $('lockDot').classList.toggle('locked', state.locked);
  $('lockState').textContent = !state.initialized
    ? '未创建'
    : state.locked
      ? '已锁定'
      : '已解锁';
  $('lockNow').hidden = state.locked || !state.initialized;
}

function showGate(mode = 'unlock') {
  state.locked = true;
  state.loaded = false;
  document.body.classList.remove('booting');
  if ($('entryDialog').open) $('entryDialog').close();
  if ($('dangerDialog').open) $('dangerDialog').close();
  for (const timer of state.revealTimers.values()) clearTimeout(timer);
  state.revealTimers.clear();
  state.entries = [];
  state.stats = null;
  $('vaultList').replaceChildren();
  $('vaultEmpty').hidden = true;
  $('shell').hidden = true;
  updateLockUi();

  const setup = mode === 'setup';
  $('gate').hidden = false;
  $('gateTitle').textContent = setup ? '创建本地密码库' : '解锁 SubVault';
  $('gateSub').textContent = setup
    ? '设置一个主密码。它只在本机用于加密，忘记后无法找回。'
    : '输入主密码以管理本机密码库。';
  $('gateUnlockForm').hidden = setup;
  $('gateSetupForm').hidden = true;
  $('gateImportPrompt').hidden = true;
  $('gateImportForm').hidden = true;
  setError($('gateError'), '');
  $('gatePassword').value = '';
  $('gateImportPassword').value = '';
  if (setup) {
    $('gateNewPassword').value = '';
    $('gateConfirmPassword').value = '';
    $('gateAck').checked = false;
    void detectGateImport();
    return;
  }
  setTimeout(() => {
    $('gatePassword').focus();
  }, 60);
}

async function detectGateImport() {
  const status = await send('SV_SYNC_STATUS');
  if (state.initialized) return;
  if (status.ok && status.exists) {
    $('gateTitle').textContent = '发现本机已有密码库';
    $('gateSub').textContent = '选择导入已有密码库，或创建全新的本地密码库。';
    $('gateImportPrompt').hidden = false;
    $('gateSetupForm').hidden = true;
    $('gateImportChoose').focus();
    return;
  }
  $('gateTitle').textContent = '创建本地密码库';
  $('gateSub').textContent = '设置一个主密码。它只在本机用于加密，忘记后无法找回。';
  $('gateImportPrompt').hidden = true;
  $('gateSetupForm').hidden = false;
  $('gateNewPassword').focus();
}

function setSyncPromptDismissed(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ syncPromptDismissed: Boolean(value) }, resolve);
  });
}

function hideGate() {  document.body.classList.remove('booting');
  state.locked = false;
  $('gate').hidden = true;
  $('shell').hidden = false;
  updateLockUi();
}

function handleError(result, fallback = '操作失败') {
  if (!result || result.ok) return false;
  if (isLockedError(result.error)) {
    showGate('unlock');
    return true;
  }
  toast(result.error || fallback, { error: true });
  return true;
}

async function loadSettings() {
  const result = await send('SV_GET_SETTINGS');
  if (result.ok && result.settings) {
    state.settings = {
      ...state.settings,
      ...result.settings,
      isolatedDomains: Array.isArray(result.settings.isolatedDomains)
        ? result.settings.isolatedDomains
        : [],
    };
    applySettings();
  }
}

async function refreshSyncBanner() {
  const banner = $('syncBanner');
  if (!banner) return;
  if (!state.initialized || state.locked) {
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
  banner.hidden = !result.ok || !result.exists || state.entries.length > 0;
}

async function syncPullExisting() {
  const password = window.prompt(
    '检测到本机已有 SubVault 密码库。\n\n同步会使用已有密码库的主密码；当前新密码库为空，同步后当前主密码将被替换。\n请输入浏览器 A 的主密码：',
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
  toast(`已同步 ${result.count} 个账号；请使用浏览器 A 的主密码解锁`);
  await loadAll();
}

async function loadAll() {
  if (state.loadingAll) return;
  state.loadingAll = true;
  try {
    const [entriesResult, settingsResult, takeoverResult, usageResult] = await Promise.all([
      send('SV_LIST_ENTRIES'),
      send('SV_GET_SETTINGS'),
      send('SV_GET_TAKEOVER_STATUS'),
      send('SV_GET_USAGE'),
    ]);

    if (!entriesResult.ok) {
      handleError(entriesResult, '无法读取密码库');
      return;
    }
    if (state.locked) return;

    state.entries = Array.isArray(entriesResult.entries) ? entriesResult.entries : [];
    state.stats = entriesResult.stats || null;
    if (settingsResult.ok && settingsResult.settings) {
      state.settings = {
        ...state.settings,
        ...settingsResult.settings,
        isolatedDomains: Array.isArray(settingsResult.settings.isolatedDomains)
          ? settingsResult.settings.isolatedDomains
          : [],
      };
    }
    state.takeover = takeoverResult.ok ? takeoverResult.status : { supported: false };
    state.usage = usageResult.ok ? usageResult : null;
    state.loaded = true;
    state.locked = false;
    state.initialized = true;
    updateLockUi();
    applySettings();
    renderStats();
    renderVault();
    renderDomains();
    renderExceptions();
    renderPreview();
    renderTakeover();
    renderUsage();
    void refreshClipboardPermission();
    void refreshSyncBanner();
    $('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;
  } finally {
    state.loadingAll = false;
  }
}

function renderStats() {
  const stats = state.stats || {
    total: state.entries.length,
    hosts: new Set(state.entries.map((entry) => entry.host)).size,
    weak: 0,
    reused: 0,
    old: 0,
  };
  $('statTotal').textContent = stats.total ?? 0;
  $('statHosts').textContent = stats.hosts ?? 0;
  $('statWeak').textContent = stats.weak ?? 0;
  $('statReused').textContent = stats.reused ?? 0;
  $('statOld').textContent = stats.old ?? 0;
}

function filteredEntries() {
  const query = state.search.trim().toLowerCase();
  let list = state.entries.filter((entry) => {
    if (query) {
      const haystack = `${entry.host} ${entry.title} ${entry.username}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (state.filter === 'weak' && !entry.weak) return false;
    if (state.filter === 'reused' && !entry.reused) return false;
    if (state.filter === 'old' && !entry.old) return false;
    return true;
  });

  if (state.sort === 'updated') {
    list = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } else if (state.sort === 'changed') {
    list = [...list].sort((a, b) => (b.passwordChangedAt || 0) - (a.passwordChangedAt || 0));
  } else {
    list = [...list].sort(
      (a, b) =>
        a.host.localeCompare(b.host) ||
        (a.username || '').localeCompare(b.username || ''),
    );
  }
  return list;
}

function renderVault() {
  for (const timer of state.revealTimers.values()) clearTimeout(timer);
  state.revealTimers.clear();
  const list = filteredEntries();
  const visible = list.slice(0, state.limit);
  const container = $('vaultList');
  container.replaceChildren();

  for (const entry of visible) container.appendChild(renderEntry(entry));

  $('vaultEmpty').hidden = list.length > 0;
  const emptyTitle = $('vaultEmpty').querySelector('h3');
  const emptyText = $('vaultEmpty').querySelector('p');
  if (state.entries.length === 0) {
    emptyTitle.textContent = '这里还没有密码';
    emptyText.textContent = '导入浏览器密码，或手动添加第一条账号。';
  } else {
    emptyTitle.textContent = '没有符合条件的账号';
    emptyText.textContent = '换个搜索词或筛选条件试试。';
  }

  const remaining = list.length - visible.length;
  $('loadMoreBtn').hidden = remaining <= 0;
  $('loadMoreBtn').textContent = `显示更多（剩余 ${remaining} 条）`;
}

function renderEntry(entry) {
  const card = div('entry-card');
  const avatar = div('entry-avatar');
  avatar.textContent = (entry.title || entry.host || '?').trim().charAt(0).toUpperCase() || '?';

  const main = div('entry-main');
  const titleRow = div('entry-title-row');
  titleRow.appendChild(div('entry-title', entry.title || entry.host));
  if (entry.weak) titleRow.appendChild(span('badge weak', '弱密码'));
  if (entry.reused) titleRow.appendChild(span('badge reused', '重复使用'));
  if (entry.old) titleRow.appendChild(span('badge old', '超过 1 年'));
  const isolated = isHostIsolated(entry.host, state.settings.isolatedDomains || []);
  titleRow.appendChild(span('badge scope', isolated ? '独立子域' : '主域共享'));

  const sub = div('entry-sub');
  sub.append(span('', entry.port ? `${entry.host}:${entry.port}` : entry.host));
  sub.append(span('dot'));
  sub.append(span('', entry.username || '无用户名'));

  const meta = div(
    'entry-meta',
    `记录于 ${formatDateTime(entry.passwordChangedAt)} · ${formatRelative(
      entry.passwordChangedAt,
    )}`,
  );
  main.append(titleRow, sub, meta);

  const actions = div('entry-actions');
  const revealButton = miniButton('显示');
  const copyButton = miniButton('复制');
  const editButton = miniButton('编辑');
  const deleteButton = miniButton('删除', 'danger');
  if (entry.hasTotp) {
    const totpButton = miniButton('动态码');
    totpButton.addEventListener('click', () => void openTotp(entry));
    actions.append(totpButton);
  }
  if (entry.historyCount) {
    const historyButton = miniButton('历史');
    historyButton.addEventListener('click', () => void openHistory(entry));
    actions.append(historyButton);
  }
  actions.append(revealButton, copyButton, editButton, deleteButton);

  const secretRow = div('secret-row');
  secretRow.hidden = true;
  const secretValue = div('secret-value');
  const secretCopy = miniButton('复制密码');
  secretRow.append(secretValue, secretCopy);

  const clearReveal = () => {
    const timer = state.revealTimers.get(entry.id);
    if (timer) clearTimeout(timer);
    state.revealTimers.delete(entry.id);
    secretRow.hidden = true;
    revealButton.textContent = '显示';
  };

  revealButton.addEventListener('click', async () => {
    if (!secretRow.hidden) {
      clearReveal();
      return;
    }
    const result = await send('SV_GET_SECRET', { id: entry.id });
    if (!result.ok) {
      handleError(result, '无法读取密码');
      return;
    }
    secretValue.textContent = result.password;
    secretRow.hidden = false;
    revealButton.textContent = '隐藏';
    const timer = setTimeout(clearReveal, 20_000);
    state.revealTimers.set(entry.id, timer);
  });

  copyButton.addEventListener('click', () => void copyPassword(entry.id, copyButton));
  secretCopy.addEventListener('click', () => void copyPassword(entry.id, secretCopy));
  editButton.addEventListener('click', () => void openEntryDialog(entry.id));
  deleteButton.addEventListener('click', () => void deleteEntry(entry));

  card.append(avatar, main, actions, secretRow);
  return card;
}

function miniButton(label, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `mini-btn ${extraClass}`.trim();
  button.textContent = label;
  return button;
}

async function copyPassword(id, button) {
  const result = await send('SV_GET_SECRET', { id });
  if (!result.ok) {
    handleError(result, '无法读取密码');
    return;
  }
  const ok = await copyText(result.password, {
    clearAfterSeconds: Number(state.settings.clipboardClearSeconds) || 0,
  });
  if (ok) {
    toast('密码已复制');
    const original = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } else {
    toast('复制失败，请手动选择', { error: true });
  }
}

async function deleteEntry(entry) {
  if (!window.confirm(`删除 ${entry.host} 的账号“${entry.username || '无用户名'}”？`)) {
    return;
  }
  const result = await send('SV_DELETE_ENTRY', { id: entry.id });
  if (!result.ok) {
    handleError(result, '删除失败');
    return;
  }
  toast('账号已删除');
  await loadAll();
}

let totpTimer = 0;
let totpRemaining = 0;
let totpId = '';

async function loadTotpCode() {
  if (!totpId) return;
  const result = await send('SV_GET_TOTP_CODE', { id: totpId });
  if (!result.ok) {
    handleError(result, '无法生成动态码');
    return;
  }
  $('totpCode').textContent = result.code;
  totpRemaining = result.remaining;
  $('totpMeta').textContent = `${result.username || '无用户名'} · ${
    result.remaining
  } 秒后刷新`;
}

async function openTotp(entry) {
  const result = await send('SV_GET_TOTP_CODE', { id: entry.id });
  if (!result.ok) {
    handleError(result, '无法生成动态码');
    return;
  }
  totpId = entry.id;
  $('totpTitle').textContent = `${entry.title || entry.host} 的动态码`;
  $('totpCode').textContent = result.code;
  totpRemaining = result.remaining;
  $('totpMeta').textContent = `${result.username || '无用户名'} · ${result.remaining} 秒后刷新`;
  $('totpDialog').showModal();
  clearInterval(totpTimer);
  totpTimer = setInterval(() => {
    totpRemaining -= 1;
    if (totpRemaining <= 0) {
      void loadTotpCode();
      return;
    }
    $('totpMeta').textContent = `${result.username || '无用户名'} · ${totpRemaining} 秒后刷新`;
  }, 1000);
}

function closeTotp() {
  clearInterval(totpTimer);
  totpTimer = 0;
  totpId = '';
  $('totpCode').textContent = '------';
  $('totpMeta').textContent = '';
}

async function openHistory(entry) {
  const result = await send('SV_GET_HISTORY', { id: entry.id });
  if (!result.ok) {
    handleError(result, '无法读取密码历史');
    return;
  }
  const list = $('historyList');
  list.replaceChildren();
  if (result.history.length === 0) {
    list.append(div('muted-text', '没有历史密码'));
  }
  for (let index = 0; index < result.history.length; index += 1) {
    const item = result.history[index];
    const card = div('history-item');
    card.append(div('history-time', formatDateTime(item.changedAt)));
    const secret = div('history-secret', '••••••••');
    const actions = div('history-actions');
    const reveal = miniButton('显示');
    reveal.addEventListener('click', () => {
      const hidden = secret.textContent === '••••••••';
      secret.textContent = hidden ? item.password : '••••••••';
      reveal.textContent = hidden ? '隐藏' : '显示';
    });
    const copy = miniButton('复制');
    copy.addEventListener('click', async () => {
      const ok = await copyText(item.password, {
        clearAfterSeconds: Number(state.settings.clipboardClearSeconds) || 0,
      });
      toast(ok ? '历史密码已复制' : '复制失败', { error: !ok });
    });
    const restore = miniButton('恢复此密码', 'danger');
    restore.addEventListener('click', async () => {
      if (!window.confirm('把这个历史密码恢复为当前密码？当前密码会进入历史。')) return;
      const restored = await send('SV_RESTORE_HISTORY', { id: entry.id, index });
      if (!restored.ok) {
        handleError(restored, '恢复历史密码失败');
        return;
      }
      toast('历史密码已恢复');
      $('historyDialog').close();
      await loadAll();
    });
    actions.append(reveal, copy, restore);
    card.append(secret, actions);
    list.appendChild(card);
  }
  $('historyDialog').showModal();
}

async function findDuplicates() {
  const result = await send('SV_FIND_DUPLICATES');
  if (!result.ok) {
    handleError(result, '检查重复失败');
    return;
  }
  renderDuplicates(result.groups || []);
}

function renderDuplicates(groups) {
  const panel = $('duplicatesPanel');
  panel.replaceChildren();
  if (groups.length === 0) {
    panel.className = 'result';
    panel.append(div('result-title', '没有发现重复账号'), div('', '同一站点桶、同一账号目前只有一条记录。'));
    panel.hidden = false;
    return;
  }
  panel.className = 'result preview';
  panel.append(
    div(
      'result-title',
      `发现 ${groups.length} 组重复账号，可合并 ${groups.reduce(
        (sum, group) => sum + group.count - 1,
        0,
      )} 条`,
    ),
    div('', '合并会保留记录时间最新的一条，并保留已有备注；操作前建议先导出备份。'),
  );
  for (const group of groups) {
    const row = document.createElement('div');
    row.className = 'conflict-item';
    const head = document.createElement('strong');
    head.textContent = `${group.host} · ${group.username || '无用户名'}`;
    row.appendChild(head);
    row.appendChild(
      document.createTextNode(
        ` — ${group.count} 条记录；保留 ${formatDateTime(group.entries[0].passwordChangedAt)} 的密码`,
      ),
    );
    const merge = miniButton('合并保留最新');
    merge.addEventListener('click', () => void mergeDuplicateGroup(group));
    row.appendChild(merge);
    panel.appendChild(row);
  }
  panel.hidden = false;
}

async function mergeDuplicateGroup(group) {
  if (
    !window.confirm(
      `合并 ${group.host} / ${group.username || '无用户名'} 的 ${group.count} 条记录，只保留最新密码？`,
    )
  ) {
    return;
  }
  const snapshot = await send('SV_EXPORT_BACKUP');
  if (!snapshot.ok) {
    toast(snapshot.error || '合并前快照失败，已取消合并', { error: true });
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  downloadText(`subvault-pre-merge-${stamp}.json`, snapshot.backup, 'application/json');
  const result = await send('SV_MERGE_DUPLICATES', { key: group.key });
  if (!result.ok) {
    handleError(result, '合并失败');
    return;
  }
  toast(`已合并 ${result.merged || 0} 条重复记录`);
  await loadAll();
  await findDuplicates();
}

async function openEntryDialog(id = null) {
  setError($('entryError'), '');
  state.editingId = id;
  $('entryDialogTitle').textContent = id ? '编辑账号' : '添加账号';
  $('entryPassword').type = 'password';
  $('entryReveal').textContent = '显示';
  $('entryTimeLabel').textContent = '';

  if (id) {
    const result = await send('SV_GET_SECRET', { id });
    if (!result.ok) {
      handleError(result, '无法读取账号');
      return;
    }
    $('entryHost').value = result.port
      ? `${result.host}:${result.port}`
      : result.host || '';
    $('entryTitle').value = result.title || '';
    $('entryUsername').value = result.username || '';
    $('entryPassword').value = result.password || '';
    $('entryNotes').value = result.notes || '';
    $('entryTotp').value = result.totpSecret || '';
    $('entryTimeLabel').textContent = `密码记录于 ${formatDateTime(
      result.passwordChangedAt,
    )}；修改密码会更新为当前时间。`;
  } else {
    $('entryHost').value = '';
    $('entryTitle').value = '';
    $('entryUsername').value = '';
    $('entryPassword').value = '';
    $('entryNotes').value = '';
    $('entryTotp').value = '';
  }

  updateEntryPolicyHint();
  updateStrength($('entryPassword'), $('entryStrengthBar'), $('entryStrengthText'));
  $('entryDialog').showModal();
  setTimeout(() => {
    ($('entryHost').value ? $('entryUsername') : $('entryHost')).focus();
  }, 40);
}

function updateEntryPolicyHint() {
  const host = normalizeHost($('entryHost').value);
  const hint = $('entryPolicyHint');
  if (!host) {
    hint.textContent = '输入完整域名后显示匹配规则';
    return;
  }
  if (isHostIsolated(host, state.settings.isolatedDomains || [])) {
    hint.textContent = `独立子域：账号只匹配 ${host}，不会与同主域的其他子域共享。`;
  } else {
    hint.textContent = `主域共享：${suggestBaseDomain(host)} 下的所有子域共用这个账号。`;
  }
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
  const editing = Boolean(state.editingId);
  const payload = {
    host,
    port,
    title: $('entryTitle').value.trim(),
    username: $('entryUsername').value.trim(),
    password,
    notes: $('entryNotes').value,
    totpSecret: $('entryTotp').value.trim(),
    url: parsedHost?.href || `https://${host}${port ? `:${port}` : ''}/`,
  };
  const result = state.editingId
    ? await send('SV_UPDATE_ENTRY', { entry: { id: state.editingId, ...payload } })
    : await send('SV_ADD_ENTRY', { entry: payload });
  setBusy(button, false);

  if (!result.ok) {
    setError($('entryError'), result.error || '保存失败');
    return;
  }
  $('entryDialog').close();
  const account = payload.username || '无用户名';
  toast(account, `已${editing ? '更新' : '新增'}账号 · ${payload.host}`);
  await loadAll();
}

async function saveSettings(patch) {
  const result = await send('SV_SET_SETTINGS', { settings: patch });
  if (!result.ok) {
    handleError(result, '保存设置失败');
    applySettings();
    return false;
  }
  state.settings = {
    ...state.settings,
    ...result.settings,
    isolatedDomains: Array.isArray(result.settings.isolatedDomains)
      ? result.settings.isolatedDomains
      : [],
  };
  applySettings();
  renderVault();
  renderDomains();
  renderExceptions();
  renderPreview();
  renderTakeover();
  toast('设置已保存');
  return true;
}

function applyTheme() {
  const theme = state.settings?.theme || 'system';
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  const material = ['solid', 'glass', 'liquid'].includes(state.settings?.material)
    ? state.settings.material
    : 'solid';
  document.documentElement.dataset.material = material;
}

function applySettings() {
  const settings = state.settings;
  applyTheme();
  $('autoLockSelect').value = String(settings.autoLockMinutes ?? 15);
  $('clipboardClearSelect').value = String(settings.clipboardClearSeconds ?? 30);
  $('savePromptPositionSelect').value = settings.savePromptPosition || 'top-right';
  $('themeSelect').value = settings.theme || 'system';
  $('materialSelect').value = settings.material || 'solid';
  for (const key of [
    'savePrompt',
    'showIcon',
    'autoFill',
    'autoOpenOnFocus',
    'takeoverMode',
    'clearNativeAutofill',
  ]) {
    const input = document.querySelector(`[data-setting="${key}"]`);
    if (input) input.checked = Boolean(settings[key]);
  }
  $('chromeSaveToggle').checked = Boolean(settings.disableChromeSavePrompt);
}

function hasClipboardReadPermission() {
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions?.contains) {
        resolve(false);
        return;
      }
      chrome.permissions.contains({ permissions: ['clipboardRead'] }, (granted) => {
        resolve(Boolean(granted) && !chrome.runtime.lastError);
      });
    } catch {
      resolve(false);
    }
  });
}

async function refreshClipboardPermission() {
  const granted = await hasClipboardReadPermission();
  $('enableClipboardReadBtn').hidden = granted;
  $('clipboardReadStatus').textContent = granted
    ? '已允许读取剪贴板，自动清除会校验内容后再清空。'
    : '未允许读取剪贴板；自动清除会跳过，仍可用“立即清除剪贴板”。';
}

async function requestClipboardReadPermission() {
  try {
    const granted = await new Promise((resolve) => {
      chrome.permissions.request({ permissions: ['clipboardRead'] }, (value) => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(Boolean(value));
      });
    });
    toast(granted ? '已启用剪贴板自动清除校验' : '未授予剪贴板读取权限', {
      error: !granted,
    });
    await refreshClipboardPermission();
  } catch {
    toast('无法请求剪贴板读取权限', { error: true });
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function renderUsage() {
  const box = $('storageUsage');
  if (!state.usage) {
    box.className = 'status-box';
    box.textContent = '本地存储：无法读取';
    return;
  }
  const { bytes = 0, quota = 10 * 1024 * 1024, entries = 0 } = state.usage;
  const percent = quota > 0 ? bytes / quota : 0;
  box.className = `status-box${percent > 0.85 ? ' warn' : ''}`;
  box.textContent = `本地存储：${formatBytes(bytes)} / ${formatBytes(quota)} · ${entries} 条账号${
    percent > 0.85 ? ' · 接近配额，请导出备份并清理' : ''
  }`;
}

function renderTakeover() {  const status = state.takeover;
  const toggle = $('chromeSaveToggle');
  const badge = $('takeoverBadge');
  const box = $('takeoverStatus');
  const restore = $('restoreChromeBtn');

  if (!status) {
    badge.textContent = '检测中';
    box.textContent = '正在读取 Chrome 设置…';
    box.className = 'status-box';
    return;
  }

  if (!status.supported) {
    badge.textContent = '需手动设置';
    badge.className = 'tag danger';
    toggle.disabled = true;
    restore.hidden = true;
    box.className = 'status-box warn';
    box.textContent =
      '当前浏览器不支持 chrome.privacy 密码设置接口。请在 Chrome 设置 → 密码管理器中手动关闭“提示保存密码”。SubVault 的页面接管仍会生效。';
    return;
  }

  badge.textContent = 'API 可用';
  badge.className = 'tag';
  const controllable = ['', 'controllable_by_this_extension', 'controlled_by_this_extension'].includes(
    status.levelOfControl || '',
  );
  toggle.disabled = !controllable;
  toggle.checked = Boolean(state.settings.disableChromeSavePrompt);

  if (!controllable) {
    box.className = 'status-box warn';
    box.textContent = `Chrome 的“保存密码”设置当前由策略或其他扩展控制，无法从 SubVault 修改（${status.levelOfControl}）。`;
    restore.hidden = !status.changedByUs;
    return;
  }

  if (status.chromeValue) {
    box.className = 'status-box';
    box.textContent = `Chrome 当前会提示保存密码${
      status.changedByUs ? '（SubVault 已请求关闭，但当前仍为开启）' : ''
    }。`;
  } else {
    box.className = 'status-box ok';
    box.textContent = status.changedByUs
      ? 'Chrome 的“保存密码”提示已由 SubVault 关闭。'
      : 'Chrome 的“保存密码”提示当前已关闭（不是由 SubVault 修改）。';
  }
  restore.hidden = !status.changedByUs;
}

function renderDomains() {
  const list = Array.isArray(state.settings.isolatedDomains)
    ? state.settings.isolatedDomains
    : [];
  $('domainCount').textContent = `${list.length} 个`;
  $('domainEmpty').hidden = list.length > 0;
  const container = $('domainList');
  container.replaceChildren();

  for (const domain of list) {
    const row = div('domain-row');
    const copy = div('');
    copy.append(div('domain-name', domain));
    copy.append(div('domain-desc', '该主域下所有子域各自独立保存与匹配'));
    const remove = miniButton('移除', 'danger');
    remove.addEventListener('click', () => void removeDomain(domain));
    row.append(copy, remove);
    container.appendChild(row);
  }
}

function renderPreview() {
  const target = $('previewResult');
  const raw = $('previewHost').value;
  if (!raw.trim()) {
    target.textContent = '输入域名后显示结果';
    return;
  }
  const parsed = parseHttpUrl(raw) || parseHttpUrl(`https://${raw}`);
  const host = normalizeHost(parsed?.hostname || raw);
  if (!host || !isValidHost(host)) {
    target.textContent = '域名格式无效';
    return;
  }
  const port = normalizePort(parsed?.port || '');
  const list = state.settings.isolatedDomains || [];
  const isolated = isHostIsolated(host, list);
  const key = siteKeyFor(host, list, {
    port,
    portIsolation: Boolean(state.settings.portIsolation),
  });
  target.replaceChildren();
  const line1 = div('');
  line1.append(document.createTextNode('存储桶：'));
  const mono = span('mono', key);
  line1.appendChild(mono);
  const line2 = div(
    '',
    isolated
      ? '独立子域：该域名及子域各自使用完整主机名匹配。'
      : `主域共享：与 ${suggestBaseDomain(host)} 下所有子域共用账号。`,
  );
  if (port) {
    line2.append(
      document.createTextNode(
        state.settings.portIsolation
          ? ` 端口 ${port} 参与 localhost/IP 匹配。`
          : ' 普通域名匹配忽略端口。',
      ),
    );
  }
  target.append(line1, line2);
}

async function addDomain(event) {
  event.preventDefault();
  setError($('domainError'), '');
  const host = normalizeHost($('domainInput').value);
  if (!host || !isValidHost(host)) {
    setError($('domainError'), '请输入有效的主域名，例如 example.com');
    return;
  }
  const list = Array.isArray(state.settings.isolatedDomains)
    ? [...state.settings.isolatedDomains]
    : [];
  if (list.includes(host)) {
    setError($('domainError'), '这个域名已经在独立列表中');
    return;
  }
  const covering = list.find((domain) => host === domain || host.endsWith(`.${domain}`));
  if (covering) {
    setError($('domainError'), `该域名已被 ${covering} 覆盖，无需重复添加`);
    return;
  }
  const next = list.filter((domain) => !(domain === host || domain.endsWith(`.${host}`)));
  next.push(host);
  const ok = await saveSettings({ isolatedDomains: next });
  if (ok) {
    $('domainInput').value = '';
    toast(`${host} 已设为独立主域`);
  }
}

async function removeDomain(domain) {
  const list = (state.settings.isolatedDomains || []).filter((item) => item !== domain);
  const ok = await saveSettings({ isolatedDomains: list });
  if (ok) toast(`${domain} 已恢复为主域共享`);
}

function renderExceptions() {
  const exceptions = state.settings.siteExceptions || {};
  const hosts = Object.keys(exceptions).sort();
  $('exceptionEmpty').hidden = hosts.length > 0;
  const container = $('exceptionList');
  container.replaceChildren();
  for (const host of hosts) {
    const policy = exceptions[host] || {};
    const labels = [];
    if (policy.disableTakeover) labels.push('不接管');
    if (policy.disableSavePrompt) labels.push('不提示保存');
    if (policy.hideIcon) labels.push('隐藏按钮');
    const row = div('domain-row');
    const copy = div('');
    copy.append(div('domain-name', host));
    copy.append(div('domain-desc', labels.join(' · ') || '默认'));
    const remove = miniButton('移除', 'danger');
    remove.addEventListener('click', () => void removeException(host));
    row.append(copy, remove);
    container.appendChild(row);
  }
}

async function addException(event) {
  event.preventDefault();
  setError($('exceptionError'), '');
  const host = normalizeHost($('exceptionHost').value);
  if (!host || !isValidHost(host)) {
    setError($('exceptionError'), '请输入有效的完整主机名，例如 mail.example.com');
    return;
  }
  const policy = {};
  if ($('exceptionTakeover').checked) policy.disableTakeover = true;
  if ($('exceptionSave').checked) policy.disableSavePrompt = true;
  if ($('exceptionHide').checked) policy.hideIcon = true;
  if (Object.keys(policy).length === 0) {
    setError($('exceptionError'), '请至少选择一项例外行为');
    return;
  }
  const next = { ...(state.settings.siteExceptions || {}), [host]: policy };
  const ok = await saveSettings({ siteExceptions: next });
  if (ok) {
    $('exceptionHost').value = '';
    $('exceptionTakeover').checked = false;
    $('exceptionSave').checked = false;
    $('exceptionHide').checked = false;
    toast(`${host} 的站点例外已保存`);
  }
}

async function removeException(host) {
  const next = { ...(state.settings.siteExceptions || {}) };
  delete next[host];
  const ok = await saveSettings({ siteExceptions: next });
  if (ok) toast(`${host} 的站点例外已移除`);
}

async function importCsvFile(file) {
  $('importResult').hidden = true;
  $('importPreview').hidden = true;
  setError($('importResult'), '');
  state.pendingImport = null;
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    showImportError('文件超过 25 MB，无法导入');
    return;
  }
  const zone = $('dropZone');
  zone.classList.add('busy');
  try {
    const text = await file.text();
    const preview = await send('SV_PREVIEW_CSV', {
      text,
      fileLastModified: file.lastModified,
      fileName: file.name,
    });
    if (!preview.ok) {
      showImportError(preview.error || '导入预演失败');
      return;
    }
    state.pendingImport = {
      text,
      fileLastModified: file.lastModified,
      fileName: file.name,
    };
    showImportPreview(preview, file.name);
  } catch (error) {
    showImportError(error?.message || '读取文件失败');
  } finally {
    zone.classList.remove('busy');
    $('csvFile').value = '';
  }
}

function showImportPreview(result, fileName) {
  const box = $('importPreview');
  box.className = 'result preview';
  box.replaceChildren();
  box.append(div('result-title', `导入预演 · ${result.format || 'CSV'}`));
  box.append(
    div(
      '',
      `${fileName || '文件'}：将新增 ${result.imported || 0} 条，更新 ${
        result.updated || 0
      } 条，合并 ${result.merged || 0} 条，跳过 ${result.skipped || 0} 条。`,
    ),
  );
  box.append(
    div(
      '',
      result.hasTimestamps
        ? '时间依据：CSV 中的密码更改时间列。'
        : '时间依据：文件没有时间列，使用文件修改时间。',
    ),
  );

  if (result.conflictCount > 0) {
    box.append(
      div(
        '',
        `发现 ${result.conflictCount} 组同站点同账号的密码差异（显示前 ${
          result.conflicts?.length || 0
        } 组）：`,
      ),
    );
    const list = document.createElement('ul');
    list.className = 'conflict-list';
    for (const conflict of result.conflicts || []) {
      const item = document.createElement('li');
      item.className = `conflict-item ${conflict.result}`;
      const head = document.createElement('strong');
      head.textContent = `${conflict.host} · ${conflict.username || '无用户名'}`;
      item.appendChild(head);
      item.appendChild(
        document.createTextNode(
          ` — 导入 ${formatDateTime(conflict.incomingTime)}，现有 ${formatDateTime(
            conflict.existingTime,
          )}；${conflict.result === 'update' ? '将用导入密码更新' : '保留现有密码'}`,
        ),
      );
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    const list = document.createElement('ul');
    for (const warning of result.warnings.slice(0, 8)) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  const actions = div('preview-actions');
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'btn primary';
  confirm.textContent = '确认导入（先自动保存快照）';
  confirm.addEventListener('click', () => void confirmCsvImport(confirm));
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => {
    state.pendingImport = null;
    box.hidden = true;
  });
  actions.append(confirm, cancel);
  box.appendChild(actions);
  box.hidden = false;
}

async function confirmCsvImport(button) {
  if (!state.pendingImport) return;
  setBusy(button, true, '正在创建快照…');
  try {
    const snapshot = await send('SV_EXPORT_BACKUP');
    if (!snapshot.ok) {
      toast(snapshot.error || '导入前快照失败，已取消导入', { error: true });
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    downloadText(
      `subvault-pre-import-${stamp}.json`,
      snapshot.backup,
      'application/json',
    );

    button.textContent = '正在导入…';
    const result = await send('SV_IMPORT_CSV', {
      text: state.pendingImport.text,
      fileLastModified: state.pendingImport.fileLastModified,
      fileName: state.pendingImport.fileName,
    });
    if (!result.ok) {
      showImportError(result.error || '导入失败');
      return;
    }
    $('importPreview').hidden = true;
    const fileName = state.pendingImport.fileName;
    state.pendingImport = null;
    showImportResult(result, fileName);
    await loadAll();
  } finally {
    setBusy(button, false);
  }
}

function showImportError(message) {
  const box = $('importResult');
  $('importPreview').hidden = true;
  box.className = 'result error';
  box.replaceChildren(div('result-title', '导入失败'), div('', message));
  box.hidden = false;
}

function showImportResult(result, fileName) {
  $('importPreview').hidden = true;
  const box = $('importResult');
  box.className = 'result';
  box.replaceChildren();
  box.append(div('result-title', `导入完成 · ${result.format || 'CSV'}`));
  box.append(
    div(
      '',
      `${fileName || '文件'}：新增 ${result.imported || 0} 条，更新 ${
        result.updated || 0
      } 条，合并 ${result.merged || 0} 条，跳过 ${result.skipped || 0} 条。`,
    ),
  );
  box.append(
    div(
      '',
      result.hasTimestamps
        ? '时间依据：CSV 中的密码更改时间列。'
        : '时间依据：文件没有时间列，使用文件修改时间。',
    ),
  );
  box.append(
    div(
      '',
      (state.settings.isolatedDomains || []).length > 0
        ? '合并规则：默认主域按最新时间合并；独立主域下的每个子域分别合并。'
        : '合并规则：同一主域、同一账号按最新时间合并为一条记录。',
    ),
  );
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    const list = document.createElement('ul');
    for (const warning of result.warnings.slice(0, 8)) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.appendChild(item);
    }
    box.appendChild(list);
  }
}

async function exportCsv() {
  if (
    !window.confirm(
      'CSV 是明文密码文件，任何拿到文件的人都能读取全部密码。确定导出吗？',
    )
  ) {
    return;
  }
  const password = window.prompt('请输入主密码以导出明文 CSV：');
  if (!password) return;
  const result = await send('SV_EXPORT_CSV', { password });
  if (!result.ok) {
    handleError(result, '导出失败');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`subvault-passwords-${stamp}.csv`, result.csv, 'text/csv;charset=utf-8');
  toast('明文 CSV 已导出，请妥善保管');
}

async function exportBackup() {
  const backupPassword = $('exportBackupPassword').value;
  if (backupPassword && backupPassword.length < 10) {
    toast('独立备份密码至少需要 10 个字符', { error: true });
    return;
  }
  if (
    !backupPassword &&
    !window.confirm(
      '未填写独立备份密码，将导出由主密码保护的原始密码库密文。继续导出吗？',
    )
  ) {
    return;
  }
  const result = await send('SV_EXPORT_BACKUP', { backupPassword });
  if (!result.ok) {
    handleError(result, '导出备份失败');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  downloadText(`subvault-backup-${stamp}.json`, result.backup, 'application/json');
  $('exportBackupPassword').value = '';
  toast(
    result.independent
      ? '已导出独立密码加密的备份，请单独保管该密码'
      : '已导出主密码加密的备份',
  );
}

async function importBackup() {
  if (!state.backupText) {
    toast('请先选择备份文件', { error: true });
    return;
  }
  const password = $('backupPassword').value;
  if (!password) {
    toast('请输入该备份文件的密码', { error: true });
    return;
  }
  const mode = $('backupRestoreMode').value;
  const restoreSettings = $('backupRestoreSettings').checked;
  if (mode === 'replace') {
    if (
      !window.confirm(
        '覆盖恢复会删除当前密码库中的全部账号，并用备份内容替换。当前数据会先自动导出为快照，确定继续吗？',
      )
    ) {
      return;
    }
    const snapshot = await send('SV_EXPORT_BACKUP');
    if (!snapshot.ok) {
      toast(snapshot.error || '覆盖前快照失败，已取消恢复', { error: true });
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    downloadText(`subvault-pre-restore-${stamp}.json`, snapshot.backup, 'application/json');
  }

  const button = $('importBackupBtn');
  setBusy(button, true, '恢复中…');
  const result = await send('SV_IMPORT_BACKUP', {
    text: state.backupText,
    password,
    mode,
    restoreSettings,
  });
  setBusy(button, false);
  if (!result.ok) {
    handleError(result, '恢复备份失败');
    return;
  }
  $('backupPassword').value = '';
  toast(
    result.replaced
      ? `已覆盖恢复 ${result.total || 0} 条账号${result.settingsRestored ? '，设置已恢复' : ''}`
      : `备份已合并：新增 ${result.imported || 0} 条，更新 ${result.updated || 0} 条${
          result.settingsRestored ? '，设置已恢复' : ''
        }`,
  );
  await loadAll();
}

async function changeMasterPassword() {
  setError($('changePasswordError'), '');
  const current = $('currentPassword').value;
  const next = $('newPassword').value;
  const confirm = $('confirmPassword').value;
  if (!current) {
    setError($('changePasswordError'), '请输入当前主密码');
    return;
  }
  if (next.length < 10) {
    setError($('changePasswordError'), '新主密码至少需要 10 个字符');
    return;
  }
  if (next !== confirm) {
    setError($('changePasswordError'), '两次输入的新主密码不一致');
    return;
  }
  const button = $('changePasswordBtn');
  setBusy(button, true, '正在重新加密…');
  const result = await send('SV_CHANGE_MASTER', {
    currentPassword: current,
    newPassword: next,
  });
  setBusy(button, false);
  if (!result.ok) {
    setError($('changePasswordError'), result.error || '修改失败');
    return;
  }
  $('currentPassword').value = '';
  $('newPassword').value = '';
  $('confirmPassword').value = '';
  toast('主密码已修改，密码库已重新加密');
}

function openDanger(mode) {
  state.dangerMode = mode;
  setError($('dangerError'), '');
  $('dangerPassword').value = '';
  $('dangerConfirm').value = '';
  const reset = mode === 'reset';
  $('dangerTitle').textContent = reset ? '重置密码库' : '清空密码库';
  $('dangerMessage').textContent = reset
    ? '如果忘记了主密码，只能删除整个密码库并重新创建。所有已保存账号将被永久删除，且无法恢复。'
    : '这会删除本机密码库中的全部账号和密码，且无法撤销。建议先导出加密备份。';
  $('dangerPasswordField').hidden = reset;
  $('dangerAction').textContent = reset ? '确认重置' : '确认清空';
  $('dangerDialog').showModal();
  setTimeout(() => {
    (reset ? $('dangerConfirm') : $('dangerPassword')).focus();
  }, 40);
}

async function runDangerAction() {
  setError($('dangerError'), '');
  if ($('dangerConfirm').value.trim() !== '清空密码库') {
    setError($('dangerError'), '请输入确认文字：清空密码库');
    return;
  }
  const reset = state.dangerMode === 'reset';
  const password = $('dangerPassword').value;
  if (!reset && !password) {
    setError($('dangerError'), '请输入主密码以确认');
    return;
  }
  const button = $('dangerAction');
  setBusy(button, true, '处理中…');
  const result = reset
    ? await send('SV_RESET_VAULT', { confirm: '清空密码库' })
    : await send('SV_WIPE', { password, confirm: '清空密码库' });
  setBusy(button, false);
  if (!result.ok) {
    setError($('dangerError'), result.error || '操作失败');
    return;
  }
  $('dangerDialog').close();
  state.initialized = false;
  state.locked = true;
  state.entries = [];
  state.stats = null;
  toast(reset ? '密码库已重置' : '密码库已清空');
  showGate('setup');
}

async function setChromeSavePrompt(disabled) {
  if (
    disabled &&
    !window.confirm(
      '这会修改 Chrome 的全局设置，关闭浏览器自带的“保存密码”提示。卸载 SubVault 前请先在设置中恢复。继续吗？',
    )
  ) {
    $('chromeSaveToggle').checked = false;
    return;
  }
  const result = await send('SV_SET_CHROME_SAVE_PROMPT', { disabled });
  if (!result.ok) {
    $('chromeSaveToggle').checked = !disabled;
    handleError(result, '无法修改 Chrome 设置');
    return;
  }
  state.takeover = result.status;
  state.settings.disableChromeSavePrompt = Boolean(result.status?.enabled);
  renderTakeover();
  if (!disabled && state.settings.disableChromeSavePrompt) {
    toast('Chrome 设置未能恢复，请手动关闭 SubVault 或修改 Chrome 设置', { error: true });
  } else {
    toast(disabled ? '已请求关闭 Chrome 保存密码提示' : '已恢复 Chrome 保存密码提示');
  }
}

async function restoreChrome() {
  await setChromeSavePrompt(false);
}

async function openChromeSettings() {
  const url = 'chrome://password-manager/settings';
  try {
    await chrome.tabs.create({ url });
  } catch {
    const ok = await copyText(url);
    toast(ok ? '无法自动打开，地址已复制到剪贴板' : '请手动打开 chrome://password-manager/settings', {
      error: true,
    });
  }
}

function selectSection(name) {
  const section = PAGE_META[name] ? name : 'vault';
  state.section = section;
  for (const element of document.querySelectorAll('.section')) {
    element.hidden = element.id !== `section-${section}`;
  }
  for (const button of document.querySelectorAll('.nav-item')) {
    button.classList.toggle('active', button.dataset.section === section);
  }
  const [title, subtitle] = PAGE_META[section];
  $('pageTitle').textContent = title;
  $('pageSub').textContent = subtitle;
  $('headAddBtn').hidden = section !== 'vault';
  if (location.hash !== `#${section}`) {
    history.replaceState(null, '', `#${section}`);
  }
  if (section === 'security') {
    applySettings();
    renderTakeover();
  }
  if (section === 'domains') {
    renderDomains();
    renderExceptions();
    renderPreview();
  }
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => selectSection(button.dataset.section));
  });

  $('headAddBtn').addEventListener('click', () => void openEntryDialog());
  $('lockNow').addEventListener('click', async () => {
    await send('SV_LOCK');
    showGate('unlock');
  });

  $('gateUnlockForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    setError($('gateError'), '');
    const password = $('gatePassword').value;
    if (!password) {
      setError($('gateError'), '请输入主密码');
      return;
    }
    const button = $('gateUnlockBtn');
    setBusy(button, true, '正在解锁…');
    const result = await send('SV_UNLOCK', { password });
    setBusy(button, false);
    if (!result.ok) {
      setError($('gateError'), result.error || '解锁失败');
      return;
    }
    $('gatePassword').value = '';
    hideGate();
    await loadAll();
  });

  $('gateImportChoose').addEventListener('click', () => {
    $('gateImportPrompt').hidden = true;
    $('gateImportForm').hidden = false;
    setError($('gateError'), '');
    $('gateImportPassword').focus();
  });

  $('gateImportBack').addEventListener('click', () => {
    $('gateImportForm').hidden = true;
    $('gateImportPrompt').hidden = false;
    setError($('gateError'), '');
  });

  $('gateNewInstall').addEventListener('click', async () => {
    await setSyncPromptDismissed(true);
    $('gateImportPrompt').hidden = true;
    $('gateImportForm').hidden = true;
    $('gateSetupForm').hidden = false;
    $('gateTitle').textContent = '创建本地密码库';
    $('gateSub').textContent = '设置一个主密码。它只在本机用于加密，忘记后无法找回。';
    $('gateNewPassword').focus();
  });

  $('gateImportBtn').addEventListener('click', async () => {
    const password = $('gateImportPassword').value;
    if (!password) {
      setError($('gateError'), '请输入已有密码库的主密码');
      return;
    }
    const button = $('gateImportBtn');
    setBusy(button, true, '正在导入…');
    const result = await send('SV_SYNC_IMPORT', { password });
    setBusy(button, false);
    if (!result.ok) {
      setError($('gateError'), result.error || '导入失败');
      return;
    }
    await setSyncPromptDismissed(false);
    $('gateImportPassword').value = '';
    hideGate();
    await loadAll();
    toast(`已导入 ${result.count} 个账号；主密码已使用原密码库的主密码`);
  });

  $('gateSetupForm').addEventListener('submit', async (event) => {    event.preventDefault();
    setError($('gateError'), '');
    const password = $('gateNewPassword').value;
    if (password.length < 10) {
      setError($('gateError'), '主密码至少需要 10 个字符');
      return;
    }
    if (password !== $('gateConfirmPassword').value) {
      setError($('gateError'), '两次输入的主密码不一致');
      return;
    }
    if (!$('gateAck').checked) {
      setError($('gateError'), '请确认你已了解主密码无法找回');
      return;
    }
    const button = $('gateSetupBtn');
    setBusy(button, true, '正在创建加密密码库…');
    const result = await send('SV_SETUP', { password });
    setBusy(button, false);
    if (!result.ok) {
      setError($('gateError'), result.error || '创建失败');
      return;
    }
    $('gateNewPassword').value = '';
    $('gateConfirmPassword').value = '';
    hideGate();
    await loadAll();
    toast('密码库已创建');
  });

  document.querySelectorAll('.reveal[data-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = $(button.dataset.target);
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.textContent = reveal ? '隐藏' : '显示';
    });
  });

  $('searchInput').addEventListener('input', () => {
    state.search = $('searchInput').value;
    state.limit = 200;
    renderVault();
  });
  $('filterSelect').addEventListener('change', () => {
    state.filter = $('filterSelect').value;
    state.limit = 200;
    renderVault();
  });
  $('sortSelect').addEventListener('change', () => {
    state.sort = $('sortSelect').value;
    renderVault();
  });
  $('loadMoreBtn').addEventListener('click', () => {
    state.limit += 200;
    renderVault();
  });
  $('findDuplicatesBtn').addEventListener('click', () => void findDuplicates());

  $('entryClose').addEventListener('click', () => $('entryDialog').close());
  $('entryCancel').addEventListener('click', () => $('entryDialog').close());
  $('entryDialog').addEventListener('click', (event) => {
    if (event.target === $('entryDialog')) $('entryDialog').close();
  });
  $('entryDialog').addEventListener('close', () => {
    $('entryPassword').value = '';
    $('entryNotes').value = '';
    $('entryTotp').value = '';
    $('entryPassword').type = 'password';
    $('entryReveal').textContent = '显示';
    state.editingId = null;
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

  $('domainForm').addEventListener('submit', (event) => void addDomain(event));
  $('exceptionForm').addEventListener('submit', (event) => void addException(event));
  $('previewHost').addEventListener('input', renderPreview);

  $('autoLockSelect').addEventListener('change', () => {
    void saveSettings({ autoLockMinutes: Number($('autoLockSelect').value) });
  });
  $('savePromptPositionSelect').addEventListener('change', () => {
    void saveSettings({ savePromptPosition: $('savePromptPositionSelect').value });
  });
  $('themeSelect').addEventListener('change', () => {
    void saveSettings({ theme: $('themeSelect').value });
  });
  $('materialSelect').addEventListener('change', () => {
    void saveSettings({ material: $('materialSelect').value });
  });
  $('clipboardClearSelect').addEventListener('change', () => {
    void saveSettings({ clipboardClearSeconds: Number($('clipboardClearSelect').value) });
  });
  $('clearClipboardBtn').addEventListener('click', async () => {
    const ok = await clearClipboard();
    toast(ok ? '剪贴板已清空' : '无法清空剪贴板，请手动覆盖', { error: !ok });
  });
  $('enableClipboardReadBtn').addEventListener('click', () => void requestClipboardReadPermission());
  document.querySelectorAll('[data-setting]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.setting;
      const patch = { [key]: input.checked };
      void saveSettings(patch).then((ok) => {
        if (
          ok &&
          ['takeoverMode', 'clearNativeAutofill', 'savePrompt', 'showIcon', 'autoFill', 'autoOpenOnFocus'].includes(
            key,
          )
        ) {
          toast('已保存；刷新已打开的网页后完全生效');
        }
      });
    });
  });

  $('chromeSaveToggle').addEventListener('change', () => {
    void setChromeSavePrompt($('chromeSaveToggle').checked);
  });
  $('restoreChromeBtn').addEventListener('click', () => void restoreChrome());
  $('openChromeSettingsBtn').addEventListener('click', () => void openChromeSettings());

  $('changePasswordBtn').addEventListener('click', () => void changeMasterPassword());

  $('wipeBtn').addEventListener('click', () => openDanger('wipe'));
  $('resetBtn').addEventListener('click', () => openDanger('reset'));
  $('dangerClose').addEventListener('click', () => $('dangerDialog').close());
  $('dangerCancel').addEventListener('click', () => $('dangerDialog').close());
  $('dangerDialog').addEventListener('click', (event) => {
    if (event.target === $('dangerDialog')) $('dangerDialog').close();
  });
  $('dangerDialog').addEventListener('close', () => {
    $('dangerPassword').value = '';
    $('dangerConfirm').value = '';
    state.dangerMode = '';
  });
  $('dangerAction').addEventListener('click', () => void runDangerAction());

  $('totpClose').addEventListener('click', () => $('totpDialog').close());
  $('totpDialog').addEventListener('close', closeTotp);
  $('totpCopyBtn').addEventListener('click', async () => {
    const code = $('totpCode').textContent;
    if (!code || code === '------') return;
    const ok = await copyText(code);
    toast(ok ? '动态码已复制' : '复制失败', { error: !ok });
  });
  $('historyClose').addEventListener('click', () => $('historyDialog').close());
  $('historyDialog').addEventListener('close', () => {
    $('historyList').replaceChildren();
  });

  $('chooseCsvBtn').addEventListener('click', () => $('csvFile').click());
  $('csvFile').addEventListener('change', () => {
    const file = $('csvFile').files?.[0];
    if (file) void importCsvFile(file);
  });
  const zone = $('dropZone');
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragover');
    const file = event.dataTransfer?.files?.[0];
    if (file) void importCsvFile(file);
  });

  $('exportCsvBtn').addEventListener('click', () => void exportCsv());
  $('exportBackupBtn').addEventListener('click', () => void exportBackup());
  $('chooseBackupBtn').addEventListener('click', () => $('backupFile').click());
  $('backupFile').addEventListener('change', async () => {
    const file = $('backupFile').files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast('备份文件超过 25 MB', { error: true });
      return;
    }
    try {
      state.backupText = await file.text();
      state.backupName = file.name;
      $('backupFileName').textContent = `已选择：${file.name}`;
      $('backupFileName').hidden = false;
    } catch {
      toast('读取备份文件失败', { error: true });
    }
  });
  $('importBackupBtn').addEventListener('click', () => void importBackup());
  $('syncPullBtn').addEventListener('click', () => void syncPullExisting());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      state.settings = { ...state.settings, ...changes.settings.newValue };
      applySettings();
      return;
    }
    if (area !== 'session' || !changes.session) return;
    const value = changes.session.newValue;
    if (value?.keyJwk) {
      if (state.locked || !state.loaded) {
        hideGate();
        void loadAll();
      }
    } else if (state.initialized) {
      showGate('unlock');
    }
  });
}

async function bootstrap() {
  bindEvents();
  selectSection(location.hash.replace('#', '') || 'vault');
  await loadSettings();

  const status = await send('SV_GET_STATUS');
  if (!status.ok) {
    showGate('unlock');
    setError($('gateError'), status.error || '无法读取密码库状态');
    return;
  }

  state.initialized = Boolean(status.initialized);
  state.locked = Boolean(status.locked);
  updateLockUi();

  if (!state.initialized) {
    showGate('setup');
    return;
  }  if (state.locked) {
    showGate('unlock');
    return;
  }

  hideGate();
  await loadAll();
}

void bootstrap();
