import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve('.');
const PROFILE = path.join(ROOT, '.tmp-totp-passkey', String(Date.now()));
const SYNC_DIR = path.join(ROOT, '.tmp-totp-passkey', `sync-${Date.now()}`);
const MASTER = 'SubVault-Test-2026!Qm7#';
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(SYNC_DIR, { recursive: true });

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body><input id="username" autocomplete="username"><input id="password" type="password"></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: SYNC_DIR },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
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
const checks = {};

await send({ type: 'SV_SETUP', password: MASTER });
await send({
  type: 'SV_SET_SETTINGS',
  settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
});
await send({
  type: 'SV_ADD_ENTRY',
  entry: {
    host: '127.0.0.1',
    port: String(port),
    username: 'otp-user',
    password: 'otp-secret',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    passkey: {
      credentialId: 'credential-otp-1',
      rpId: '127.0.0.1',
      username: 'otp-user',
      note: 'Windows Hello',
    },
  },
});
await options.reload();
await options.waitForSelector('#gate', { state: 'hidden' });
await options.waitForSelector('.entry-card', { state: 'visible' });
await options.click('[data-section="vault"]');
await options.waitForSelector('.entry-card');

await options.locator('.entry-actions button', { hasText: '编辑' }).first().click();
await options.waitForSelector('#entryDialog[open]');
checks.passkeyDialog = {
  credentialId: await options.inputValue('#entryPasskeyCredential'),
  rpId: await options.inputValue('#entryPasskeyRp'),
  username: await options.inputValue('#entryPasskeyUsername'),
  note: await options.inputValue('#entryPasskeyNote'),
};
await options.click('#entryDialog button[value="cancel"], #entryCancel').catch(async () => {
  await options.keyboard.press('Escape');
});

const totpButton = options.locator('.entry-card .entry-totp').first();
await totpButton.click();
await options.waitForSelector('#totpDialog[open]');
checks.optionsTotp = {
  code: await options.textContent('#totpCode'),
  width: await options.evaluate(() => document.querySelector('#totpProgressBar')?.style.width || ''),
};
await options.keyboard.press('Escape');

await options.click('[data-section="transfer"]');
await options.waitForSelector('#kdbxExportGenerate');
await options.click('#kdbxExportGenerate');
checks.kdbxGenerated = {
  length: (await options.inputValue('#kdbxExportPassword')).length,
  type: await options.getAttribute('#kdbxExportPassword', 'type'),
};
await options.click('#exportBackupGenerate');
checks.backupGenerated = {
  length: (await options.inputValue('#exportBackupPassword')).length,
  type: await options.getAttribute('#exportBackupPassword', 'type'),
  expiryOptions: await options.locator('#exportBackupExpiry option').count(),
};

const site = await context.newPage();
await site.goto(`http://127.0.0.1:${port}/`);
await site.bringToFront();
await options.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${extensionId}/src/popup/popup.html`);
let popup = null;
for (let i = 0; i < 50 && !popup; i += 1) {
  popup = context.pages().find((page) => page.url().includes('/src/popup/popup.html')) || null;
  if (!popup) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!popup) throw new Error('popup tab did not open');
popup.on('pageerror', (error) => errors.push(String(error)));
await popup.waitForSelector('#vaultView', { state: 'visible' });
await popup.waitForSelector('.entry-otp strong', { timeout: 15000 });
let popupCode = '';
for (let i = 0; i < 60 && !/^\d{6}$/.test(popupCode); i += 1) {
  popupCode = (await popup.textContent('.entry-otp strong')) || '';
  if (!/^\d{6}$/.test(popupCode)) await new Promise((resolve) => setTimeout(resolve, 250));
}
checks.popupTotp = {
  code: popupCode,
  meta: await popup.textContent('.entry-otp span'),
};
await popup.click('.entry-otp-copy');

checks.pass = Boolean(
  checks.passkeyDialog.credentialId === 'credential-otp-1'
  && checks.passkeyDialog.rpId === '127.0.0.1'
  && checks.passkeyDialog.note === 'Windows Hello'
  && /^\d{6}$/.test(checks.optionsTotp.code.trim())
  && checks.optionsTotp.width !== ''
  && checks.kdbxGenerated.length === 20
  && checks.kdbxGenerated.type === 'text'
  && checks.backupGenerated.length === 20
  && checks.backupGenerated.type === 'text'
  && checks.backupGenerated.expiryOptions >= 2
  && /^\d{6}$/.test(checks.popupTotp.code.trim())
  && checks.popupTotp.meta.trim() !== ''
  && errors.length === 0,
);
checks.errors = errors;
console.log(JSON.stringify(checks, null, 2));
await context.close();
server.close();
fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.rmSync(SYNC_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!checks.pass) process.exit(1);
