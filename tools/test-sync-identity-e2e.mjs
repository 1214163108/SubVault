// Reproduces the real incident: a browser that already synced one vault meets a
// different vault on the host (the host data folder moved, another machine
// published there). It must say so instead of blaming the master password.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'sync-identity-data');
const realDirs = [
  path.join(root, 'native-host', 'data'),
  path.join(root, 'dist', 'subvault-sync-host-1.0.0', 'data'),
  path.join(root, 'dist', 'native-host', 'data'),
];
for (const base of [process.env.LOCALAPPDATA, process.env.XDG_CONFIG_HOME, process.env.HOME]) {
  if (base) realDirs.push(path.join(base, 'SubVaultSync'));
}
if (process.env.SUBVAULT_SYNC_DIR) {
  throw new Error('test-sync-identity must not be pointed at SUBVAULT_SYNC_DIR');
}
for (const dir of realDirs) {
  if (path.resolve(syncDir) === path.resolve(dir)) {
    throw new Error(`refusing to run against real host data dir: ${dir}`);
  }
}
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const PASSWORD_A = 'Vault-A-2026!Qm7#x';
const PASSWORD_B = 'Vault-B-2026!Zp4#y';
const statePath = path.join(syncDir, 'state.json');

async function openExtension(profile) {
  fs.rmSync(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-32000,-32000',
      '--window-size=900,900',
    ],
    env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/options/options.html`);
  await page.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  return { context, page, id };
}

const send = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);

const checks = {};
let a = null;
let b = null;
try {
  // 1. A creates its vault on an empty host, so the host now holds vault A.
  a = await openExtension(path.join(root, '.tmp-host', 'identity-profile-a'));
  const setupA = await send(a.page, { type: 'SV_SETUP', password: PASSWORD_A });
  if (!setupA?.ok) throw new Error(`A setup: ${setupA?.error}`);
  await send(a.page, {
    type: 'SV_ADD_ENTRY',
    entry: { host: 'example.com', title: 'A account', username: 'alice', password: 'alpha-secret' },
  });
  await a.page.waitForTimeout(2500);
  const vaultA = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  checks.vaultACreatedAt = Number(vaultA?.vault?.createdAt) || 0;
  checks.vaultABox = String(vaultA?.vault?.box?.data || '');
  await a.context.close();
  a = null;

  // 2. B is a second machine with its own vault; it starts from an empty host,
  //    publishes, and is therefore a normal joined device.
  fs.rmSync(statePath, { force: true });
  b = await openExtension(path.join(root, '.tmp-host', 'identity-profile-b'));
  const setupB = await send(b.page, { type: 'SV_SETUP', password: PASSWORD_B });
  if (!setupB?.ok) throw new Error(`B setup: ${setupB?.error}`);
  await send(b.page, {
    type: 'SV_ADD_ENTRY',
    entry: { host: 'example.org', title: 'B account', username: 'bob', password: 'beta-secret' },
  });
  await b.page.waitForTimeout(2500);
  const joinedB = await send(b.page, { type: 'SV_SYNC_STATUS' });
  checks.bJoined = Boolean(joinedB?.exists);
  const vaultB = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  checks.vaultBCreatedAt = Number(vaultB?.vault?.createdAt) || 0;
  checks.differentVaults = checks.vaultACreatedAt !== checks.vaultBCreatedAt;

  // 3. Vault A appears on the host again, newer than B's local copy.
  const now = Date.now() + 60_000;
  vaultA.updatedAt = now;
  vaultA.vault.updatedAt = now;
  fs.writeFileSync(statePath, JSON.stringify(vaultA), 'utf8');

  // 4. B syncs and meets the other vault.
  let syncResult = null;
  try {
    syncResult = await send(b.page, { type: 'SV_SYNC_NOW' });
  } catch (error) {
    syncResult = { thrown: String(error?.message || error) };
  }
  checks.syncResult = syncResult;
  const statusAfter = await send(b.page, { type: 'SV_SYNC_STATUS' });
  const lastError = String(statusAfter?.lastError || syncResult?.lastError || syncResult?.error || '');
  checks.lastErrorCode = statusAfter?.lastErrorCode || syncResult?.lastErrorCode || '';
  checks.identityMismatchFlag = statusAfter?.identityMismatch === true;
  checks.syncState = statusAfter?.state || '';
  const optionsState = await b.page.evaluate(async () => {
    const tag = document.getElementById('syncStateTag');
    const box = document.getElementById('syncStateBox');
    return { tag: tag?.textContent || '', box: box?.textContent || '' };
  });
  checks.optionsTag = optionsState.tag;
  checks.optionsBoxMentionsPaused = /同步已暂停/.test(optionsState.box);
  checks.retryScheduled = Number(statusAfter?.retryAt) > Date.now();
  checks.errorMentionsDifferentVault = /不是同一个/.test(lastError);
  checks.errorNotPasswordBlame = !/主密码错误/.test(lastError);

  // A second forced sync must still refuse and must not touch the host.
  const secondSync = await send(b.page, { type: 'SV_SYNC_NOW' }).catch((error) => ({ error: String(error?.message || error) }));
  checks.secondSyncStillRefused = Boolean(secondSync?.error) || secondSync?.ok === false;

  const hostAfter = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  checks.hostStillVaultA = String(hostAfter?.vault?.box?.data || '') === checks.vaultABox;

  const entriesB = await send(b.page, { type: 'SV_LIST_ENTRIES' });
  checks.bKeptOwnEntries = entriesB?.entries?.some((entry) => entry.username === 'bob') === true;
} finally {
  if (a) await a.context.close().catch(() => {});
  if (b) await b.context.close().catch(() => {});
}

const pass = checks.vaultACreatedAt > 0
  && checks.vaultBCreatedAt > 0
  && checks.differentVaults
  && checks.bJoined
  && checks.lastErrorCode === 'vault_identity'
  && checks.identityMismatchFlag
  && checks.syncState === 'identity_mismatch'
  && checks.optionsTag === '密码库不一致'
  && checks.optionsBoxMentionsPaused
  && checks.retryScheduled
  && checks.secondSyncStillRefused
  && checks.errorMentionsDifferentVault
  && checks.errorNotPasswordBlame
  && checks.hostStillVaultA
  && checks.bKeptOwnEntries;

console.log(JSON.stringify({ pass, checks }, null, 2));
if (!pass) process.exitCode = 1;
