import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const root = path.resolve('.');
const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subvault-kfui-'));
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
await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
const password = 'SubVault-Test-2026!Qm7#';
const keyBuffer = Buffer.from('popup-key-file-content');
const wrongBuffer = Buffer.from('wrong-popup-key-file');

await page.fill('#setupPassword', password);
await page.fill('#setupConfirm', password);
await page.check('#setupAck');
await page.check('#setupKeyFileToggle');
await page.setInputFiles('#setupKeyFile', { name: 'key.bin', mimeType: 'application/octet-stream', buffer: keyBuffer });
await page.click('#setupBtn');
await page.waitForSelector('#vaultView:not([hidden])', { timeout: 15000 });

await page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LOCK' }));
await page.reload();
await page.waitForSelector('#lockedView:not([hidden])', { timeout: 10000 });
const rowVisible = await page.isVisible('#unlockKeyFileRow');
await page.fill('#unlockPassword', password);
await page.click('#unlockBtn');
await page.waitForTimeout(500);
const withoutFileError = await page.textContent('#unlockError');
await page.setInputFiles('#unlockKeyFile', { name: 'wrong.bin', mimeType: 'application/octet-stream', buffer: wrongBuffer });
await page.click('#unlockBtn');
await page.waitForTimeout(800);
const wrongError = await page.textContent('#unlockError');
await page.setInputFiles('#unlockKeyFile', { name: 'key.bin', mimeType: 'application/octet-stream', buffer: keyBuffer });
await page.click('#unlockBtn');
await page.waitForSelector('#vaultView:not([hidden])', { timeout: 15000 }).catch(() => {});

await page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LOCK' }));
const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await options.waitForSelector('#gate:not([hidden])', { timeout: 10000 });
const optionsRowVisible = await options.isVisible('#gateUnlockKeyFileRow');
await options.fill('#gatePassword', password);
await options.setInputFiles('#gateUnlockKeyFile', { name: 'key.bin', mimeType: 'application/octet-stream', buffer: keyBuffer });
await options.click('#gateUnlockBtn');
await options.waitForSelector('#shell:not([hidden])', { timeout: 15000 }).catch(() => {});
const optionsUnlocked = await options.isVisible('#shell');

const result = {
  rowVisible,
  optionsRowVisible,
  optionsUnlocked,
  withoutFileError: withoutFileError || '',
  wrongError: wrongError || '',
  unlocked: await page.isVisible('#vaultView'),
};
result.pass =
  rowVisible &&
  /密钥文件/.test(result.withoutFileError) &&
  /主密码错误|损坏/.test(result.wrongError) &&
  result.unlocked &&
  optionsRowVisible &&
  optionsUnlocked;
console.log(JSON.stringify(result, null, 2));
await context.close();
if (!result.pass) process.exit(1);
