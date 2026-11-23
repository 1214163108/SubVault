import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'screenshot-v241-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const out = path.join(root, 'docs');
const profile = fs.mkdtempSync(path.join(root, '.tmp-shot-'));
fs.mkdirSync(out, { recursive: true });

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
    '--window-size=980,1000',
  ],
  viewport: { width: 980, height: 900 },
  locale: 'zh-CN',
});

const send = (page, type, payload = {}) =>
  page.evaluate(([kind, extra]) => chrome.runtime.sendMessage({ type: kind, ...extra }), [type, payload]);

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/options/options.html`);
  await page.waitForTimeout(800);
  await send(page, 'SV_SETUP', { password: 'Shot-Pass-2026!x9Kq7vT' });
  await send(page, 'SV_SET_SETTINGS', {
    settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
  });
  const entries = [
    { host: 'github.com', username: 'octocat', password: 'gh-Secret-1!', tags: ['work'], totpSecret: 'JBSWY3DPEHPK3PXP' },
    { host: 'mail.example.com', username: 'alice@example.com', password: 'mail-Secret-2!', tags: ['work'] },
    { host: 'forum.example.org', username: 'bob', password: 'weakpass', tags: ['personal'] },
  ];
  for (const entry of entries) await send(page, 'SV_ADD_ENTRY', { entry });
  await page.reload();
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const shield = document.getElementById('privacyShield'); if (shield) shield.hidden = true; });

  await page.click('[data-section="security"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const card = document.getElementById('generatorCard');
    card?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, 'ui-2.4.1-generator.png') });
  console.log('wrote docs/ui-2.4.1-generator.png');

  await page.click('[data-section="vault"]');
  await page.waitForTimeout(600);
  page.on('dialog', (dialog) => dialog.accept());
  const card = page.locator('.entry-card').first();
  await await card.locator('.entry-actions button', { hasText: '删除' }).first().click();
  await page.waitForSelector('#undoToast:not([hidden])', { timeout: 8000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'ui-2.4.1-toast.png') });
  console.log('wrote docs/ui-2.4.1-toast.png');

  const site = await context.newPage();
  await site.goto(`chrome-extension://${id}/src/options/options.html`);
  await site.waitForTimeout(300);
  await page.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${id}/src/popup/popup.html`);
  let popup = null;
  for (let i = 0; i < 60 && !popup; i += 1) {
    popup = context.pages().find((item) => item.url().includes('/src/popup/popup.html')) || null;
    if (!popup) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!popup) throw new Error('popup did not open');
  await popup.setViewportSize({ width: 382, height: 640 });
  await popup.waitForTimeout(2200);
  await popup.screenshot({ path: path.join(out, 'ui-2.4.1-popup.png') });
  console.log('wrote docs/ui-2.4.1-popup.png');

  await popup.evaluate(() => {
    const block = document.getElementById('quickGen');
    block?.scrollIntoView({ block: 'start' });
    document.getElementById('quickGenLength')?.focus();
  });
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: path.join(out, 'ui-2.4.1-popup-generator.png') });
  console.log('wrote docs/ui-2.4.1-popup-generator.png');
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
