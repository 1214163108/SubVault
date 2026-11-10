/**
 * SubVault background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - own the encrypted vault (chrome.storage.local) and the unlocked session
 *  - derive/keep the AES key only in memory (chrome.storage.session)
 *  - route narrowly-scoped messages from content scripts and extension pages
 *  - match credentials by effective site bucket (parent domain by default,
 *    exact host for configured isolated main domains)
 *  - keep short-lived "pending save" candidates and offer them on the next page
 *  - import/export CSV and encrypted backups
 */

import {
  KDF_ITERATIONS,
  KDF_LEGACY_HASH,
  KDF_MIN_ITERATIONS,
  VAULT_VERSION,
  createKdfParams,
  decryptJSON,
  deriveKey,
  encryptJSON,
  exportKeyJwk,
  importKeyJwk,
  isCommonPassword,
  randomId,
  passwordStrength,
} from '../lib/crypto.js';
import {
  hostFromUrl,
  isHostIsolated,
  isValidHost,
  matchesHost,
  normalizeDomainList,
  normalizeHost,
  normalizePort,
  parseHttpUrl,
  siteKeyFor,
} from '../lib/domain.js';
import { csvToEntries, entriesToCsv } from '../lib/csv.js';
import { entryTime, conflictGroupKey, mergeEntries } from '../lib/merge.js';
import { generateTotp, isValidTotpSecret, normalizeTotpSecret } from '../lib/totp.js';

const AAD = 'subvault:vault:v1';
const AAD_BACKUP = 'subvault:backup:v1';
const AAD_BACKUP_V3 = 'subvault:backup:v3';
const BACKUP_VERSION = 3;
const STORAGE = {
  vault: 'vault',
  settings: 'settings',
  session: 'session',
  pending: 'pending',
  ignores: 'saveIgnores',
  takeover: 'takeoverState',
  syncJoined: 'syncJoined',
};
const LIMITS = {
  entries: 5000,
  pending: 20,
  pendingTtlMs: 15 * 60 * 1000,
  title: 200,
  username: 320,
  password: 4096,
  notes: 5000,
  url: 2000,
  totp: 128,
};
const DEFAULT_SETTINGS = {
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
  lockOnSystemLock: true,
  lockOnSystemIdle: false,
  clipboardClearSeconds: 30,
  isolatedDomains: [],
  siteExceptions: {},
  portIsolation: false,
};
const ALARM_NAME = 'subvault-auto-lock';
const LOCK_ALARM_NAME = 'subvault-lock-at';
const SYNC_ALARM_NAME = 'subvault-sync-poll';

/** @type {{key: CryptoKey, keyJwk: any, kdf: any, data: any, lastActivity: number}|null} */
let session = null;
let settingsCache = null;
let loadingPromise = null;
let lastSessionPersist = 0;
let opQueue = Promise.resolve();

/* Local native sync state. The host only stores an encrypted blob + settings. */
let nativePort = null;
let nativeRequestSeq = 0;
const nativePending = new Map();
const syncInfo = { available: false, exists: false, revision: 0, updatedAt: 0, path: '' };
let syncBaseRevision = 0;
let syncReady = false;
let syncDirty = false;
let syncPushTimer = null;
let autoLockTimer = null;

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

function friendlyStorageError(error, action = '访问') {
  const message = String(error?.message || error || '未知错误');
  if (/quota|QUOTA_BYTES|quotaexceeded/i.test(message)) {
    return new Error('本地存储空间不足。请先导出加密备份，再清理不需要的账号或浏览器扩展数据。');
  }
  if (/permission|denied|not authorized|access/i.test(message)) {
    return new Error('浏览器拒绝了本地存储访问，请检查扩展权限或重新加载扩展。');
  }
  if (/ENOSPC|no space|disk/i.test(message)) {
    return new Error('磁盘空间不足，无法写入密码库。');
  }
  return new Error(`${action}本地存储失败：${message}`);
}

async function readLocal(key, fallback) {
  try {
    const stored = await chrome.storage.local.get(key);
    return stored[key] === undefined ? fallback : stored[key];
  } catch (error) {
    throw friendlyStorageError(error, '读取');
  }
}

async function writeLocal(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (error) {
    throw friendlyStorageError(error, '写入');
  }
}

async function readSessionArea(key, fallback) {
  try {
    const stored = await chrome.storage.session.get(key);
    return stored[key] === undefined ? fallback : stored[key];
  } catch {
    return fallback;
  }
}

async function writeSessionArea(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch {
    /* session storage may be unavailable */
  }
}

async function removeSessionArea(key) {
  try {
    await chrome.storage.session.remove(key);
  } catch {
    /* ignore */
  }
}

function normalizeSiteExceptions(input) {
  const output = {};
  if (!input || typeof input !== 'object') return output;
  for (const [rawHost, rawPolicy] of Object.entries(input)) {
    const host = normalizeHost(rawHost);
    if (!isValidHost(host) || !rawPolicy || typeof rawPolicy !== 'object') continue;
    const policy = {};
    if (rawPolicy.disableTakeover) policy.disableTakeover = true;
    if (rawPolicy.disableSavePrompt) policy.disableSavePrompt = true;
    if (rawPolicy.hideIcon) policy.hideIcon = true;
    if (Object.keys(policy).length > 0) output[host] = policy;
  }
  return output;
}

