import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const root = path.resolve('.');
const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subvault-psl-'));
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

const setup = await send('SV_SETUP', { password: 'SubVault-Test-2026!Qm7#' });
if (!setup.ok) throw new Error('setup failed: ' + setup.error);
await send('SV_SET_SETTINGS', { settings: { lockOnSystemLock: false, lockOnSystemIdle: false } });

const beforeA = await send('SV_SITE_KEY', { url: 'https://a.foo.internal/login' });
const beforeB = await send('SV_SITE_KEY', { url: 'https://b.foo.internal/login' });
const importResult = await send('SV_SET_CUSTOM_PSL', {
  text: '// custom\nfoo.internal\n*.bar.internal\n!keep.bar.internal\n',
});
const afterA = await send('SV_SITE_KEY', { url: 'https://a.foo.internal/login' });
const afterB = await send('SV_SITE_KEY', { url: 'https://b.foo.internal/login' });
const wildA = await send('SV_SITE_KEY', { url: 'https://x.bar.internal/login' });
const wildB = await send('SV_SITE_KEY', { url: 'https://keep.bar.internal/login' });
const status = await send('SV_GET_CUSTOM_PSL');
await page.evaluate(() => chrome.runtime.reload()).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 2500));
const page2 = await context.newPage();
await page2.goto(`chrome-extension://${extensionId}/src/options/options.html`);
const send2 = (type, payload = {}) => page2.evaluate(([type, payload]) => chrome.runtime.sendMessage({ type, ...payload }), [type, payload]);
const reloadedStatus = await send2('SV_GET_CUSTOM_PSL');
const clear = await send2('SV_CLEAR_CUSTOM_PSL');
const clearedA = await send2('SV_SITE_KEY', { url: 'https://a.foo.internal/login' });

const result = {
  beforeA: beforeA.siteKey,
  beforeB: beforeB.siteKey,
  sharedBefore: beforeA.siteKey === beforeB.siteKey,
  accepted: importResult.accepted,
  afterA: afterA.siteKey,
  afterB: afterB.siteKey,
  isolatedAfter: afterA.siteKey !== afterB.siteKey,
  wildcard: wildA.siteKey,
  exception: wildB.siteKey,
  statusRules: status.rules,
  persistedRules: reloadedStatus.rules,
  clearedRules: clear.rules,
  clearedShared: clearedA.siteKey === beforeA.siteKey,
};
result.pass =
  result.sharedBefore &&
  result.accepted === 3 &&
  result.isolatedAfter &&
  result.wildcard === 'x.bar.internal' &&
  result.exception === 'keep.bar.internal' &&
  result.statusRules === 3 &&
  result.persistedRules === 3 &&
  result.clearedRules === 0 &&
  result.clearedShared;
console.log(JSON.stringify(result, null, 2));
await context.close();
if (!result.pass) process.exit(1);
