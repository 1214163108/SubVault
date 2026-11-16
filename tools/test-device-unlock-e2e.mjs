import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const PROFILE = path.join(ROOT, '.tmp-device-unlock', String(Date.now()));
const SYNC_DIR = path.join(ROOT, '.tmp-device-unlock', `sync-${Date.now()}`);
const MASTER = 'SubVault-Test-2026!Qm7#';
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(SYNC_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: SYNC_DIR },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = worker.url().split('/')[2];
const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await options.waitForSelector('#gate');

const errors = [];
options.on('pageerror', (error) => errors.push(String(error)));
const send = (message) => options.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const result = {};

await send({ type: 'SV_SETUP', password: MASTER });
await send({
  type: 'SV_SET_SETTINGS',
  settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
});
await options.reload();
await options.waitForSelector('#gate', { state: 'hidden' });
await send({ type: 'SV_ADD_ENTRY', entry: { host: 'example.com', username: 'alice', password: 'alice-secret' } });

const before = await send({ type: 'SV_DEVICE_STATUS' });
result.initialDeviceStatus = before;
result.initiallyDisabled = before.ok === true && before.supported === true && before.exists === false;

const enabled = await send({ type: 'SV_DEVICE_ENABLE' });
result.enable = enabled;
result.enabled = enabled.ok === true && enabled.exists === true;
await options.click('[data-section="security"]');
await options.waitForTimeout(800);
result.optionsBindTag = await options.locator('#deviceBindTag').textContent().catch(() => '');
result.optionsDisableVisible = await options.locator('#deviceDisableBtn').isVisible();

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
await popup.waitForSelector('#lockedView', { state: 'hidden' }).catch(() => {});
await send({ type: 'SV_LOCK' });
await popup.reload();
await popup.waitForSelector('#lockedView', { state: 'visible' });
await popup.waitForSelector('#deviceUnlockRow', { state: 'visible' });
result.deviceRowVisibleWhileLocked = await popup.locator('#deviceUnlockRow').isVisible();
const lockedState = await send({ type: 'SV_GET_STATUS' });
result.lockedBefore = lockedState.locked === true;

await popup.click('#deviceUnlockBtn');
await popup.waitForSelector('#vaultView', { state: 'visible' });
const afterDevice = await send({ type: 'SV_GET_STATUS' });
const deviceEntries = await send({ type: 'SV_LIST_ENTRIES' });
result.deviceUnlocked = afterDevice.locked === false && afterDevice.initialized === true;
result.entryPresent = (deviceEntries.entries || []).some((entry) => entry.username === 'alice');

const disabled = await send({ type: 'SV_DEVICE_DISABLE' });
result.disable = disabled;
result.disabled = disabled.ok === true && disabled.exists === false;
await options.reload();
await options.waitForSelector('#gate', { state: 'hidden' });
await options.click('[data-section="security"]');
await options.waitForTimeout(800);
result.optionsUnbindTag = await options.locator('#deviceBindTag').textContent().catch(() => '');
await send({ type: 'SV_LOCK' });
await popup.reload();
await popup.waitForSelector('#lockedView', { state: 'visible' });
await popup.waitForTimeout(500);
result.deviceRowHiddenAfterDisable = await popup.locator('#deviceUnlockRow').isHidden();
const rejected = await send({ type: 'SV_DEVICE_UNLOCK' });
result.rejectedAfterDisable = rejected.ok === false;

await popup.fill('#unlockPassword', MASTER);
await popup.click('#unlockBtn');
await popup.waitForSelector('#vaultView', { state: 'visible' });
const afterPassword = await send({ type: 'SV_GET_STATUS' });
result.passwordFallback = afterPassword.locked === false;
result.errors = errors;
result.pass = [
  result.initiallyDisabled,
  result.enabled,
  result.deviceRowVisibleWhileLocked,
  result.lockedBefore,
  result.deviceUnlocked,
  result.entryPresent,
  result.disabled,
  result.optionsBindTag.includes('已启用'),
  result.optionsDisableVisible,
  result.optionsUnbindTag.includes('未启用'),
  result.deviceRowHiddenAfterDisable,
  result.rejectedAfterDisable,
  result.passwordFallback,
  errors.length === 0,
].every(Boolean);

console.log(JSON.stringify(result, null, 2));
await context.close();
fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.rmSync(SYNC_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!result.pass) process.exit(1);