function sitePolicyFor(host) {
  const target = normalizeHost(host);
  const policy = settingsCache?.siteExceptions?.[target] || {};
  return {
    disableTakeover: Boolean(policy.disableTakeover),
    disableSavePrompt: Boolean(policy.disableSavePrompt),
    hideIcon: Boolean(policy.hideIcon),
  };
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await readLocal(STORAGE.settings, {});
  settingsCache = {
    ...DEFAULT_SETTINGS,
    ...(stored || {}),
    isolatedDomains: normalizeDomainList(stored?.isolatedDomains),
    siteExceptions: normalizeSiteExceptions(stored?.siteExceptions),
  };
  return settingsCache;
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (next.isolatedDomains !== undefined) {
    next.isolatedDomains = normalizeDomainList(next.isolatedDomains);
  }
  if (next.siteExceptions !== undefined) {
    next.siteExceptions = normalizeSiteExceptions(next.siteExceptions);
  }
  settingsCache = next;
  await writeLocal(STORAGE.settings, next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Chrome built-in password manager takeover                           */
/* ------------------------------------------------------------------ */

function chromePasswordSetting() {
  try {
    return chrome.privacy?.services?.passwordSavingEnabled || null;
  } catch {
    return null;
  }
}

/** chrome.privacy predates promise support, so always use callbacks. */
function getChromeSetting(setting) {
  return new Promise((resolve, reject) => {
    try {
      setting.get({}, (details) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(details);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function setChromeSetting(setting, value) {
  return new Promise((resolve, reject) => {
    try {
      setting.set({ value }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getTakeoverStatus() {
  const settings = await getSettings();
  const setting = chromePasswordSetting();
  if (!setting) {
    return {
      supported: false,
      enabled: Boolean(settings.disableChromeSavePrompt),
      chromeValue: null,
      changedByUs: false,
      levelOfControl: 'unavailable',
    };
  }
  try {
    const current = await getChromeSetting(setting);
    const state = await readLocal(STORAGE.takeover, {});
    return {
      supported: true,
      enabled: Boolean(settings.disableChromeSavePrompt),
      chromeValue: current.value === true,
      changedByUs: Boolean(state.changedByUs),
      levelOfControl: current.levelOfControl || '',
    };
  } catch (error) {
    return {
      supported: false,
      enabled: Boolean(settings.disableChromeSavePrompt),
      chromeValue: null,
      changedByUs: false,
      levelOfControl: 'error',
      error: error?.message || String(error),
    };
  }
}

/**
 * Enable/disable Chrome's global "offer to save passwords" preference.
 * The previous value is remembered so the switch can restore it. Extensions
 * cannot suppress the in-field Chrome key icon itself; that part is handled by
 * the content script + user guidance.
 */
async function setChromeSavePromptDisabled(disabled) {
  const setting = chromePasswordSetting();
  if (!setting) throw new Error('当前浏览器不支持 chrome.privacy 密码设置 API');

  let state = await readLocal(STORAGE.takeover, {});
  if (!state || typeof state !== 'object') state = {};
  const current = await getChromeSetting(setting);

  if (disabled) {
    if (current.value === true) {
      try {
        await setChromeSetting(setting, false);
      } catch (error) {
        throw new Error(`无法关闭 Chrome 保存密码提示：${error?.message || '设置被策略锁定'}`);
      }
      state = { changedByUs: true, previous: true, updatedAt: Date.now() };
    } else {
      state = { ...state, updatedAt: Date.now() };
    }
    await saveSettings({ disableChromeSavePrompt: true });
  } else {
    let restored = true;
    if (state.changedByUs && current.value === false) {
      try {
        await setChromeSetting(setting, state.previous !== false);
      } catch {
        restored = false;
      }
    }
    if (restored) {
      state = { changedByUs: false, previous: null, updatedAt: Date.now() };
      await saveSettings({ disableChromeSavePrompt: false });
    } else {
      state = { ...state, updatedAt: Date.now() };
      await saveSettings({ disableChromeSavePrompt: true });
    }
  }

  await writeLocal(STORAGE.takeover, state);
  return getTakeoverStatus();
}

/* ------------------------------------------------------------------ */
/* Vault / session                                                     */
/* ------------------------------------------------------------------ */

async function getVaultBlob() {
  const blob = await readLocal(STORAGE.vault, null);
  if (!blob || typeof blob !== 'object' || !blob.box || !blob.kdf) return null;
  return blob;
}

function sessionExpired(meta) {
  if (!meta) return true;
  const minutes = Number(
    settingsCache?.autoLockMinutes ?? DEFAULT_SETTINGS.autoLockMinutes,
  );
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  return Date.now() - Number(meta.lastActivity || 0) > minutes * 60 * 1000;
}

function clearAutoLockSchedule() {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  try {
    void chrome.alarms.clear(LOCK_ALARM_NAME);
  } catch {
    /* alarms may be unavailable during shutdown */
  }
}

function scheduleAutoLock() {
  clearAutoLockSchedule();
  if (!session || !settingsCache) return;
  const minutes = Number(
    settingsCache?.autoLockMinutes ?? DEFAULT_SETTINGS.autoLockMinutes,
  );
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const remaining = minutes * 60 * 1000 - (Date.now() - session.lastActivity);
  if (remaining <= 0) {
    void enforceAutoLock();
    return;
  }
  autoLockTimer = setTimeout(() => {
    autoLockTimer = null;
    void enforceAutoLock().then((stillUnlocked) => {
      if (stillUnlocked) scheduleAutoLock();
    });
  }, remaining);
  try {
    void chrome.alarms.create(LOCK_ALARM_NAME, { when: Date.now() + remaining });
  } catch {
    /* setTimeout still covers a live worker */
  }
}

async function persistSession() {
  if (!session) return;
  lastSessionPersist = Date.now();
  await writeSessionArea(STORAGE.session, {
    keyJwk: session.keyJwk,
    lastActivity: session.lastActivity,
  });
}

function touchSession() {
  if (!session) return;
  session.lastActivity = Date.now();
  scheduleAutoLock();
  if (Date.now() - lastSessionPersist > 15_000) void persistSession();
}

async function loadSession() {
  if (session) return true;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    await getSettings();
    const meta = await readSessionArea(STORAGE.session, null);
    if (!meta?.keyJwk) return false;
    if (sessionExpired(meta)) {
      await removeSessionArea(STORAGE.session);
      return false;
    }
    const blob = await getVaultBlob();
    if (!blob) {
      await removeSessionArea(STORAGE.session);
      return false;
    }
    try {
      const key = await importKeyJwk(meta.keyJwk);
      const data = await decryptJSON(key, blob.box, AAD);
      if (!data || !Array.isArray(data.entries)) throw new Error('invalid vault');
      session = {
        key,
        keyJwk: meta.keyJwk,
        kdf: blob.kdf,
        data,
        lastActivity: Number(meta.lastActivity) || Date.now(),
      };
      scheduleAutoLock();
      await ensureEntryTimes();
      return true;
    } catch {
      await removeSessionArea(STORAGE.session);
      return false;
    }
  })();
  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

async function enforceAutoLock() {
  if (!session) return false;
  await getSettings();
  if (sessionExpired({ lastActivity: session.lastActivity })) {
    await lockVault();
    return false;
  }
  return true;
}

async function requireUnlocked() {
  await getSettings();
  await loadSession();
  if (!session) throw new Error('密码库已锁定，请先解锁');
  if (!(await enforceAutoLock())) throw new Error('密码库已锁定，请先解锁');
  touchSession();
  return session;
}

async function lockVault({ broadcast = true } = {}) {
  const wasUnlocked = Boolean(session);
  clearAutoLockSchedule();
  session = null;
  lastSessionPersist = 0;
  await removeSessionArea(STORAGE.session);
  await refreshBadge();
  if (wasUnlocked && broadcast) {
    try {
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      await Promise.allSettled(
        tabs.map((tab) =>
          chrome.tabs.sendMessage(tab.id, { type: 'SV_LOCKED' }).catch(() => {}),
        ),
      );
    } catch {
      /* tabs may be unavailable */
    }
  }
}

/** Backfill passwordChangedAt for vaults created by earlier SubVault builds. */
async function ensureEntryTimes() {
  if (!session) return false;
  let changed = false;
  for (const entry of session.data.entries) {
    const value = Number(entry.passwordChangedAt);
    if (!Number.isFinite(value) || value <= 0) {
      entry.passwordChangedAt = entryTime(entry) || Date.now();
      changed = true;
    }
  }
  if (changed) await saveVault();
  return changed;
}

async function saveVault() {
  if (!session) throw new Error('密码库已锁定');
  session.data.updatedAt = Date.now();
  const box = await encryptJSON(session.key, session.data, AAD);
  const blob = {
    v: VAULT_VERSION,
    kdf: session.kdf,
    box,
    createdAt: session.data.createdAt || Date.now(),
    updatedAt: session.data.updatedAt,
  };
  await writeLocal(STORAGE.vault, blob);
  void refreshBadge();
  scheduleSyncPush();
}

/* ------------------------------------------------------------------ */
/* Local native sync                                                   */
/* ------------------------------------------------------------------ */

function broadcastSync() {
  try {
    chrome.runtime.sendMessage({ type: 'SV_SYNC_CHANGED', sync: { ...syncInfo } }).catch(() => {});
  } catch {
    // No extension page is listening.
  }
}

function connectNativeHost() {
  if (nativePort) return nativePort;
  if (!chrome.runtime?.connectNative) throw new Error('当前浏览器不支持本机同步');
  const port = chrome.runtime.connectNative('com.subvault.sync');
  nativePort = port;
  port.onMessage.addListener(handleNativeMessage);
  port.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message || '本机同步宿主已断开';
    nativePort = null;
    syncInfo.available = false;
    for (const pending of nativePending.values()) pending.reject(new Error(message));
    nativePending.clear();
    broadcastSync();
  });
  return port;
}

function handleNativeMessage(message) {
  if (message?.id && nativePending.has(message.id)) {
    const pending = nativePending.get(message.id);
    nativePending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === false && message.error) pending.reject(new Error(message.error));
    else pending.resolve(message);
    return;
  }
  if (message?.type === 'change') {
    syncInfo.revision = Number(message.revision) || 0;
    syncInfo.updatedAt = Number(message.updatedAt) || 0;
    broadcastSync();
    if (!syncReady && session) {
      void ensureSyncReady().then((ok) => {
        if (ok && !syncDirty) void pullAndApplyRemote().catch(() => {});
      });
      return;
    }
    if (syncReady && !syncDirty && session) {
      void pullAndApplyRemote().catch(() => {});
    }
  }
}

function nativeRequest(type, payload = {}, timeout = 8000) {
  const port = connectNativeHost();
  const id = ++nativeRequestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativePending.delete(id);
      reject(new Error('本机同步宿主响应超时'));
    }, timeout);
    nativePending.set(id, { resolve, reject, timer });
    try {
      port.postMessage({ type, id, ...payload });
    } catch (error) {
      clearTimeout(timer);
      nativePending.delete(id);
      reject(error);
    }
  });
}

async function refreshNativeStatus() {
  try {
    const status = await nativeRequest('status', {}, 2500);
    syncInfo.available = true;
    syncInfo.exists = Boolean(status.exists);
    syncInfo.revision = Number(status.revision) || 0;
    syncInfo.updatedAt = Number(status.updatedAt) || 0;
    syncInfo.path = status.path || '';
    if (!syncInfo.exists && session && session.data.entries.length > 0) {
      syncReady = true;
      void pushLocalVault();
    }
    broadcastSync();
    return { ...syncInfo };
  } catch (error) {
    syncInfo.available = false;
    broadcastSync();
    throw error;
  }
}

async function decryptVaultBlob(blob, password) {
  const kdf = blob?.kdf || {};
  if (!kdf.salt) throw new Error('同步数据缺少加密参数');
  const key = await deriveKey(
    password,
    kdf.salt,
    Math.max(KDF_MIN_ITERATIONS, Number(kdf.iterations) || KDF_ITERATIONS),
    kdf.hash === 'SHA-512' ? 'SHA-512' : KDF_LEGACY_HASH,
  );
  const data = await decryptJSON(key, blob.box, AAD);
  return { key, data, kdf };
}

async function applyRemotePayload(payload, key, data, kdf) {
  await getSettings();
  await writeLocal(STORAGE.vault, {
    v: VAULT_VERSION,
    kdf,
    box: payload.vault.box,
    createdAt: payload.vault.createdAt || data.createdAt || Date.now(),
    updatedAt: payload.vault.updatedAt || data.updatedAt || Date.now(),
  });
  if (payload.settings && typeof payload.settings === 'object') {
    await saveSettings(payload.settings);
  }
  if (Array.isArray(payload.ignores)) {
    await writeLocal(STORAGE.ignores, payload.ignores.filter((host) => isValidHost(host)));
  }
  const keyJwk = await exportKeyJwk(key);
  session = { key, keyJwk, kdf, data, lastActivity: Date.now() };
  lastSessionPersist = 0;
  await persistSession();
  scheduleAutoLock();
  syncBaseRevision = Number(payload.revision) || 0;
  syncReady = true;
  syncDirty = false;
  await writeLocal(STORAGE.syncJoined, true);
  await refreshBadge();
}

async function pullAndApplyRemote() {
  const payload = await nativeRequest('pull');
  if (!payload.exists) return { exists: false };
  if (!session) return { exists: true, locked: true };
  if (session.kdf?.salt !== payload.vault?.kdf?.salt) {
    throw new Error('同步密码库与当前主密码不匹配，请重新同步');
  }
  const data = await decryptJSON(session.key, payload.vault.box, AAD);
  await applyRemotePayload(payload, session.key, data, session.kdf);
  broadcastSync();
  return { exists: true, count: data.entries.length, revision: syncBaseRevision };
}

async function pushLocalVault() {
  if (!session || !syncReady) return { skipped: true };
  const blob = await getVaultBlob();
  if (!blob) return { skipped: true };
  const result = await nativeRequest('publish', {
    baseRevision: syncBaseRevision,
    vault: blob,
    settings: settingsCache || {},
    ignores: await readLocal(STORAGE.ignores, []),
  });
  if (result.conflict) {
    syncInfo.revision = Number(result.revision) || syncInfo.revision;
    broadcastSync();
    return { conflict: true, revision: syncInfo.revision };
  }
  syncBaseRevision = Number(result.revision) || syncBaseRevision;
  syncInfo.available = true;
  syncInfo.exists = true;
  syncInfo.revision = syncBaseRevision;
  syncDirty = false;
  await writeLocal(STORAGE.syncJoined, true);
  broadcastSync();
  return { ok: true, revision: syncBaseRevision };
}

async function ensureSyncReady() {
  if (syncReady) return true;
  if (!session) return false;
  const joined = await readLocal(STORAGE.syncJoined, false);
  if (!joined) return false;
  try {
    const status = await refreshNativeStatus();
    syncBaseRevision = Number(status.revision) || 0;
    syncReady = true;
    return true;
  } catch {
    return false;
  }
}

async function syncPoll() {
  if (!session) return;
  const joined = await readLocal(STORAGE.syncJoined, false);
  if (!joined) return;
  const status = await refreshNativeStatus();
  if (!status.exists) return;
  const localBlob = await getVaultBlob();
  const localUpdated = Number(localBlob?.updatedAt) || 0;
  const hostUpdated = Number(status.updatedAt) || 0;
  syncBaseRevision = Number(status.revision) || 0;
  syncReady = true;
  if (localUpdated > hostUpdated + 1000) {
    await pushLocalVault();
  } else if (hostUpdated > localUpdated + 1000) {
    if (!syncDirty) await pullAndApplyRemote();
  }
}

function scheduleSyncPush() {
  syncDirty = true;
  if (!syncReady) {
    void ensureSyncReady().then((ok) => {
      if (ok) void pushLocalVault();
    });
    return;
  }
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    pushLocalVault().catch(() => {
      syncDirty = true;
    });
  }, 600);
}

async function initializeSyncAfterSetup() {
  try {
    const status = await refreshNativeStatus();
    if (!status.exists) {
      syncReady = true;
      await writeLocal(STORAGE.syncJoined, true);
      if (session.data.entries.length > 0) await pushLocalVault();
    }
    return status;
  } catch {
    return { available: false, exists: false };
  }
}

async function reconcileSyncAfterUnlock() {
  try {
    const status = await refreshNativeStatus();
    if (!status.exists) {
      syncReady = true;
      if (session.data.entries.length > 0) void pushLocalVault();
      return status;
    }
    if (session.data.entries.length > 0) {
      syncBaseRevision = status.revision;
      syncReady = true;
      await writeLocal(STORAGE.syncJoined, true);
      if (syncDirty) void pushLocalVault();
    }
    return status;
  } catch {
    return { available: false, exists: false };
  }
}

async function syncPullWithPassword(password) {
  if (!session) throw new Error('密码库已锁定');
  if (session.data.entries.length > 0) {
    throw new Error('当前密码库已有数据，请先导出后清空，再同步本机已有数据');
  }
  const payload = await nativeRequest('pull');
  if (!payload.exists) throw new Error('本机没有可同步的数据');
  const { key, data } = await decryptVaultBlob(payload.vault, password);
  await applyRemotePayload(payload, key, data, payload.vault.kdf);
  return { count: data.entries.length, revision: syncBaseRevision };
}


function enqueue(task) {
  const run = opQueue.then(task, task);
  opQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ------------------------------------------------------------------ */
/* Pending saves                                                       */
/* ------------------------------------------------------------------ */

async function readPending() {
  const list = await readSessionArea(STORAGE.pending, []);
  if (!Array.isArray(list)) return [];
  const cutoff = Date.now() - LIMITS.pendingTtlMs;
  const fresh = list.filter((item) => item && item.createdAt > cutoff);
  if (fresh.length !== list.length) await writeSessionArea(STORAGE.pending, fresh);
  return fresh;
}

async function writePending(list) {
  await writeSessionArea(STORAGE.pending, list.slice(-LIMITS.pending));
  await refreshBadge();
}

function publicPending(item) {
  return {
    id: item.id,
    host: item.host,
    port: item.port || '',
    username: item.username || '',
    createdAt: item.createdAt,
    existing: Boolean(item.existing),
  };
}

async function refreshBadge() {
  try {
    await chrome.action.setBadgeText({ text: '' });
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    if (!session) {
      await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
      await Promise.allSettled(
        tabs.map((tab) =>
          tab.id
            ? chrome.action.setBadgeText({ tabId: tab.id, text: '锁' })
            : Promise.resolve(),
        ),
      );
      return;
    }
    await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
    await Promise.allSettled(
      tabs.map((tab) => {
        if (!tab.id) return Promise.resolve();
        const parsed = parseHttpUrl(tab.url || '');
        if (!parsed) {
          return chrome.action.setBadgeText({ tabId: tab.id, text: '' });
        }
        const host = normalizeHost(parsed.hostname);
        const port = normalizePort(parsed.port);
        const count = session.data.entries.filter((entry) =>
          entryMatches(entry, host, port),
        ).length;
        return chrome.action.setBadgeText({
          tabId: tab.id,
          text: count > 0 ? String(Math.min(count, 99)) : '',
        });
      }),
    );
  } catch {
    /* action API may be unavailable during shutdown */
  }
}

/* ------------------------------------------------------------------ */
/* Entry helpers                                                       */
/* ------------------------------------------------------------------ */

function clampText(value, max) {
  return String(value ?? '').slice(0, max);
}

function normalizeEntryInput(input, hostOverride = '') {
  const rawHostInput = String(input.host || hostOverride || '').trim();
  const parsedHost = parseHttpUrl(rawHostInput);
  const host = normalizeHost(parsedHost?.hostname || rawHostInput);
  if (!isValidHost(host)) throw new Error('网站域名无效');

  const password = String(input.password ?? '');
  if (!password) throw new Error('密码不能为空');
  if (password.length > LIMITS.password) throw new Error('密码过长');

  const rawTotp = String(input.totpSecret ?? '').trim();
  let totpSecret = '';
  if (rawTotp) {
    if (!isValidTotpSecret(rawTotp)) throw new Error('TOTP 密钥不是有效的 Base32');
    totpSecret = normalizeTotpSecret(rawTotp);
    if (totpSecret.length > LIMITS.totp) throw new Error('TOTP 密钥过长');
  }

  const parsedUrl = parseHttpUrl(input.url || '') || parsedHost;
  const port = normalizePort(input.port || parsedUrl?.port || parsedHost?.port || '');
  const url = parsedUrl ? parsedUrl.href.slice(0, LIMITS.url) : `https://${host}/`;

  return {
    title: clampText(input.title, LIMITS.title).trim() || host,
    host,
    port,
    username: clampText(input.username, LIMITS.username).trim(),
    password,
    notes: clampText(input.notes, LIMITS.notes),
    url,
    totpSecret,
  };
}

function safeEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    host: entry.host,
    port: entry.port || '',
    username: entry.username || '',
    url: entry.url || '',
    createdAt: entry.createdAt || 0,
    updatedAt: entry.updatedAt || 0,
    passwordChangedAt: entryTime(entry),
    lastUsedAt: entry.lastUsedAt || 0,
    source: entry.source || '',
    hasPassword: Boolean(entry.password),
    hasTotp: Boolean(entry.totpSecret),
    historyCount: Array.isArray(entry.history) ? entry.history.length : 0,
  };
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.host !== b.host) return a.host.localeCompare(b.host);
    const userCompare = (a.username || '').localeCompare(b.username || '');
    if (userCompare !== 0) return userCompare;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function matchOptions(port = '') {
  return {
    port: normalizePort(port),
    portIsolation: Boolean(settingsCache?.portIsolation),
  };
}

function entryMatches(entry, host, port = '') {
  return matchesHost(
    entry,
    host,
    settingsCache?.isolatedDomains || [],
    matchOptions(port),
  );
}

function findEntriesForHost(host, port = '') {
  if (!session) return [];
  return sortEntries(
    session.data.entries.filter((entry) => entryMatches(entry, host, port)),
  );
}

function findEntry(id) {
  if (!session) return null;
  return session.data.entries.find((entry) => entry.id === id) || null;
}

function pushPasswordHistory(entry) {
  if (!entry?.password) return;
  const history = Array.isArray(entry.history) ? entry.history : [];
  entry.history = [
    { password: entry.password, changedAt: entryTime(entry) },
    ...history.filter((item) => item && item.password !== entry.password),
  ].slice(0, 5);
}

/**
 * Save a credential captured on `host`. The effective site bucket is decided
 * by the global subdomain policy (shared parent domain by default, exact host
 * for configured isolated domains). Existing entries in the same bucket and
 * with the same username are updated instead of duplicated.
 */
async function upsertCredential(input, hostOverride) {
  const normalized = normalizeEntryInput(input, hostOverride);
  const s = await requireUnlocked();
  const isolated = settingsCache?.isolatedDomains || [];
  const now = Date.now();
  const sameUser = (entry) =>
    (entry.username || '').trim() === normalized.username &&
    entryMatches(entry, normalized.host, normalized.port);
  const exact = s.data.entries.find(
    (entry) =>
      sameUser(entry) &&
      normalizeHost(entry.host) === normalized.host &&
      normalizePort(entry.port) === normalized.port,
  );
  const covering = exact || s.data.entries.find(sameUser);

  if (covering) {
    if (covering.password !== normalized.password) {
      pushPasswordHistory(covering);
      covering.password = normalized.password;
      covering.passwordChangedAt = now;
    }
    covering.username = normalized.username;
    if (normalized.port) covering.port = normalized.port;
    if (input.title) covering.title = normalized.title;
    if (input.notes) covering.notes = normalized.notes;
    if (input.url) covering.url = normalized.url;
    if (input.totpSecret !== undefined) covering.totpSecret = normalized.totpSecret;
    covering.updatedAt = now;
    covering.source = input.source || covering.source || 'manual';
    await saveVault();
    return { id: covering.id, updated: true };
  }

  if (s.data.entries.length >= LIMITS.entries) throw new Error('密码库条目已达上限');

  const entry = {
    id: randomId(),
    ...normalized,
    source: input.source || 'manual',
    createdAt: now,
    updatedAt: now,
    passwordChangedAt: Number(input.passwordChangedAt) || now,
    lastUsedAt: 0,
    history: [],
  };
  s.data.entries.push(entry);
  await saveVault();
  return { id: entry.id, updated: false };
}

/**
 * Normalize import rows, then merge them with timestamp-aware conflict
 * resolution: same registrable domain + same account = one current password,
 * newest `passwordChangedAt` wins across subdomains.
 */
function normalizeImportRows(rows, now = Date.now()) {
  const normalized = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      const entry = normalizeEntryInput(row, row.host);
      normalized.push({
        ...entry,
        passwordChangedAt: Number(row.passwordChangedAt) || now,
        source: row.source || '',
        history: Array.isArray(row.history)
          ? row.history
              .filter((item) => item && typeof item.password === 'string')
              .slice(0, 5)
          : [],
      });
    } catch {
      skipped += 1;
    }
  }
  return { normalized, skipped };
}

