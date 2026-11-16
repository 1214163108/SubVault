import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'toast-privacy-data');
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

const errors = [];
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = worker.url().split('/')[2];
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${id}/src/options/options.html`);
  await page.waitForTimeout(600);
  const setup = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' }),
  );
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: {
        theme: 'light',
        material: 'glass',
        lockOnSystemLock: false,
        lockOnSystemIdle: false,
        autoLockMinutes: 0,
      },
    }),
  );
  const added = await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_ADD_ENTRY',
      entry: {
        host: 'example.com',
        title: 'Toast test',
        username: 'toast-user',
        password: 'toast-secret',
      },
    }),
  );
  if (!added?.ok) throw new Error(`add: ${added?.error}`);

  const popup = await context.newPage();
  popup.on('pageerror', (e) => errors.push(String(e)));
  await popup.addInitScript(() => {
    chrome.tabs.query = () =>
      Promise.resolve([{ id: 999, windowId: 1, active: true, url: 'http://example.com/' }]);
  });
  await popup.setViewportSize({ width: 382, height: 600 });
  await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
  await popup.waitForSelector('[title="复制密码"]');
  await popup.locator('[title="复制密码"]').first().click();
  await popup.waitForSelector('#toast:not([hidden])');
  await popup.waitForTimeout(250);
  const toast = await popup.evaluate(() => {
    const node = document.getElementById('toast');
    const title = node?.querySelector('.toast-title');
    const style = node ? getComputedStyle(node) : null;
    const titleStyle = title ? getComputedStyle(title) : null;
    return {
      text: title?.textContent || '',
      hidden: node?.hidden,
      background: style?.backgroundColor || '',
      color: titleStyle?.color || '',
      rect: node?.getBoundingClientRect().toJSON(),
    };
  });
  await popup.close();

  const setShield = (enabled) =>
    page.evaluate((value) =>
      chrome.runtime.sendMessage({
        type: 'SV_SET_SETTINGS',
        settings: { privacyShieldOnBlur: value },
      }), enabled);

  await setShield(false);
  await page.waitForTimeout(350);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(150);
  const shieldOff = await page.evaluate(() => document.getElementById('privacyShield').hidden);

  await setShield(true);
  await page.waitForTimeout(350);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(150);
  const shieldOn = await page.evaluate(() => {
    const node = document.getElementById('privacyShield');
    return { hidden: node.hidden, text: node.textContent.trim() };
  });
  await page.locator('#privacyShield').click({ position: { x: 5, y: 5 } });
  const shieldDismissed = await page.evaluate(() => document.getElementById('privacyShield').hidden);

  const rgb = (toast.color.match(/\d+/g) || []).map(Number);
  const lightText = rgb.length >= 3 && rgb[0] > 220 && rgb[1] > 220 && rgb[2] > 220;
  const result = {
    toast: { ...toast, lightText },
    shieldOff,
    shieldOn,
    shieldDismissed,
    errors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!toast.text || toast.hidden) throw new Error('toast text missing');
  if (lightText) throw new Error(`toast text is too light: ${toast.color}`);
  if (shieldOff !== true) throw new Error('privacy shield still shows when disabled');
  if (shieldOn.hidden || !shieldOn.text.includes('内容已隐藏')) throw new Error('privacy shield did not show');
  if (shieldDismissed !== true) throw new Error('privacy shield did not dismiss');
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('PASS=true');
} finally {
  await context.close();
}
