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

// Static import: MV3 service workers disallow dynamic import(); this exposes
// the bundled zxcvbn estimator on the global object before validation runs.
import '../vendor/zxcvbn.js';
import { bindKdfToExpiry } from '../lib/share.js';

import {
  KDF_ITERATIONS,
  KDF_LEGACY_HASH,
  KDF_MIN_ITERATIONS,
  VAULT_VERSION,
  VAULT_FORMAT_VERSION,
  createArgon2Params,
  createKdfParams,
  createVaultKey,
  decryptJSON,
  decryptPayload,
  deriveKeyFromKdf,
  encryptJSON,
  encryptPayload,
  exportKeyJwk,
  exportKeyRaw,
  unwrapVaultKey,
  wrapVaultKey,
  importKeyJwk,
  importKeyRaw,
  bytesToBase64,
  base64ToBytes,
  isCommonPassword,
  randomId,
  passwordStrength,
  sha256Hex,
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
  addCustomPslRules,
  clearCustomPslRules,
  customPslRuleCount,
} from '../lib/domain.js';
import { csvToEntries, entriesToCsv } from '../lib/csv.js';
import { entryTime, conflictGroupKey, mergeEntries } from '../lib/merge.js';
import { generateTotp, isValidTotpSecret, normalizeTotpSecret, parseOtpAuthUri } from '../lib/totp.js';
import { generatePassword } from '../lib/generator.js';
import { isWeakPasswordHash } from '../vendor/weak-passwords.js';
import { evaluateMasterPassword } from '../lib/strength.js';

const AAD = 'subvault:vault:v1';
const VAULT_CIPHER = 'AES-GCM';
const AAD_BACKUP = 'subvault:backup:v1';
const AAD_BACKUP_V3 = 'subvault:backup:v3';
const AAD_BACKUP_V4 = 'subvault:backup:v4';
const AAD_BACKUP_V5 = 'subvault:backup:v5';
const BACKUP_VERSION = 4;
const BACKUP_VERSION_EXPIRY = 5;
const STORAGE = {
  vault: 'vault',
  vaultIndex: 'vaultIndex',
  activeVault: 'activeVaultId',
  settings: 'settings',
  session: 'session',
  pending: 'pending',
  ignores: 'saveIgnores',
  takeover: 'takeoverState',
  syncJoined: 'syncJoined',
  syncMeta: 'syncMeta',
  webdavSnapshot: 'webdavSnapshot',
  webdavRestoreGuard: 'webdavRestoreGuard',
  webdavBackupMeta: 'webdavBackupMeta',
  travelMode: 'travelMode',
  customPsl: 'customPsl',
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
  allowSequenceSubmit: false,
  privacyShieldOnBlur: true,
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
  kdfAlgorithm: 'argon2id',
  syncTrigger: 'realtime',
  syncIntervalMinutes: 15,
  syncScheduleTime: '09:00',
  syncTransport: 'host',
  uiLanguage: 'auto',
  generatorOptions: {
    length: 20,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    pin: false,
    readable: true,
  },
};
const ALARM_NAME = 'subvault-auto-lock';
const LOCK_ALARM_NAME = 'subvault-lock-at';
const SYNC_ALARM_NAME = 'subvault-sync-poll';
const SYNC_TRIGGERS = ['realtime', 'interval', 'scheduled', 'unlock', 'manual'];

/** @type {{key: CryptoKey, keyJwk: any, kdf: any, data: any, lastActivity: number}|null} */
const DEFAULT_VAULT_ID = 'default';
let vaultIndexCache = null;
let vaultIndexReady = null;
let activeVaultId = DEFAULT_VAULT_ID;
let session = null;
let settingsCache = null;
let loadingPromise = null;
let lastSessionPersist = 0;
let opQueue = Promise.resolve();

/* Local native sync state. The host only stores an encrypted blob + settings. */
let nativePort = null;
let nativeRequestSeq = 0;
const nativePending = new Map();
const syncInfo = {
  available: false,
  exists: false,
  revision: 0,
  updatedAt: 0,
  path: '',
  joined: false,
  busy: false,
  lastSyncAt: 0,
  lastDirection: '',
  lastError: '',
  lastErrorCode: '',
  conflict: null,
  failures: 0,
  retryAt: 0,
  transport: 'host',
  configured: true,
  etag: '',
};
let syncBaseRevision = 0;
/**
 * Drop every piece of target metadata. Called whenever the transport or the
 * remote target changes so a stale host revision can never leak into a
 * WebDAV comparison (or vice versa).
 */
function resetSyncTarget() {
  syncReady = false;
  syncDirty = false;
  syncBaseRevision = 0;
  clearTimeout(syncPushTimer);
  syncPushTimer = null;
  syncInfo.available = false;
  syncInfo.exists = false;
  syncInfo.revision = 0;
  syncInfo.updatedAt = 0;
  syncInfo.path = '';
  syncInfo.etag = '';
  syncInfo.busy = false;
  syncInfo.conflict = null;
  syncInfo.joined = false;
  syncInfo.lastError = '';
  syncInfo.lastErrorCode = '';
  syncInfo.failures = 0;
  syncInfo.retryAt = 0;
}
const syncMetaReady = (async () => {
  try {
    const stored = await readLocal(STORAGE.syncMeta, null);
    if (stored && typeof stored === 'object') {
      syncInfo.joined = Boolean(stored.joined);
      syncInfo.lastSyncAt = Number(stored.lastSyncAt) || 0;
      syncInfo.lastDirection = String(stored.lastDirection || '');
      syncInfo.lastError = String(stored.lastError || '');
      syncInfo.lastErrorCode = String(stored.lastErrorCode || '');
      syncInfo.conflict = stored.conflict && typeof stored.conflict === 'object'
        ? stored.conflict
        : null;
      syncBaseRevision = Number(stored.baseRevision) || 0;
      syncInfo.etag = String(stored.etag || '');
      syncInfo.failures = Number(stored.failures) || 0;
      syncInfo.retryAt = Number(stored.retryAt) || 0;
    }
  } catch {
    /* best-effort metadata restore */
  }
})();
let syncReady = false;
let syncDirty = false;
let syncPushTimer = null;
let autoLockTimer = null;

/* Travel mode: local-only UI filtering. Never synced, never deleted. */
const TRAVEL_ALARM = 'subvault-travel-restore';
let travelState = {
  enabled: false,
  autoRestoreAt: 0,
  hiddenEntryIds: [],
  hiddenHosts: [],
  hiddenTags: [],
};
function normalizeTravel(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = (value, max, map = (item) => item) =>
    [...new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => map(String(item || '').trim().slice(0, max)))
        .filter(Boolean),
    )].slice(0, 2000);
  return {
    enabled: source.enabled === true,
    autoRestoreAt: Math.max(0, Number(source.autoRestoreAt) || 0),
    hiddenEntryIds: list(source.hiddenEntryIds, 80),
    hiddenHosts: list(source.hiddenHosts, 253, (item) => normalizeHost(item)),
    hiddenTags: list(source.hiddenTags, 32, (item) => item.toLowerCase()),
  };
}
const travelReady = (async () => {
  try {
    travelState = normalizeTravel(await readLocal(STORAGE.travelMode, null));
    if (travelState.enabled && travelState.autoRestoreAt) {
      await chrome.alarms.create(TRAVEL_ALARM, { when: travelState.autoRestoreAt });
    }
  } catch {
    /* travel config is optional */
  }
})();
async function persistTravel() {
  await writeLocal({ [STORAGE.travelMode]: travelState });
}
async function clearTravelAlarm() {
  try {
    await chrome.alarms?.clear?.(TRAVEL_ALARM);
  } catch {
    /* alarms may be unavailable in tests */
  }
}
async function disableTravel(reason = 'manual') {
  if (!travelState.enabled) return;
  travelState.enabled = false;
  travelState.autoRestoreAt = 0;
  await persistTravel();
  await clearTravelAlarm();
  await broadcastTravel(reason);
  await refreshBadge();
}
async function getTravel() {
  await travelReady;
  if (travelState.enabled && travelState.autoRestoreAt && Date.now() >= travelState.autoRestoreAt) {
    await disableTravel('auto');
  }
  return travelState;
}
function travelHides(entry, travel = travelState) {
  if (!travel?.enabled || !entry) return false;
  if (travel.hiddenEntryIds.includes(entry.id)) return true;
  if (
    travel.hiddenHosts.some((host) => host && entryMatches(entry, host)) ||
    (Array.isArray(entry.tags) &&
      entry.tags.some((tag) => travel.hiddenTags.includes(String(tag).toLowerCase())))
  ) {
    return true;
  }
  return false;
}
async function broadcastTravel(reason) {
  const payload = {
    type: 'SV_TRAVEL_CHANGED',
    reason,
    enabled: travelState.enabled,
    autoRestoreAt: travelState.autoRestoreAt,
  };
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.allSettled(
      tabs
        .filter((tab) => tab.id)
        .map((tab) => chrome.tabs.sendMessage(tab.id, payload)),
    );
  } catch {
    /* tabs may be unavailable during startup */
  }
}

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