/**
 * Compute merge counts and a password-free conflict preview without writing.
 * The actual apply path still uses mergeImported().
 */
async function previewImported(rows) {
  const s = await requireUnlocked();
  const now = Date.now();
  const { normalized, skipped } = normalizeImportRows(rows, now);
  const isolated = settingsCache?.isolatedDomains || [];
  const portIsolation = Boolean(settingsCache?.portIsolation);
  const result = mergeEntries(s.data.entries, normalized, {
    now,
    source: 'preview',
    isolatedDomains: isolated,
    portIsolation,
  });

  const conflicts = [];
  const seen = new Set();
  for (const row of normalized) {
    const options = { port: row.port, portIsolation };
    const key = conflictGroupKey(row.host, row.username, isolated, options);
    if (!key || seen.has(key)) continue;
    const group = s.data.entries.filter(
      (entry) =>
        conflictGroupKey(entry.host, entry.username, isolated, {
          port: entry.port,
          portIsolation,
        }) === key,
    );
    if (group.length === 0) continue;
    let newest = group[0];
    for (const entry of group) {
      if (entryTime(entry) > entryTime(newest)) newest = entry;
    }
    if (newest.password === row.password) continue;
    seen.add(key);
    conflicts.push({
      host: row.host,
      username: row.username || '',
      incomingTime: row.passwordChangedAt,
      existingTime: entryTime(newest),
      result: row.passwordChangedAt > entryTime(newest) ? 'update' : 'keep',
    });
  }

  return {
    imported: result.imported,
    updated: result.updated,
    merged: result.merged,
    skipped,
    conflicts: conflicts.slice(0, 50),
    conflictCount: conflicts.length,
  };
}

