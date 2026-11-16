import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const PROFILE = path.join(ROOT, '.tmp-hello-gate', String(Date.now()));
const SYNC_DIR = path.join(ROOT, '.tmp-hello-gate', `sync-${Date.now()}`);
const MASTER = 'SubVault-Test-2026!Qm7#';
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(SYNC_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: SYNC_DIR },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await context.addInitScript(() => {
  window.__hello = { create: 0, get: 0 };
  class FakePublicKeyCredential {
    static async isUserVerifyingPlatformAuthenticatorAvailable() { return true; }
  }
  Object.defineProperty(window, 'PublicKeyCredential', { value: FakePublicKeyCredential, configurable: true });
  const raw = new Uint8Array([9, 8, 7, 6, 5]).buffer;
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      async create() { window.__hello.create += 1; return { type: 'public-key', rawId: raw }; },
      async get() { window.__hello.get += 1; return { type: 'public-key', rawId: raw }; },
    },
  });
});

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = worker.url().split('/')[2];
const options = await context.newPage();
const errors = [];
options.on('pageerror', (error) => errors.push(String(error)));
await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await options.waitForSelector('#gate');
const send = (message) => options.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const result = {};

await send({ type: 'SV_SETUP', password: MASTER });
await send({
  type: 'SV_SET_SETTINGS',
  settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
});
await send({ type: 'SV_ADD_ENTRY', entry: { host: 'example.com', username: 'alice', password: 'alice-secret' } });
await options.reload();
await options.waitForSelector('#gate', { state: 'hidden' });
await options.click('[data-section="security"]');
await options.waitForTimeout(500);
await options.click('#deviceEnableBtn');
await options.waitForTimeout(800);
result.afterEnable = await send({ type: 'SV_DEVICE_STATUS' });
result.credentialStored = Boolean(result.afterEnable?.credentialId);
result.createCalls = await options.evaluate(() => window.__hello?.create || 0);
result.bindTag = await options.locator('#deviceBindTag').textContent().catch(() => '');

const popup = await context.newPage();
popup.on('pageerror', (error) => errors.push(String(error)));
await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
await send({ type: 'SV_LOCK' });
await popup.reload();
await popup.waitForSelector('#deviceUnlockRow', { state: 'visible', timeout: 10000 });
result.rowVisible = await popup.locator('#deviceUnlockRow').isVisible();
await popup.click('#deviceUnlockBtn');
await popup.waitForSelector('#vaultView', { state: 'visible', timeout: 15000 });
result.getCalls = await popup.evaluate(() => window.__hello?.get || 0);
const status = await send({ type: 'SV_GET_STATUS' });
result.unlocked = status.locked === false && status.initialized === true;
result.pass = Boolean(
  result.credentialStored
  && result.createCalls >= 1
  && result.bindTag.includes('已启用')
  && result.rowVisible
  && result.getCalls >= 1
  && result.unlocked
  && errors.length === 0,
);
result.errors = errors;
console.log(JSON.stringify(result, null, 2));
await context.close();
fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.rmSync(SYNC_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!result.pass) process.exit(1);
