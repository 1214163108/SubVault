import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'copy-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  headless: false,
  permissions: ['clipboard-read', 'clipboard-write'],
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  const setup = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'copy-password' }),
  );
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  const added = await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: 'example.com',
        title: 'Copy test',
        username: 'copy-user',
        password: 'copy-secret-value',
      },
    }),
  );
  if (!added?.ok) throw new Error(`add: ${added?.error}`);

  const popup = await context.newPage();
  const popupErrors = [];
  popup.on('pageerror', (error) => popupErrors.push(error.message));
  await popup.addInitScript(() => {
    chrome.tabs.query = () =>
      Promise.resolve([
        { id: 999, windowId: 1, active: true, url: 'http://example.com/' },
      ]);
  });
  await popup.setViewportSize({ width: 382, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForSelector('[title="复制密码"]');
  await popup.locator('[title="复制密码"]').first().click();
  await popup.waitForTimeout(500);
  await popup.bringToFront();
  const popupClipboard = await popup.evaluate(() => navigator.clipboard.readText());
  if (popupClipboard !== 'copy-secret-value') {
    throw new Error(`popup clipboard mismatch: ${popupClipboard}`);
  }
  if (popupErrors.length) throw new Error(`popup errors: ${popupErrors.join('; ')}`);
  const popupToast = await popup.locator('#toast').textContent();
  await popup.close();

  await page.reload();
  await page.waitForSelector('.entry-actions');
  await page.locator('.entry-actions button', { hasText: '复制' }).first().click();
  await page.waitForTimeout(400);
  await page.bringToFront();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  if (clipboard !== 'copy-secret-value') {
    throw new Error(`clipboard mismatch: ${clipboard}`);
  }

  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LOCK' }));
  const lockedPopup = await context.newPage();
  await lockedPopup.setViewportSize({ width: 382, height: 600 });
  await lockedPopup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await lockedPopup.waitForTimeout(800);
  const lockedHeight = await lockedPopup.evaluate(
    () => document.querySelector('.app')?.offsetHeight || 0,
  );
  if (lockedHeight > 560) {
    throw new Error(`locked popup is too tall: ${lockedHeight}`);
  }

  console.log(
    JSON.stringify(
      { ok: true, popupClipboard, popupToast, clipboard, lockedHeight },
      null,
      2,
    ),
  );
} finally {
  await context.close();
}