async function mergeImported(rows, source) {
  const s = await requireUnlocked();
  const now = Date.now();
  const { normalized, skipped } = normalizeImportRows(rows, now);

  if (normalized.length === 0) {
    return { imported: 0, updated: 0, merged: 0, skipped, groups: 0 };
  }

  const result = mergeEntries(s.data.entries, normalized, {
    now,
    source,
    isolatedDomains: settingsCache?.isolatedDomains || [],
    portIsolation: Boolean(settingsCache?.portIsolation),
  });
  if (result.entries.length > LIMITS.entries) {
    const overflow = result.entries.length - LIMITS.entries;
    result.entries.length = LIMITS.entries;
    result.imported = Math.max(0, result.imported - overflow);
  }
  s.data.entries = result.entries;
  if (result.imported > 0 || result.updated > 0) await saveVault();
  return {
    imported: result.imported,
    updated: result.updated,
    merged: result.merged,
    skipped,
    groups: result.groups,
  };
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

function validateMasterPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('主密码至少需要 10 个字符');
  }
  if (password.length > 1024) throw new Error('主密码过长');
  if (isCommonPassword(password)) throw new Error('该主密码太常见，请更换一个更安全的主密码');
}

async function setupVault(password) {
  validateMasterPassword(password);
  if (await getVaultBlob()) throw new Error('密码库已存在，请直接解锁');
  const kdf = createKdfParams();
  const key = await deriveKey(password, kdf.salt, kdf.iterations);
  const now = Date.now();
  const data = { version: VAULT_VERSION, entries: [], createdAt: now, updatedAt: now };
  const box = await encryptJSON(key, data, AAD);
  const blob = { v: VAULT_VERSION, kdf, box, createdAt: now, updatedAt: now };
  await writeLocal(STORAGE.vault, blob);
  const keyJwk = await exportKeyJwk(key);
  session = { key, keyJwk, kdf, data, lastActivity: now };
  lastSessionPersist = 0;
  await persistSession();
  scheduleAutoLock();
  await refreshBadge();
  void initializeSyncAfterSetup();
  return { unlocked: true, created: true };
}

let failedUnlocks = 0;
let blockedUntil = 0;

async function unlockVault(password) {
  if (!password) throw new Error('请输入主密码');
  await getSettings();
  if (Date.now() < blockedUntil) {
    const seconds = Math.ceil((blockedUntil - Date.now()) / 1000);
    throw new Error(`尝试次数过多，请 ${seconds} 秒后再试`);
  }
  const previousSession = session;
  const blob = await getVaultBlob();
  if (!blob) throw new Error('尚未创建密码库');
  const kdf = blob.kdf || {};
  if (!kdf.salt) throw new Error('密码库数据损坏');
  const iterations = Math.max(KDF_MIN_ITERATIONS, Number(kdf.iterations) || KDF_ITERATIONS);
  const hash = kdf.hash === 'SHA-512' ? 'SHA-512' : KDF_LEGACY_HASH;

  try {
    let key = await deriveKey(password, kdf.salt, iterations, hash);
    const data = await decryptJSON(key, blob.box, AAD);
    if (!data || !Array.isArray(data.entries)) throw new Error('密码库内容无效');

    // Transparently upgrade older SHA-256 vaults to SHA-512 + a 32-byte salt.
    let activeKdf = kdf;
    if (kdf.hash !== 'SHA-512') {
      activeKdf = createKdfParams();
      key = await deriveKey(password, activeKdf.salt, activeKdf.iterations, activeKdf.hash);
    }

    const keyJwk = await exportKeyJwk(key);
    session = { key, keyJwk, kdf: activeKdf, data, lastActivity: Date.now() };
    lastSessionPersist = 0;
    failedUnlocks = 0;
    if (activeKdf !== kdf) await saveVault();
    await ensureEntryTimes();
    await persistSession();
    scheduleAutoLock();
    await refreshBadge();
    void reconcileSyncAfterUnlock();
    return { unlocked: true, count: data.entries.length, upgradedKdf: activeKdf !== kdf };
  } catch {
    session = previousSession;
    if (!previousSession) {
      lastSessionPersist = 0;
      await removeSessionArea(STORAGE.session);
    }
    failedUnlocks += 1;
    if (failedUnlocks >= 5) {
      failedUnlocks = 0;
      blockedUntil = Date.now() + 30_000;
    }
    throw new Error('主密码错误，或密码库数据已损坏');
  }
}

async function changeMasterPassword(current, next) {
  if (typeof current !== 'string' || !current) throw new Error('请输入当前主密码');
  validateMasterPassword(next);
  await unlockVault(current);

  const kdf = createKdfParams();
  const key = await deriveKey(next, kdf.salt, kdf.iterations);
  const keyJwk = await exportKeyJwk(key);
  const prev = session;
  session = { ...prev, key, keyJwk, kdf };
  await saveVault();
  lastSessionPersist = 0;
  await persistSession();
  return { changed: true };
}

async function verifyPassword(password) {
  const blob = await getVaultBlob();
  if (!blob) throw new Error('密码库不存在');
  const kdf = blob.kdf || {};
  if (!kdf.salt) throw new Error('密码库数据损坏');
  const key = await deriveKey(
    password,
    kdf.salt,
    Math.max(KDF_MIN_ITERATIONS, Number(kdf.iterations) || KDF_ITERATIONS),
    kdf.hash === 'SHA-512' ? 'SHA-512' : KDF_LEGACY_HASH,
  );
  await decryptJSON(key, blob.box, AAD);
}

