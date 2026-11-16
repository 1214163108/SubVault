import {
  clearClipboard,
  clipboardMessage,
  copyText,
  downloadText,
  formatDateTime,
  formatRelative,
  isLockedError,
  makeToast,
  readFileBase64,
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
import { generatePassword, generatePin } from '../lib/generator.js';
import { passwordStrength } from '../lib/crypto.js';
import { evaluateMasterPassword } from '../lib/strength.js';
import { parseOtpAuthUri } from '../lib/totp.js';
import { parseImportFile } from '../lib/importers.js';
import { collectKdbxRows, kdbxFieldText } from '../lib/kdbx-map.js';
import {
  createSharePackage,
  defaultShareExpiry,
  openSharePackage,
} from '../lib/share.js';
import { applyI18n, installI18n, setUiLanguage, tr } from '../lib/i18n.js';
import { installPrivacyShield } from '../lib/privacy.js';
import {
  assertDeviceCredential,
  createDeviceCredential,
  describeVerificationError,
  deviceVerificationSupported,
  platformVerifierAvailable,
} from '../lib/webauthn.js';

const $ = (id) => document.getElementById(id);
const toast = makeToast($('toast'));

const PAGE_META = {
  vault: ['密码库', '管理本机保存的登录账号与密码。'],
  general: ['通用', '外观、剪贴板与常规行为。'],
  security: ['安全', '自动锁定、密钥文件与主密码。'],
  takeover: ['浏览器接管', 'Chrome 原生密码管理与页面提示。'],
  domains: ['域名与站点', '默认按主域共享；可指定独立主域，让每个子域完全隔离。'],
  sync: ['同步与备份', '本机或 WebDAV 密文同步、备份与恢复。'],
  transfer: ['导入与导出', '从浏览器迁移密码，或创建加密备份。'],
  share: ['分享与旅行', '一次性分享与旅行模式。'],
  language: ['语言与格式', '界面语言与日期、数字的显示格式。'],
  about: ['关于', 'SubVault 的本地安全模型与权限说明。'],
};

const state = {
  initialized: false,
  locked: true,
  loaded: false,
  loadingAll: false,
  entries: [],
  selected: new Set(),
  shareSelected: new Set(),
  shareReady: false,
  shareFilter: '',
  travel: null,
  travelEntries: [],
  travelHidden: new Set(),
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
  entryTotpMeta: null,
  dangerMode: '',
  revealTimers: new Map(),
  sync: null,
  syncConfig: null,
  snapshot: null,
  keyFile: false,
  migration: null,
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

let masterStrengthToken = 0;

async function updateMasterStrength({
  input,
  bar,
  text,
  hint,
  ackLabel,
  ackInput,
}) {
  if (!input || !bar || !text) return;
  const value = input.value;
  if (!value) {
    bar.style.width = '0%';
    bar.style.background = '#94a3b8';
    text.textContent = '未输入';
    if (hint) {
      hint.hidden = true;
      hint.textContent = '';
    }
    if (ackLabel) ackLabel.hidden = true;
    if (ackInput) ackInput.checked = false;
    return;
  }
  const token = ++masterStrengthToken;
  const result = await evaluateMasterPassword(value);
  if (token !== masterStrengthToken || input.value !== value) return;
  bar.style.width = `${result.percent}%`;
  bar.style.background = scoreColor(result.score);
  text.textContent = `${result.label} · 约 ${Math.round(result.bits)} bits`;
  if (hint) {
    hint.hidden = !result.message;
    hint.textContent = result.message || '';
    hint.classList.toggle('is-danger', result.blocked);
  }
  if (ackLabel) {
    ackLabel.hidden = !result.needsConfirm;
    if (!result.needsConfirm && ackInput) ackInput.checked = false;
  }
}

function refreshNewPasswordStrength() {
  void updateMasterStrength({
    input: $('newPassword'),
    bar: $('newPasswordStrengthBar'),
    text: $('newPasswordStrengthText'),
    hint: $('newPasswordHint'),
    ackLabel: $('newPasswordAckLabel'),
    ackInput: $('newPasswordAck'),
  });
}

function refreshGateStrength() {
  void updateMasterStrength({
    input: $('gateNewPassword'),
    bar: $('gateStrengthBar'),
    text: $('gateStrengthText'),
    hint: $('gateStrengthHint'),
    ackLabel: $('gateStrengthAckLabel'),
    ackInput: $('gateStrengthAck'),
  });
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

function syncGateVaultMeta() {
  const select = $('gateVaultSelect');
  const option = select?.selectedOptions?.[0];
  if ($('gateUnlockKeyFileRow')) {
    $('gateUnlockKeyFileRow').hidden = option ? option.dataset.keyFile !== '1' : false;
  }
  void refreshGateDeviceUnlock();
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
    $('gateStrengthAck').checked = false;
    $('gateKeyFileToggle').checked = false;
    $('gateKeyFileRow').hidden = true;
    if ($('gateKeyFile')) $('gateKeyFile').value = '';
    refreshGateStrength();
    void detectGateImport();
    return;
  }
  void send('SV_GET_STATUS').then((status) => {
    if (!status?.ok) return;
    const row = $('gateVaultRow');
    const select = $('gateVaultSelect');
    const vaults = Array.isArray(status.vaults) ? status.vaults : [];
    if (row && select) {
      select.replaceChildren();
      for (const vault of vaults) {
        const option = document.createElement('option');
        option.value = vault.id;
        option.textContent = vault.name;
        option.dataset.keyFile = vault.keyFile ? '1' : '';
        select.append(option);
      }
      if (status.activeVaultId) select.value = status.activeVaultId;
      row.hidden = vaults.length <= 1;
    }
    syncGateVaultMeta();
    void refreshGateDeviceUnlock();
  });
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
    setUiLanguage(state.settings.uiLanguage || 'auto');
    applyI18n(document.body);
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

const SYNC_STATE_TEXT = {
  idle: '已同步',
  syncing: '同步中',
  conflict: '需要处理',
  unavailable: '宿主未连接',
  unconfigured: '未配置 WebDAV',
  not_joined: '未加入同步',
  no_remote: '远端为空',
  locked: '已锁定',
};

function formatSyncTime(value) {
  const stamp = Number(value);
  if (!stamp) return '从未';
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? '从未' : formatDateTime(stamp);
}

function renderSyncCenter(sync = state.sync) {
  if (!$('syncStateBox')) return;
  state.sync = sync || null;
  const name = sync?.locked ? 'locked' : sync?.state || (sync?.available ? 'idle' : 'unavailable');
  const label = SYNC_STATE_TEXT[name] || '未知';
  $('syncStateTag').textContent = label;
  const box = $('syncStateBox');
  box.className = 'status-box';
  if (name === 'idle') {
    box.classList.add('ok');
    box.textContent = sync?.exists
      ? '已与远端同步。密码库变化会按当前触发方式自动处理。'
      : '已加入同步，但远端还没有密码库；保存账号或点击“立即同步”后会创建。';
  } else if (name === 'syncing') {
    box.textContent = '正在与远端比较并同步…';
  } else if (name === 'conflict') {
    box.classList.add('warn');
    box.textContent = '远端和本机都有新的修改，请在下方选择保留哪个版本。';
  } else if (name === 'unconfigured') {
    box.classList.add('warn');
    box.textContent = '尚未配置 WebDAV。请填写地址、用户名和密码后保存，再点击“立即同步”。';
  } else if (name === 'unavailable') {
    box.classList.add('warn');
    box.textContent = '未检测到本机同步宿主。请先安装 subvault-sync-host，然后重启浏览器。';
  } else if (name === 'not_joined') {
    box.textContent = '已连接同步宿主，但本机尚未建立同步。另一台浏览器创建密码库后，点击“立即同步”即可加入。';
  } else if (name === 'no_remote') {
    box.textContent = '已连接宿主，但同步目录中还没有密码库；保存账号或点击“立即同步”会创建。';
  } else {
    box.textContent = '解锁后可查看同步状态。';
  }
  $('syncLastAt').textContent = formatSyncTime(sync?.lastSyncAt);
  $('syncLastDirection').textContent =
    sync?.lastDirection === 'pull' ? '拉取远端' : sync?.lastDirection === 'push' ? '推送到远端' : '—';
  $('syncRevision').textContent = sync?.revision ? `#${sync.revision}` : '—';
  $('syncIntro').textContent = '通过本机 Native Messaging 宿主在同一台电脑的不同浏览器之间同步加密密码库，不经过网络。';
  const trigger = sync?.trigger || state.settings?.syncTrigger || 'realtime';
  const triggers = ['realtime', 'interval', 'scheduled', 'unlock', 'manual'];
  const activeTrigger = triggers.includes(trigger) ? trigger : 'realtime';
  $('syncTriggerSelect').value = activeTrigger;
  $('syncIntervalRow').hidden = activeTrigger !== 'interval';
  $('syncScheduleRow').hidden = activeTrigger !== 'scheduled';
  if (document.activeElement !== $('syncIntervalMinutes')) {
    $('syncIntervalMinutes').value = String(state.settings?.syncIntervalMinutes || 15);
  }
  if (document.activeElement !== $('syncScheduleTime')) {
    $('syncScheduleTime').value = state.settings?.syncScheduleTime || '09:00';
  }
  const errorBox = $('syncErrorBox');
  if (sync?.lastError && !sync?.conflict) {
    errorBox.textContent = sync.lastError;
    errorBox.hidden = false;
  } else {
    errorBox.hidden = true;
  }
  const conflictBox = $('syncConflictBox');
  if (sync?.conflict) {
    const local = formatSyncTime(sync.conflict.localUpdated);
    const remote = formatSyncTime(sync.conflict.remoteUpdated);
    $('syncConflictText').textContent = `本机版本：${local}；远端版本：${remote}。保留本机版本会覆盖远端。`;
    conflictBox.hidden = false;
  } else {
    conflictBox.hidden = true;
  }
}

function renderWebdavConfig(config = state.syncConfig) {
  if (!$('webdavUrl')) return;
  const has = Boolean(config?.webdav?.url);
  if (document.activeElement !== $('webdavUrl')) $('webdavUrl').value = config?.webdav?.url || '';
  if (document.activeElement !== $('webdavUsername')) $('webdavUsername').value = config?.webdav?.username || '';
  $('webdavPassword').value = '';
  $('webdavPassword').placeholder = has ? '留空则保持原密码' : 'WebDAV 密码';
  $('webdavStatus').textContent = has ? '已保存 WebDAV 配置。' : '尚未配置 WebDAV。';
  $('webdavClearBtn').hidden = !has;
  $('webdavError').hidden = true;
}

async function refreshWebdavConfig() {
  if (state.locked || !$('webdavUrl')) return null;
  const result = await send('SV_GET_SYNC_CONFIG');
  if (!result.ok) return null;
  state.syncConfig = result;
  renderWebdavConfig(result);
  void refreshWebdavBackupStatus();
  return result;
}

async function saveWebdavConfig() {
  const error = $('webdavError');
  error.hidden = true;
  const url = $('webdavUrl').value.trim();
  if (!url) {
    error.textContent = '请填写 WebDAV 地址';
    error.hidden = false;
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    error.textContent = 'WebDAV 地址格式不正确';
    error.hidden = false;
    return;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    error.textContent = 'WebDAV 地址必须使用 HTTPS（本机测试可用 http://127.0.0.1）';
    error.hidden = false;
    return;
  }
  const button = $('webdavSaveBtn');
  setBusy(button, true, '保存中…');
  const result = await send('SV_SET_WEBDAV', {
    webdav: {
      url,
      username: $('webdavUsername').value.trim(),
      password: $('webdavPassword').value,
    },
  });
  setBusy(button, false);
  if (!result.ok) {
    error.textContent = result.error || '保存 WebDAV 配置失败';
    error.hidden = false;
    toast(error.textContent, { error: true });
    return;
  }
  toast('WebDAV 配置已保存');
  state.syncConfig = { ...result, ok: true };
  renderWebdavConfig(state.syncConfig);
  await refreshWebdavBackupStatus();
}

async function clearWebdavConfig() {
  if (!window.confirm('清除 WebDAV 配置？已保存的地址和凭据会从密码库中删除。')) return;
  const result = await send('SV_CLEAR_WEBDAV');
  if (!result.ok) {
    toast(result.error || '清除失败', { error: true });
    return;
  }
  state.syncConfig = { ok: true, configured: false, webdav: null };
  renderWebdavConfig(state.syncConfig);
  toast('WebDAV 配置已清除');
  await refreshWebdavBackupStatus();
}

function renderWebdavBackupStatus(status = state.webdavBackup) {
  state.webdavBackup = status || null;
  if (!$('webdavBackupTag')) return;
  const configured = Boolean(status?.configured ?? state.syncConfig?.configured);
  const tag = $('webdavBackupTag');
  if (!configured) {
    tag.textContent = '未配置';
    tag.className = 'tag';
  } else if (status?.lastError) {
    tag.textContent = '备份失败';
    tag.className = 'tag warn';
  } else if (status?.lastBackupAt) {
    tag.textContent = '已备份';
    tag.className = 'tag ok';
  } else {
    tag.textContent = '已配置';
    tag.className = 'tag';
  }
  $('webdavBackupBtn').disabled = !configured;
  const meta = $('webdavBackupMeta');
  if (!configured) {
    meta.textContent = '保存 WebDAV 配置后即可备份。';
  } else {
    const at = status?.lastBackupAt ? formatSyncTime(status.lastBackupAt) : '从未';
    const revision = status?.lastRevision ? ` · 远端 #${status.lastRevision}` : '';
    meta.textContent = `上次备份：${at}${revision}`;
  }
  if (status?.lastError) {
    $('webdavError').textContent = status.lastError;
    $('webdavError').hidden = false;
  } else if ($('webdavError')) {
    $('webdavError').hidden = true;
  }
}

async function refreshWebdavBackupStatus() {
  if (state.locked || !$('webdavBackupTag')) return null;
  const result = await send('SV_WEBDAV_BACKUP_STATUS');
  if (!result?.ok) return null;
  renderWebdavBackupStatus(result);
  return result;
}

async function backupWebdavNow() {
  const error = $('webdavError');
  error.hidden = true;
  const button = $('webdavBackupBtn');
  setBusy(button, true, '备份中…');
  const result = await send('SV_WEBDAV_BACKUP_NOW');
  setBusy(button, false);
  if (!result.ok) {
    error.textContent = result.error || '备份失败';
    error.hidden = false;
    toast(error.textContent, { error: true });
    return;
  }
  toast(`已备份到 WebDAV（远端 #${result.revision || '?'}）`);
  await refreshWebdavBackupStatus();
}

async function restoreWebdavBackup() {
  const error = $('webdavError');
  error.hidden = true;
  const password = $('webdavRestorePassword').value;
  if (!password) {
    error.textContent = '请输入用于恢复的主密码';
    error.hidden = false;
    return;
  }
  if (!window.confirm('从 WebDAV 恢复会覆盖当前密码库，并要求重新解锁。继续？')) return;
  let keyFileBase64 = '';
  if ($('webdavRestoreKeyFile')?.files?.length) {
    keyFileBase64 = await readFileBase64($('webdavRestoreKeyFile').files[0]);
  }
  const button = $('webdavRestoreBtn');
  setBusy(button, true, '恢复中…');
  const result = await send('SV_WEBDAV_RESTORE', { password, keyFileBase64 });
  setBusy(button, false);
  if (!result.ok) {
    error.textContent = result.error || '恢复失败';
    error.hidden = false;
    toast(error.textContent, { error: true });
    return;
  }
  toast(`已从 WebDAV 恢复 ${result.entries || 0} 个账号，请重新解锁`);
  showGate('unlock');
}

async function refreshSyncCenter() {
  const result = await send('SV_SYNC_STATUS');
  void refreshWebdavSnapshot();
  if (result?.ok) {
    renderSyncCenter(result);
    return result;
  }
  renderSyncCenter({ state: 'unavailable', lastError: result?.error || '无法读取同步状态' });
  return result;
}

async function refreshWebdavSnapshot() {
  const row = $('syncSnapshotRow');
  if (!row) return;
  const result = await send('SV_GET_WEBDAV_SNAPSHOT');
  if (!result?.ok || !result.exists) {
    state.snapshot = null;
    row.hidden = true;
    return;
  }
  state.snapshot = result;
  row.hidden = false;
  $('syncSnapshotText').textContent = `${formatDateTime(result.savedAt)} · ${tr(
    '远端版本',
  )} #${result.remoteRevision || 0}；${tr('恢复后需要重新解锁')}`;
}

async function restoreWebdavSnapshot() {
  if (!state.snapshot?.exists) return;
  if (!window.confirm('恢复同步前的本机快照？当前密码库会被快照覆盖，并需要重新解锁。')) return;
  const button = $('syncRestoreSnapshotBtn');
  setBusy(button, true, '正在恢复…');
  const result = await send('SV_RESTORE_WEBDAV_SNAPSHOT');
  setBusy(button, false);
  if (!result.ok) {
    toast(result.error || '恢复快照失败', { error: true });
    return;
  }
  toast('已恢复同步前的本机快照');
  setTimeout(() => location.reload(), 600);
}

async function syncNow() {
  const button = $('syncNowBtn');
  setBusy(button, true, '同步中…');
  const result = await send('SV_SYNC_NOW');
  setBusy(button, false);
  if (!result.ok) {
    toast(result.error || '同步失败', { error: true });
    await refreshSyncCenter();
    return;
  }
  renderSyncCenter(result);
  if (result.conflict) {
    toast('检测到同步冲突', { error: true });
    return;
  }
  toast('同步完成');
  await loadAll();
}

async function resolveSyncConflict(strategy) {
  if (strategy === 'local' && !window.confirm('保留本机版本会覆盖远端密码库，确定继续？')) return;
  const button = strategy === 'local' ? $('syncKeepLocalBtn') : $('syncKeepRemoteBtn');
  setBusy(button, true, '处理中…');
  const result = await send('SV_SYNC_RESOLVE', { strategy });
  setBusy(button, false);
  if (!result.ok) {
    toast(result.error || '处理冲突失败', { error: true });
    await refreshSyncCenter();
    return;
  }
  toast(strategy === 'remote' ? '已使用远端版本' : '已保留本机版本');
  await loadAll();
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

async function refreshVaultManage() {
  const result = await send('SV_GET_VAULTS');
  if (!result.ok) return;
  const list = $('vaultManageList');
  if (!list) return;
  list.replaceChildren();
  for (const vault of result.vaults || []) {
    const row = document.createElement('div');
    row.className = 'vault-manage-row';
    row.dataset.vaultId = vault.id;
    const copy = document.createElement('div');
    copy.className = 'vault-manage-copy';
    const name = document.createElement('strong');
    name.textContent = vault.name;
    const meta = document.createElement('small');
    meta.textContent = vault.id === result.activeVaultId
      ? '当前密码库'
      : `创建于 ${formatDateTime(vault.createdAt)}${vault.keyFile ? ' · 需密钥文件' : ''}`;
    copy.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'vault-manage-actions';
    if (vault.id !== result.activeVaultId) {
      const merge = document.createElement('button');
      merge.className = 'btn small';
      merge.type = 'button';
      merge.textContent = '合并到此库';
      merge.addEventListener('click', () => void mergeVaultFromSettings(vault.id, vault.name));
      actions.append(merge);
      const use = document.createElement('button');
      use.className = 'btn small';
      use.type = 'button';
      use.textContent = '切换';
      use.addEventListener('click', () => void switchVault(vault.id));
      actions.append(use);
    }
    const rename = document.createElement('button');
    rename.className = 'btn small';
    rename.type = 'button';
    rename.textContent = '重命名';
    rename.addEventListener('click', () => void renameVaultFromSettings(vault.id, vault.name));
    actions.append(rename);
    if ((result.vaults || []).length > 1) {
      const remove = document.createElement('button');
      remove.className = 'btn small danger-ghost';
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', () => void deleteVaultFromSettings(vault.id, vault.name));
      actions.append(remove);
    }
    row.append(copy, actions);
    list.append(row);
  }
}

async function switchVault(id) {
  const result = await send('SV_SELECT_VAULT', { vaultId: id });
  if (!result.ok) return toast(result.error || '切换失败', { error: true });
  showGate('unlock');
}

async function createVaultFromSettings() {
  const name = $('newVaultName').value.trim();
  const password = $('newVaultPassword').value;
  if (!name) return setError($('vaultManageError'), '请输入密码库名称');
  if (password.length < 10) return setError($('vaultManageError'), '主密码至少 10 个字符');
  setError($('vaultManageError'), '');
  const button = $('newVaultCreateBtn');
  setBusy(button, true, '创建中…');
  const result = await send('SV_CREATE_VAULT', { name, password });
  setBusy(button, false);
  if (!result.ok) return setError($('vaultManageError'), result.error || '创建失败');
  $('newVaultName').value = '';
  $('newVaultPassword').value = '';
  showGate('unlock');
}

async function mergeVaultFromSettings(id, name) {
  const password = window.prompt(`输入密码库“${name}”的主密码以合并到当前库`);
  if (!password) return;
  const result = await send('SV_MERGE_VAULT', { vaultId: id, password });
  if (!result.ok) return toast(result.error || '合并失败', { error: true });
  toast(`已合并 ${result.imported + result.updated} 条账号`, `当前密码库共 ${result.total} 条`);
  await loadAll();
}

async function renameVaultFromSettings(id, current) {
  const name = window.prompt('新的密码库名称', current);
  if (name === null) return;
  const result = await send('SV_RENAME_VAULT', { vaultId: id, name: name.trim() });
  if (!result.ok) return toast(result.error || '重命名失败', { error: true });
  await refreshVaultManage();
}

async function deleteVaultFromSettings(id, name) {
  if (!window.confirm(`确定删除密码库“${name}”？该库数据无法恢复。`)) return;
  const password = window.prompt('输入该密码库的主密码以确认删除');
  if (!password) return;
  const result = await send('SV_DELETE_VAULT', { vaultId: id, password });
  if (!result.ok) return toast(result.error || '删除失败', { error: true });
  await refreshVaultManage();
  const status = await send('SV_GET_STATUS');
  if (status.ok && !status.unlocked && status.initialized) showGate('unlock');
}

let profileCache = [];

async function refreshProfilesManage() {
  const result = await send('SV_LIST_PROFILES');
  if (!result.ok) return;
  profileCache = Array.isArray(result.profiles) ? result.profiles : [];
  const select = $('profileSelectOptions');
  if (!select) return;
  const current = select.value;
  select.replaceChildren();
  const fresh = document.createElement('option');
  fresh.value = '';
  fresh.textContent = '新建资料';
  select.append(fresh);
  for (const profile of profileCache) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    select.append(option);
  }
  if (current && profileCache.some((profile) => profile.id === current)) {
    select.value = current;
  } else {
    select.value = '';
    clearProfileForm();
  }
}

function clearProfileForm() {
  for (const id of ['profileName', 'profileFullName', 'profileEmail', 'profilePhone', 'profileCompany', 'profileWebsite', 'profileAddress', 'profileNotes']) {
    if ($(id)) $(id).value = '';
  }
  if ($('profileDeleteBtn')) $('profileDeleteBtn').hidden = true;
  setError($('profileError'), '');
}

function loadProfileIntoForm(id) {
  const profile = profileCache.find((item) => item.id === id);
  if (!profile) {
    clearProfileForm();
    return;
  }
  $('profileName').value = profile.name || '';
  $('profileFullName').value = profile.fullName || '';
  $('profileEmail').value = profile.email || '';
  $('profilePhone').value = profile.phone || '';
  $('profileCompany').value = profile.company || '';
  $('profileWebsite').value = profile.website || '';
  $('profileAddress').value = profile.address || '';
  $('profileNotes').value = profile.notes || '';
  $('profileDeleteBtn').hidden = false;
  setError($('profileError'), '');
}

async function saveProfileFromSettings() {
  const id = $('profileSelectOptions').value;
  const profile = {
    id: id || undefined,
    name: $('profileName').value.trim() || '默认资料',
    fullName: $('profileFullName').value,
    email: $('profileEmail').value,
    phone: $('profilePhone').value,
    company: $('profileCompany').value,
    website: $('profileWebsite').value,
    address: $('profileAddress').value,
    notes: $('profileNotes').value,
  };
  setError($('profileError'), '');
  const result = await send('SV_SAVE_PROFILE', { profile });
  if (!result.ok) return setError($('profileError'), result.error || '保存失败');
  toast('资料模板已保存');
  await refreshProfilesManage();
  $('profileSelectOptions').value = result.profile?.id || '';
  loadProfileIntoForm(result.profile?.id || '');
}

async function deleteProfileFromSettings() {
  const id = $('profileSelectOptions').value;
  if (!id || !window.confirm('确定删除该资料模板？')) return;
  const result = await send('SV_DELETE_PROFILE', { id });
  if (!result.ok) return toast(result.error || '删除失败', { error: true });
  clearProfileForm();
  await refreshProfilesManage();
}

async function refreshPslStatus() {
  const result = await send('SV_GET_CUSTOM_PSL');
  const rules = Number(result.rules) || 0;
  if ($('pslRuleCount')) $('pslRuleCount').textContent = rules > 0 ? `${rules} 条自定义` : '内置';
  if ($('pslStatus') && rules === 0) {
    $('pslStatus').textContent = '未导入自定义规则，使用内置完整 PSL。';
  }
  if ($('pslClearBtn')) $('pslClearBtn').hidden = rules === 0;
}

async function loadAll() {
  await refreshPslStatus();
  if (state.loadingAll) return;
  state.loadingAll = true;
  try {
    const [entriesResult, settingsResult, takeoverResult, usageResult, statusResult, syncResult] =
      await Promise.all([
        send('SV_LIST_ENTRIES'),
        send('SV_GET_SETTINGS'),
        send('SV_GET_TAKEOVER_STATUS'),
        send('SV_GET_USAGE'),
        send('SV_GET_STATUS'),
        send('SV_SYNC_STATUS'),
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
    if (statusResult?.ok) state.keyFile = Boolean(statusResult.keyFile);
    state.usage = usageResult.ok ? usageResult : null;
    state.sync = syncResult?.ok ? syncResult : null;
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
    renderKeyFile();
    renderMigration();
    void refreshMigrationStatus();
    void refreshDeviceBinding();
    renderShareEntries();
    if (!state.locked) {
      try {
        await refreshTravel();
      } catch {
        /* travel mode is optional */
      }
    }
    renderSyncCenter(syncResult?.ok ? syncResult : null);
    void refreshWebdavBackupStatus();
    void refreshClipboardPermission();
    void refreshSyncBanner();
    void refreshBackupHealth();
    $('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;
  } finally {
    state.loadingAll = false;
  }
}

function shareMatches(entry, needle) {
  if (!needle) return true;
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const haystack = [entry.title, entry.host, entry.username, entry.email, ...tags]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return needle.split(/\s+/).every((token) => haystack.includes(token));
}

function renderShareEntries() {
  const list = $('shareEntryList');
  if (!list) return;
  const known = new Set(state.entries.map((entry) => entry.id));
  for (const id of state.shareSelected) if (!known.has(id)) state.shareSelected.delete(id);
  const needle = state.shareFilter.trim().toLowerCase();
  const visible = state.entries.filter((entry) => shareMatches(entry, needle));
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'muted-text';
    empty.textContent = needle ? '没有匹配的账号' : '密码库中还没有账号。';
    list.appendChild(empty);
  }
  for (const entry of visible) {
    const row = document.createElement('label');
    row.className = 'share-entry-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.shareId = entry.id;
    input.checked = state.shareSelected.has(entry.id);
    const text = document.createElement('span');
    text.className = 'share-entry-text';
    const title = document.createElement('strong');
    title.textContent = entry.title || entry.host;
    const sub = document.createElement('small');
    sub.textContent = `${entry.host} · ${entry.username || '无用户名'}`;
    text.append(title, sub);
    row.append(input, text);
    list.appendChild(row);
  }
  updateShareSelectionUi();
}

function updateShareSelectionUi() {
  const inputs = [...document.querySelectorAll('#shareEntryList input[data-share-id]')];
  const checked = state.shareSelected.size;
  if ($('shareSelectionCount')) {
    $('shareSelectionCount').textContent = `${checked} / ${state.entries.length}`;
  }
  if ($('shareSelectAllBtn')) {
    const allChecked = inputs.length > 0 && inputs.every((input) => input.checked);
    $('shareSelectAllBtn').disabled = inputs.length === 0;
    $('shareSelectAllBtn').textContent = allChecked ? '取消全选当前' : '全选当前';
  }
  if ($('shareExportBtn')) {
    $('shareExportBtn').disabled = checked === 0;
    $('shareExportBtn').textContent = checked ? `导出 ${checked} 个账号` : '导出 .svshare';
  }
}

async function exportShare() {
  const button = $('shareExportBtn');
  setError($('shareError'), '');
  const password = $('sharePassword').value;
  if (password.length < 8) {
    setError($('shareError'), '分享密码至少需要 8 个字符');
    return;
  }
  if (!state.shareSelected.size) {
    setError($('shareError'), '请至少选择一个账号');
    return;
  }
  setBusy(button, true, '正在加密…');
  try {
    const secrets = await send('SV_GET_ALL_SECRETS');
    if (!secrets.ok) throw new Error(secrets.error || '无法读取账号密码');
    const entries = (secrets.entries || []).filter((entry) => state.shareSelected.has(entry.id));
    if (!entries.length) throw new Error('选中的账号没有可分享的密码');
    const days = Number($('shareExpiry').value) || 1;
    const pkg = await createSharePackage(entries, {
      password,
      expiresAt: defaultShareExpiry(days),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(
      `subvault-share-${stamp}.svshare`,
      JSON.stringify(pkg, null, 2),
      'application/json',
    );
    $('sharePassword').value = '';
    toast(`已导出 ${entries.length} 个账号的分享文件`);
  } catch (error) {
    setError($('shareError'), error?.message || '分享文件生成失败');
  } finally {
    setBusy(button, false);
  }
}

async function importShare() {
  const button = $('shareImportBtn');
  setError($('shareError'), '');
  const file = $('shareFile').files?.[0];
  if (!file) {
    setError($('shareError'), '请选择 .svshare 文件');
    return;
  }
  const password = $('shareImportPassword').value;
  if (!password) {
    setError($('shareError'), '请输入分享密码');
    return;
  }
  setBusy(button, true, '正在解密…');
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('分享文件超过 10 MB');
    const pkg = JSON.parse(await file.text());
    const opened = await openSharePackage(pkg, password);
    const entries = opened.entries;
    const preview = await send('SV_PREVIEW_IMPORT_ROWS', {
      entries,
      total: entries.length,
      format: 'SVSHARE',
      warnings: [],
    });
    if (!preview.ok) throw new Error(preview.error || '导入预演失败');
    state.pendingImport = {
      kind: 'rows',
      entries,
      skipped: 0,
      total: entries.length,
      format: 'SVSHARE',
      warnings: [],
      fileName: file.name,
    };
    selectSection('transfer');
    showImportPreview(preview, file.name);
    $('shareFile').value = '';
    $('shareImportPassword').value = '';
    toast(`已解密 ${entries.length} 个账号，请确认导入`);
  } catch (error) {
    setError($('shareError'), error?.message || '分享文件导入失败');
  } finally {
    setBusy(button, false);
  }
}

async function refreshTravel() {
  if (!$('travelEnabled')) return;
  const [travel, list] = await Promise.all([
    send('SV_GET_TRAVEL'),
    send('SV_LIST_ENTRIES', { includeHidden: true }),
  ]);
  if (!travel.ok) throw new Error(travel.error || '无法读取旅行模式');
  state.travel = travel;
  state.travelEntries = list.ok ? list.entries || [] : [];
  state.travelHidden = new Set(travel.hiddenEntryIds || []);
  $('travelEnabled').checked = Boolean(travel.enabled);
  $('travelHiddenHosts').value = (travel.hiddenHosts || []).join('\n');
  $('travelHiddenTags').value = (travel.hiddenTags || []).join(', ');
  $('travelAutoRestore').value = '0';
  $('travelDisableRow').hidden = !travel.enabled;
  $('travelStatus').textContent = travel.enabled
    ? travel.autoRestoreAt
      ? `已启用，将在 ${formatDateTime(travel.autoRestoreAt)} 自动关闭`
      : '已启用，仅在本机生效'
    : '未启用';
  renderTravelEntries();
}

function travelEntryHiddenByRule(entry) {
  const travel = state.travel || {};
  if ((travel.hiddenEntryIds || []).includes(entry.id)) return true;
  const host = normalizeHost(entry.host || '');
  if ((travel.hiddenHosts || []).some((hidden) => host === hidden || host.endsWith(`.${hidden}`))) {
    return true;
  }
  const hiddenTags = new Set((travel.hiddenTags || []).map((tag) => String(tag).toLowerCase()));
  return (entry.tags || []).some((tag) => hiddenTags.has(String(tag).toLowerCase()));
}

function renderTravelEntries() {
  const list = $('travelEntryList');
  if (!list) return;
  list.replaceChildren();
  state.travelHidden = new Set();
  if (!state.travelEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted-text';
    empty.textContent = '密码库中还没有账号。';
    list.appendChild(empty);
    return;
  }
  for (const entry of state.travelEntries) {
    const row = document.createElement('label');
    row.className = 'share-entry-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.travelId = entry.id;
    const ruleHidden = travelEntryHiddenByRule(entry);
    input.checked = ruleHidden;
    input.disabled = ruleHidden &&
      !(state.travel?.hiddenEntryIds || []).includes(entry.id);
    if (input.checked) state.travelHidden.add(entry.id);
    const text = document.createElement('span');
    text.className = 'share-entry-text';
    const title = document.createElement('strong');
    title.textContent = entry.title || entry.host;
    const sub = document.createElement('small');
    sub.textContent = `${entry.host} · ${entry.username || '无用户名'}`;
    text.append(title, sub);
    row.append(input, text);
    if (input.disabled) row.title = '由隐藏站点或标签规则隐藏';
    list.appendChild(row);
  }
}

async function saveTravel() {
  const button = $('travelSaveBtn');
  setError($('travelError'), '');
  if (!$('travelEnabled').checked) {
    setError($('travelError'), '请先勾选“启用旅行模式”');
    return;
  }
  const ids = [...document.querySelectorAll('#travelEntryList input[data-travel-id]')]
    .filter((input) => input.checked)
    .map((input) => input.dataset.travelId);
  const hosts = $('travelHiddenHosts')
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tags = $('travelHiddenTags')
    .value.split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  setBusy(button, true, '正在保存…');
  try {
    const result = await send('SV_SET_TRAVEL', {
      travel: {
        enabled: true,
        hiddenEntryIds: ids,
        hiddenHosts: hosts,
        hiddenTags: tags,
      },
      autoRestoreHours: Number($('travelAutoRestore').value) || 0,
    });
    if (!result.ok) throw new Error(result.error || '保存旅行模式失败');
    toast('旅行模式已更新');
    await refreshTravel();
    await loadAll();
  } catch (error) {
    setError($('travelError'), error?.message || '保存旅行模式失败');
  } finally {
    setBusy(button, false);
  }
}

async function disableTravelMode() {
  const button = $('travelDisableBtn');
  setError($('travelError'), '');
  const password = $('travelPassword').value;
  if (!password) {
    setError($('travelError'), '请输入主密码');
    return;
  }
  setBusy(button, true, '正在关闭…');
  try {
    const result = await send('SV_SET_TRAVEL', {
      travel: { enabled: false },
      password,
    });
    if (!result.ok) throw new Error(result.error || '关闭旅行模式失败');
    $('travelPassword').value = '';
    toast('旅行模式已关闭');
    await refreshTravel();
    await loadAll();
  } catch (error) {
    setError($('travelError'), error?.message || '关闭旅行模式失败');
  } finally {
    setBusy(button, false);
  }
}

function renderKeyFile() {
  if (!$('keyFileStatus')) return;
  const enabled = Boolean(state.keyFile);
  $('keyFileStatus').textContent = enabled ? '已启用' : '未启用';
  $('keyFileCurrentRow').hidden = !enabled;
  $('keyFileDisableBtn').hidden = !enabled;
}

function renderMigration() {
  if (!$('migrationCard')) return;
  if (state.locked) {
    $('migrationCard').hidden = true;
    return;
  }
  $('migrationCard').hidden = false;
  const info = state.migration || {};
  const version = Number(info.currentVersion) || 0;
  $('migrationTag').textContent = version ? `v${version}` : tr('未知');
  if (version >= 4) {
    $('migrationStatus').textContent = info.exists
      ? `${tr('当前已是 v4（VaultKey 包装）。迁移备份保存于')} ${formatDateTime(info.savedAt)}${tr('，可回滚到迁移前格式。')}`
      : tr('当前已是 v4（VaultKey 包装）。主密码只用于包装 VaultKey，修改主密码不会重新加密整个密码库。');
  } else {
    $('migrationStatus').textContent = tr('当前仍是旧格式，下次使用主密码解锁时会自动迁移到 v4。');
  }
  $('migrationRollbackRow').hidden = !info.exists;
  $('migrationKeyFileRow').hidden = !info.keyFile;
}

async function refreshMigrationStatus() {
  if (state.locked || !$('migrationCard')) return null;
  const result = await send('SV_GET_MIGRATION_STATUS');
  if (!result.ok) return null;
  state.migration = result;
  renderMigration();
  return result;
}

async function rollbackMigration() {
  const button = $('migrationRollbackBtn');
  setError($('migrationError'), '');
  const password = $('migrationPassword').value;
  if (!password) {
    setError($('migrationError'), tr('请输入主密码'));
    return;
  }
  if (!window.confirm(tr('回滚会用迁移前的密文备份覆盖当前密码库，确定继续？'))) return;
  setBusy(button, true, tr('正在回滚…'));
  try {
    const keyFile = $('migrationKeyFile')?.files?.[0];
    const keyFileBase64 = keyFile ? await readFileBase64(keyFile) : '';
    const result = await send('SV_ROLLBACK_MIGRATION', { password, keyFileBase64 });
    if (!result.ok) throw new Error(result.error || tr('回滚失败'));
    $('migrationPassword').value = '';
    if ($('migrationKeyFile')) $('migrationKeyFile').value = '';
    toast(`${tr('已回滚到 v')}${result.version}${tr('，请重新解锁以再次迁移')}`);
    await loadAll();
    showGate('unlock');
  } catch (error) {
    setError($('migrationError'), error?.message || tr('回滚失败'));
  } finally {
    setBusy(button, false);
  }
}

async function refreshGateDeviceUnlock() {
  const button = $('gateDeviceUnlockBtn');
  if (!button) return;
  const vaultId = $('gateVaultSelect')?.value || '';
  try {
    const status = await send('SV_DEVICE_STATUS', { vaultId });
    const available = Boolean(status.ok && status.supported && status.exists);
    const ready = Boolean(available && status.credentialId && !status.needsHello);
    button.hidden = !available;
    button.disabled = !ready;
    button.dataset.credentialId = status.credentialId || '';
    button.title = ready
      ? tr('使用 Windows Hello 解锁')
      : tr('此绑定缺少 Windows Hello 验证，请用主密码解锁后在设置页重新启用');
    const hint = $('gateDeviceHint');
    if (hint) {
      hint.hidden = !available;
      hint.textContent = ready
        ? tr('解锁时需要 Windows Hello 验证')
        : tr('旧绑定缺少 Windows Hello 验证，请用主密码解锁后在设置页重新启用');
    }
  } catch {
    button.hidden = true;
    if ($('gateDeviceHint')) $('gateDeviceHint').hidden = true;
  }
}

async function deviceUnlockFromGate() {
  const button = $('gateDeviceUnlockBtn');
  setError($('gateError'), '');
  const vaultId = $('gateVaultSelect')?.value || '';
  const credentialId = button.dataset.credentialId || '';
  setBusy(button, true, tr('正在验证…'));
  try {
    if (!credentialId) throw new Error(tr('此设备绑定缺少 Windows Hello 验证，请用主密码解锁后在设置页重新启用'));
    await assertDeviceCredential(credentialId);
    setBusy(button, true, tr('正在解锁…'));
    const result = await send('SV_DEVICE_UNLOCK', { vaultId, credentialId });
    if (!result.ok) throw new Error(result.error || tr('设备快速解锁失败，请使用主密码解锁'));
    hideGate();
    await loadAll();
  } catch (error) {
    setError($('gateError'), error?.name ? describeVerificationError(error) : (error?.message || tr('设备快速解锁失败，请使用主密码解锁')));
  } finally {
    setBusy(button, false);
  }
}

async function refreshDeviceBinding() {
  if (!$('deviceUnlockCard')) return null;
  try {
    const status = await send('SV_DEVICE_STATUS', {});
    const supported = Boolean(status.ok && status.supported);
    const needsHello = Boolean(status.needsHello || (status.exists && !status.credentialId));
    $('deviceBindTag').textContent = !supported
      ? tr('不可用')
      : status.exists
        ? (needsHello ? tr('需重新启用') : tr('已启用'))
        : tr('未启用');
    if (!supported) {
      $('deviceBindStatus').textContent = status.error || tr('当前同步宿主不支持设备快速解锁（仅 Windows DPAPI）。');
    } else if (needsHello) {
      $('deviceBindStatus').textContent = tr('旧绑定缺少 Windows Hello 验证，无法绕过 PIN 直接解锁；请重新启用设备快速解锁。');
    } else if (status.exists) {
      $('deviceBindStatus').textContent = `${tr('已在本机绑定')} · ${formatDateTime(status.createdAt)} · ${tr('解锁时需要 Windows Hello 验证')}`;
    } else {
      $('deviceBindStatus').textContent = tr('尚未启用。启用时需要密码库已解锁。');
    }
    $('deviceEnableBtn').hidden = !supported || (Boolean(status.exists) && !needsHello);
    $('deviceDisableBtn').hidden = !supported || !status.exists;
    return status;
  } catch (error) {
    $('deviceBindTag').textContent = tr('不可用');
    $('deviceBindStatus').textContent = error?.message || tr('无法读取设备绑定状态');
    $('deviceEnableBtn').hidden = true;
    $('deviceDisableBtn').hidden = true;
    return null;
  }
}

async function enableDeviceBinding() {
  const button = $('deviceEnableBtn');
  setError($('deviceBindError'), '');
  setBusy(button, true, tr('正在验证…'));
  try {
    if (!deviceVerificationSupported()) throw new Error(tr('当前浏览器不支持 Windows Hello 验证'));
    if (!(await platformVerifierAvailable())) throw new Error(tr('当前设备没有可用的 Windows Hello 验证器'));
    const credentialId = await createDeviceCredential();
    setBusy(button, true, tr('正在启用…'));
    const result = await send('SV_DEVICE_ENABLE', { credentialId });
    if (!result.ok) throw new Error(result.error || tr('启用失败'));
    toast(tr('已启用设备快速解锁'));
    await refreshDeviceBinding();
  } catch (error) {
    setError($('deviceBindError'), error?.name ? describeVerificationError(error) : (error?.message || tr('启用失败')));
  } finally {
    setBusy(button, false);
  }
}

async function disableDeviceBinding() {
  const button = $('deviceDisableBtn');
  if (!window.confirm(tr('移除后只能使用主密码解锁，确定移除本机设备绑定？'))) return;
  setError($('deviceBindError'), '');
  setBusy(button, true, tr('正在移除…'));
  try {
    const result = await send('SV_DEVICE_DISABLE');
    if (!result.ok) throw new Error(result.error || tr('移除失败'));
    toast(tr('已移除本机设备绑定'));
    await refreshDeviceBinding();
  } catch (error) {
    setError($('deviceBindError'), error?.message || tr('移除失败'));
  } finally {
    setBusy(button, false);
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
  $('statHttp').textContent = stats.http ?? 0;
}

function filteredEntries() {
  const query = state.search.trim().toLowerCase();
  let list = state.entries.filter((entry) => {
    if (query) {
      const haystack = `${entry.host} ${entry.title} ${entry.username} ${entry.aliasEmail || ''} ${
        entry.aliasProvider || ''
      } ${entry.folder || ''} ${(entry.tags || []).join(' ')}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (state.filter === 'favorite' && !entry.favorite) return false;
    if (state.filter === 'recent' && !entry.lastUsedAt) return false;
    if (state.filter === 'weak' && !entry.weak) return false;
    if (state.filter === 'reused' && !entry.reused) return false;
    if (state.filter === 'old' && !entry.old) return false;
    if (state.filter === 'http' && !entry.http) return false;
    if (state.filter === 'totp' && !entry.hasTotp) return false;
    return true;
  });

  if (state.sort === 'recent') {
    list = [...list].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  } else if (state.sort === 'updated') {
    list = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } else if (state.sort === 'changed') {
    list = [...list].sort((a, b) => (b.passwordChangedAt || 0) - (a.passwordChangedAt || 0));
  } else {
    list = [...list].sort(
      (a, b) =>
        Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
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
  renderBulkBar();
}

function renderBulkBar() {
  for (const id of [...state.selected]) {
    if (!state.entries.some((entry) => entry.id === id)) state.selected.delete(id);
  }
  const bar = $('bulkBar');
  bar.hidden = state.selected.size === 0;
  $('bulkCount').textContent = `已选 ${state.selected.size} 项`;
}

async function bulkSetFavorite(favorite) {
  if (state.selected.size === 0) return;
  const result = await send('SV_BULK_UPDATE', {
    ids: [...state.selected],
    favorite,
  });
  if (!result.ok) {
    handleError(result, '批量收藏失败');
    return;
  }
  toast(`已更新 ${result.updated || 0} 个账号的收藏状态`);
  state.selected.clear();
  await loadAll();
}

async function bulkDelete() {
  if (state.selected.size === 0) return;
  if (!window.confirm(`确定删除选中的 ${state.selected.size} 个账号吗？`)) return;
  const result = await send('SV_BULK_DELETE', { ids: [...state.selected] });
  if (!result.ok) {
    handleError(result, '批量删除失败');
    return;
  }
  toast(`已删除 ${result.deleted || 0} 个账号`);
  state.selected.clear();
  await loadAll();
}

function renderEntry(entry) {
  const card = div('entry-card');
  const select = document.createElement('input');
  select.type = 'checkbox';
  select.className = 'entry-select';
  select.checked = state.selected.has(entry.id);
  select.title = '选择此账号';
  select.addEventListener('change', () => {
    if (select.checked) state.selected.add(entry.id);
    else state.selected.delete(entry.id);
    renderBulkBar();
  });
  const avatar = div('entry-avatar');
  avatar.textContent = (entry.title || entry.host || '?').trim().charAt(0).toUpperCase() || '?';

  const main = div('entry-main');
  const titleRow = div('entry-title-row');
  titleRow.appendChild(div('entry-title', entry.title || entry.host));
  if (entry.weak) titleRow.appendChild(span('badge weak', '弱密码'));
  if (entry.reused) titleRow.appendChild(span('badge reused', '重复使用'));
  if (entry.old) titleRow.appendChild(span('badge old', '超过 1 年'));
  if (entry.http) titleRow.appendChild(span('badge http', 'HTTP 明文'));
  const isolated = isHostIsolated(entry.host, state.settings.isolatedDomains || []);
  titleRow.appendChild(span('badge scope', isolated ? '独立子域' : '主域共享'));

  const sub = div('entry-sub');
  sub.append(span('', entry.port ? `${entry.host}:${entry.port}` : entry.host));
  sub.append(span('dot'));
  sub.append(span('', entry.username || '无用户名'));
  if (entry.aliasEmail) sub.append(span('badge scope', `别名 ${entry.aliasEmail}`));
  if (entry.hasPasskey) sub.append(span('badge scope', 'Passkey'));
  if (entry.folder) sub.append(span('badge scope', entry.folder));
  for (const tag of (entry.tags || []).slice(0, 3)) {
    sub.append(span('badge tag', `#${tag}`));
  }

  const meta = div(
    'entry-meta',
    `记录于 ${formatDateTime(entry.passwordChangedAt)} · ${formatRelative(
      entry.passwordChangedAt,
    )}`,
  );
  main.append(titleRow, sub, meta);

  const actions = div('entry-actions');
  const favoriteButton = miniButton(entry.favorite ? '★ 收藏' : '☆ 收藏');
  favoriteButton.classList.add('favorite');
  favoriteButton.title = entry.favorite ? '取消收藏' : '收藏账号';
  favoriteButton.addEventListener('click', async () => {
    const result = await send('SV_TOGGLE_FAVORITE', { id: entry.id });
    if (!result.ok) {
      handleError(result, '更新收藏失败');
      return;
    }
    entry.favorite = Boolean(result.favorite);
    renderVault();
  });
  const revealButton = miniButton('显示');
  const copyButton = miniButton('复制');
  const editButton = miniButton('编辑');
  const deleteButton = miniButton('删除', 'danger');
  const totpButton = entry.hasTotp ? miniButton('动态码') : null;
  if (totpButton) totpButton.addEventListener('click', () => void openTotp(entry));
  const historyButton = entry.historyCount ? miniButton('历史') : null;
  if (historyButton) historyButton.addEventListener('click', () => void openHistory(entry));
  actions.append(
    favoriteButton,
    ...(totpButton ? [totpButton] : []),
    ...(historyButton ? [historyButton] : []),
    revealButton,
    copyButton,
    editButton,
    deleteButton,
  );

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

  card.append(select, avatar, main, actions, secretRow);
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
  const seconds = Number(state.settings.clipboardClearSeconds) || 0;
  const ok = await copyText(result.password, { clearAfterSeconds: seconds });
  if (ok) {
    toast(clipboardMessage('密码已复制', seconds));
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
let totpPeriod = 30;
let totpId = '';

function updateTotpProgress() {
  const bar = $('totpProgressBar');
  if (!bar) return;
  const ratio = totpPeriod > 0 ? Math.max(0, Math.min(1, totpRemaining / totpPeriod)) : 0;
  bar.style.width = `${ratio * 100}%`;
  bar.dataset.low = ratio <= 0.2 ? 'true' : 'false';
}

async function loadTotpCode() {
  if (!totpId) return;
  const result = await send('SV_GET_TOTP_CODE', { id: totpId });
  if (!result.ok) {
    handleError(result, '无法生成动态码');
    return;
  }
  $('totpCode').textContent = result.code;
  totpRemaining = result.remaining;
  totpPeriod = Number(result.period) || 30;
  updateTotpProgress();
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
  totpPeriod = Number(result.period) || 30;
  updateTotpProgress();
  $('totpMeta').textContent = `${result.username || '无用户名'} · ${result.remaining} 秒后刷新`;
  $('totpDialog').showModal();
  clearInterval(totpTimer);
  totpTimer = setInterval(() => {
    totpRemaining -= 1;
    if (totpRemaining <= 0) {
      void loadTotpCode();
      return;
    }
    updateTotpProgress();
    $('totpMeta').textContent = `${result.username || '无用户名'} · ${totpRemaining} 秒后刷新`;
  }, 1000);
}

function closeTotp() {
  clearInterval(totpTimer);
  totpTimer = 0;
  totpId = '';
  totpRemaining = 0;
  updateTotpProgress();
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
      const seconds = Number(state.settings.clipboardClearSeconds) || 0;
      const ok = await copyText(item.password, { clearAfterSeconds: seconds });
      toast(ok ? clipboardMessage('历史密码已复制', seconds) : '复制失败', { error: !ok });
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

const FILL_SEQUENCE_PRESETS = {
  '': [],
  username: [{ type: 'username' }],
  'username-wait-password': [
    { type: 'username' },
    { type: 'wait', ms: 300 },
    { type: 'password' },
  ],
  'username-password-totp-enter': [
    { type: 'username' },
    { type: 'password' },
    { type: 'totp' },
    { type: 'enter' },
  ],
};

function formatFillSequence(steps) {
  if (!Array.isArray(steps)) return '';
  return steps
    .map((step) => (step.type === 'wait' ? `wait ${step.ms}` : step.type === 'click' ? `click ${step.selector}` : step.type))
    .join('\n');
}

function parseFillSequence(text) {
  const steps = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (!line) continue;
    if (line.startsWith('wait')) {
      steps.push({ type: 'wait', ms: Math.min(10000, Math.max(0, Number(line.slice(4)) || 300)) });
    } else if (line.startsWith('click ')) {
      steps.push({ type: 'click', selector: raw.trim().slice(6).slice(0, 200) });
    } else if (['username', 'password', 'totp', 'tab', 'enter'].includes(line)) {
      steps.push({ type: line });
    } else {
      throw new Error(`无法识别填充步骤：${raw.trim()}`);
    }
  }
  return steps.slice(0, 20);
}

async function openEntryDialog(id = null) {
  setError($('entryError'), '');
  state.editingId = id;
  state.entryTotpMeta = null;
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
    $('entryAliasEmail').value = result.aliasEmail || '';
    $('entryAliasProvider').value = result.aliasProvider || '';
    $('entryPasskeyCredential').value = result.passkey?.credentialId || '';
    $('entryPasskeyRp').value = result.passkey?.rpId || '';
    $('entryPasskeyUsername').value = result.passkey?.username || '';
    $('entryPasskeyNote').value = result.passkey?.note || '';
    $('entryFillSteps').value = formatFillSequence(result.fillSequence);
    $('entryFillPreset').value = '';
    $('entryPassword').value = result.password || '';
    $('entryNotes').value = result.notes || '';
    $('entryTotp').value = result.totpSecret || '';
    state.entryTotpMeta = result.totpSecret
      ? {
          digits: result.totpDigits || 6,
          period: result.totpPeriod || 30,
          algorithm: result.totpAlgorithm || 'SHA1',
        }
      : null;
    $('entryTotpHint').textContent = result.totpSecret
      ? '已配置 TOTP；可粘贴新的 otpauth 链接替换。'
      : '';
    $('entryFolder').value = result.folder || '';
    $('entryTags').value = Array.isArray(result.tags) ? result.tags.join(', ') : '';
    $('entryFavorite').checked = Boolean(result.favorite);
    $('entryTimeLabel').textContent = `密码记录于 ${formatDateTime(
      result.passwordChangedAt,
    )}；修改密码会更新为当前时间。`;
  } else {
    $('entryHost').value = '';
    $('entryTitle').value = '';
    $('entryUsername').value = '';
    $('entryAliasEmail').value = '';
    $('entryAliasProvider').value = '';
    $('entryPasskeyCredential').value = '';
    $('entryPasskeyRp').value = '';
    $('entryPasskeyUsername').value = '';
    $('entryPasskeyNote').value = '';
    $('entryFillSteps').value = '';
    $('entryFillPreset').value = '';
    $('entryPassword').value = '';
    $('entryNotes').value = '';
    $('entryTotp').value = '';
    $('entryTotpHint').textContent = '';
    $('entryFolder').value = '';
    $('entryTags').value = '';
    $('entryFavorite').checked = false;
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

async function importTotpQr(file) {
  if (!file) return;
  const hint = $('entryTotpHint');
  if (!('BarcodeDetector' in window)) {
    hint.textContent = '当前 Chrome 不支持二维码识别，请直接粘贴 otpauth 链接。';
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const bitmap = await createImageBitmap(file);
    const codes = await detector.detect(bitmap);
    const raw = codes[0]?.rawValue?.trim();
    if (!raw) throw new Error('图片中没有识别到二维码');
    if (parseOtpAuthUri(raw)) {
      $('entryTotp').value = raw;
      hint.textContent = '已识别 otpauth 链接，保存时会解析密钥和参数。';
    } else if (/^[A-Z2-7\s-]+=*$/i.test(raw)) {
      $('entryTotp').value = raw;
      hint.textContent = '已识别 Base32 密钥。';
    } else {
      throw new Error('二维码不是 TOTP 密钥');
    }
  } catch (error) {
    hint.textContent = error?.message || '二维码识别失败';
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
  const passkey = {
    credentialId: $('entryPasskeyCredential').value.trim(),
    rpId: $('entryPasskeyRp').value.trim(),
    username: $('entryPasskeyUsername').value.trim(),
    note: $('entryPasskeyNote').value.trim(),
  };
  const hasPasskey = Boolean(passkey.credentialId || passkey.rpId || passkey.username || passkey.note);
  if (!password && !hasPasskey) {
    setError($('entryError'), '密码不能为空；只有 Passkey 记录时可以留空');
    return;
  }

  let fillSequence;
  try {
    fillSequence = parseFillSequence($('entryFillSteps').value);
  } catch (error) {
    setError($('entryError'), error.message);
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
    aliasEmail: $('entryAliasEmail').value.trim(),
    aliasProvider: $('entryAliasProvider').value.trim(),
    passkey: hasPasskey ? passkey : null,
    fillSequence,
    password,
    notes: $('entryNotes').value,
    totpSecret: $('entryTotp').value.trim(),
    totpDigits: state.entryTotpMeta?.digits,
    totpPeriod: state.entryTotpMeta?.period,
    totpAlgorithm: state.entryTotpMeta?.algorithm,
    favorite: $('entryFavorite').checked,
    tags: $('entryTags').value,
    folder: $('entryFolder').value.trim(),
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
  $('kdfSelect').value = settings.kdfAlgorithm || 'argon2id';
  if ($('syncTriggerSelect')) {
    const triggers = ['realtime', 'interval', 'scheduled', 'unlock', 'manual'];
    const trigger = triggers.includes(settings.syncTrigger) ? settings.syncTrigger : 'realtime';
    $('syncTriggerSelect').value = trigger;
    $('syncIntervalRow').hidden = trigger !== 'interval';
    $('syncScheduleRow').hidden = trigger !== 'scheduled';
    $('syncIntervalMinutes').value = String(settings.syncIntervalMinutes ?? 15);
    $('syncScheduleTime').value = settings.syncScheduleTime || '09:00';
  }
  $('savePromptPositionSelect').value = settings.savePromptPosition || 'top-right';
  $('themeSelect').value = settings.theme || 'system';
  $('materialSelect').value = settings.material || 'solid';
  if ($('uiLanguageSelect')) {
    $('uiLanguageSelect').value = ['auto', 'zh-CN', 'en'].includes(settings.uiLanguage)
      ? settings.uiLanguage
      : 'auto';
  }
  for (const key of [
    'savePrompt',
    'showIcon',
    'autoFill',
    'autoOpenOnFocus',
    'allowSequenceSubmit',
    'privacyShieldOnBlur',
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

let kdbxArgonReady = false;

function kdbxEngine() {
  const kdbx = globalThis.kdbxweb;
  if (!kdbx) throw new Error('KDBX 模块未加载，请刷新设置页');
  if (!kdbxArgonReady) {
    const haswasm = globalThis.hashwasm;
    if (haswasm?.argon2id) {
      kdbx.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type) => {
        const fn =
          type === 0 ? haswasm.argon2d
          : type === 1 ? haswasm.argon2i
          : haswasm.argon2id;
        return fn({
          password: new Uint8Array(password),
          salt: new Uint8Array(salt),
          parallelism: Math.max(1, parallelism || 1),
          iterations: Math.max(1, iterations || 1),
          memorySize: Math.max(8, memory || 8),
          hashLength: length || 32,
          outputType: 'binary',
        }).then((result) => result.buffer);
      });
    }
    kdbxArgonReady = true;
  }
  return kdbx;
}

async function importKdbxFile() {
  setError($('kdbxError'), '');
  const file = $('kdbxFile').files?.[0];
  const password = $('kdbxPassword').value;
  const keyFile = $('kdbxKeyFile')?.files?.[0] || null;
  if (!file) {
    setError($('kdbxError'), '请选择 .kdbx 文件');
    return;
  }
  if (!password) {
    setError($('kdbxError'), '请输入该 KDBX 的密码');
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    setError($('kdbxError'), '文件超过 25 MB，无法导入');
    return;
  }
  const button = $('kdbxImportBtn');
  setBusy(button, true, '正在解析 KDBX…');
  try {
    const kdbx = kdbxEngine();
    const credentials = new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
    if (keyFile) {
      if (keyFile.size > 1024 * 1024) throw new Error('KDBX 密钥文件超过 1 MB');
      await credentials.setKeyFile(await keyFile.arrayBuffer());
    }
    const db = await kdbx.Kdbx.load(await file.arrayBuffer(), credentials);
    const rows = collectKdbxRows(db.groups?.[0]);
    if (rows.length === 0) throw new Error('KDBX 中没有带网址和密码的登录条目');
    const preview = await send('SV_PREVIEW_IMPORT_ROWS', {
      entries: rows,
      total: rows.length,
      format: 'KDBX',
      warnings: [],
    });
    if (!preview.ok) throw new Error(preview.error || '导入预演失败');
    state.pendingImport = {
      kind: 'rows',
      entries: rows,
      skipped: 0,
      total: rows.length,
      format: 'KDBX',
      warnings: [],
      fileName: file.name,
    };
    showImportPreview(preview, file.name);
    $('kdbxPassword').value = '';
    $('kdbxFile').value = '';
    if ($('kdbxKeyFile')) $('kdbxKeyFile').value = '';
  } catch (error) {
    const message = String(error?.message || '');
    setError(
      $('kdbxError'),
      /InvalidKey|Invalid key/i.test(message) ? 'KDBX 密码错误或文件已损坏' : message || 'KDBX 解析失败',
    );
  } finally {
    setBusy(button, false);
  }
}

async function exportKdbx() {
  setError($('kdbxError'), '');
  const password = $('kdbxExportPassword').value;
  if (password.length < 10) {
    setError($('kdbxError'), '导出密码至少需要 10 位');
    return;
  }
  const button = $('kdbxExportBtn');
  setBusy(button, true, '正在生成 KDBX…');
  try {
    const kdbx = kdbxEngine();
    const credentials = new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
    const db = kdbx.Kdbx.create(credentials, 'SubVault');
    const root = db.getDefaultGroup();
    const groupCache = new Map([['', root]]);
    const groupFor = (folder) => {
      const path = String(folder || '')
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean);
      let parent = root;
      let key = '';
      for (const name of path) {
        key = key ? `${key}/${name}` : name;
        if (!groupCache.has(key)) groupCache.set(key, db.createGroup(parent, name));
        parent = groupCache.get(key);
      }
      return parent;
    };
    const secrets = await send('SV_GET_ALL_SECRETS');
    if (!secrets.ok) throw new Error(secrets.error || '读取账号失败');
    for (const entry of secrets.entries) {
      const item = db.createEntry(groupFor(entry.folder));
      item.fields.set('Title', entry.title || entry.host);
      item.fields.set('UserName', entry.username || '');
      if (entry.aliasEmail) item.fields.set('alias_email', entry.aliasEmail);
      if (entry.aliasProvider) item.fields.set('alias_provider', entry.aliasProvider);
      if (entry.passkey?.credentialId) item.fields.set('passkey_credential_id', entry.passkey.credentialId);
      if (entry.passkey?.rpId) item.fields.set('passkey_rp_id', entry.passkey.rpId);
      if (entry.passkey?.username) item.fields.set('passkey_username', entry.passkey.username);
      if (entry.passkey?.note) item.fields.set('passkey_note', entry.passkey.note);
      item.fields.set('Password', kdbx.ProtectedValue.fromString(entry.password || ''));
      item.fields.set('URL', entry.url || (entry.host ? `https://${entry.host}` : ''));
      item.fields.set('Notes', entry.notes || '');
      if (Array.isArray(entry.tags) && entry.tags.length) item.tags = [...entry.tags];
      if (entry.totpSecret) {
        item.fields.set(
          'otp',
          /^otpauth:\/\//i.test(entry.totpSecret)
            ? entry.totpSecret
            : `otpauth://totp/${encodeURIComponent(entry.title || entry.host || 'SubVault')}?secret=${encodeURIComponent(
                entry.totpSecret,
              )}&digits=${Number(entry.totpDigits) === 8 ? 8 : 6}&period=${
                Number(entry.totpPeriod) || 30
              }&algorithm=${encodeURIComponent(entry.totpAlgorithm || 'SHA1')}`,
        );
      }
    }
    const buffer = await db.save();
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `subvault-${new Date().toISOString().slice(0, 10)}.kdbx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    $('kdbxExportPassword').value = '';
    toast(`已导出 ${state.entries.length} 个账号到 KDBX`);
  } catch (error) {
    setError($('kdbxError'), error?.message || 'KDBX 导出失败');
  } finally {
    setBusy(button, false);
  }
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
    const lowerName = file.name.toLowerCase();
    if (!/\.(csv|json|1pux)$/i.test(lowerName)) {
      throw new Error('请选择 CSV、Bitwarden JSON 或 1PUX 文件');
    }
    if (!lowerName.endsWith('.csv')) {
      const parsed = await parseImportFile(file);
      const preview = await send('SV_PREVIEW_IMPORT_ROWS', {
        entries: parsed.entries,
        skipped: parsed.skipped,
        total: parsed.total,
        format: parsed.format,
        warnings: parsed.warnings,
      });
      if (!preview.ok) {
        showImportError(preview.error || '导入预演失败');
        return;
      }
      state.pendingImport = {
        kind: 'rows',
        entries: parsed.entries,
        skipped: parsed.skipped,
        total: parsed.total,
        format: parsed.format,
        warnings: parsed.warnings,
        fileName: file.name,
      };
      showImportPreview(preview, file.name);
      return;
    }
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
      kind: 'csv',
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

function updatePreviewSelectionUi() {
  const rows = state.pendingImport?.previewRows || [];
  const selection = state.pendingImport?.selection;
  if (!Array.isArray(rows) || !(selection instanceof Set)) return;
  const count = $('importPreview').querySelector('.preview-rows-count');
  if (count) count.textContent = `已选择 ${selection.size} / ${rows.length} 条`;
  const all = $('importPreview').querySelector('.preview-select-all');
  if (all) {
    all.checked = rows.length > 0 && selection.size === rows.length;
    all.indeterminate = selection.size > 0 && selection.size < rows.length;
  }
  const confirm = $('importPreview').querySelector('[data-preview-confirm]');
  if (confirm) confirm.disabled = selection.size === 0;
}

function buildPreviewRows(rows) {
  const section = div('preview-rows');
  const head = div('preview-rows-head');
  const toggle = document.createElement('label');
  const all = document.createElement('input');
  all.type = 'checkbox';
  all.className = 'preview-select-all';
  all.checked = state.pendingImport.selection.size === rows.length;
  all.addEventListener('change', () => {
    state.pendingImport.selection = new Set(
      all.checked ? rows.map((row) => row.index) : [],
    );
    for (const checkbox of section.querySelectorAll('.preview-row-check')) {
      checkbox.checked = all.checked;
    }
    updatePreviewSelectionUi();
  });
  toggle.append(all, document.createTextNode('全选（已存在的默认不勾选）'));
  const count = document.createElement('span');
  count.className = 'preview-rows-count';
  count.textContent = `已选择 ${state.pendingImport.selection.size} / ${rows.length} 条`;
  head.append(toggle, count);
  section.appendChild(head);

  const list = div('preview-row-list');
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const item = document.createElement('label');
    item.className = `preview-row${row.duplicate ? ' is-duplicate' : ''}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'preview-row-check';
    checkbox.checked = state.pendingImport.selection.has(row.index);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.pendingImport.selection.add(row.index);
      else state.pendingImport.selection.delete(row.index);
      updatePreviewSelectionUi();
    });
    const title = document.createElement('span');
    title.className = 'preview-row-title';
    title.textContent = row.title || row.host;
    const meta = document.createElement('span');
    meta.className = 'preview-row-meta';
    meta.textContent = `${row.host}${row.username ? ` · ${row.username}` : ''}`;
    const badge = document.createElement('span');
    badge.className = 'preview-row-badge';
    badge.textContent = row.duplicate ? '已存在' : '新增';
    item.append(checkbox, title, meta, badge);
    fragment.appendChild(item);
  }
  list.appendChild(fragment);
  section.appendChild(list);
  return section;
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
        ? `时间依据：${result.format || '导入文件'} 中的密码更改时间。`
        : '时间依据：文件没有时间信息，使用当前时间或文件修改时间。',
    ),
  );

  if (Array.isArray(result.rows) && result.rows.length > 0) {
    state.pendingImport.previewRows = result.rows;
    state.pendingImport.selection = new Set(
      result.rows.filter((row) => !row.duplicate).map((row) => row.index),
    );
    box.append(buildPreviewRows(result.rows));
  }

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
  confirm.dataset.previewConfirm = '1';
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
  updatePreviewSelectionUi();
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
    let entries = state.pendingImport.entries;
    let skipped = state.pendingImport.skipped;
    if (
      state.pendingImport.selection instanceof Set &&
      Array.isArray(state.pendingImport.previewRows)
    ) {
      const selection = state.pendingImport.selection;
      const allRows = entries;
      entries = allRows.filter((_, index) => selection.has(index));
      skipped += allRows.length - entries.length;
      if (entries.length === 0) {
        toast('请至少勾选一条要导入的记录', { error: true });
        button.textContent = '确认导入（先自动保存快照）';
        return;
      }
    }
    const result =
      state.pendingImport.kind === 'rows'
        ? await send('SV_IMPORT_ROWS', {
            entries,
            skipped,
            total: entries.length,
            format: state.pendingImport.format,
            warnings: state.pendingImport.warnings,
          })
        : await send('SV_IMPORT_CSV', {
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

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function refreshBackupHealth() {
  const box = $('backupHealth');
  let meta = null;
  try {
    meta = (await chrome.storage.local.get('backupMeta')).backupMeta || null;
  } catch {
    meta = null;
  }
  if (!meta?.at) {
    box.className = 'status-box warn';
    box.textContent = '最近备份：尚未记录。建议立即导出一次加密备份。';
    return;
  }
  const days = Math.floor((Date.now() - Number(meta.at)) / 86_400_000);
  box.className = days > 30 ? 'status-box warn' : 'status-box';
  box.textContent = `最近备份：${formatDateTime(meta.at)}（${days} 天前）${
    meta.checksum ? ` · SHA-256 ${meta.checksum.slice(0, 12)}…` : ''
  }${days > 30 ? '。建议重新备份。' : ''}`;
}

async function verifyBackupStructure() {
  if (!state.backupText) {
    toast('请先选择备份文件', { error: true });
    return;
  }
  try {
    const parsed = JSON.parse(state.backupText);
    if (!parsed || typeof parsed !== 'object' || !parsed.box) {
      throw new Error('不是 SubVault 加密备份');
    }
    toast('备份结构有效', '加密数据存在，恢复时仍需校验密码。');
  } catch (error) {
    toast('备份校验失败', error?.message || 'JSON 格式无效', { error: true });
  }
}

function downloadRecoveryKit() {
  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [
    'SubVault Recovery Kit',
    '',
    `生成时间：${formatDateTime(Date.now())}`,
    `扩展版本：${chrome.runtime.getManifest().version}`,
    `账号数量：${state.entries.length}`,
    '',
    '重要说明：',
    '1. SubVault 没有云端账号，也没有服务器端恢复通道。',
    '2. 加密备份必须配合备份创建时的主密码或独立备份密码使用。',
    '3. 主密码、独立备份密码和恢复文件应分开保存在安全位置。',
    '4. 不要通过聊天软件、邮件或普通网盘明文传输主密码。',
    '',
    '恢复步骤：',
    '1. 安装同版本或更新版本的 SubVault。',
    '2. 打开设置 → 导入与导出。',
    '3. 选择加密备份文件并输入对应密码。',
    '4. 先在空密码库或合并模式中验证账号，再执行覆盖恢复。',
    '',
    '如需重新导出，请在设置页点击“导出加密备份”。',
  ];
  downloadText(`subvault-recovery-kit-${stamp}.txt`, lines.join('\n'), 'text/plain;charset=utf-8');
  toast('恢复说明已下载', '请与加密备份分开保存。');
}

async function exportBackup() {
  const backupPassword = $('exportBackupPassword').value;
  if (backupPassword && backupPassword.length < 10) {
    toast('独立备份密码至少需要 10 个字符', { error: true });
    return;
  }
  const expiryDays = Number($('exportBackupExpiry').value) || 0;
  if (expiryDays && !backupPassword) {
    toast('设置备份有效期时必须填写独立备份密码', { error: true });
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
  const backupExpiresAt = expiryDays ? Date.now() + expiryDays * 86400000 : 0;
  const result = await send('SV_EXPORT_BACKUP', { backupPassword, backupExpiresAt });
  if (!result.ok) {
    handleError(result, '导出备份失败');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const checksum = await sha256Hex(result.backup);
  downloadText(`subvault-backup-${stamp}.json`, result.backup, 'application/json');
  downloadText(`subvault-backup-${stamp}.sha256`, `${checksum}  subvault-backup-${stamp}.json\n`);
  await chrome.storage.local.set({
    backupMeta: { at: Date.now(), checksum, independent: Boolean(result.independent) },
  });
  await refreshBackupHealth();
  $('exportBackupPassword').value = '';
  $('exportBackupExpiry').value = '0';
  toast(
    result.independent
      ? '已导出独立密码加密的备份，请单独保管该密码'
      : '已导出主密码加密的备份',
    `SHA-256 ${checksum.slice(0, 12)}…`,
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
  const strength = await evaluateMasterPassword(next);
  if (strength.blocked) {
    setError($('changePasswordError'), strength.message || '新主密码强度不足');
    return;
  }
  if (strength.needsConfirm && !$('newPasswordAck').checked) {
    setError($('changePasswordError'), strength.message || '该主密码强度一般，请勾选确认后继续');
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
  $('newPasswordAck').checked = false;
  refreshNewPasswordStrength();
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

function arrangeSettingsSections() {
  const move = (cardId, sectionName) => {
    const card = $(cardId);
    const section = $(`section-${sectionName}`);
    if (card && section) section.appendChild(card);
  };
  move('syncCard', 'sync');
  move('webdavCard', 'sync');
  move('takeoverCard', 'takeover');
  move('generalCard', 'general');
}

function clearSettingsSearch() {
  const input = $('settingsSearch');
  if (input && input.value) input.value = '';
  for (const card of document.querySelectorAll('.section .card')) {
    card.hidden = false;
  }
}

function applySettingsSearch(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) {
    clearSettingsSearch();
    selectSection(state.section);
    return;
  }
  for (const section of document.querySelectorAll('.section')) {
    let any = false;
    for (const card of section.querySelectorAll('.card')) {
      const match = (card.textContent || '').toLowerCase().includes(needle);
      card.hidden = !match;
      if (match) any = true;
    }
    section.hidden = !any;
  }
}

function selectSection(name) {
  const section = PAGE_META[name] ? name : 'vault';
  state.section = section;
  clearSettingsSearch();
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
  if (section === 'general' || section === 'security' || section === 'takeover' || section === 'language') {
    applySettings();
  }
  if (section === 'general') {
    void refreshVaultManage();
    void refreshProfilesManage();
  }
  if (section === 'security' || section === 'takeover') {
    renderTakeover();
  }
  if (section === 'security' || section === 'sync') {
    void refreshSyncCenter();
    void refreshWebdavConfig();
    void refreshWebdavBackupStatus();
    void refreshMigrationStatus();
    void refreshDeviceBinding();
  }
  if (section === 'language') {
    const sample = $('formatSample');
    if (sample) sample.textContent = formatDateTime(Date.now());
  }
  if (section === 'domains') {
    renderDomains();
    renderExceptions();
    renderPreview();
  }
  if (section === 'share') {
    renderShareEntries();
    void refreshTravel().catch(() => {});
  }
}

function enhanceFilePickers() {
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  for (const input of document.querySelectorAll('input[type="file"]:not([hidden])')) {
    if (input.dataset.filePickerReady) continue;
    input.dataset.filePickerReady = '1';
    input.classList.add('file-native');
    const picker = document.createElement('div');
    picker.className = 'file-picker';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost file-picker-btn';
    button.textContent = '选择文件';
    const label = document.createElement('span');
    label.className = 'file-picker-name';
    const sync = () => {
      const file = input.files && input.files[0];
      label.textContent = file ? file.name : '未选择文件';
      label.title = label.textContent;
    };
    picker.append(button, label);
    input.after(picker);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.click();
    });
    input.addEventListener('change', sync);
    if (valueDescriptor?.get && valueDescriptor?.set) {
      Object.defineProperty(input, 'value', {
        configurable: true,
        get() {
          return valueDescriptor.get.call(this);
        },
        set(value) {
          valueDescriptor.set.call(this, value);
          sync();
        },
      });
    }
    sync();
  }
}

function generateExportSecret(inputId) {
  const input = $(inputId);
  if (!input) return;
  input.value = generatePassword({ length: 20, readable: true });
  input.type = 'text';
  toast('已生成强随机密码', '请立即复制保存；关闭页面后无法恢复');
}

function bindEvents() {
  $('migrationRollbackBtn')?.addEventListener('click', () => void rollbackMigration());
  $('gateDeviceUnlockBtn')?.addEventListener('click', () => void deviceUnlockFromGate());
  $('deviceEnableBtn')?.addEventListener('click', () => void enableDeviceBinding());
  $('deviceDisableBtn')?.addEventListener('click', () => void disableDeviceBinding());
  $('newVaultCreateBtn')?.addEventListener('click', () => void createVaultFromSettings());
  $('profileSelectOptions')?.addEventListener('change', (event) => loadProfileIntoForm(event.target.value));
  $('profileSaveBtn')?.addEventListener('click', () => void saveProfileFromSettings());
  $('profileDeleteBtn')?.addEventListener('click', () => void deleteProfileFromSettings());
  $('gateKeyFileToggle')?.addEventListener('change', () => {
    $('gateKeyFileRow').hidden = !$('gateKeyFileToggle').checked;
  });

  $('keyFileSaveBtn')?.addEventListener('click', async () => {
    setError($('keyFileError'), '');
    const password = $('keyFilePassword').value;
    if (!password) {
      setError($('keyFileError'), '请输入当前主密码');
      return;
    }
    const nextFile = $('keyFileNew').files?.[0];
    if (!nextFile) {
      setError($('keyFileError'), '请选择新密钥文件');
      return;
    }
    let currentKeyFileBase64 = '';
    if (state.keyFile) {
      const currentFile = $('keyFileCurrent').files?.[0];
      if (!currentFile) {
        setError($('keyFileError'), '当前已启用密钥文件，请先选择当前密钥文件');
        return;
      }
      currentKeyFileBase64 = await readFileBase64(currentFile);
    }
    const newKeyFileBase64 = await readFileBase64(nextFile);
    const result = await send('SV_SET_KEY_FILE', {
      password,
      currentKeyFileBase64,
      newKeyFileBase64,
    });
    if (!result.ok) {
      setError($('keyFileError'), result.error || '设置失败');
      return;
    }
    $('keyFilePassword').value = '';
    $('keyFileNew').value = '';
    if ($('keyFileCurrent')) $('keyFileCurrent').value = '';
    state.keyFile = Boolean(result.keyFile);
    renderKeyFile();
    toast('密钥文件已启用');
  });

  $('keyFileDisableBtn')?.addEventListener('click', async () => {
    setError($('keyFileError'), '');
    const password = $('keyFilePassword').value;
    if (!password) {
      setError($('keyFileError'), '请输入当前主密码');
      return;
    }
    const currentFile = $('keyFileCurrent').files?.[0];
    if (!currentFile) {
      setError($('keyFileError'), '请选择当前密钥文件');
      return;
    }
    const result = await send('SV_SET_KEY_FILE', {
      password,
      currentKeyFileBase64: await readFileBase64(currentFile),
      newKeyFileBase64: '',
    });
    if (!result.ok) {
      setError($('keyFileError'), result.error || '停用失败');
      return;
    }
    $('keyFilePassword').value = '';
    if ($('keyFileCurrent')) $('keyFileCurrent').value = '';
    state.keyFile = false;
    renderKeyFile();
    toast('密钥文件已停用');
  });
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => selectSection(button.dataset.section));
  });
  $('settingsSearch')?.addEventListener('input', (event) => {
    applySettingsSearch(event.target.value);
  });

  $('headAddBtn').addEventListener('click', () => void openEntryDialog());
  $('lockNow').addEventListener('click', async () => {
    await send('SV_LOCK');
    showGate('unlock');
  });

  $('pslImportBtn')?.addEventListener('click', async () => {
    const file = $('pslFile')?.files?.[0];
    setError($('pslError'), '');
    if (!file) {
      setError($('pslError'), '请先选择 PSL 文件');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError($('pslError'), 'PSL 文件过大（上限 2 MB）');
      return;
    }
    const button = $('pslImportBtn');
    setBusy(button, true, '导入中…');
    try {
      const text = await file.text();
      const result = await send('SV_SET_CUSTOM_PSL', { text });
      if (!result.ok) {
        setError($('pslError'), result.error || '导入失败');
      } else {
        $('pslStatus').textContent = `已导入 ${result.accepted} 条规则，共 ${result.rules} 条自定义规则。`;
        await refreshPslStatus();
      }
    } finally {
      setBusy(button, false);
      if ($('pslFile')) $('pslFile').value = '';
    }
  });

  $('pslClearBtn')?.addEventListener('click', async () => {
    await send('SV_CLEAR_CUSTOM_PSL');
    await refreshPslStatus();
  });

  $('gateVaultSelect')?.addEventListener('change', syncGateVaultMeta);
  $('gateUnlockForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    setError($('gateError'), '');
    const password = $('gatePassword').value;
    if (!password) {
      setError($('gateError'), '请输入主密码');
      return;
    }
    let keyFileBase64 = '';
    if (!$('gateUnlockKeyFileRow').hidden) {
      const file = $('gateUnlockKeyFile').files?.[0];
      if (!file) {
        setError($('gateError'), '请选择密钥文件');
        return;
      }
      keyFileBase64 = await readFileBase64(file);
    }
    const button = $('gateUnlockBtn');
    setBusy(button, true, '正在解锁…');
    const vaultId = $('gateVaultSelect')?.value || '';
    const result = await send('SV_UNLOCK', { password, keyFileBase64, vaultId });
    setBusy(button, false);
    if (!result.ok) {
      setError($('gateError'), result.error || '解锁失败');
      return;
    }
    $('gatePassword').value = '';
    if ($('gateUnlockKeyFile')) $('gateUnlockKeyFile').value = '';
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
    const file = $('gateImportKeyFile')?.files?.[0];
    const keyFileBase64 = file ? await readFileBase64(file) : '';
    const result = await send('SV_SYNC_IMPORT', { password, keyFileBase64 });
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
    const strength = await evaluateMasterPassword(password);
    if (strength.blocked) {
      setError($('gateError'), strength.message || '主密码强度不足');
      return;
    }
    if (strength.needsConfirm && !$('gateStrengthAck').checked) {
      setError($('gateError'), strength.message || '该主密码强度一般，请勾选确认后继续');
      return;
    }
    let keyFileBase64 = '';
    if ($('gateKeyFileToggle').checked) {
      const file = $('gateKeyFile').files?.[0];
      if (!file) {
        setError($('gateError'), '请选择密钥文件，或取消勾选');
        return;
      }
      keyFileBase64 = await readFileBase64(file);
    }
    const button = $('gateSetupBtn');
    setBusy(button, true, '正在创建加密密码库…');
    const result = await send('SV_SETUP', { password, keyFileBase64 });
    setBusy(button, false);
    if (!result.ok) {
      setError($('gateError'), result.error || '创建失败');
      return;
    }
    $('gateNewPassword').value = '';
    $('gateConfirmPassword').value = '';
    $('gateStrengthAck').checked = false;
    refreshGateStrength();
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
  $('bulkFavoriteBtn').addEventListener('click', () => void bulkSetFavorite(true));
  $('bulkUnfavoriteBtn').addEventListener('click', () => void bulkSetFavorite(false));
  $('bulkDeleteBtn').addEventListener('click', () => void bulkDelete());
  $('bulkClearBtn').addEventListener('click', () => {
    state.selected.clear();
    renderVault();
  });

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
  $('entryFillPreset').addEventListener('change', () => {
    const preset = $('entryFillPreset').value;
    $('entryFillSteps').value = formatFillSequence(FILL_SEQUENCE_PRESETS[preset] || []);
  });
  $('entrySave').addEventListener('click', () => void saveEntry());
  $('entryPasskeyClear').addEventListener('click', () => {
    $('entryPasskeyCredential').value = '';
    $('entryPasskeyRp').value = '';
    $('entryPasskeyUsername').value = '';
    $('entryPasskeyNote').value = '';
  });
  $('entryHost').addEventListener('input', updateEntryPolicyHint);
  $('entryPassword').addEventListener('input', () => {
    updateStrength($('entryPassword'), $('entryStrengthBar'), $('entryStrengthText'));
  });
  $('entryGenerate').addEventListener('click', () => {
    const options = state.settings?.generatorOptions || {};
    $('entryPassword').value = options.pin
      ? generatePin(options.length)
      : generatePassword({
          length: options.length || 20,
          lower: options.lower !== false,
          upper: options.upper !== false,
          digits: options.digits !== false,
          symbols: options.symbols !== false,
          readable: options.readable !== false,
        });
    $('entryPassword').type = 'text';
    $('entryReveal').textContent = '隐藏';
    updateStrength($('entryPassword'), $('entryStrengthBar'), $('entryStrengthText'));
  });
  $('entryTotp').addEventListener('input', () => {
    state.entryTotpMeta = null;
    const raw = $('entryTotp').value.trim();
    if (!raw) {
      $('entryTotpHint').textContent = '';
      return;
    }
    try {
      const parsed = parseOtpAuthUri(raw);
      $('entryTotpHint').textContent = parsed
        ? `${parsed.issuer || 'TOTP'} · ${parsed.account || '账号'} · ${parsed.algorithm} / ${parsed.period}s`
        : 'Base32 密钥；保存时校验。';
    } catch (error) {
      $('entryTotpHint').textContent = error?.message || 'otpauth 链接无效';
    }
  });
  $('entryTotpQrBtn').addEventListener('click', () => $('entryTotpQrFile').click());
  $('entryTotpQrFile').addEventListener('change', () => {
    const file = $('entryTotpQrFile').files?.[0];
    void importTotpQr(file).finally(() => {
      $('entryTotpQrFile').value = '';
    });
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
  $('kdfSelect').addEventListener('change', () => {
    void saveSettings({ kdfAlgorithm: $('kdfSelect').value });
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
  $('uiLanguageSelect')?.addEventListener('change', async () => {
    const language = $('uiLanguageSelect').value;
    setUiLanguage(language);
    applyI18n(document.body);
    await saveSettings({ uiLanguage: language });
    selectSection(location.hash.replace('#', '') || 'vault');
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
  $('newPassword').addEventListener('input', refreshNewPasswordStrength);
  $('gateNewPassword').addEventListener('input', refreshGateStrength);

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

  $('kdbxImportBtn')?.addEventListener('click', () => void importKdbxFile());
  $('kdbxExportBtn')?.addEventListener('click', () => void exportKdbx());
  $('kdbxExportGenerate')?.addEventListener('click', () => generateExportSecret('kdbxExportPassword'));
  $('exportBackupGenerate')?.addEventListener('click', () => generateExportSecret('exportBackupPassword'));
  $('shareGenerate')?.addEventListener('click', () => generateExportSecret('sharePassword'));

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
  $('recoveryKitBtn').addEventListener('click', downloadRecoveryKit);
  $('verifyBackupBtn').addEventListener('click', () => void verifyBackupStructure());
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
  $('syncTriggerSelect')?.addEventListener('change', () => {
    const trigger = $('syncTriggerSelect').value;
    $('syncIntervalRow').hidden = trigger !== 'interval';
    $('syncScheduleRow').hidden = trigger !== 'scheduled';
    void saveSettings({ syncTrigger: trigger });
  });
  $('syncIntervalMinutes')?.addEventListener('change', () => {
    const minutes = Math.min(1440, Math.max(5, Math.round(Number($('syncIntervalMinutes').value) || 15)));
    $('syncIntervalMinutes').value = String(minutes);
    void saveSettings({ syncIntervalMinutes: minutes });
  });
  $('syncScheduleTime')?.addEventListener('change', () => {
    void saveSettings({ syncScheduleTime: $('syncScheduleTime').value || '09:00' });
  });
  $('webdavBackupBtn')?.addEventListener('click', () => void backupWebdavNow());
  $('webdavRestoreBtn')?.addEventListener('click', () => void restoreWebdavBackup());
  $('webdavSaveBtn')?.addEventListener('click', () => void saveWebdavConfig());
  $('webdavClearBtn')?.addEventListener('click', () => void clearWebdavConfig());
  $('syncNowBtn')?.addEventListener('click', () => void syncNow());
  $('syncRefreshBtn')?.addEventListener('click', () => void refreshSyncCenter());
  $('syncKeepRemoteBtn')?.addEventListener('click', () => void resolveSyncConflict('remote'));
  $('syncKeepLocalBtn')?.addEventListener('click', () => void resolveSyncConflict('local'));
  $('syncRestoreSnapshotBtn')?.addEventListener('click', () => void restoreWebdavSnapshot());

  $('shareEntryList')?.addEventListener('change', (event) => {
    const input = event.target.closest?.('input[data-share-id]');
    if (!input) return;
    if (input.checked) state.shareSelected.add(input.dataset.shareId);
    else state.shareSelected.delete(input.dataset.shareId);
    updateShareSelectionUi();
  });
  $('shareSearch')?.addEventListener('input', (event) => {
    state.shareFilter = event.target.value;
    renderShareEntries();
  });
  $('shareSelectAllBtn')?.addEventListener('click', () => {
    const inputs = [...document.querySelectorAll('#shareEntryList input[data-share-id]')];
    const allChecked = inputs.length > 0 && inputs.every((input) => input.checked);
    for (const input of inputs) {
      input.checked = !allChecked;
      if (input.checked) state.shareSelected.add(input.dataset.shareId);
      else state.shareSelected.delete(input.dataset.shareId);
    }
    updateShareSelectionUi();
  });
  $('shareExportBtn')?.addEventListener('click', () => void exportShare());
  $('shareImportBtn')?.addEventListener('click', () => void importShare());

  $('travelEntryList')?.addEventListener('change', (event) => {
    const input = event.target.closest?.('input[data-travel-id]');
    if (!input) return;
    if (input.checked) state.travelHidden.add(input.dataset.travelId);
    else state.travelHidden.delete(input.dataset.travelId);
  });
  $('travelSelectAllBtn')?.addEventListener('click', () => {
    const inputs = [...document.querySelectorAll('#travelEntryList input[data-travel-id]')];
    const allChecked = inputs.length > 0 && inputs.every((input) => input.checked);
    for (const input of inputs) {
      input.checked = !allChecked;
      if (input.checked) state.travelHidden.add(input.dataset.travelId);
      else state.travelHidden.delete(input.dataset.travelId);
    }
  });
  $('travelSaveBtn')?.addEventListener('click', () => void saveTravel());
  $('travelDisableBtn')?.addEventListener('click', () => void disableTravelMode());

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SV_SYNC_CHANGED' && message.sync && !state.locked) {
      renderSyncCenter(message.sync);
    }
  });

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
  installI18n(document.body);
  installPrivacyShield();
  arrangeSettingsSections();
  enhanceFilePickers();
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
