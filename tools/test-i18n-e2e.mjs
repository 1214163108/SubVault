import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'i18n-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const loginHtml = `<!doctype html><html><body>
  <form id="login" onsubmit="event.preventDefault()">
    <label>Username <input name="username" autocomplete="username" /></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" /></label>
    <button type="submit">Log in</button>
  </form>
</body></html>`;

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(loginHtml);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  locale: 'en-US',
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--lang=en-US',
    '--accept-lang=en-US',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
    '--window-size=1000,900',
  ],
});

const result = {};
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  result.extensionLanguage = await options.evaluate(() => chrome.i18n.getUILanguage());
  result.manifestName = await options.evaluate(() => chrome.runtime.getManifest().name);

  const setup = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }),
  );
  result.setup = setup;
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
    }),
  );

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: path.join(root, 'docs', 'i18n-popup-en.png') });
  const popupText = await popup.locator('body').innerText();
  result.popup = {
    hasAddAccount: popupText.includes('Add account'),
    hasManageVault: popupText.includes('Manage vault'),
    leftoverSample: (popupText.match(/[\u4e00-\u9fff]{2,}/g) || []).slice(0, 8),
  };

  await options.reload();
  await options.waitForTimeout(900);
  const optionsText = await options.locator('body').innerText();
  await options.click('[data-section="security"]');
  await options.waitForTimeout(500);
  const securityText = await options.locator('body').innerText();
  result.options = {
    gateHidden: await options.locator('#gate').isHidden().catch(() => null),
    textHead: optionsText.replace(/\s+/g, ' ').slice(0, 260),
    hasImportExport: optionsText.includes('Import & export'),
    hasAutoLock: securityText.includes('Auto-lock'),
    hasSecurity: optionsText.includes('Security'),
    leftoverSample: (optionsText.match(/[\u4e00-\u9fff]{2,}/g) || []).slice(0, 8),
    securityLeftoverSample: (securityText.match(/[\u4e00-\u9fff]{2,}/g) || []).slice(0, 8),
  };

  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: { host: '127.0.0.1', username: 'alice', password: 'alice-secret' },
    }),
  );

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/login`);
  await page.waitForTimeout(900);
  await page.locator('input[name="username"]').click();
  await page.waitForTimeout(500);
  result.content = {
    triggerLabel: await page
      .locator('[data-subvault-trigger]')
      .getAttribute('aria-label')
      .catch(() => null),
    triggerVisible: await page.locator('[data-subvault-trigger]').isVisible().catch(() => false),
  };
  if (result.content.triggerVisible) {
    await page.locator('[data-subvault-trigger]').click();
    await page.waitForTimeout(400);
    const panelText = await page
      .locator('[data-subvault-popover]')
      .evaluate((element) => element.textContent || '');
    result.content.panel = {
      hasFillLogin: panelText.includes('Fill login'),
      hasManage: panelText.includes('Manage vault'),
      leftoverSample: (panelText.match(/[\u4e00-\u9fff]{2,}/g) || []).slice(0, 8),
    };
    await page.screenshot({ path: path.join(root, 'docs', 'i18n-content-en.png') });
  }

  result.pass =
    result.extensionLanguage.toLowerCase().startsWith('en') &&
    result.manifestName === 'SubVault Subdomain Password Vault' &&
    result.popup.hasAddAccount &&
    result.popup.leftoverSample.length === 0 &&
    result.options.hasImportExport &&
    result.options.hasSecurity &&
    result.options.hasAutoLock &&
    result.options.leftoverSample.length === 0 &&
    result.options.securityLeftoverSample.length === 0 &&
    result.content.triggerLabel === 'Fill with SubVault' &&
    result.content.panel?.hasFillLogin &&
    result.content.panel?.leftoverSample.length === 0;
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
  server.close();
}