async function wipeVault() {
  session = null;
  lastSessionPersist = 0;
  try {
    await chrome.storage.local.remove(STORAGE.vault);
    await chrome.storage.local.remove(STORAGE.ignores);
  } catch (error) {
    throw friendlyStorageError(error, '清除');
  }
  await removeSessionArea(STORAGE.session);
  await writeSessionArea(STORAGE.pending, []);
  await refreshBadge();
  return { wiped: true };
}

const RESTORE_SETTING_KEYS = [
  'autoLockMinutes',
  'autoFill',
  'autoOpenOnFocus',
  'savePrompt',
  'savePromptPosition',
  'theme',
  'material',
  'showIcon',
  'takeoverMode',
  'clearNativeAutofill',
  'clipboardClearSeconds',
  'lockOnSystemLock',
  'lockOnSystemIdle',
  'portIsolation',
];

function backupSettingsSnapshot() {
  const settings = settingsCache || {};
  const snapshot = {};
  for (const key of RESTORE_SETTING_KEYS) snapshot[key] = settings[key];
  snapshot.isolatedDomains = [...(settings.isolatedDomains || [])];
  snapshot.siteExceptions = { ...(settings.siteExceptions || {}) };
  return snapshot;
}

function normalizeRestoredSettings(input) {
  if (!input || typeof input !== 'object') return {};
  const output = {};
  const minutes = Number(input.autoLockMinutes);
  if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 240) {
    output.autoLockMinutes = Math.round(minutes);
  }
  const clipboard = Number(input.clipboardClearSeconds);
  if (Number.isFinite(clipboard) && clipboard >= 0 && clipboard <= 600) {
    output.clipboardClearSeconds = Math.round(clipboard);
  }
  for (const key of [
    'autoFill',
    'autoOpenOnFocus',
    'savePrompt',
    'showIcon',
    'takeoverMode',
    'clearNativeAutofill',
    'lockOnSystemLock',
    'lockOnSystemIdle',
    'portIsolation',
  ]) {
    if (input[key] !== undefined) output[key] = Boolean(input[key]);
  }
  if (input.isolatedDomains !== undefined) {
    output.isolatedDomains = normalizeDomainList(input.isolatedDomains);
  }
  if (input.siteExceptions !== undefined) {
    output.siteExceptions = normalizeSiteExceptions(input.siteExceptions);
  }
  if (input.savePromptPosition !== undefined) {
    const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
    if (positions.includes(input.savePromptPosition)) {
      output.savePromptPosition = input.savePromptPosition;
    }
  }
  if (input.theme !== undefined) {
    const themes = ['system', 'light', 'dark'];
    if (themes.includes(input.theme)) output.theme = input.theme;
  }
  if (input.material !== undefined) {
    const materials = ['solid', 'glass', 'liquid'];
    if (materials.includes(input.material)) output.material = input.material;
  }
  return output;
}

async function restoreBackupPreferences(payload) {
  const settings = normalizeRestoredSettings(payload?.settings);
  if (Object.keys(settings).length > 0) await saveSettings(settings);
  if (Array.isArray(payload?.ignores)) {
    const ignores = [];
    for (const item of payload.ignores) {
      const host = normalizeHost(item);
      if (isValidHost(host) && !ignores.includes(host)) ignores.push(host);
    }
    await writeLocal(STORAGE.ignores, ignores.slice(-500));
  }
}

async function checkSave(host, port, username, password) {
  await getSettings();
  const s = await requireUnlocked();
  if (!settingsCache.savePrompt) return { offer: false };
  if (sitePolicyFor(host).disableSavePrompt) return { offer: false };
  if (!password || password.length > LIMITS.password) return { offer: false };

  const ignores = await readLocal(STORAGE.ignores, []);
  if (Array.isArray(ignores) && ignores.includes(host)) return { offer: false };

  const normalizedUser = String(username || '').trim().slice(0, LIMITS.username);
  const isolated = settingsCache?.isolatedDomains || [];
  const sameUser = (entry) =>
    (entry.username || '').trim() === normalizedUser &&
    entryMatches(entry, host, port);
  const existing =
    s.data.entries.find(
      (entry) =>
        sameUser(entry) &&
        normalizeHost(entry.host) === host &&
        normalizePort(entry.port) === normalizePort(port),
    ) || s.data.entries.find(sameUser);
  if (existing && existing.password === password) return { offer: false };

  const list = await readPending();
  const filtered = list.filter(
    (item) =>
      !(
        item.host === host &&
        normalizePort(item.port) === normalizePort(port) &&
        (item.username || '') === normalizedUser
      ),
  );
  const item = {
    id: randomId(),
    host,
    port: normalizePort(port),
    username: normalizedUser,
    password,
    existing: Boolean(existing),
    createdAt: Date.now(),
  };
  filtered.push(item);
  await writePending(filtered);
  return { offer: true, id: item.id, existing: Boolean(existing) };
}

/* ------------------------------------------------------------------ */
/* Message routing                                                     */
/* ------------------------------------------------------------------ */

function isExtensionPage(sender) {
  return (
    Boolean(sender) &&
    sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''))
  );
}

/** True for a content-script sender (options/popup pages can also have sender.tab). */
function isContentContext(sender) {
  return Boolean(sender?.tab?.id) && !isExtensionPage(sender);
}

function senderHost(sender) {
  // For content scripts, sender.url is the URL of the frame that sent the
  // message; sender.tab.url is the top-level tab. Prefer the frame URL so
  // cross-origin iframe logins match their own site bucket.
  const url = sender?.url || sender?.tab?.url || '';
  const fromUrl = hostFromUrl(url);
  if (fromUrl) return fromUrl;
  const origin = sender?.origin || '';
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return normalizeHost(parsed.hostname);
    }
  } catch {
    /* ignore */
  }
  return '';
}

async function requireContentHost(sender) {
  if (!sender?.tab?.id) throw new Error('该操作仅支持网页页面');
  const host = senderHost(sender);
  if (!host) throw new Error('当前页面不是 http/https 网站');
  return host;
}

function senderPort(sender) {
  const parsed = parseHttpUrl(sender?.url || sender?.tab?.url || '');
  return parsed?.port || '';
}

