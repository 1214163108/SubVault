import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const root = path.resolve('.');
const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subvault-kf-'));
const context = await chromium.launchPersistentContext('', {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const extensionId = worker.url().split('/')[2];
const page = await context.newPage();
await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
const send = (type, payload = {}) =>
  page.evaluate(([type, payload]) => chrome.runtime.sendMessage({ type, ...payload }), [type, payload]);

const noIdle = () => send('SV_SET_SETTINGS', { settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 } });

const password = 'SubVault-Test-2026!Qm7#';
const nextPassword = 'Zt7#Qm2vLp9@Rt4xWn6!';
const keyFile = Buffer.from('subvault-key-file-content-v1').toString('base64');
const wrongFile = Buffer.from('not-the-right-key-file').toString('base64');

const setup = await send('SV_SETUP', { password, keyFileBase64: keyFile });
await noIdle();
const statusAfterSetup = await send('SV_GET_STATUS');
await send('SV_LOCK');
const withoutFile = await send('SV_UNLOCK', { password });
const wrong = await send('SV_UNLOCK', { password, keyFileBase64: wrongFile });
const correct = await send('SV_UNLOCK', { password, keyFileBase64: keyFile });

const changed = await send('SV_CHANGE_MASTER', {
  currentPassword: password,
  newPassword: nextPassword,
  keyFileBase64: keyFile,
});
await send('SV_LOCK');
const oldPassword = await send('SV_UNLOCK', { password, keyFileBase64: keyFile });
const newPasswordWithFile = await send('SV_UNLOCK', { password: nextPassword, keyFileBase64: keyFile });
const disabled = await send('SV_SET_KEY_FILE', {
  password: nextPassword,
  currentKeyFileBase64: keyFile,
  newKeyFileBase64: '',
});
await send('SV_LOCK');
const noFileAfterDisable = await send('SV_UNLOCK', { password: nextPassword });
const statusAfterDisable = await send('SV_GET_STATUS');

const result = {
  setup: setup.ok,
  keyFileFlag: statusAfterSetup.keyFile === true,
  withoutFileRejected: !withoutFile.ok && /密钥文件/.test(withoutFile.error || ''),
  wrongFileRejected: !wrong.ok,
  correctAccepted: correct.ok,
  changed: changed.ok,
  oldPasswordRejected: !oldPassword.ok,
  newPasswordAccepted: newPasswordWithFile.ok,
  disabled: disabled.ok && disabled.keyFile === false,
  noFileAfterDisable: noFileAfterDisable.ok,
  statusAfterDisable: statusAfterDisable.keyFile === false,
};
result.pass = Object.values(result).every(Boolean);
console.log(JSON.stringify(result, null, 2));
await context.close();
if (!result.pass) process.exit(1);
