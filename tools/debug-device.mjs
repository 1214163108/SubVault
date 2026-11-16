import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const PROFILE = path.join(ROOT, '.tmp-device-debug', String(Date.now()));
const SYNC_DIR = path.join(ROOT, '.tmp-device-debug', `sync-${Date.now()}`);
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
const page = await context.newPage();
page.on('console', (msg) => console.log('CONSOLE', msg.type(), msg.text()));
page.on('pageerror', (error) => console.log('PAGEERROR', String(error)));
await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await page.waitForTimeout(3000);
console.log('gate hidden', await page.locator('#gate').getAttribute('hidden'));
console.log('body class', await page.locator('body').getAttribute('class'));
console.log('status', await page.evaluate(async () => {
  const result = await Promise.race([
    chrome.runtime.sendMessage({ type: 'SV_GET_STATUS' }),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
  ]);
  return result;
}));
await context.close();