async function removeLocal(key) {
  try {
    await chrome.storage.local.remove(key);
  } catch (error) {
    throw friendlyStorageError(error, '删除');
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

function normalizeGeneratorOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const length = Number(source.length);
  return {
    length: Number.isFinite(length) ? Math.min(64, Math.max(4, Math.round(length))) : 20,
    lower: source.lower === undefined ? true : Boolean(source.lower),
    upper: source.upper === undefined ? true : Boolean(source.upper),
    digits: source.digits === undefined ? true : Boolean(source.digits),
    symbols: source.symbols === undefined ? true : Boolean(source.symbols),
    pin: Boolean(source.pin),
    readable: source.readable === undefined ? true : Boolean(source.readable),
  };
}

function normalizeSyncTrigger(value) {
  return SYNC_TRIGGERS.includes(value) ? value : 'realtime';
}

function normalizeSyncInterval(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return 15;
  return Math.min(1440, Math.max(5, Math.round(minutes)));
}

function normalizeSyncTime(value) {
  const text = String(value || '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : '09:00';
}

function normalizeUiLanguage(value) {
  return value === 'en' || value === 'zh-CN' ? value : 'auto';
}

const customPslReady = (async () => {
  try {
    const stored = await chrome.storage.local.get(STORAGE.customPsl);
    if (stored?.[STORAGE.customPsl]) addCustomPslRules(stored[STORAGE.customPsl]);
  } catch {
    /* best-effort */
  }
})();

async function getSettings() {
  await customPslReady;
  if (settingsCache) return settingsCache;
  const stored = await readLocal(STORAGE.settings, {});
  settingsCache = {
    ...DEFAULT_SETTINGS,
    ...(stored || {}),
    isolatedDomains: normalizeDomainList(stored?.isolatedDomains),
    siteExceptions: normalizeSiteExceptions(stored?.siteExceptions),
    generatorOptions: normalizeGeneratorOptions(stored?.generatorOptions),
    syncTrigger: normalizeSyncTrigger(stored?.syncTrigger),
    syncIntervalMinutes: normalizeSyncInterval(stored?.syncIntervalMinutes),
    syncScheduleTime: normalizeSyncTime(stored?.syncScheduleTime),
    syncTransport: 'host',
    uiLanguage: normalizeUiLanguage(stored?.uiLanguage),
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
  if (next.syncTrigger !== undefined) {
    next.syncTrigger = normalizeSyncTrigger(next.syncTrigger);
  }
  next.syncIntervalMinutes = normalizeSyncInterval(next.syncIntervalMinutes);
  next.syncScheduleTime = normalizeSyncTime(next.syncScheduleTime);
  next.syncTransport = 'host';
  next.uiLanguage = normalizeUiLanguage(next.uiLanguage);
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

function vaultStorageKey(id) {
  return id === DEFAULT_VAULT_ID ? STORAGE.vault : `vault:${id}`;
}

function normalizeVaultName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) return '未命名密码库';
  return name.slice(0, 60);
}

async function ensureVaultIndex() {
  if (vaultIndexReady) return vaultIndexReady;
  vaultIndexReady = (async () => {
    let index = await readLocal(STORAGE.vaultIndex, null);
    if (!Array.isArray(index)) index = [];
    index = index.filter(
      (item) => item && typeof item.id === 'string' && item.id.length <= 80,
    );
    if (!index.length) {
      const legacy = await readLocal(STORAGE.vault, null);
      if (legacy?.box) {
        index = [
          {
            id: DEFAULT_VAULT_ID,
            name: '默认密码库',
            createdAt: Number(legacy.createdAt) || Date.now(),
          },
        ];
        await writeLocal(STORAGE.vaultIndex, index);
      }
    }
    const storedActive = await readLocal(STORAGE.activeVault, '');
    const known = new Set(index.map((item) => item.id));
    activeVaultId = known.has(storedActive)
      ? storedActive
      : index[0]?.id || DEFAULT_VAULT_ID;
    await writeLocal(STORAGE.activeVault, activeVaultId);
    vaultIndexCache = index;
    return index;
  })();
  try {
    return await vaultIndexReady;
  } finally {
    // Keep the resolved index cached; a failed load may retry next call.
    if (!vaultIndexCache) vaultIndexReady = null;
  }
}

async function getVaultIndex() {
  await ensureVaultIndex();
  return vaultIndexCache || [];
}

async function setActiveVault(id) {
  const index = await getVaultIndex();
  if (!index.some((item) => item.id === id)) throw new Error('密码库不存在');
  activeVaultId = id;
  await writeLocal(STORAGE.activeVault, id);
  return index.find((item) => item.id === id);
}

async function getVaultBlob(id = activeVaultId) {
  await ensureVaultIndex();
  const blob = await readLocal(vaultStorageKey(id), null);
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
  autoLockTimer?.unref?.();
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
    vaultId: session.vaultId || activeVaultId,
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
    await ensureVaultIndex();
    const meta = await readSessionArea(STORAGE.session, null);
    if (!meta?.keyJwk) return false;
    if ((meta.vaultId || DEFAULT_VAULT_ID) !== activeVaultId) {
      await removeSessionArea(STORAGE.session);
      return false;
    }
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
      const v4 = isV4VaultBlob(blob);
      const data = v4
        ? await decryptPayload(key, blob.box)
        : await decryptJSON(key, blob.box, AAD);
      if (!data || !Array.isArray(data.entries)) throw new Error('invalid vault');
      if (!Array.isArray(data.profiles)) data.profiles = [];
      session = {
        key,
        keyJwk: meta.keyJwk,
        kdf: blob.kdf,
        wrappedKey: v4 ? blob.wrappedKey : null,
        data,
        vaultId: activeVaultId,
        keyFile: Boolean(blob.keyFile),
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
  const v4 = Boolean(session.wrappedKey);
  const box = v4
    ? await encryptPayload(session.key, session.data)
    : await encryptJSON(session.key, session.data, AAD);
  const blob = v4
    ? {
        v: VAULT_FORMAT_VERSION,
        cipher: VAULT_CIPHER,
        kdf: session.kdf,
        wrappedKey: session.wrappedKey,
        box,
        createdAt: session.data.createdAt || Date.now(),
        updatedAt: session.data.updatedAt,
        keyFile: Boolean(session.keyFile),
      }
    : {
        v: VAULT_VERSION,
        cipher: VAULT_CIPHER,
        kdf: session.kdf,
        box,
        createdAt: session.data.createdAt || Date.now(),
        updatedAt: session.data.updatedAt,
        keyFile: Boolean(session.keyFile),
      };
  await writeLocal(vaultStorageKey(session.vaultId || activeVaultId), blob);
  void refreshBadge();
  scheduleSyncPush();
}

/* ------------------------------------------------------------------ */
/* Local native sync                                                   */
/* ------------------------------------------------------------------ */

function broadcastSync() {
  try {
    chrome.runtime.sendMessage({ type: 'SV_SYNC_CHANGED', sync: syncStatusPayload() }).catch(() => {});
  } catch {
    // No extension page is listening.
  }
}

function syncTransport() {
  return 'host';
}

function hasWebdavConfig() {
  return Boolean(session?.data?.webdav?.url);
}

function webdavConfig() {
  const config = session?.data?.webdav;
  if (!config?.url) throw new Error('尚未配置 WebDAV 服务器');
  return {
    url: String(config.url || ''),
    username: String(config.username || ''),
    password: String(config.password || ''),
  };
}

function normalizeWebdavUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('WebDAV 地址格式不正确');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('WebDAV 地址必须使用 HTTPS（本机测试可用 http://127.0.0.1）');
  }
  if (url.username || url.password) throw new Error('请不要把用户名或密码写在 WebDAV 地址里');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function sanitizeWebdavConfig(raw, previous = null) {
  if (!raw || typeof raw !== 'object') throw new Error('WebDAV 配置格式无效');
  const url = normalizeWebdavUrl(raw.url);
  const username = String(raw.username ?? '').trim().slice(0, 256);
  let password = String(raw.password ?? '');
  if (!password && previous?.password) password = String(previous.password);
  if (password.length > 1024) throw new Error('WebDAV 密码过长');
  return { url, username, password };
}

function syncStateInfo() {
  let state = 'idle';
  const transport = 'host';
  const configured = true;
  if (syncInfo.conflict) state = 'conflict';
  else if (syncInfo.busy) state = 'syncing';
  else if (!syncInfo.available) state = 'unavailable';
  else if (!syncInfo.joined) state = 'not_joined';
  else if (!syncInfo.exists) state = 'no_remote';
  return {
    state,
    trigger: settingsCache?.syncTrigger || 'realtime',
    locked: !session,
    transport,
    configured,
  };
}

function syncStatusPayload() {
  return { ...syncInfo, ...syncStateInfo() };
}

async function syncRequest(type, payload = {}, timeout = 8000, override = null) {
  const transport = override ? 'webdav' : syncTransport();
  const vaultId = session?.vaultId || activeVaultId || DEFAULT_VAULT_ID;
  if (transport === 'host') return nativeRequest(type, { ...payload, vaultId }, timeout);
  const config = override || webdavConfig();
  const limit = Math.max(timeout, 25000);
  if (type === 'status') {
    return nativeRequest('webdav-status', { config, etag: payload.etag ?? (syncInfo.etag || ''), vaultId }, Math.max(limit, 12000));
  }
  if (type === 'pull') return nativeRequest('webdav-pull', { config, vaultId }, limit);
  if (type === 'publish') {
    return nativeRequest('webdav-push', {
      config,
      vaultId,
      baseRevision: payload.baseRevision ?? syncBaseRevision,
      etag: payload.etag !== undefined ? payload.etag : (syncInfo.etag || ''),
      vault: payload.vault,
      settings: payload.settings,
      ignores: payload.ignores,
    }, limit);
  }
  throw new Error('未知的同步操作');
}

async function persistSyncMeta() {
  await syncMetaReady;
  try {
    await writeLocal(STORAGE.syncMeta, {
      joined: syncInfo.joined,
      lastSyncAt: syncInfo.lastSyncAt,
      lastDirection: syncInfo.lastDirection,
      lastError: syncInfo.lastError,
      lastErrorCode: syncInfo.lastErrorCode,
      conflict: syncInfo.conflict,
      baseRevision: syncBaseRevision,
      etag: syncInfo.etag || '',
      failures: syncInfo.failures,
      retryAt: syncInfo.retryAt,
    });
  } catch {
    /* metadata is best-effort; never block sync on it */
  }
}

async function markSyncSuccess(direction) {
  syncInfo.joined = true;
  syncInfo.busy = false;
  syncInfo.lastSyncAt = Date.now();
  syncInfo.lastDirection = direction;
  syncInfo.lastError = '';
  syncInfo.lastErrorCode = '';
  syncInfo.conflict = null;
  syncInfo.failures = 0;
  syncInfo.retryAt = 0;
  await persistSyncMeta();
  broadcastSync();
}

function classifySyncError(error) {
  const raw = String(error?.message || error || '同步失败');
  if (/connectNative|not supported|不支持本机同步|宿主已断开|not found|Access is denied|找不到/i.test(raw)) {
    return { code: 'host_unavailable', message: '未检测到本机同步宿主，请安装宿主后重启浏览器' };
  }
  if (/超时|timeout/i.test(raw)) return { code: 'timeout', message: '同步宿主响应超时，请稍后重试' };
  if (/权限|denied|permission/i.test(raw)) return { code: 'permission', message: '同步目录无法写入，请检查宿主目录权限' };
  if (/不匹配|mismatch/i.test(raw)) return { code: 'vault_mismatch', message: '同步密码库与当前主密码不匹配，请用原主密码解锁后重试' };
  if (/conflict|冲突/i.test(raw)) return { code: 'conflict', message: '远端已有更新，需要选择保留哪个版本' };
  return { code: 'unknown', message: raw };
}

function setSyncError(error) {
  const { code, message } = classifySyncError(error);
  if (error && typeof error === 'object' && error.__syncErrorRecorded) {
    return { code, message };
  }
  if (error && typeof error === 'object') error.__syncErrorRecorded = true;
  syncInfo.busy = false;
  syncInfo.lastErrorCode = code;
  syncInfo.lastError = message;
  syncInfo.failures = Math.min(10, (Number(syncInfo.failures) || 0) + 1);
  const delay = Math.min(30 * 60 * 1000, 15_000 * 2 ** (syncInfo.failures - 1));
  syncInfo.retryAt = Date.now() + delay;
  void persistSyncMeta();
  broadcastSync();
  return { code, message };
}

function setSyncConflict(localUpdated, remoteUpdated, remoteRevision) {
  syncInfo.busy = false;
  syncInfo.conflict = {
    at: Date.now(),
    localUpdated: Number(localUpdated) || 0,
    remoteUpdated: Number(remoteUpdated) || 0,
    remoteRevision: Number(remoteRevision) || 0,
  };
  syncInfo.lastErrorCode = 'conflict';
  syncInfo.lastError = '远端已有更新，需要选择保留哪个版本';
  void persistSyncMeta();
  broadcastSync();
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
    syncInfo.busy = false;
    setSyncError(new Error(message));
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
    if ((settingsCache?.syncTrigger || 'realtime') !== 'realtime') return;
    if (!syncReady && session) {
      void ensureSyncReady().then((ok) => {
        if (ok) void syncPoll().catch(() => {});
      });
      return;
    }
    if (syncReady && session) {
      // Compare timestamps first: a stale 'change' notification must never
      // overwrite a newer local edit with an older remote revision.
      void syncPoll().catch(() => {});
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

async function deviceStatusFor(vaultId = activeVaultId) {
  await ensureVaultIndex();
  const id = vaultId || activeVaultId || DEFAULT_VAULT_ID;
  try {
    const status = await nativeRequest('device-status', { vaultId: id }, 3000);
    return {
      ok: true,
      supported: status.supported !== false,
      exists: Boolean(status.exists),
      createdAt: Number(status.createdAt) || 0,
      cipher: status.cipher || '',
      credentialId: String(status.credentialId || ''),
      needsHello: Boolean(status.needsHello),
      vaultId: id,
    };
  } catch (error) {
    return {
      ok: false,
      supported: false,
      exists: false,
      vaultId: id,
      error: `无法连接本机同步宿主：${error?.message || error}`,
    };
  }
}

async function enableDeviceUnlock(credentialId = '') {
  await requireUnlocked();
  if (!credentialId) throw new Error('需要先完成 Windows Hello 验证');
  if (!isV4VaultBlob(await getVaultBlob())) {
    throw new Error('仅 v4 密码库支持设备快速解锁，请先用主密码解锁完成迁移');
  }
  const raw = await exportKeyRaw(session.key);
  const result = await nativeRequest(
    'device-protect',
    {
      vaultId: session.vaultId || activeVaultId,
      key: bytesToBase64(raw),
      credentialId: String(credentialId || '').slice(0, 1024),
    },
    6000,
  );
  if (!result?.ok) throw new Error(result?.error || '无法创建本机设备绑定');
  return deviceStatusFor(session.vaultId || activeVaultId);
}

async function disableDeviceUnlock(vaultId = activeVaultId) {
  await ensureVaultIndex();
  const id = vaultId || activeVaultId || DEFAULT_VAULT_ID;
  const result = await nativeRequest('device-forget', { vaultId: id }, 4000);
  if (!result?.ok) throw new Error(result?.error || '无法移除本机设备绑定');
  return deviceStatusFor(id);
}

async function unlockWithDevice(vaultId = activeVaultId, credentialId = '') {
  if (session) return { ok: true, alreadyUnlocked: true, count: session.data?.entries?.length || 0 };
  await ensureVaultIndex();
  const id = vaultId || activeVaultId || DEFAULT_VAULT_ID;
  if (!credentialId) {
    throw new Error('此设备绑定缺少 Windows Hello 验证凭据，请用主密码解锁后在设置页重新启用设备快速解锁');
  }
  if (id !== activeVaultId) await setActiveVault(id);
  const result = await nativeRequest('device-unlock', { vaultId: id, credentialId }, 6000);
  if (!result?.ok || !result.key) {
    throw new Error(result?.error || '设备快速解锁失败，请使用主密码解锁');
  }
  const blob = await getVaultBlob(id);
  if (!isV4VaultBlob(blob)) {
    throw new Error('该密码库不是 v4 格式，无法使用设备快速解锁');
  }
  const key = await importKeyRaw(base64ToBytes(result.key));
  const data = await decryptPayload(key, blob.box);
  if (!data || !Array.isArray(data.entries)) throw new Error('密码库数据无效');
  if (!Array.isArray(data.profiles)) data.profiles = [];
  const keyJwk = await exportKeyJwk(key);
  session = {
    key,
    keyJwk,
    kdf: blob.kdf,
    wrappedKey: blob.wrappedKey,
    data,
    vaultId: id,
    keyFile: Boolean(blob.keyFile),
    lastActivity: Date.now(),
  };
  lastSessionPersist = 0;
  await persistSession();
  scheduleAutoLock();
  await ensureEntryTimes();
  await refreshBadge();
  await broadcastVaultUnlocked();
  return { ok: true, unlocked: true, count: data.entries.length, format: 4 };
}

async function forgetDeviceBindingsForVaults(ids) {
  for (const id of ids) {
    try {
      await nativeRequest('device-forget', { vaultId: id }, 2500);
    } catch {
      // Best effort: deleting the vault already makes the binding unusable.
    }
  }
}

async function refreshNativeStatus() {
  try {
    const status = await syncRequest('status', {}, 2500);
    const notModified = status.notModified === true;
    syncInfo.available = true;
    syncInfo.exists = notModified ? true : Boolean(status.exists);
    if (!notModified) {
      syncInfo.revision = Number(status.revision) || 0;
      syncInfo.updatedAt = Number(status.updatedAt) || 0;
      syncInfo.path = status.path || '';
    }
    syncInfo.transport = syncTransport();
    syncInfo.configured = true;
    if (typeof status.etag === 'string' && status.etag) syncInfo.etag = status.etag;
    broadcastSync();
    return { ...syncInfo };
  } catch (error) {
    syncInfo.available = false;
    setSyncError(error);
    throw error;
  }
}

/**
 * Optional key-file second factor: fold the SHA-256 of the chosen file into
 * the KDF password. The file itself is never stored; a wrong file simply
 * fails to decrypt.
 */
async function effectivePassword(password, keyFileBase64 = '') {
  if (!keyFileBase64) return password;
  return `${password}\u0000kf:${await sha256Hex(String(keyFileBase64))}`;
}

function isV4VaultBlob(blob) {
  return Number(blob?.v) >= VAULT_FORMAT_VERSION && Boolean(blob?.wrappedKey);
}

function migrationBackupKey(vaultId = activeVaultId) {
  return `vaultBackup:${vaultId || DEFAULT_VAULT_ID}`;
}

async function readMigrationBackup(vaultId = activeVaultId) {
  const stored = await readLocal(migrationBackupKey(vaultId), null);
  return stored && stored.blob ? stored : null;
}

async function decryptVaultBlob(blob, password, keyFileBase64 = '') {
  const kdf = blob?.kdf || {};
  if (!kdf.salt) throw new Error('同步数据缺少加密参数');
  if (blob?.cipher && blob.cipher !== VAULT_CIPHER) {
    throw new Error('密码库使用了不受支持的加密算法');
  }
  const kek = await deriveKeyFromKdf(await effectivePassword(password, keyFileBase64), kdf);
  if (isV4VaultBlob(blob)) {
    const key = await unwrapVaultKey(kek, blob.wrappedKey);
    const data = await decryptPayload(key, blob.box);
    return {
      key,
      kek,
      data,
      kdf,
      wrappedKey: blob.wrappedKey,
      format: VAULT_FORMAT_VERSION,
      v3Blob: null,
    };
  }
  const data = await decryptJSON(kek, blob.box, AAD);
  return {
    key: kek,
    kek,
    data,
    kdf,
    wrappedKey: null,
    format: Number(blob?.v) || 1,
    v3Blob: blob,
  };
}

/**
 * Wrap the payload key under a KEK derived from the current master password.
 * The payload box is kept as-is: changing the password (or the key file) only
 * rewraps the VaultKey, exactly like the format-v4 design requires.
 */
async function writeRewrappedVault({ kdf, kek }) {
  if (!session?.key || !session.wrappedKey) throw new Error('当前密码库不是 v4 格式');
  const blob = await getVaultBlob(session.vaultId || activeVaultId);
  if (!blob?.box) throw new Error('密码库不存在');
  const wrappedKey = await wrapVaultKey(kek, session.key);
  const next = {
    ...blob,
    v: VAULT_FORMAT_VERSION,
    cipher: VAULT_CIPHER,
    kdf,
    wrappedKey,
    updatedAt: blob.updatedAt || Date.now(),
    keyFile: Boolean(session.keyFile),
  };
  await writeLocal(vaultStorageKey(session.vaultId || activeVaultId), next);
  // The migration backup is tied to the previous credentials; after a
  // password/key-file change it can no longer serve as a safe rollback point.
  await removeLocal(migrationBackupKey(session.vaultId || activeVaultId));
  session.kdf = kdf;
  session.wrappedKey = wrappedKey;
  session.kek = kek;
  lastSessionPersist = 0;
  await persistSession();
  return next;
}

async function saveRemoteSnapshot(payload) {
  const current = await readLocal(vaultStorageKey(activeVaultId));
  if (!current?.box) return;
  const existing = await readLocal(STORAGE.webdavSnapshot);
  // Keep the first local state seen for a remote revision: repeated pulls of
  // the same revision must not overwrite the rollback point with synced data.
  if (existing && Number(existing.remoteRevision) === Number(payload?.revision)) return;
  await writeLocal(STORAGE.webdavSnapshot, {
    blob: current,
    savedAt: Date.now(),
    remoteRevision: Number(payload?.revision) || 0,
  });
}

async function applyRemotePayload(payload, key, data, kdf) {
  await getSettings();
  await saveRemoteSnapshot(payload);
  const format = Number(payload.vault.v) >= VAULT_FORMAT_VERSION ? VAULT_FORMAT_VERSION : 1;
  const wrappedKey = format === VAULT_FORMAT_VERSION ? payload.vault.wrappedKey : null;
  await writeLocal(vaultStorageKey(activeVaultId), {
    v: format,
    cipher: payload.vault.cipher || VAULT_CIPHER,
    kdf,
    ...(wrappedKey ? { wrappedKey } : {}),
    box: payload.vault.box,
    createdAt: payload.vault.createdAt || data.createdAt || Date.now(),
    updatedAt: payload.vault.updatedAt || data.updatedAt || Date.now(),
    keyFile: Boolean(payload.vault.keyFile),
  });
  if (payload.settings && typeof payload.settings === 'object') {
    // Sync transport/schedule is device-local; a remote vault must not flip it.
    const localSync = {
      syncTransport: settingsCache.syncTransport,
      syncTrigger: settingsCache.syncTrigger,
      syncIntervalMinutes: settingsCache.syncIntervalMinutes,
      syncScheduleTime: settingsCache.syncScheduleTime,
      uiLanguage: settingsCache.uiLanguage,
      lockOnSystemLock: settingsCache.lockOnSystemLock,
      lockOnSystemIdle: settingsCache.lockOnSystemIdle,
    };
    await saveSettings(payload.settings);
    await saveSettings(localSync);
  }
  if (Array.isArray(payload.ignores)) {
    await writeLocal(STORAGE.ignores, payload.ignores.filter((host) => isValidHost(host)));
  }
  const keyJwk = await exportKeyJwk(key);
  session = {
    key,
    keyJwk,
    kdf,
    wrappedKey,
    data,
    lastActivity: Date.now(),
    keyFile: Boolean(payload.vault?.keyFile),
    vaultId: activeVaultId,
  };
  lastSessionPersist = 0;
  await persistSession();
  scheduleAutoLock();
  syncBaseRevision = Number(payload.revision) || 0;
  syncInfo.revision = Number(payload.revision) || 0;
  syncInfo.updatedAt = Number(payload.updatedAt) || 0;
  if (payload.path) syncInfo.path = payload.path;
  syncInfo.exists = true;
  syncInfo.available = true;
  syncInfo.etag = payload.etag || '';
  syncInfo.transport = syncTransport();
  syncInfo.configured = true;
  syncReady = true;
  syncDirty = false;
  syncInfo.joined = true;
  await writeLocal(STORAGE.syncJoined, true);
  await persistSyncMeta();
  await refreshBadge();
  await broadcastVaultUnlocked();
}

async function pullAndApplyRemote() {
  const payload = await syncRequest('pull');
  if (!payload.exists) return { exists: false };
  if (!session) return { exists: true, locked: true };
  const format = Number(payload.vault?.v) >= VAULT_FORMAT_VERSION ? VAULT_FORMAT_VERSION : 1;
  let data;
  if (format === VAULT_FORMAT_VERSION) {
    // The payload key is wrapped in the remote blob; any device that already
    // unlocked this vault holds the same VaultKey, so a password change on the
    // other device only changes the wrapper, not this decryption path.
    data = await decryptPayload(session.key, payload.vault.box);
  } else {
    if (session.kdf?.salt !== payload.vault?.kdf?.salt) {
      throw new Error('同步密码库与当前主密码不匹配，请重新同步');
    }
    data = await decryptJSON(session.key, payload.vault.box, AAD);
  }
  await applyRemotePayload(payload, session.key, data, payload.vault.kdf);
  syncInfo.etag = payload.etag || '';
  await markSyncSuccess('pull');
  return { exists: true, count: data.entries.length, revision: syncBaseRevision };
}

async function pushLocalVault() {
  if (!session || !syncReady) return { skipped: true };
  const blob = await getVaultBlob();
  if (!blob) return { skipped: true };
  const result = await syncRequest('publish', {
    baseRevision: syncBaseRevision,
    vault: blob,
    settings: settingsCache || {},
    ignores: await readLocal(STORAGE.ignores, []),
  });
  if (result.conflict) {
    if (syncTransport() === 'webdav') {
      try {
        await refreshNativeStatus();
      } catch {
        /* keep the last known remote metadata */
      }
    }
    syncInfo.revision = Number(result.revision) || syncInfo.revision;
    syncInfo.updatedAt = Number(result.updatedAt) || syncInfo.updatedAt;
    setSyncConflict(blob.updatedAt, syncInfo.updatedAt, syncInfo.revision);
    return { conflict: true, revision: syncInfo.revision, ...syncStatusPayload() };
  }
  syncBaseRevision = Number(result.revision) || syncBaseRevision;
  syncInfo.available = true;
  syncInfo.exists = true;
  syncInfo.revision = syncBaseRevision;
  syncInfo.updatedAt = Number(result.updatedAt) || syncInfo.updatedAt;
  if (typeof result.etag === 'string') syncInfo.etag = result.etag;
  syncDirty = false;
  await writeLocal(STORAGE.syncJoined, true);
  await markSyncSuccess('push');
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

function shouldRunSyncTrigger(trigger) {
  if (trigger === 'realtime') return true;
  if (trigger === 'interval') {
    const gap = normalizeSyncInterval(settingsCache?.syncIntervalMinutes) * 60_000;
    return !syncInfo.lastSyncAt || Date.now() - syncInfo.lastSyncAt >= gap;
  }
  if (trigger === 'scheduled') {
    const [hours, minutes] = normalizeSyncTime(settingsCache?.syncScheduleTime).split(':').map(Number);
    const now = new Date();
    const target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hours,
      minutes,
      0,
      0,
    ).getTime();
    return Date.now() >= target && (Number(syncInfo.lastSyncAt) || 0) < target;
  }
  return false;
}

async function syncPoll({ force = false } = {}) {
  await getSettings();
  const trigger = settingsCache?.syncTrigger || 'realtime';
  if (!force) {
    if (syncInfo.retryAt && Date.now() < syncInfo.retryAt) {
      return { skipped: true, reason: 'backoff', ...syncStatusPayload() };
    }
    if (!shouldRunSyncTrigger(trigger)) {
      return { skipped: true, reason: 'trigger', ...syncStatusPayload() };
    }
  }
  if (!session) return { skipped: true, reason: 'locked', ...syncStatusPayload() };
  const joined = (await readLocal(STORAGE.syncJoined, false)) || syncInfo.joined;
  if (!joined) return { skipped: true, reason: 'not_joined', ...syncStatusPayload() };
  if (syncInfo.conflict) {
    try {
      await refreshNativeStatus();
    } catch {
      /* status is best-effort here */
    }
    return { conflict: true, ...syncStatusPayload() };
  }
  syncInfo.busy = true;
  broadcastSync();
  try {
    const status = await refreshNativeStatus();
    if (!status.exists) {
      syncReady = true;
      syncBaseRevision = 0;
      const pushed = await pushLocalVault();
      syncInfo.busy = false;
      if (pushed?.conflict) return { conflict: true, ...syncStatusPayload() };
      broadcastSync();
      return { ...syncStatusPayload(), created: Boolean(pushed?.ok) };
    }
    const localBlob = await getVaultBlob();
    const localUpdated = Number(localBlob?.updatedAt) || 0;
    const hostUpdated = Number(status.updatedAt) || 0;
    const hostRevision = Number(status.revision) || 0;
    syncReady = true;
    const localDirty = syncDirty || localUpdated > hostUpdated + 1000;
    if (localDirty) {
      if (syncBaseRevision && hostRevision !== syncBaseRevision) {
        setSyncConflict(localUpdated, hostUpdated, hostRevision);
        syncInfo.busy = false;
        return { conflict: true, ...syncStatusPayload() };
      }
      syncBaseRevision = hostRevision;
      const pushed = await pushLocalVault();
      if (pushed?.conflict) {
        syncInfo.busy = false;
        return { conflict: true, ...syncStatusPayload() };
      }
    } else if (hostUpdated > localUpdated + 1000) {
      await pullAndApplyRemote();
    } else {
      syncBaseRevision = hostRevision;
      await markSyncSuccess('pull');
    }
    syncInfo.busy = false;
    broadcastSync();
    return { ok: true, ...syncStatusPayload() };
  } catch (error) {
    setSyncError(error);
    throw error;
  }
}

function scheduleSyncPush() {
  syncDirty = true;
  const trigger = settingsCache?.syncTrigger || 'realtime';
  if (trigger === 'manual' || trigger === 'unlock' || trigger === 'interval' || trigger === 'scheduled') {
    broadcastSync();
    return;
  }
  if (syncInfo.conflict) {
    broadcastSync();
    return;
  }
  if (!syncReady) {
    void ensureSyncReady().then((ok) => {
      if (ok) void pushLocalVault().catch((error) => setSyncError(error));
    });
    return;
  }
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    pushLocalVault().catch((error) => {
      syncDirty = true;
      setSyncError(error);
    });
  }, 600);
}

async function initializeSyncAfterSetup() {
  try {
    const status = await refreshNativeStatus();
    if (!status.exists) {
      syncReady = true;
      syncInfo.joined = true;
      await writeLocal(STORAGE.syncJoined, true);
      await persistSyncMeta();
      await pushLocalVault();
    }
    return status;
  } catch (error) {
    setSyncError(error);
    return { available: false, exists: false };
  }
}

async function reconcileSyncAfterUnlock() {
  try {
    // A snapshot restore is a deliberate local override; do not immediately
    // pull the remote revision back over it. The next manual sync will surface
    // the conflict and let the user choose.
    if (await readLocal(STORAGE.webdavRestoreGuard, false)) {
      await removeLocal(STORAGE.webdavRestoreGuard);
      broadcastSync();
      return { restored: true, skipped: true };
    }
    const status = await refreshNativeStatus();
    if (!status.exists) {
      syncReady = true;
      syncInfo.joined = true;
      await writeLocal(STORAGE.syncJoined, true);
      await persistSyncMeta();
      if (session.data.entries.length > 0) await pushLocalVault();
      return status;
    }
    syncBaseRevision = Number(status.revision) || 0;
    syncReady = true;
    syncInfo.joined = true;
    await writeLocal(STORAGE.syncJoined, true);
    await persistSyncMeta();
    const localBlob = await getVaultBlob();
    const localUpdated = Number(localBlob?.updatedAt) || 0;
    const hostUpdated = Number(status.updatedAt) || 0;
    if (syncDirty || localUpdated > hostUpdated + 1000) {
      const pushed = await pushLocalVault();
      if (pushed?.conflict) {
        syncInfo.busy = false;
        return { conflict: true, ...syncStatusPayload() };
      }
    } else if (hostUpdated > localUpdated + 1000) {
      await pullAndApplyRemote();
    }
    return status;
  } catch (error) {
    setSyncError(error);
    return { available: false, exists: false };
  }
}

async function resolveSyncConflict(strategy) {
  if (!session) throw new Error('密码库已锁定');
  if (!syncInfo.conflict) throw new Error('当前没有需要处理的同步冲突');
  if (strategy === 'remote') {
    syncInfo.busy = true;
    broadcastSync();
    try {
      await pullAndApplyRemote();
      syncInfo.busy = false;
      await markSyncSuccess('pull');
      return { ok: true, strategy, ...syncStatusPayload() };
    } catch (error) {
      setSyncError(error);
      throw error;
    }
  }
  if (strategy !== 'local') throw new Error('未知的冲突处理方式');
  syncInfo.busy = true;
  broadcastSync();
  try {
    const status = await refreshNativeStatus();
    syncBaseRevision = Number(status.revision) || 0;
    syncInfo.revision = syncBaseRevision;
    syncInfo.updatedAt = Number(status.updatedAt) || syncInfo.updatedAt;
    syncInfo.conflict = null;
    syncInfo.lastError = '';
    syncInfo.lastErrorCode = '';
    syncDirty = true;
    await pushLocalVault();
    if (syncInfo.conflict) throw new Error('远端在此期间再次更新，请重新选择');
    syncInfo.busy = false;
    await markSyncSuccess('push');
    return { ok: true, strategy, ...syncStatusPayload() };
  } catch (error) {
    setSyncError(error);
    throw error;
  }
}

async function syncPullWithPassword(password, keyFileBase64 = '', webdav = null) {
  if (!session) throw new Error('密码库已锁定');
  if (session.data.entries.length > 0) {
    throw new Error('当前密码库已有数据，请先导出后清空，再同步本机已有数据');
  }
  const payload = await syncRequest('pull', {}, 25000, webdav);
  if (!payload.exists) throw new Error('远端没有可同步的数据');
  const { key, data } = await decryptVaultBlob(payload.vault, password, keyFileBase64);
  await applyRemotePayload(payload, key, data, payload.vault.kdf);
  await markSyncSuccess('pull');
  return { count: data.entries.length, revision: syncBaseRevision };
}

async function webdavBackupNow(sender) {
  if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
  const s = await requireUnlocked();
  const config = webdavConfig();
  if (!config) throw new Error('请先配置 WebDAV 备份');
  const status = await syncRequest('status', {}, 10000, config);
  const vault = await getVaultBlob(s.vaultId);
  const payload = {
    vault,
    settings: backupSettingsSnapshot(),
    ignores: await readLocal(STORAGE.ignores, []),
  };
  const result = await syncRequest(
    'publish',
    {
      ...payload,
      baseRevision: status.revision || 0,
      etag: status.etag || '',
    },
    30000,
    config,
  );
  if (!result.ok) {
    if (result.conflict) throw new Error('WebDAV 上已有更新的备份，请先恢复或确认后重试');
    throw new Error(result.error || 'WebDAV 备份失败');
  }
  const meta = {
    at: Date.now(),
    revision: Number(result.revision) || 0,
    error: '',
  };
  await writeLocal(STORAGE.webdavBackupMeta, meta);
  return { ok: true, revision: meta.revision, at: meta.at };
}

async function webdavRestoreBackup(password, keyFileBase64, sender) {
  if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
  if (!password) throw new Error('请输入该密码库的主密码');
  const config = webdavConfig();
  if (!config) throw new Error('请先配置 WebDAV 备份');
  const pulled = await syncRequest('pull', {}, 30000, config);
  if (!pulled.ok) throw new Error(pulled.error || '无法从 WebDAV 下载备份');
  if (!pulled.vault) throw new Error('WebDAV 上没有可恢复的密码库备份');
  const { data } = await decryptVaultBlob(pulled.vault, password, keyFileBase64);
  return enqueue(async () => {
    const s = await requireUnlocked();
    await writeLocal(vaultStorageKey(s.vaultId), pulled.vault);
    await lockVault({ broadcast: true });
    return { ok: true, restored: true, locked: true, entries: data.entries.length };
  });
}

async function webdavBackupStatus() {
  const meta = await readLocal(STORAGE.webdavBackupMeta, null);
  const config = session?.data?.webdav || null;
  return {
    configured: Boolean(config?.url),
    lastBackupAt: Number(meta?.at) || 0,
    lastRevision: Number(meta?.revision) || 0,
    lastError: meta?.error || '',
  };
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
    const travel = await getTravel();
    await Promise.allSettled(
      tabs.map((tab) => {
        if (!tab.id) return Promise.resolve();
        const parsed = parseHttpUrl(tab.url || '');
        if (!parsed) {
          return chrome.action.setBadgeText({ tabId: tab.id, text: '' });
        }
        const host = normalizeHost(parsed.hostname);
        const port = normalizePort(parsed.port);
        const count = session.data.entries.filter(
          (entry) => entryMatches(entry, host, port) && !travelHides(entry, travel),
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

function normalizeTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,，]/);
  return [...new Set(
    list
      .map((item) => String(item || '').trim().slice(0, 32))
      .filter(Boolean),
  )].slice(0, 12);
}

function normalizeFillSequence(input) {
  if (!Array.isArray(input)) return [];
  const steps = [];
  for (const raw of input.slice(0, 20)) {
    const type = String(raw?.type || '').toLowerCase();
    if (type === 'wait') {
      steps.push({ type, ms: Math.min(10000, Math.max(0, Number(raw.ms) || 300)) });
    } else if (type === 'click') {
      const selector = clampText(raw.selector, 200).trim();
      if (selector) steps.push({ type, selector });
    } else if (['username', 'password', 'totp', 'tab', 'enter'].includes(type)) {
      steps.push({ type });
    }
  }
  return steps;
}

function normalizePasskey(input) {
  if (!input || typeof input !== 'object') return null;
  const credentialId = clampText(input.credentialId, 1024).trim();
  const rpId = normalizeHost(input.rpId || '');
  const username = clampText(input.username, LIMITS.username).trim();
  const note = clampText(input.note, 500).trim();
  if (!credentialId && !rpId && !username && !note) return null;
  return { credentialId, rpId, username, note };
}

function normalizeEntryInput(input, hostOverride = '') {
  const rawHostInput = String(input.host || hostOverride || '').trim();
  const parsedHost = parseHttpUrl(rawHostInput);
  const host = normalizeHost(parsedHost?.hostname || rawHostInput);
  if (!isValidHost(host)) throw new Error('网站域名无效');

  const password = String(input.password ?? '');
  const passkey = normalizePasskey(input.passkey);
  if (!password && !passkey) throw new Error('密码不能为空');
  if (password.length > LIMITS.password) throw new Error('密码过长');

  const rawTotp = String(input.totpSecret ?? '').trim();
  let totpSecret = '';
  let totpDigits = 6;
  let totpPeriod = 30;
  let totpAlgorithm = 'SHA1';
  if (rawTotp) {
    const parsedOtp = parseOtpAuthUri(rawTotp);
    const candidate = parsedOtp?.secret || rawTotp;
    if (!isValidTotpSecret(candidate)) throw new Error('TOTP secret must be valid Base32');
    totpSecret = normalizeTotpSecret(candidate);
    if (totpSecret.length > LIMITS.totp) throw new Error('TOTP secret is too long');
    if (parsedOtp) {
      totpDigits = parsedOtp.digits;
      totpPeriod = parsedOtp.period;
      totpAlgorithm = parsedOtp.algorithm;
    } else {
      totpDigits = Number(input.totpDigits) === 8 ? 8 : 6;
      totpPeriod = Math.min(300, Math.max(10, Number(input.totpPeriod) || 30));
      totpAlgorithm = ['SHA1', 'SHA256', 'SHA512'].includes(
        String(input.totpAlgorithm || '').toUpperCase(),
      )
        ? String(input.totpAlgorithm).toUpperCase()
        : 'SHA1';
    }
  }

  const parsedUrl = parseHttpUrl(input.url || '') || parsedHost;
  const port = normalizePort(input.port || parsedUrl?.port || parsedHost?.port || '');
  const url = parsedUrl ? parsedUrl.href.slice(0, LIMITS.url) : `https://${host}/`;

  return {
    title: clampText(input.title, LIMITS.title).trim() || host,
    host,
    port,
    username: clampText(input.username, LIMITS.username).trim(),
    aliasEmail: clampText(input.aliasEmail, LIMITS.username).trim(),
    aliasProvider: clampText(input.aliasProvider, 80).trim(),
    password,
    notes: clampText(input.notes, LIMITS.notes),
    url,
    totpSecret,
    totpDigits,
    totpPeriod,
    totpAlgorithm,
    favorite: Boolean(input.favorite),
    tags: normalizeTags(input.tags),
    folder: clampText(input.folder, 80).trim(),
    fillSequence: normalizeFillSequence(input.fillSequence),
    passkey,
  };
}

function safeEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    host: entry.host,
    port: entry.port || '',
    username: entry.username || '',
    aliasEmail: entry.aliasEmail || '',
    aliasProvider: entry.aliasProvider || '',
    url: entry.url || '',
    createdAt: entry.createdAt || 0,
    updatedAt: entry.updatedAt || 0,
    passwordChangedAt: entryTime(entry),
    lastUsedAt: entry.lastUsedAt || 0,
    source: entry.source || '',
    hasPassword: Boolean(entry.password),
    hasTotp: Boolean(entry.totpSecret),
    hasPasskey: Boolean(entry.passkey?.credentialId || entry.passkey?.rpId),
    favorite: Boolean(entry.favorite),
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    folder: entry.folder || '',
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

function normalizeProfileInput(input = {}) {
  const clamp = (value, limit = 200) => String(value ?? '').trim().slice(0, limit);
  const fields = Array.isArray(input.fields)
    ? input.fields
        .filter((field) => field && typeof field === 'object')
        .map((field) => ({ label: clamp(field.label, 60), value: clamp(field.value, 500) }))
        .filter((field) => field.label && field.value)
        .slice(0, 30)
    : [];
  return {
    name: clamp(input.name, 60) || '默认资料',
    fullName: clamp(input.fullName),
    email: clamp(input.email),
    phone: clamp(input.phone, 60),
    address: clamp(input.address, 500),
    company: clamp(input.company),
    website: clamp(input.website, 300),
    notes: clamp(input.notes, 2000),
    fields,
  };
}

function safeProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    fullName: profile.fullName,
    email: profile.email,
    phone: profile.phone,
    address: profile.address,
    company: profile.company,
    website: profile.website,
    notes: profile.notes,
    fields: Array.isArray(profile.fields) ? profile.fields : [],
    updatedAt: Number(profile.updatedAt) || 0,
  };
}

function findProfile(id) {
  if (!session) return null;
  return (session.data.profiles || []).find((profile) => profile.id === id) || null;
}

async function saveProfile(input) {
  const s = await requireUnlocked();
  if (!Array.isArray(s.data.profiles)) s.data.profiles = [];
  const normalized = normalizeProfileInput(input);
  const now = Date.now();
  let profile = input.id ? findProfile(input.id) : null;
  if (profile) {
    Object.assign(profile, normalized, { updatedAt: now });
  } else {
    if (s.data.profiles.length >= 50) throw new Error('资料模板最多 50 个');
    profile = { id: randomId(), ...normalized, createdAt: now, updatedAt: now };
    s.data.profiles.push(profile);
  }
  await saveVault();
  return { ok: true, profile: safeProfile(profile) };
}

async function deleteProfile(id) {
  const s = await requireUnlocked();
  const before = s.data.profiles?.length || 0;
  s.data.profiles = (s.data.profiles || []).filter((profile) => profile.id !== id);
  if (s.data.profiles.length === before) throw new Error('资料模板不存在');
  await saveVault();
  return { ok: true };
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
    if (input.favorite !== undefined) covering.favorite = Boolean(input.favorite);
    if (input.tags !== undefined) covering.tags = normalizeTags(input.tags);
    if (input.folder !== undefined) covering.folder = clampText(input.folder, 80).trim();
    if (input.aliasEmail !== undefined) covering.aliasEmail = normalized.aliasEmail;
    if (input.aliasProvider !== undefined) covering.aliasProvider = normalized.aliasProvider;
    if (input.fillSequence !== undefined) covering.fillSequence = normalized.fillSequence;
    if (input.passkey !== undefined) covering.passkey = normalized.passkey;
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

  const previewRows = [];
  const previewSeen = new Set();
  rows.forEach((row, index) => {
    try {
      const entry = normalizeEntryInput(row, row.host);
      const key = conflictGroupKey(entry.host, entry.username, isolated, {
        port: entry.port,
        portIsolation,
      });
      let duplicate = false;
      if (key) {
        duplicate =
          previewSeen.has(key) ||
          s.data.entries.some(
            (existing) =>
              conflictGroupKey(existing.host, existing.username, isolated, {
                port: existing.port,
                portIsolation,
              }) === key,
          );
        previewSeen.add(key);
      }
      previewRows.push({
        index,
        title: entry.title || entry.host,
        host: entry.host,
        username: entry.username || '',
        duplicate,
      });
    } catch {
      // Invalid rows are counted in `skipped` by normalizeImportRows.
    }
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
    rows: previewRows,
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

async function validateMasterPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('主密码至少需要 10 个字符');
  }
  if (password.length > 1024) throw new Error('主密码过长');
  if (isCommonPassword(password)) throw new Error('该主密码太常见，请更换一个更安全的主密码');
  // Local-only zxcvbn estimate; nothing leaves the device.
  const strength = await evaluateMasterPassword(password);
  if (strength.blocked) {
    throw new Error(strength.message || '主密码强度不足，请更换一个更长的随机密码');
  }
}

/** Tell every http(s) tab that the vault is now usable, without a reload. */
async function broadcastVaultUnlocked() {
  try {
    if (!chrome.tabs?.query) return;
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.allSettled(
      tabs.map((tab) =>
        chrome.tabs.sendMessage(tab.id, { type: 'SV_UNLOCKED' }).catch(() => {}),
      ),
    );
  } catch {
    /* tabs may be unavailable */
  }
}

function preferredKdfParams() {
  return settingsCache?.kdfAlgorithm === 'pbkdf2' ? createKdfParams() : createArgon2Params();
}

async function setupVault(password, keyFileBase64 = '', name = '默认密码库') {
  await validateMasterPassword(password);
  await getSettings();
  const index = await getVaultIndex();
  if (index.length) throw new Error('密码库已存在，请直接解锁');
  const kdf = preferredKdfParams();
  const effective = await effectivePassword(password, keyFileBase64);
  const kek = await deriveKeyFromKdf(effective, kdf);
  const key = await createVaultKey();
  const wrappedKey = await wrapVaultKey(kek, key);
  const now = Date.now();
  const data = { version: VAULT_VERSION, entries: [], profiles: [], createdAt: now, updatedAt: now };
  const box = await encryptPayload(key, data);
  const blob = {
    v: VAULT_FORMAT_VERSION,
    cipher: VAULT_CIPHER,
    kdf,
    wrappedKey,
    box,
    createdAt: now,
    updatedAt: now,
    keyFile: Boolean(keyFileBase64),
  };
  activeVaultId = DEFAULT_VAULT_ID;
  await writeLocal(vaultStorageKey(activeVaultId), blob);
  const nextIndex = [
    { id: activeVaultId, name: normalizeVaultName(name), createdAt: now },
  ];
  vaultIndexCache = nextIndex;
  await writeLocal(STORAGE.vaultIndex, nextIndex);
  await writeLocal(STORAGE.activeVault, activeVaultId);
  const keyJwk = await exportKeyJwk(key);
  session = {
    key,
    keyJwk,
    kdf,
    wrappedKey,
    kek,
    data,
    vaultId: activeVaultId,
    lastActivity: now,
    keyFile: Boolean(keyFileBase64),
  };
  lastSessionPersist = 0;
  await persistSession();
  scheduleAutoLock();
  await refreshBadge();
  await broadcastVaultUnlocked();
  void initializeSyncAfterSetup();
  return { unlocked: true, created: true, vaultId: activeVaultId };
}

async function createVault(name, password, keyFileBase64 = '', sender = null) {
  if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
  await validateMasterPassword(password);
  await getSettings();
  const index = await getVaultIndex();
  if (index.length >= 20) throw new Error('最多保存 20 个密码库');
  const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const kdf = preferredKdfParams();
  const kek = await deriveKeyFromKdf(await effectivePassword(password, keyFileBase64), kdf);
  const key = await createVaultKey();
  const wrappedKey = await wrapVaultKey(kek, key);
  const now = Date.now();
  const data = { version: VAULT_VERSION, entries: [], profiles: [], createdAt: now, updatedAt: now };
  const box = await encryptPayload(key, data);
  await writeLocal(`vault:${id}`, {
    v: VAULT_FORMAT_VERSION,
    cipher: VAULT_CIPHER,
    kdf,
    wrappedKey,
    box,
    createdAt: now,
    updatedAt: now,
    keyFile: Boolean(keyFileBase64),
  });
  const nextIndex = [
    ...index,
    { id, name: normalizeVaultName(name), createdAt: now },
  ];
  vaultIndexCache = nextIndex;
  await writeLocal(STORAGE.vaultIndex, nextIndex);
  return { ok: true, vaultId: id };
}

async function deleteVault(id, password, keyFileBase64 = '', sender = null) {
  if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
  const index = await getVaultIndex();
  const target = index.find((item) => item.id === id);
  if (!target) throw new Error('密码库不存在');
  const blob = await getVaultBlob(id);
  if (!blob) throw new Error('密码库不存在');
  if (blob.keyFile && !keyFileBase64) throw new Error('此密码库需要密钥文件');
  await decryptVaultBlob(blob, password, keyFileBase64);

  await lockVault({ broadcast: false });
  try {
    await chrome.storage.local.remove(vaultStorageKey(id));
  } catch (error) {
    throw friendlyStorageError(error, '删除');
  }
  await forgetDeviceBindingsForVaults([id]);
  const nextIndex = index.filter((item) => item.id !== id);
  vaultIndexCache = nextIndex;
  await writeLocal(STORAGE.vaultIndex, nextIndex);
  const nextActive = nextIndex.some((item) => item.id === activeVaultId)
    ? activeVaultId
    : nextIndex[0]?.id || DEFAULT_VAULT_ID;
  activeVaultId = nextActive;
  await writeLocal(STORAGE.activeVault, activeVaultId);
  await refreshBadge();
  void broadcastVaultChanged();
  return { ok: true, activeVaultId, vaults: nextIndex };
}

async function mergeVaultIntoActive(sourceId, password, keyFileBase64 = '', sender = null) {
  if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
  const current = await requireUnlocked();
  if (!sourceId || sourceId === current.vaultId) throw new Error('不能合并到自身');
  const index = await getVaultIndex();
  if (!index.some((item) => item.id === sourceId)) throw new Error('密码库不存在');
  const blob = await getVaultBlob(sourceId);
  if (!blob) throw new Error('密码库不存在');
  if (blob.keyFile && !keyFileBase64) throw new Error('该密码库需要密钥文件');
  const sourceData = (await decryptVaultBlob(blob, password, keyFileBase64)).data;
  if (!sourceData || !Array.isArray(sourceData.entries)) throw new Error('密码库内容无效');
  const settings = await getSettings();
  const result = mergeEntries(current.data.entries, sourceData.entries, {
    source: 'vault-merge',
    isolatedDomains: settings.isolatedDomains || [],
    portIsolation: settings.portIsolation === true,
  });
  current.data.entries = result.entries;
  await saveVault();
  return {
    ok: true,
    imported: result.imported,
    updated: result.updated,
    merged: result.merged,
    total: current.data.entries.length,
  };
}

async function renameVault(id, name, sender = null) {
  if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
  const index = await getVaultIndex();
  const target = index.find((item) => item.id === id);
  if (!target) throw new Error('密码库不存在');
  target.name = normalizeVaultName(name);
  await writeLocal(STORAGE.vaultIndex, index);
  return { ok: true, vaults: index };
}

async function vaultListPayload() {
  const index = await getVaultIndex();
  const vaults = [];
  for (const item of index) {
    const blob = await getVaultBlob(item.id);
    vaults.push({
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      keyFile: Boolean(blob?.keyFile),
    });
  }
  return { activeVaultId, vaults };
}

async function broadcastVaultChanged() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.allSettled(
      tabs.map((tab) =>
        chrome.tabs.sendMessage(tab.id, { type: 'SV_VAULT_CHANGED' }).catch(() => {}),
      ),
    );
  } catch {
    /* tabs may be unavailable */
  }
}

async function migrationStatusPayload() {
  const blob = await getVaultBlob();
  const backup = await readMigrationBackup();
  return {
    currentVersion: Number(blob?.v) || 0,
    keyFile: Boolean(blob?.keyFile),
    exists: Boolean(backup),
    savedAt: Number(backup?.savedAt) || 0,
    fromVersion: Number(backup?.fromVersion) || 0,
  };
}

async function rollbackVaultMigration(password, keyFileBase64 = '', sender = null) {
  if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
  return enqueue(async () => {
    const targetId = activeVaultId;
    const backup = await readMigrationBackup(targetId);
    if (!backup) throw new Error('没有可回滚的迁移备份');
    if (!password) throw new Error('请输入主密码以确认回滚');
    if (backup.blob.keyFile && !keyFileBase64) {
      throw new Error('此密码库需要密钥文件，请选择迁移前的密钥文件');
    }
    const unlocked = await decryptVaultBlob(backup.blob, password, keyFileBase64);
    const data = unlocked.data;
    if (!data || !Array.isArray(data.entries)) throw new Error('迁移备份内容无效');

    await writeLocal(vaultStorageKey(targetId), backup.blob);
    await removeLocal(migrationBackupKey(targetId));
    await forgetDeviceBindingsForVaults([targetId]);
    // The rolled-back blob is intentionally left at its old format. Lock so
    // the next unlock performs the migration again with the user present.
    await lockVault({ broadcast: true });
    return {
      ok: true,
      version: Number(backup.blob.v) || 1,
      count: data.entries.length,
      locked: true,
    };
  });
}

let failedUnlocks = 0;
let blockedUntil = 0;

async function unlockVault(password, keyFileBase64 = '', vaultId = '') {
  if (!password) throw new Error('请输入主密码');
  await getSettings();
  await ensureVaultIndex();
  if (Date.now() < blockedUntil) {
    const seconds = Math.ceil((blockedUntil - Date.now()) / 1000);
    throw new Error(`尝试次数过多，请 ${seconds} 秒后再试`);
  }
  const targetId = vaultId || activeVaultId;
  if (!(await getVaultIndex()).some((item) => item.id === targetId)) {
    throw new Error('密码库不存在');
  }
  const previousSession = session;
  const blob = await getVaultBlob(targetId);
  if (!blob) throw new Error('尚未创建密码库');
  const kdf = blob.kdf || {};
  if (!kdf.salt) throw new Error('密码库数据损坏');
  if (blob.keyFile && !keyFileBase64) {
    throw new Error('此密码库需要密钥文件，请选择密钥文件后解锁');
  }
  const legacySha = kdf.algo !== 'ARGON2ID' && kdf.hash !== 'SHA-512';
  const effective = await effectivePassword(password, keyFileBase64);

  try {
    const unlocked = await decryptVaultBlob(blob, password, keyFileBase64);
    let { key, kek, data, kdf: activeKdf, wrappedKey, format } = unlocked;
    let migrated = false;
    let upgradedKdf = false;

    // Old vaults stored the master-derived key directly. Migrate to the v4
    // VaultKey wrapper, keeping a rollback copy of the original encrypted blob.
    if (format < VAULT_FORMAT_VERSION) {
      try {
        let nextKdf = kdf;
        if (legacySha) {
          nextKdf = preferredKdfParams();
          kek = await deriveKeyFromKdf(effective, nextKdf);
          upgradedKdf = true;
        }
        const vaultKey = await createVaultKey();
        const nextWrappedKey = await wrapVaultKey(kek, vaultKey);
        const nextBox = await encryptPayload(vaultKey, data);
        // Verify before overwriting anything.
        const verifyKey = await unwrapVaultKey(kek, nextWrappedKey);
        await decryptPayload(verifyKey, nextBox);

        await writeLocal(migrationBackupKey(targetId), {
          blob,
          savedAt: Date.now(),
          fromVersion: Number(blob.v) || 1,
        });
        await writeLocal(vaultStorageKey(targetId), {
          ...blob,
          v: VAULT_FORMAT_VERSION,
          cipher: VAULT_CIPHER,
          kdf: nextKdf,
          wrappedKey: nextWrappedKey,
          box: nextBox,
        });
        key = vaultKey;
        activeKdf = nextKdf;
        wrappedKey = nextWrappedKey;
        migrated = true;
      } catch (error) {
        const failure = new Error(`密码库格式迁移失败，原密码库未覆盖：${error?.message || '未知错误'}`);
        failure.migrationFailed = true;
        throw failure;
      }
    }

    const keyJwk = await exportKeyJwk(key);
    activeVaultId = targetId;
    await writeLocal(STORAGE.activeVault, activeVaultId);
    session = {
      key,
      keyJwk,
      kdf: activeKdf,
      wrappedKey,
      kek,
      data,
      vaultId: activeVaultId,
      lastActivity: Date.now(),
      keyFile: Boolean(blob.keyFile),
    };
    lastSessionPersist = 0;
    failedUnlocks = 0;
    await ensureEntryTimes();
    await persistSession();
    scheduleAutoLock();
    await refreshBadge();
    await broadcastVaultUnlocked();
    void reconcileSyncAfterUnlock();
    return {
      unlocked: true,
      count: data.entries.length,
      upgradedKdf,
      migrated,
      format: VAULT_FORMAT_VERSION,
    };
  } catch (error) {
    session = previousSession;
    if (!previousSession) {
      lastSessionPersist = 0;
      await removeSessionArea(STORAGE.session);
    }
    if (error?.migrationFailed) throw error;
    failedUnlocks += 1;
    if (failedUnlocks >= 5) {
      failedUnlocks = 0;
      blockedUntil = Date.now() + 30_000;
    }
    throw new Error('主密码错误，或密码库数据已损坏');
  }
}

async function changeMasterPassword(current, next, keyFileBase64 = '') {
  if (typeof current !== 'string' || !current) throw new Error('请输入当前主密码');
  await validateMasterPassword(next);
  await unlockVault(current, keyFileBase64);
  // Rewrap only. The payload box must stay byte-identical so a password
  // change does not re-encrypt the whole vault.
  const kdf = preferredKdfParams();
  await writeRewrappedVault({
    kdf,
    kek: await deriveKeyFromKdf(await effectivePassword(next, keyFileBase64), kdf),
  });
  return { changed: true, rewrapped: true };
}

async function verifyPassword(password, keyFileBase64 = '') {
  const blob = await getVaultBlob();
  if (!blob) throw new Error('密码库不存在');
  await decryptVaultBlob(blob, password, keyFileBase64);
}

async function wipeVault() {
  session = null;
  lastSessionPersist = 0;
  await ensureVaultIndex();
  await forgetDeviceBindingsForVaults((vaultIndexCache || []).map((item) => item.id));
  try {
    const all = await chrome.storage.local.get(null);
    const vaultKeys = Object.keys(all).filter(
      (key) =>
        key === STORAGE.vault ||
        key.startsWith('vault:') ||
        key.startsWith('vaultBackup:'),
    );
    if (vaultKeys.length) await chrome.storage.local.remove(vaultKeys);
    await chrome.storage.local.remove([
      STORAGE.ignores,
      STORAGE.vaultIndex,
      STORAGE.activeVault,
    ]);
    vaultIndexCache = null;
    vaultIndexReady = null;
    activeVaultId = DEFAULT_VAULT_ID;
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
  'allowSequenceSubmit',
  'privacyShieldOnBlur',
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
  'kdfAlgorithm',
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
    'allowSequenceSubmit',
    'privacyShieldOnBlur',
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
  if (input.kdfAlgorithm !== undefined) {
    const algos = ['argon2id', 'pbkdf2'];
    if (algos.includes(input.kdfAlgorithm)) output.kdfAlgorithm = input.kdfAlgorithm;
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
      const blob = await getVaultBlob();
      return {
        initialized,
        locked,
        pendingCount: pending.length,
        keyFile: Boolean(blob?.keyFile),
        formatVersion: Number(blob?.v) || 0,
        migrationBackup: Boolean(await readMigrationBackup()),
        ...(await vaultListPayload()),
      };
    }

    case 'SV_GET_MIGRATION_STATUS': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return migrationStatusPayload();
    }

    case 'SV_ROLLBACK_MIGRATION':
      return rollbackVaultMigration(
        String(message.password || ''),
        String(message.keyFileBase64 || ''),
        sender,
      );

    case 'SV_DEVICE_STATUS': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return deviceStatusFor(String(message.vaultId || '') || activeVaultId);
    }

    case 'SV_DEVICE_ENABLE':
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(() => enableDeviceUnlock(String(message.credentialId || '')));

    case 'SV_DEVICE_DISABLE': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      return disableDeviceUnlock(String(message.vaultId || '') || activeVaultId);
    }

    case 'SV_DEVICE_UNLOCK':
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(() => unlockWithDevice(
        String(message.vaultId || '') || activeVaultId,
        String(message.credentialId || ''),
      ));

    case 'SV_SETUP':
      return enqueue(async () => {
        await getSettings();
        return setupVault(
          message.password,
          String(message.keyFileBase64 || ''),
          String(message.name || '默认密码库'),
        );
      });

    case 'SV_UNLOCK':
      return enqueue(() =>
        unlockVault(
          message.password,
          String(message.keyFileBase64 || ''),
          String(message.vaultId || ''),
        ),
      );

    case 'SV_GET_VAULTS':
      return vaultListPayload();

    case 'SV_SELECT_VAULT': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      const id = String(message.vaultId || '');
      await lockVault({ broadcast: false });
      await setActiveVault(id);
      resetSyncTarget();
      void broadcastVaultChanged();
      return { ok: true, ...(await vaultListPayload()) };
    }

    case 'SV_CREATE_VAULT': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await lockVault({ broadcast: false });
      resetSyncTarget();
      const created = await enqueue(() =>
        createVault(
          message.name,
          message.password,
          String(message.keyFileBase64 || ''),
          sender,
        ),
      );
      await setActiveVault(created.vaultId);
      resetSyncTarget();
      void broadcastVaultChanged();
      return { ok: true, ...(await vaultListPayload()) };
    }

    case 'SV_DELETE_VAULT': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      const result = await enqueue(() =>
        deleteVault(
          String(message.vaultId || ''),
          message.password,
          String(message.keyFileBase64 || ''),
          sender,
        ),
      );
      void broadcastVaultChanged();
      return result;
    }

    case 'SV_MERGE_VAULT': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(() =>
        mergeVaultIntoActive(
          String(message.vaultId || ''),
          message.password,
          String(message.keyFileBase64 || ''),
          sender,
        ),
      );
    }

    case 'SV_RENAME_VAULT': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      const result = await renameVault(
        String(message.vaultId || ''),
        message.name,
        sender,
      );
      void broadcastVaultChanged();
      return result;
    }

    case 'SV_LOCK':
      await lockVault();
      return { locked: true };

    case 'SV_CHANGE_MASTER':
      return enqueue(() =>
        changeMasterPassword(
          message.currentPassword,
          message.newPassword,
          String(message.keyFileBase64 || ''),
        ),
      );

    case 'SV_SET_KEY_FILE': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const password = String(message.password || '');
      const currentKeyFile = String(message.currentKeyFileBase64 || '');
      const nextKeyFile = String(message.newKeyFileBase64 || '');
      if (!password) throw new Error('请输入主密码以确认');
      await verifyPassword(password, currentKeyFile);
      return enqueue(async () => {
        const kdf = preferredKdfParams();
        const kek = await deriveKeyFromKdf(
          await effectivePassword(password, nextKeyFile),
          kdf,
        );
        session.keyFile = Boolean(nextKeyFile);
        await writeRewrappedVault({ kdf, kek });
        return { ok: true, keyFile: Boolean(nextKeyFile) };
      });
    }

    case 'SV_GENERATE_PASSWORD': {
      // Used by the inline "generate strong password" chip on signup forms and
      // by the popup generator. Generation is pure local randomness.
      const options = message.options && typeof message.options === 'object' ? message.options : {};
      const password = generatePassword({
        length: options.length,
        lower: options.lower,
        upper: options.upper,
        digits: options.digits,
        symbols: options.symbols,
      });
      return { password };
    }

    case 'SV_WIPE':
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      return enqueue(async () => {
        if (message.confirm !== '清空密码库') throw new Error('请输入确认文字：清空密码库');
        await verifyPassword(
          String(message.password || ''),
          String(message.keyFileBase64 || ''),
        );
        return wipeVault();
      });

    case 'SV_RESET_VAULT':
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      if (message.confirm !== '清空密码库') throw new Error('请输入确认文字：清空密码库');
      return enqueue(() => wipeVault());

    case 'SV_GET_SYNC_CONFIG': {
      await requireUnlocked();
      const config = session?.data?.webdav || null;
      return {
        transport: syncTransport(),
        configured: Boolean(config?.url),
        webdav: config
          ? { url: config.url, username: config.username || '', hasPassword: Boolean(config.password) }
          : null,
      };
    }

    case 'SV_SET_WEBDAV': {
      if (!isExtensionPage(sender)) throw new Error('仅设置页面可配置 WebDAV');
      await requireUnlocked();
      const config = sanitizeWebdavConfig(message.webdav, session?.data?.webdav);
      session.data.webdav = config;
      await saveVault();
      return {
        ok: true,
        configured: true,
        webdav: { url: config.url, username: config.username, hasPassword: Boolean(config.password) },
      };
    }

    case 'SV_CLEAR_WEBDAV': {
      if (!isExtensionPage(sender)) throw new Error('仅设置页面可配置 WebDAV');
      await requireUnlocked();
      if (session.data.webdav) {
        delete session.data.webdav;
        await saveVault();
      }
      await removeLocal(STORAGE.webdavBackupMeta);
      return { ok: true, configured: false };
    }

    case 'SV_WEBDAV_BACKUP_NOW':
      return webdavBackupNow(sender);

    case 'SV_WEBDAV_BACKUP_STATUS':
      return { ok: true, ...(await webdavBackupStatus()) };

    case 'SV_WEBDAV_RESTORE': {
      return webdavRestoreBackup(
        String(message.password || ''),
        String(message.keyFileBase64 || ''),
        sender,
      );
    }

    case 'SV_GET_TRAVEL': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const travel = await getTravel();
      return { ok: true, ...travel };
    }

    case 'SV_SET_TRAVEL': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const requested = message.travel && typeof message.travel === 'object' ? message.travel : {};
      if (requested.enabled === false) {
        if (!message.password) throw new Error('关闭旅行模式需要输入主密码');
        await verifyPassword(message.password, message.keyFileBase64 || '');
        await disableTravel('manual');
        return { ok: true, enabled: false };
      }
      const next = normalizeTravel({ ...travelState, ...requested, enabled: true });
      const hours = Math.max(0, Math.min(720, Number(message.autoRestoreHours) || 0));
      next.autoRestoreAt =
        Number(message.autoRestoreAt) > 0
          ? Number(message.autoRestoreAt)
          : hours > 0
            ? Date.now() + hours * 3_600_000
            : 0;
      travelState = next;
      await persistTravel();
      if (next.autoRestoreAt) await chrome.alarms.create(TRAVEL_ALARM, { when: next.autoRestoreAt });
      else await clearTravelAlarm();
      await broadcastTravel('updated');
      await refreshBadge();
      return { ok: true, ...travelState };
    }

    case 'SV_GET_WEBDAV_SNAPSHOT': {
      if (!isExtensionPage(sender)) throw new Error('仅设置页面可读取同步快照');
      const snapshot = await readLocal(STORAGE.webdavSnapshot);
      return {
        exists: Boolean(snapshot?.blob?.box),
        savedAt: Number(snapshot?.savedAt) || 0,
        remoteRevision: Number(snapshot?.remoteRevision) || 0,
      };
    }

    case 'SV_RESTORE_WEBDAV_SNAPSHOT': {
      if (!isExtensionPage(sender)) throw new Error('仅设置页面可恢复同步快照');
      const snapshot = await readLocal(STORAGE.webdavSnapshot);
      if (!snapshot?.blob?.box) throw new Error('没有可恢复的同步快照');
      await writeLocal(STORAGE.vault, snapshot.blob);
      await removeLocal(STORAGE.webdavSnapshot);
      await writeLocal(STORAGE.webdavRestoreGuard, true);
      await lockVault({ broadcast: true });
      return { ok: true, restoredAt: Number(snapshot.savedAt) || 0 };
    }

    case 'SV_SYNC_STATUS':
      await syncMetaReady;
      await getSettings();
      try {
        await refreshNativeStatus();
      } catch {
        /* refreshNativeStatus records the classified error */
      }
      return syncStatusPayload();

    case 'SV_SYNC_NOW':
      await loadSession();
      if (!session) throw new Error('密码库已锁定');
      await syncPoll({ force: true });
      return syncStatusPayload();

    case 'SV_SYNC_RESOLVE':
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可处理同步冲突');
      await requireUnlocked();
      return resolveSyncConflict(String(message.strategy || ''));

    case 'SV_SYNC_PULL':
      await requireUnlocked();
      return syncPullWithPassword(
        String(message.password || ''),
        String(message.keyFileBase64 || ''),
        message.webdav ? sanitizeWebdavConfig(message.webdav, session?.data?.webdav) : null,
      );

    case 'SV_SYNC_IMPORT': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可以导入同步数据');
      if (await getVaultBlob()) throw new Error('本地已有密码库，请使用设置页同步');
      const webdav = message.webdav ? sanitizeWebdavConfig(message.webdav) : null;
      resetSyncTarget();
      const payload = await syncRequest('pull', {}, 25000, webdav);
      if (!payload.exists) throw new Error('远端没有可导入的同步数据');
      const { key, data } = await decryptVaultBlob(
        payload.vault,
        String(message.password || ''),
        String(message.keyFileBase64 || ''),
      );
      await applyRemotePayload(payload, key, data, payload.vault.kdf);
      if (webdav) {
        session.data.webdav = webdav;
        await saveVault();
      }
      await markSyncSuccess('pull');
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

    case 'SV_POPUP_STATE': {
      await getSettings();
      const vaultsPayload = await vaultListPayload();
      const vaultBlob = await getVaultBlob();
      const initialized = Boolean(vaultBlob);
      const keyFile = Boolean(vaultBlob?.keyFile);
      const meta = await readSessionArea(STORAGE.session, null);
      const lastActivity = session?.lastActivity || meta?.lastActivity;
      const expired = !meta?.keyJwk || sessionExpired({ lastActivity });
      if (expired) {
        if (session) await lockVault({ broadcast: false });
        return { initialized, locked: true, keyFile, settings: settingsCache, pending: [], ...vaultsPayload };
      }
      if (!session && !(await loadSession())) {
        return { initialized, locked: true, keyFile, settings: settingsCache, pending: [], ...vaultsPayload };
      }
      if (!(await enforceAutoLock())) {
        return { initialized, locked: true, keyFile, settings: settingsCache, pending: [], ...vaultsPayload };
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
        keyFile,
        host,
        port,
        siteKey,
        isolated: host ? isHostIsolated(host, isolated) : false,
        isolatedDomains: isolated,
        policy: host ? sitePolicyFor(host) : {},
        matches,
        pending,
        settings: settingsCache,
        ...vaultsPayload,
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
      const travel = await getTravel();
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
        matches: findEntriesForHost(host, port)
          .filter((entry) => !travelHides(entry, travel))
          .map(safeEntry)
          .sort(
            (a, b) =>
              Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
              (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
              (a.username || '').localeCompare(b.username || ''),
          ),
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
      if (travelHides(entry, await getTravel())) throw new Error('该账号在旅行模式中已隐藏');
      if (!targetHost || !entryMatches(entry, targetHost, targetPort)) {
        throw new Error('该账号不属于当前网站，已阻止填充');
      }
      entry.lastUsedAt = Date.now();
      await saveVault();
      let totpCode = '';
      if (entry.totpSecret) {
        try {
          const totp = await generateTotp(entry.totpSecret, {
            digits: entry.totpDigits,
            period: entry.totpPeriod,
            algorithm: entry.totpAlgorithm,
          });
          totpCode = totp.code;
        } catch {
          /* a malformed legacy secret should not block password fill */
        }
      }
      return {
        username: entry.username || '',
        password: entry.password,
        title: entry.title,
        totpCode,
        fillSequence: Array.isArray(entry.fillSequence) ? entry.fillSequence : [],
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
      const travel = message.includeHidden === true ? { enabled: false } : await getTravel();
      const visibleEntries = s.data.entries.filter((entry) => !travelHides(entry, travel));
      const counts = new Map();
      for (const entry of visibleEntries) {
        counts.set(entry.password, (counts.get(entry.password) || 0) + 1);
      }
      const now = Date.now();
      const weakPasswords = new Map();
      const isWeak = async (password) => {
        const key = String(password || '');
        if (weakPasswords.has(key)) return weakPasswords.get(key);
        const digest = await sha256Hex(key);
        const weak =
          passwordStrength(key).score <= 1 ||
          isCommonPassword(key) ||
          isWeakPasswordHash(digest);
        weakPasswords.set(key, weak);
        return weak;
      };
      const entries = [];
      for (const entry of sortEntries(visibleEntries)) {
        const info = safeEntry(entry);
        info.weak = await isWeak(entry.password);
        info.reused = (counts.get(entry.password) || 0) > 1;
        info.ageDays = Math.max(0, Math.floor((now - entryTime(entry)) / 86_400_000));
        info.old = info.ageDays > 365;
        info.http = /^http:\/\//i.test(entry.url || '');
        entries.push(info);
      }
      return {
        entries,
        stats: {
          total: visibleEntries.length,
          hosts: new Set(visibleEntries.map((entry) => entry.host)).size,
          weak: entries.filter((entry) => entry.weak).length,
          reused: entries.filter((entry) => entry.reused).length,
          old: entries.filter((entry) => entry.old).length,
          http: entries.filter((entry) => entry.http).length,
          totp: entries.filter((entry) => entry.hasTotp).length,
          favorite: entries.filter((entry) => entry.favorite).length,
          updatedAt: s.data.updatedAt || 0,
        },
      };
    }

    case 'SV_GET_ALIASES': {
      const s = await requireUnlocked();
      const travel = await getTravel();
      const seen = new Set();
      const aliases = [];
      for (const entry of s.data.entries) {
        const email = String(entry.aliasEmail || '').trim();
        if (!email || travelHides(entry, travel)) continue;
        const dedupe = email.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        aliases.push({
          email,
          provider: String(entry.aliasProvider || '').trim(),
          host: entry.host || '',
          title: entry.title || entry.host || '',
        });
      }
      aliases.sort((a, b) => a.email.localeCompare(b.email));
      return { aliases };
    }

    case 'SV_GET_ALL_SECRETS': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      const s = await requireUnlocked();
      const travel = await getTravel();
      return {
        entries: s.data.entries
          .filter((entry) => !travelHides(entry, travel))
          .map((entry) => ({
          id: entry.id,
          title: entry.title || entry.host,
          host: entry.host,
          port: entry.port || '',
          username: entry.username || '',
          aliasEmail: entry.aliasEmail || '',
          aliasProvider: entry.aliasProvider || '',
          passkey: entry.passkey || null,
          password: entry.password || '',
          url: entry.url || '',
          notes: entry.notes || '',
          totpSecret: entry.totpSecret || '',
          totpDigits: entry.totpDigits || 6,
          totpPeriod: entry.totpPeriod || 30,
          totpAlgorithm: entry.totpAlgorithm || 'SHA1',
          tags: Array.isArray(entry.tags) ? entry.tags : [],
          folder: entry.folder || '',
          favorite: Boolean(entry.favorite),
          passwordChangedAt: entryTime(entry),
        })),
      };
    }

    case 'SV_GET_SECRET': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const entry = findEntry(message.id);
      if (!entry) throw new Error('账号不存在');
      if (travelHides(entry, await getTravel())) throw new Error('该账号在旅行模式中已隐藏');
      return {
        id: entry.id,
        username: entry.username || '',
        password: entry.password,
        notes: entry.notes || '',
        title: entry.title,
        host: entry.host,
        port: entry.port || '',
        url: entry.url || '',
        aliasEmail: entry.aliasEmail || '',
        aliasProvider: entry.aliasProvider || '',
        fillSequence: Array.isArray(entry.fillSequence) ? entry.fillSequence : [],
        passkey: entry.passkey || null,
        passwordChangedAt: entryTime(entry),
        totpSecret: entry.totpSecret || '',
        totpDigits: entry.totpDigits || 6,
        totpPeriod: entry.totpPeriod || 30,
        totpAlgorithm: entry.totpAlgorithm || 'SHA1',
        favorite: Boolean(entry.favorite),
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        folder: entry.folder || '',
        historyCount: Array.isArray(entry.history) ? entry.history.length : 0,
      };
    }

    case 'SV_TOGGLE_FAVORITE': {
      if (!isExtensionPage(sender)) throw new Error('Only extension pages may change favorites');
      return enqueue(async () => {
        const s = await requireUnlocked();
        const entry = s.data.entries.find((item) => item.id === message.id);
        if (!entry) throw new Error('Entry not found');
        entry.favorite = !entry.favorite;
        entry.updatedAt = Date.now();
        await saveVault();
        return { favorite: entry.favorite };
      });
    }

    case 'SV_BULK_UPDATE': {
      if (!isExtensionPage(sender)) throw new Error('Only extension pages may update entries');
      return enqueue(async () => {
        const s = await requireUnlocked();
        const ids = new Set(Array.isArray(message.ids) ? message.ids : []);
        let updated = 0;
        for (const entry of s.data.entries) {
          if (!ids.has(entry.id)) continue;
          entry.favorite = Boolean(message.favorite);
          entry.updatedAt = Date.now();
          updated += 1;
        }
        if (updated) await saveVault();
        return { updated };
      });
    }

    case 'SV_BULK_DELETE': {
      if (!isExtensionPage(sender)) throw new Error('Only extension pages may delete entries');
      return enqueue(async () => {
        const s = await requireUnlocked();
        const ids = new Set(Array.isArray(message.ids) ? message.ids : []);
        const before = s.data.entries.length;
        s.data.entries = s.data.entries.filter((entry) => !ids.has(entry.id));
        const deleted = before - s.data.entries.length;
        if (deleted) await saveVault();
        return { deleted };
      });
    }

    case 'SV_GET_TOTP_CODE': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await requireUnlocked();
      const entry = findEntry(message.id);
      if (!entry) throw new Error('账号不存在');
      if (!entry.totpSecret) throw new Error('该账号没有配置 TOTP');
      const result = await generateTotp(entry.totpSecret, {
        digits: entry.totpDigits,
        period: entry.totpPeriod,
        algorithm: entry.totpAlgorithm,
      });
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

    case 'SV_LIST_PROFILES': {
      const s = await requireUnlocked();
      return { ok: true, profiles: (s.data.profiles || []).map(safeProfile) };
    }

    case 'SV_GET_PROFILE': {
      await requireUnlocked();
      const profile = findProfile(String(message.id || ''));
      if (!profile) throw new Error('资料模板不存在');
      return { ok: true, profile: safeProfile(profile) };
    }

    case 'SV_SAVE_PROFILE':
      return enqueue(() => saveProfile(message.profile || message));

    case 'SV_DELETE_PROFILE':
      return enqueue(() => deleteProfile(String(message.id || '')));

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

    case 'SV_PREVIEW_IMPORT_ROWS': {
      if (!isExtensionPage(sender)) throw new Error('Only extension pages may import');
      await requireUnlocked();
      const rows = Array.isArray(message.entries) ? message.entries : [];
      if (rows.length === 0) {
        return {
          imported: 0,
          updated: 0,
          merged: 0,
          skipped: Number(message.skipped) || 0,
          total: Number(message.total) || 0,
          format: String(message.format || 'Import'),
          warnings: ['No importable login rows'],
          hasTimestamps: false,
          timeBasis: 'file',
          conflicts: [],
          conflictCount: 0,
        };
      }
      const preview = await previewImported(rows);
      return {
        ...preview,
        skipped: (Number(message.skipped) || 0) + (preview.skipped || 0),
        total: Number(message.total) || rows.length,
        format: String(message.format || 'Import'),
        warnings: Array.isArray(message.warnings) ? message.warnings : [],
        hasTimestamps: rows.some((row) => Number(row.passwordChangedAt) > 0),
        timeBasis: rows.some((row) => Number(row.passwordChangedAt) > 0) ? 'file' : 'fileModified',
      };
    }

    case 'SV_IMPORT_ROWS': {
      if (!isExtensionPage(sender)) throw new Error('Only extension pages may import');
      await requireUnlocked();
      const rows = Array.isArray(message.entries) ? message.entries : [];
      if (rows.length === 0) {
        return {
          imported: 0,
          updated: 0,
          merged: 0,
          skipped: Number(message.skipped) || 0,
          total: Number(message.total) || 0,
          format: String(message.format || 'Import'),
          warnings: ['No importable login rows'],
          hasTimestamps: false,
          timeBasis: 'file',
        };
      }
      return enqueue(async () => {
        const result = await mergeImported(rows, `import:${message.format || 'file'}`);
        return {
          ...result,
          total: Number(message.total) || rows.length,
          format: String(message.format || 'Import'),
          warnings: Array.isArray(message.warnings) ? message.warnings : [],
          hasTimestamps: rows.some((row) => Number(row.passwordChangedAt) > 0),
          timeBasis: rows.some((row) => Number(row.passwordChangedAt) > 0) ? 'file' : 'fileModified',
        };
      });
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
      const expiresAt = Number(message.backupExpiresAt) || 0;
      if (expiresAt && expiresAt <= Date.now()) throw new Error('备份有效期必须晚于当前时间');
      if (expiresAt) payload.expiresAt = expiresAt;
      const mode = backupPassword ? 'independent' : 'master';
      if (expiresAt && !backupPassword) {
        throw new Error('设置备份有效期时必须填写独立备份密码');
      }
      let kdf;
      let wrappedKey = null;
      if (session.wrappedKey) {
        if (backupPassword) {
          kdf = preferredKdfParams();
          if (expiresAt) kdf = await bindKdfToExpiry(kdf, expiresAt);
          const backupKek = await deriveKeyFromKdf(backupPassword, kdf);
          wrappedKey = await wrapVaultKey(backupKek, session.key);
        } else {
          kdf = session.kdf;
          wrappedKey = session.wrappedKey;
        }
        const aad = expiresAt ? `${AAD_BACKUP_V5}:${expiresAt}` : AAD_BACKUP_V4;
        const box = await encryptJSON(session.key, payload, aad);
        return {
          backup: JSON.stringify(
            {
              app: 'SubVault',
              format: 'subvault-backup',
              version: expiresAt ? BACKUP_VERSION_EXPIRY : BACKUP_VERSION,
              mode,
              exportedAt: Date.now(),
              ...(expiresAt ? { expiresAt } : {}),
              entryCount: session.data.entries.length,
              includesSettings: true,
              kdf,
              wrappedKey,
              box,
            },
            null,
            2,
          ),
          count: session.data.entries.length,
          independent: Boolean(backupPassword),
        };
      }

      // Legacy session fallback (v3 vault already loaded in memory).
      const key = backupPassword ? null : session.key;
      const legacyKdf = backupPassword ? preferredKdfParams() : session.kdf;
      const legacyKey = backupPassword
        ? await deriveKeyFromKdf(backupPassword, legacyKdf)
        : key;
      const box = await encryptJSON(legacyKey, payload, AAD_BACKUP_V3);

      return {
        backup: JSON.stringify(
          {
            app: 'SubVault',
            format: 'subvault-backup',
            version: 3,
            mode,
            exportedAt: Date.now(),
            entryCount: session.data.entries.length,
            includesSettings: true,
            kdf: legacyKdf,
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

      const isV5 =
        parsed?.format === 'subvault-backup' &&
        Number(parsed?.version) >= 5 &&
        parsed?.box &&
        parsed?.kdf &&
        parsed?.wrappedKey &&
        Number(parsed?.expiresAt) > 0;
      const isV4 =
        parsed?.format === 'subvault-backup' &&
        Number(parsed?.version) === 4 &&
        parsed?.box &&
        parsed?.kdf &&
        parsed?.wrappedKey;
      const isV3 =
        parsed?.format === 'subvault-backup' &&
        Number(parsed?.version) >= 3 &&
        parsed?.box &&
        parsed?.kdf;
      if (isV5 || isV4 || isV3) {
        const password = String(message.password || '');
        if (!password) throw new Error('请输入该备份文件的密码（独立备份密码或主密码）');
        let payload;
        if (isV5) {
          const expiresAt = Number(parsed.expiresAt);
          if (Date.now() > expiresAt) throw new Error('备份文件已过期，无法解密');
          const kek = await deriveKeyFromKdf(password, parsed.kdf);
          const vaultKey = await unwrapVaultKey(kek, parsed.wrappedKey);
          payload = await decryptJSON(vaultKey, parsed.box, `${AAD_BACKUP_V5}:${expiresAt}`);
          if (Number(payload?.expiresAt) !== expiresAt) {
            throw new Error('备份有效期校验失败，文件可能已被修改');
          }
        } else if (isV4) {
          const kek = await deriveKeyFromKdf(password, parsed.kdf);
          const vaultKey = await unwrapVaultKey(kek, parsed.wrappedKey);
          payload = await decryptJSON(vaultKey, parsed.box, AAD_BACKUP_V4);
        } else {
          const key = await deriveKeyFromKdf(password, parsed.kdf);
          payload = await decryptJSON(key, parsed.box, AAD_BACKUP_V3);
        }
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
      const backupKey = await deriveKeyFromKdf(password, kdf);
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

    case 'SV_SITE_KEY': {
      const parsed = parseHttpUrl(message.url);
      if (!parsed) return { ok: false, error: '无效网址' };
      const settings = await getSettings();
      return {
        ok: true,
        host: parsed.hostname,
        siteKey: siteKeyFor(parsed.hostname, settings.isolatedDomains, {
          portIsolation: settings.portIsolation === true,
          port: parsed.port,
        }),
      };
    }
    case 'SV_GET_CUSTOM_PSL':
      await customPslReady;
      return { ok: true, rules: customPslRuleCount() };
    case 'SV_SET_CUSTOM_PSL': {
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await customPslReady;
      const text = String(message.text || '');
      if (!text.trim()) throw new Error('PSL 文件为空');
      if (text.length > 2 * 1024 * 1024) throw new Error('PSL 文件过大（上限 2 MB）');
      const before = customPslRuleCount();
      const accepted = addCustomPslRules(text);
      if (accepted === 0) throw new Error('未能从文件中解析出有效规则');
      await writeLocal(STORAGE.customPsl, text);
      return { ok: true, accepted, total: customPslRuleCount() - before, rules: customPslRuleCount() };
    }
    case 'SV_CLEAR_CUSTOM_PSL':
      if (!isExtensionPage(sender)) throw new Error('仅扩展页面可执行该操作');
      await chrome.storage.local.remove(STORAGE.customPsl);
      clearCustomPslRules();
      return { ok: true, rules: customPslRuleCount() };
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
      if (patch.generatorOptions !== undefined) {
        next.generatorOptions = normalizeGeneratorOptions(patch.generatorOptions);
      }
      if (patch.kdfAlgorithm !== undefined) {
        if (!['argon2id', 'pbkdf2'].includes(patch.kdfAlgorithm)) {
          throw new Error('KDF 算法无效');
        }
        next.kdfAlgorithm = patch.kdfAlgorithm;
      }
      if (patch.syncTrigger !== undefined) {
        if (!SYNC_TRIGGERS.includes(patch.syncTrigger)) throw new Error('同步触发方式无效');
        next.syncTrigger = patch.syncTrigger;
      }
      if (patch.syncIntervalMinutes !== undefined) {
        next.syncIntervalMinutes = normalizeSyncInterval(patch.syncIntervalMinutes);
      }
      if (patch.syncScheduleTime !== undefined) {
        next.syncScheduleTime = normalizeSyncTime(patch.syncScheduleTime);
      }
      if (patch.uiLanguage !== undefined) {
        if (!['auto', 'zh-CN', 'en'].includes(patch.uiLanguage)) throw new Error('界面语言无效');
        next.uiLanguage = patch.uiLanguage;
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
        'allowSequenceSubmit',
        'privacyShieldOnBlur',
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
      if (next.syncTrigger !== undefined) {
        broadcastSync();
        if (next.syncTrigger === 'realtime' && syncDirty) scheduleSyncPush();
      }
      try {
        if (chrome.tabs?.query) {
          const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
          await Promise.allSettled(
            tabs.map((tab) =>
              tab.id
                ? chrome.tabs
                    .sendMessage(tab.id, { type: 'SV_SETTINGS_CHANGED', settings: saved })
                    .catch(() => {})
                : Promise.resolve(),
            ),
          );
        }
      } catch {
        /* tabs may be unavailable */
      }
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
  if (alarm.name === TRAVEL_ALARM) {
    void disableTravel('auto').catch(() => {});
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

if (chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(() => {
    void refreshBadge();
  });
}

if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') void refreshBadge();
  });
}

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