async function handleMessage(message, sender) {
  const type = message?.type;

  switch (type) {
    case 'SV_GET_STATUS': {
      await getSettings();
      const initialized = Boolean(await getVaultBlob());
      const meta = await readSessionArea(STORAGE.session, null);
      const lastActivity = session?.lastActivity || meta?.lastActivity;
      let locked = !meta?.keyJwk || sessionExpired({ lastActivity });
      if (locked && session) await lockVault({ broadcast: false });
      if (!locked && !session) {
        await loadSession();
        locked = !session;
      }
      if (!locked && session) touchSession();
      const pending = await readPending();
      return { initialized, locked, pendingCount: pending.length };
    }

    case 'SV_SETUP':
      return enqueue(async () => {
        await getSettings();
        return setupVault(message.password);
      });

    case 'SV_UNLOCK':
      return enqueue(() => unlockVault(message.password));

    case 'SV_LOCK':
      await lockVault();
      return { locked: true };

    case 'SV_CHANGE_MASTER':
      return enqueue(() => changeMasterPassword(message.currentPassword, message.newPassword));

    case 'SV_WIPE':
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(async () => {
        if (message.confirm !== '清空密码库') throw new Error('请输入确认文字：清空密码库');
        await verifyPassword(String(message.password || ''));
        return wipeVault();
      });

    case 'SV_RESET_VAULT':
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      if (message.confirm !== '清空密码库') throw new Error('请输入确认文字：清空密码库');
      return enqueue(() => wipeVault());

    case 'SV_SYNC_STATUS':
      try {
        const status = { ...(await refreshNativeStatus()) };
        if (session) void syncPoll().catch(() => {});
        return status;
      } catch (error) {
        return { available: false, exists: false, error: error.message };
      }

    case 'SV_SYNC_NOW':
      await loadSession();
      if (!session) throw new Error('密码库已锁定');
      await syncPoll();
      return { ok: true, ...syncInfo };

    case 'SV_SYNC_PULL':
      await requireUnlocked();
      return syncPullWithPassword(String(message.password || ''));

    case 'SV_SYNC_IMPORT': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可以导入同步数据');
      if (await getVaultBlob()) throw new Error('本地已有密码库，请使用设置页同步');
      const payload = await nativeRequest('pull');
      if (!payload.exists) throw new Error('本机没有可导入的同步数据');
      const { key, data } = await decryptVaultBlob(
        payload.vault,
        String(message.password || ''),
      );
      await applyRemotePayload(payload, key, data, payload.vault.kdf);
      return { count: data.entries.length, revision: syncBaseRevision };
    }

    case 'SV_SYNC_PUSH':
      await requireUnlocked();
      return pushLocalVault();

    case 'SV_SYNC_DISCONNECT':
      if (nativePort) {
        nativePort.disconnect();
        nativePort = null;
      }
      syncReady = false;
      syncInfo.available = false;
      return { disconnected: true };

    case 'SV_POPUP_STATE': {      await getSettings();
      const initialized = Boolean(await getVaultBlob());
      const meta = await readSessionArea(STORAGE.session, null);
      const lastActivity = session?.lastActivity || meta?.lastActivity;
      const expired = !meta?.keyJwk || sessionExpired({ lastActivity });
      if (expired) {
        if (session) await lockVault({ broadcast: false });
        return { initialized, locked: true, settings: settingsCache, pending: [] };
      }
      if (!session && !(await loadSession())) {
        return { initialized, locked: true, settings: settingsCache, pending: [] };
      }
      if (!(await enforceAutoLock())) {
        return { initialized, locked: true, settings: settingsCache, pending: [] };
      }
      touchSession();
      await refreshBadge();

      const host = normalizeHost(message.host);
      const port = normalizePort(message.port);
      const isolated = settingsCache?.isolatedDomains || [];
      const siteKey = host
        ? siteKeyFor(host, isolated, {
            port,
            portIsolation: Boolean(settingsCache?.portIsolation),
          })
        : '';
      const matches = host
        ? sortEntries(
            session.data.entries.filter((entry) => entryMatches(entry, host, port)),
          ).map(safeEntry)
        : [];
      const pending = (await readPending())
        .filter(
          (item) =>
            !host || entryMatches({ host: item.host, port: item.port }, host, port),
        )
        .map(publicPending);
      return {
        initialized,
        locked: false,
        host,
        port,
        siteKey,
        isolated: host ? isHostIsolated(host, isolated) : false,
        isolatedDomains: isolated,
        policy: host ? sitePolicyFor(host) : {},
        matches,
        pending,
        settings: settingsCache,
        stats: {
          total: session.data.entries.length,
          hosts: new Set(session.data.entries.map((entry) => entry.host)).size,
        },
      };
    }

    case 'SV_GET_MATCHES': {
      await getSettings();
      await loadSession();
      const host = isContentContext(sender)
        ? await requireContentHost(sender)
        : normalizeHost(message.host);
      const port = isContentContext(sender)
        ? senderPort(sender)
        : normalizePort(message.port);
      const isolated = settingsCache?.isolatedDomains || [];
      if (!session || !(await enforceAutoLock())) {
        return {
          locked: true,
          host: host || '',
          port,
          siteKey: host
            ? siteKeyFor(host, isolated, {
                port,
                portIsolation: Boolean(settingsCache?.portIsolation),
              })
            : '',
          isolated: host ? isHostIsolated(host, isolated) : false,
          matches: [],
        };
      }
      touchSession();
      if (!host) {
        return {
          locked: false,
          host: '',
          port: '',
          siteKey: '',
          isolated: false,
          policy: {},
          matches: [],
        };
      }
      return {
        locked: false,
        host,
        port,
        siteKey: siteKeyFor(host, isolated, {
          port,
          portIsolation: Boolean(settingsCache?.portIsolation),
        }),
        isolated: isHostIsolated(host, isolated),
        policy: sitePolicyFor(host),
        matches: findEntriesForHost(host, port).map(safeEntry),
      };
    }

    case 'SV_FILL': {
      await requireUnlocked();
      const targetHost = isContentContext(sender)
        ? await requireContentHost(sender)
        : normalizeHost(message.host);
      const targetPort = isContentContext(sender)
        ? senderPort(sender)
        : normalizePort(message.port);
      const entry = findEntry(message.id);
      if (!entry) throw new Error('账号不存在');
      if (!targetHost || !entryMatches(entry, targetHost, targetPort)) {
        throw new Error('该账号不属于当前网站，已阻止填充');
      }
      entry.lastUsedAt = Date.now();
      await saveVault();
      return {
        username: entry.username || '',
        password: entry.password,
        title: entry.title,
      };
    }

    case 'SV_CHECK_SAVE': {
      if (!isExtensionPage(sender) && !isContentContext(sender)) {
        throw new Error('无效的调用来源');
      }
      const host = isContentContext(sender)
        ? await requireContentHost(sender)
        : normalizeHost(message.host);
      const port = isContentContext(sender)
        ? senderPort(sender)
        : normalizePort(message.port);
      if (!host) throw new Error('当前页面不是 http/https 网站');
      await getSettings();
      await loadSession();
      if (!session || !(await enforceAutoLock())) return { offer: false, locked: true };
      const result = await enqueue(() => checkSave(host, port, message.username, message.password));
      if (result?.offer && sender.tab?.id) {
        try {
          const pending = (await readPending()).find((item) => item.id === result.id);
          if (pending) {
            await chrome.tabs.sendMessage(
              sender.tab.id,
              { type: 'SV_PENDING_AVAILABLE', pending: publicPending(pending) },
              { frameId: 0 },
            );
          }
        } catch {
          /* top frame may have no content script */
        }
      }
      return result;
    }

    case 'SV_SAVE_PENDING': {
      await requireUnlocked();
      const list = await readPending();
      const pending = list.find((item) => item.id === message.id);
      if (!pending) throw new Error('待保存的登录信息已过期');
      if (isContentContext(sender)) {
        const host = await requireContentHost(sender);
        const port = senderPort(sender);
        if (!entryMatches({ host: pending.host, port: pending.port }, host, port)) {
          throw new Error('页面与待保存信息不匹配');
        }
      }
      const result = await enqueue(() =>
        upsertCredential(
          {
            host: pending.host,
            port: pending.port,
            username: pending.username,
            password: pending.password,
            source: 'autosave',
          },
          pending.host,
        ),
      );
      await writePending(list.filter((item) => item.id !== pending.id));
      return { ...result, saved: true, host: pending.host };
    }

    case 'SV_DISMISS_PENDING': {
      await getSettings();
      const list = await readPending();
      const pending = list.find((item) => item.id === message.id);
      if (pending && isContentContext(sender)) {
        const host = await requireContentHost(sender);
        const port = senderPort(sender);
        if (!entryMatches({ host: pending.host, port: pending.port }, host, port)) {
          throw new Error('页面与待保存信息不匹配');
        }
      }
      await writePending(list.filter((item) => item.id !== message.id));
      return { dismissed: true };
    }

    case 'SV_GET_PENDING': {
      await getSettings();
      await loadSession();
      if (!session || !(await enforceAutoLock())) return { pending: [], locked: true };
      const list = await readPending();
      if (isContentContext(sender)) {
        const host = await requireContentHost(sender);
        const port = senderPort(sender);
        return {
          locked: false,
          pending: list
            .filter((item) =>
              entryMatches({ host: item.host, port: item.port }, host, port),
            )
            .map(publicPending),
        };
      }
      return { locked: false, pending: list.map(publicPending) };
    }

    case 'SV_IGNORE_SITE': {
      const host = isContentContext(sender)
        ? await requireContentHost(sender)
        : normalizeHost(message.host);
      if (!isValidHost(host)) throw new Error('网站域名无效');
      const ignores = await readLocal(STORAGE.ignores, []);
      const next = Array.isArray(ignores) ? ignores.filter((item) => item !== host) : [];
      next.push(host);
      await writeLocal(STORAGE.ignores, next.slice(-500));
      const list = await readPending();
      await writePending(list.filter((item) => item.host !== host));
      return { ignored: true, host };
    }

    case 'SV_UNIGNORE_SITE': {
      if (!isExtensionPage(sender)) throw new Error('仅设置页面可执行该操作');
      const host = normalizeHost(message.host);
      const ignores = await readLocal(STORAGE.ignores, []);
      await writeLocal(
        STORAGE.ignores,
        (Array.isArray(ignores) ? ignores : []).filter((item) => item !== host),
      );
      return { ignored: false, host };
    }

    case 'SV_GET_IGNORES': {
      if (!isExtensionPage(sender)) throw new Error('仅设置页面可执行该操作');
      const ignores = await readLocal(STORAGE.ignores, []);
      return { ignores: Array.isArray(ignores) ? ignores : [] };
    }

    case 'SV_GET_USAGE': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const bytes = await new Promise((resolve) => {
        try {
          chrome.storage.local.getBytesInUse(null, (value) => {
            if (chrome.runtime.lastError) resolve(0);
            else resolve(Number(value) || 0);
          });
        } catch {
          resolve(0);
        }
      });
      return {
        bytes,
        quota: Number(chrome.storage.local.QUOTA_BYTES) || 10 * 1024 * 1024,
        entries: session.data.entries.length,
      };
    }

    case 'SV_FIND_DUPLICATES': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      const s = await requireUnlocked();
      const isolated = settingsCache?.isolatedDomains || [];
      const portIsolation = Boolean(settingsCache?.portIsolation);
      const groups = new Map();
      for (const entry of s.data.entries) {
        const key = conflictGroupKey(entry.host, entry.username, isolated, {
          port: entry.port,
          portIsolation,
        });
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      }
      const result = [];
      for (const [key, entries] of groups) {
        if (entries.length < 2) continue;
        const sorted = [...entries].sort(
          (a, b) => entryTime(b) - entryTime(a) || (b.updatedAt || 0) - (a.updatedAt || 0),
        );
        result.push({
          key,
          username: sorted[0].username || '',
          host: sorted[0].host,
          count: sorted.length,
          entries: sorted.map((entry) => ({
            id: entry.id,
            host: entry.host,
            title: entry.title,
            username: entry.username || '',
            passwordChangedAt: entryTime(entry),
            updatedAt: entry.updatedAt || 0,
          })),
        });
      }
      return { groups: result, total: result.reduce((sum, group) => sum + group.count - 1, 0) };
    }

    case 'SV_MERGE_DUPLICATES': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      const key = String(message.key || '');
      if (!key) throw new Error('缺少重复分组标识');
      return enqueue(async () => {
        const s = await requireUnlocked();
        const isolated = settingsCache?.isolatedDomains || [];
        const portIsolation = Boolean(settingsCache?.portIsolation);
        const entries = s.data.entries.filter(
          (entry) =>
            conflictGroupKey(entry.host, entry.username, isolated, {
              port: entry.port,
              portIsolation,
            }) === key,
        );
        if (entries.length < 2) return { merged: 0 };
        const sorted = [...entries].sort(
          (a, b) => entryTime(b) - entryTime(a) || (b.updatedAt || 0) - (a.updatedAt || 0),
        );
        const winner = sorted[0];
        const notes = winner.notes || sorted.find((entry) => entry.notes)?.notes || '';
        if (!winner.notes && notes) winner.notes = notes;
        const removeIds = new Set(sorted.slice(1).map((entry) => entry.id));
        s.data.entries = s.data.entries.filter((entry) => !removeIds.has(entry.id));
        await saveVault();
        return { merged: removeIds.size, id: winner.id };
      });
    }

    case 'SV_LIST_ENTRIES': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      const s = await requireUnlocked();
      const counts = new Map();
      for (const entry of s.data.entries) {
        counts.set(entry.password, (counts.get(entry.password) || 0) + 1);
      }
      const now = Date.now();
      const entries = sortEntries(s.data.entries).map((entry) => {
        const info = safeEntry(entry);
        info.weak = passwordStrength(entry.password).score <= 1;
        info.reused = (counts.get(entry.password) || 0) > 1;
        info.ageDays = Math.max(0, Math.floor((now - entryTime(entry)) / 86_400_000));
        info.old = info.ageDays > 365;
        return info;
      });
      return {
        entries,
        stats: {
          total: s.data.entries.length,
          hosts: new Set(s.data.entries.map((entry) => entry.host)).size,
          weak: entries.filter((entry) => entry.weak).length,
          reused: entries.filter((entry) => entry.reused).length,
          old: entries.filter((entry) => entry.old).length,
          updatedAt: s.data.updatedAt || 0,
        },
      };
    }

    case 'SV_GET_SECRET': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const entry = findEntry(message.id);
      if (!entry) throw new Error('账号不存在');
      return {
        id: entry.id,
        username: entry.username || '',
        password: entry.password,
        notes: entry.notes || '',
        title: entry.title,
        host: entry.host,
        port: entry.port || '',
        url: entry.url || '',
        passwordChangedAt: entryTime(entry),
        totpSecret: entry.totpSecret || '',
        historyCount: Array.isArray(entry.history) ? entry.history.length : 0,
      };
    }

    case 'SV_GET_TOTP_CODE': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const entry = findEntry(message.id);
      if (!entry) throw new Error('账号不存在');
      if (!entry.totpSecret) throw new Error('该账号没有配置 TOTP');
      const result = await generateTotp(entry.totpSecret);
      return {
        ...result,
        title: entry.title,
        username: entry.username || '',
      };
    }

    case 'SV_GET_HISTORY': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const entry = findEntry(message.id);
      if (!entry) throw new Error('账号不存在');
      return {
        id: entry.id,
        history: Array.isArray(entry.history)
          ? entry.history.slice(0, 5).map((item) => ({
              password: item.password,
              changedAt: Number(item.changedAt) || 0,
            }))
          : [],
      };
    }

    case 'SV_RESTORE_HISTORY': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(async () => {
        await requireUnlocked();
        const entry = findEntry(message.id);
        if (!entry) throw new Error('账号不存在');
        const history = Array.isArray(entry.history) ? entry.history : [];
        const index = Number(message.index);
        if (!Number.isInteger(index) || index < 0 || index >= history.length) {
          throw new Error('历史密码不存在');
        }
        const target = history[index];
        const previous = {
          password: entry.password,
          changedAt: entryTime(entry),
        };
        entry.password = target.password;
        entry.passwordChangedAt = Date.now();
        entry.history = [
          previous,
          ...history.filter((_, itemIndex) => itemIndex !== index),
        ]
          .filter((item) => item && item.password)
          .slice(0, 5);
        await saveVault();
        return { restored: true, id: entry.id };
      });
    }

    case 'SV_ADD_ENTRY': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(() => upsertCredential(message.entry || {}, message.entry?.host));
    }

    case 'SV_UPDATE_ENTRY': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(async () => {
        const s = await requireUnlocked();
        const entry = findEntry(message.entry?.id);
        if (!entry) throw new Error('账号不存在');
        const normalized = normalizeEntryInput(
          { ...message.entry, url: message.entry?.url },
          entry.host,
        );
        if (message.entry?.totpSecret === undefined) {
          normalized.totpSecret = entry.totpSecret || '';
        }
        const now = Date.now();
        const passwordChanged = entry.password !== normalized.password;
        if (passwordChanged) pushPasswordHistory(entry);
        Object.assign(entry, normalized, { updatedAt: now });
        if (passwordChanged) entry.passwordChangedAt = now;
        else if (!entry.passwordChangedAt) entry.passwordChangedAt = entryTime(entry) || now;
        await saveVault();
        return { updated: true, id: entry.id, passwordChanged };
      });
    }

    case 'SV_DELETE_ENTRY': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(async () => {
        const s = await requireUnlocked();
        const index = s.data.entries.findIndex((entry) => entry.id === message.id);
        if (index === -1) throw new Error('账号不存在');
        s.data.entries.splice(index, 1);
        await saveVault();
        return { deleted: true };
      });
    }

    case 'SV_PREVIEW_CSV': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const parsed = csvToEntries(String(message.text || ''), {
        fallbackTime: Number(message.fileLastModified) || Date.now(),
      });
      if (parsed.entries.length === 0) {
        return {
          imported: 0,
          updated: 0,
          merged: 0,
          skipped: parsed.skipped,
          total: parsed.total,
          format: parsed.format,
          warnings: parsed.warnings.length ? parsed.warnings : ['没有可导入的密码行'],
          hasTimestamps: parsed.hasTimestamps,
          timeBasis: parsed.hasTimestamps ? 'file' : 'fileModified',
          conflicts: [],
          conflictCount: 0,
        };
      }
      const preview = await previewImported(parsed.entries);
      return {
        ...preview,
        skipped: parsed.skipped + preview.skipped,
        total: parsed.total,
        format: parsed.format,
        warnings: parsed.warnings,
        hasTimestamps: parsed.hasTimestamps,
        timeBasis: parsed.hasTimestamps ? 'file' : 'fileModified',
      };
    }

    case 'SV_IMPORT_CSV': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const parsed = csvToEntries(String(message.text || ''), {
        fallbackTime: Number(message.fileLastModified) || Date.now(),
      });
      if (parsed.entries.length === 0) {
        return {
          imported: 0,
          updated: 0,
          merged: 0,
          skipped: parsed.skipped,
          total: parsed.total,
          format: parsed.format,
          warnings: parsed.warnings.length ? parsed.warnings : ['没有可导入的密码行'],
          hasTimestamps: parsed.hasTimestamps,
          timeBasis: parsed.hasTimestamps ? 'file' : 'fileModified',
        };
      }
      return enqueue(async () => {
        const result = await mergeImported(parsed.entries, `import:${parsed.format}`);
        return {
          ...result,
          total: parsed.total,
          format: parsed.format,
          warnings: parsed.warnings,
          hasTimestamps: parsed.hasTimestamps,
          timeBasis: parsed.hasTimestamps ? 'file' : 'fileModified',
        };
      });
    }

    case 'SV_EXPORT_CSV': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const password = String(message.password || '');
      if (!password) throw new Error('导出明文 CSV 需要再次输入主密码');
      await verifyPassword(password);
      const csv = entriesToCsv(sortEntries(session.data.entries));
      return { csv, count: session.data.entries.length };
    }

    case 'SV_EXPORT_BACKUP': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const backupPassword = String(message.backupPassword || '');
      if (backupPassword) {
        if (backupPassword.length < 10) throw new Error('备份密码至少需要 10 个字符');
        if (isCommonPassword(backupPassword)) {
          throw new Error('该备份密码太常见，请更换一个更安全的密码');
        }
      }

      const payload = {
        data: session.data,
        settings: backupSettingsSnapshot(),
        ignores: await readLocal(STORAGE.ignores, []),
      };
      const mode = backupPassword ? 'independent' : 'master';
      const kdf = backupPassword ? createKdfParams() : session.kdf;
      const key = backupPassword
        ? await deriveKey(backupPassword, kdf.salt, kdf.iterations, kdf.hash)
        : session.key;
      const box = await encryptJSON(key, payload, AAD_BACKUP_V3);

      return {
        backup: JSON.stringify(
          {
            app: 'SubVault',
            format: 'subvault-backup',
            version: BACKUP_VERSION,
            mode,
            exportedAt: Date.now(),
            entryCount: session.data.entries.length,
            includesSettings: true,
            kdf,
            box,
          },
          null,
          2,
        ),
        count: session.data.entries.length,
        independent: Boolean(backupPassword),
      };
    }

    case 'SV_IMPORT_BACKUP': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      let parsed;
      try {
        parsed = JSON.parse(String(message.text || ''));
      } catch {
        throw new Error('备份文件不是有效的 JSON');
      }

      const isV3 =
        parsed?.format === 'subvault-backup' &&
        Number(parsed?.version) >= 3 &&
        parsed?.box &&
        parsed?.kdf;
      if (isV3) {
        const password = String(message.password || '');
        if (!password) throw new Error('请输入该备份文件的密码（独立备份密码或主密码）');
        const key = await deriveKey(
          password,
          parsed.kdf.salt,
          Math.max(KDF_MIN_ITERATIONS, Number(parsed.kdf.iterations) || KDF_ITERATIONS),
          parsed.kdf.hash === 'SHA-512' ? 'SHA-512' : KDF_LEGACY_HASH,
        );
        const payload = await decryptJSON(key, parsed.box, AAD_BACKUP_V3);
        const data = payload?.data;
        if (!data || !Array.isArray(data.entries)) throw new Error('备份内容无效');
        if (data.entries.length > LIMITS.entries) throw new Error('备份条目超过上限');
        const replace = message.mode === 'replace';
        const restoreSettings = message.restoreSettings !== false;
        return enqueue(async () => {
          if (replace) {
            session.data = {
              ...data,
              version: VAULT_VERSION,
              updatedAt: Date.now(),
            };
            await saveVault();
            await writeSessionArea(STORAGE.pending, []);
            await refreshBadge();
            if (restoreSettings) await restoreBackupPreferences(payload);
            return {
              replaced: true,
              imported: data.entries.length,
              updated: 0,
              merged: 0,
              total: data.entries.length,
              independent: parsed.mode === 'independent',
              settingsRestored: restoreSettings,
            };
          }
          const result = await mergeImported(data.entries, 'backup');
          if (restoreSettings) await restoreBackupPreferences(payload);
          return {
            ...result,
            total: data.entries.length,
            independent: parsed.mode === 'independent',
            settingsRestored: restoreSettings,
          };
        });
      }

      if (message.mode === 'replace') {
        throw new Error('旧版备份格式只支持合并导入，请使用新版备份进行覆盖恢复');
      }

      const independent =
        parsed?.format === 'encrypted-backup' && parsed?.box && parsed?.kdf;
      const blob = parsed?.vault || parsed;
      const box = independent ? parsed.box : blob?.box;
      const kdf = independent ? parsed.kdf : blob?.kdf;
      if (!box || !kdf?.salt) throw new Error('备份文件缺少密码库数据');

      const password = String(message.password || '');
      if (!password) throw new Error('请输入该备份文件的密码（独立备份密码或主密码）');
      const backupKey = await deriveKey(
        password,
        kdf.salt,
        Math.max(KDF_MIN_ITERATIONS, Number(kdf.iterations) || KDF_ITERATIONS),
        kdf.hash === 'SHA-512' ? 'SHA-512' : KDF_LEGACY_HASH,
      );
      const data = await decryptJSON(backupKey, box, independent ? AAD_BACKUP : AAD);
      if (!data || !Array.isArray(data.entries)) throw new Error('备份内容无效');
      return enqueue(async () => {
        const result = await mergeImported(data.entries, 'backup');
        return {
          ...result,
          total: data.entries.length,
          independent: Boolean(independent),
          settingsRestored: false,
        };
      });
    }

    case 'SV_GET_TAKEOVER_STATUS': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return { status: await getTakeoverStatus() };
    }

    case 'SV_SET_CHROME_SAVE_PROMPT': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(async () => {
        const status = await setChromeSavePromptDisabled(Boolean(message.disabled));
        return { status };
      });
    }

    case 'SV_GET_SETTINGS': {
      await getSettings();
      return { settings: settingsCache };
    }

    case 'SV_SET_SETTINGS': {
      if (!isExtensionPage(sender)) throw new Error('仅设置页面可执行该操作');
      const patch = message.settings || {};
      const next = {};
      if (patch.autoLockMinutes !== undefined) {
        const minutes = Number(patch.autoLockMinutes);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) {
          throw new Error('自动锁定时间需在 0–240 分钟之间');
        }
        next.autoLockMinutes = Math.round(minutes);
      }
      if (patch.clipboardClearSeconds !== undefined) {
        const seconds = Number(patch.clipboardClearSeconds);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
          throw new Error('剪贴板清除时间需在 0–600 秒之间');
        }
        next.clipboardClearSeconds = Math.round(seconds);
      }
      if (patch.savePromptPosition !== undefined) {
        const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
        if (!positions.includes(patch.savePromptPosition)) {
          throw new Error('保存提示位置无效');
        }
        next.savePromptPosition = patch.savePromptPosition;
      }
      if (patch.theme !== undefined) {
        const themes = ['system', 'light', 'dark'];
        if (!themes.includes(patch.theme)) throw new Error('主题外观无效');
        next.theme = patch.theme;
      }
      if (patch.material !== undefined) {
        const materials = ['solid', 'glass', 'liquid'];
        if (!materials.includes(patch.material)) throw new Error('材质设置无效');
        next.material = patch.material;
      }
      for (const key of [
        'autoFill',
        'autoOpenOnFocus',
        'savePrompt',
        'showIcon',
        'takeoverMode',
        'clearNativeAutofill',
        'lockOnSystemLock',
        'lockOnSystemIdle',
        'portIsolation',
      ]) {
        if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
      }
      if (patch.isolatedDomains !== undefined) {
        if (!Array.isArray(patch.isolatedDomains)) {
          throw new Error('独立主域名列表格式无效');
        }
        const cleaned = [];
        for (const item of patch.isolatedDomains) {
          const host = normalizeHost(item);
          if (!isValidHost(host)) throw new Error(`无效的主域名：${String(item)}`);
          if (!cleaned.includes(host)) cleaned.push(host);
        }
        if (cleaned.length > 200) throw new Error('独立主域名最多 200 个');
        next.isolatedDomains = cleaned;
      }
      if (patch.siteExceptions !== undefined) {
        if (!patch.siteExceptions || typeof patch.siteExceptions !== 'object') {
          throw new Error('站点例外格式无效');
        }
        const cleaned = normalizeSiteExceptions(patch.siteExceptions);
        if (Object.keys(cleaned).length > 500) throw new Error('站点例外最多 500 个');
        next.siteExceptions = cleaned;
      }
      const saved = await saveSettings(next);
      touchSession();
      return { settings: saved };
    }

    case 'SV_OPEN_OPTIONS': {
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    }

    case 'SV_GET_ACTIVE_TAB_HOST': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const parsed = parseHttpUrl(tab?.url || '');
      return {
        host: parsed ? normalizeHost(parsed.hostname) : '',
        title: tab?.title || '',
        url: parsed ? parsed.href : '',
      };
    }

    default:
      throw new Error(`未知操作：${String(type)}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Promise.resolve()
    .then(() => handleMessage(message || {}, sender))
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
  return true;
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function initialize() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    /* older Chromium without session access levels */
  }
  await getSettings();
  const stored = await readLocal(STORAGE.settings, null);
  if (!stored) await writeLocal(STORAGE.settings, DEFAULT_SETTINGS);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  await chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });
  try {
    if (chrome.idle?.setDetectionInterval) chrome.idle.setDetectionInterval(60);
  } catch {
    /* idle API may be unavailable */
  }
  await readPending();
  const meta = await readSessionArea(STORAGE.session, null);
  if (meta?.keyJwk && !sessionExpired(meta)) await loadSession();
  if (session) {
    scheduleAutoLock();
    void syncPoll().catch(() => {});
  }
  await refreshBadge();
  if (settingsCache.disableChromeSavePrompt && chromePasswordSetting()) {
    try {
      await setChromeSavePromptDisabled(true);
    } catch {
      /* browser policy may block the change; the options page reports it */
    }
  }
}

function safeInitialize() {
  void initialize().catch((error) => {
    console.error('[SubVault] initialize failed:', error?.message || error);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  safeInitialize();
});

chrome.runtime.onStartup.addListener(() => {
  safeInitialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM_NAME) {
    void (async () => {
      await loadSession();
      const stillUnlocked = await enforceAutoLock();
      if (stillUnlocked) scheduleAutoLock();
    })().catch(() => {});
    return;
  }
  if (alarm.name === SYNC_ALARM_NAME) {
    void (async () => {
      await loadSession();
      await syncPoll();
    })().catch(() => {});
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  void (async () => {
    await getSettings();
    if (session) {
      await enforceAutoLock();
      return;
    }
    const meta = await readSessionArea(STORAGE.session, null);
    if (meta && sessionExpired(meta)) await removeSessionArea(STORAGE.session);
    await refreshBadge();
  })().catch((error) => {
    console.error('[SubVault] auto-lock failed:', error?.message || error);
  });
});

if (chrome.idle?.onStateChanged) {
  chrome.idle.onStateChanged.addListener((state) => {
    void (async () => {
      if (!session) return;
      await getSettings();
      if (state === 'locked' && settingsCache.lockOnSystemLock) {
        await lockVault();
      } else if (state === 'idle' && settingsCache.lockOnSystemIdle) {
        await lockVault();
      }
    })().catch((error) => {
      console.error('[SubVault] idle lock failed:', error?.message || error);
    });
  });
}

chrome.tabs.onActivated.addListener(() => {
  void refreshBadge();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') void refreshBadge();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'fill-login') return;
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'SV_FILL_SHORTCUT' });
    } catch {
      /* active tab has no content script (chrome:// etc.) */
    }
  })();
});

void safeInitialize();
