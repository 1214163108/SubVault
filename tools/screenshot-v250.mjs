import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'screenshot-v250-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const profile = path.join(root, '.tmp-shot250');
const out = path.join(root, 'docs');
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--window-size=1180,900',
  ],
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const id = worker.url().split('/')[2];

const options = await context.newPage();
await options.setViewportSize({ width: 1180, height: 900 });
await options.goto(`chrome-extension://${id}/src/options/options.html`);
await options.evaluate(async () => {
  await chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'Shot-Pass-2026!x9Kq7vT' });
  await chrome.runtime.sendMessage({
    type: 'SV_SET_SETTINGS',
    settings: {
      lockOnSystemLock: false,
      lockOnSystemIdle: false,
      autoLockMinutes: 0,
      privacyShieldOnBlur: false,
      theme: 'light',
      material: 'liquid',
      otpToastSeconds: 30,
    },
  });
  const entries = [
    { host: 'github.com', username: 'octocat@example.com', password: 'gh-pass-1', totpSecret: 'JBSWY3DPEHPK3PXP', tags: ['work'] },
    { host: 'github.com', username: 'octocat-personal', password: 'gh-pass-2', tags: ['personal'] },
    { host: 'example.com', username: 'alice@example.com', password: 'ex-pass-1' },
    { host: 'example.com', username: 'bob', password: 'ex-pass-2', totpSecret: 'JBSWY3DPEHPK3PXP' },
    { host: 'gitee.com', username: 'gitee-user', password: 'gitee-pass', totpSecret: 'JBSWY3DPEHPK3PXP' },
    { host: '127.0.0.1', username: 'octocat@example.com', password: 'gh-pass-1', totpSecret: 'JBSWY3DPEHPK3PXP' },
    { host: '127.0.0.1', username: 'octocat-work', password: 'gh-pass-2' },
  ];
  for (const entry of entries) await chrome.runtime.sendMessage({ type: 'SV_ADD_ENTRY', entry });
});
await options.reload();
await options.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
await options.waitForTimeout(700);

// Delete two entries that are not needed for the popup shot so the trash
// dialog has content (the 127.0.0.1 entries stay, the popup reads that host).
await options.evaluate(async () => {
  const list = await chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' });
  const entries = list.entries || list.items || [];
  const victims = entries.filter((entry) => entry.host !== '127.0.0.1').slice(0, 2);
  for (const entry of victims) {
    await chrome.runtime.sendMessage({ type: 'SV_DELETE_ENTRY', id: entry.id });
  }
});
await options.reload();
await options.waitForSelector('.entry-card', { timeout: 15000 });
await options.waitForTimeout(800);

await options.screenshot({ path: path.join(out, 'ui-2.5.0-vault.png') });

await options.click('#openTrashBtn');
await options.waitForSelector('#trashDialog[open]', { timeout: 8000 });
await options.waitForTimeout(500);
await options.screenshot({ path: path.join(out, 'ui-2.5.0-trash-dialog.png') });
const trashShot = {
  dialogOpen: await options.locator('#trashDialog[open]').count(),
  badge: await options.locator('#trashCount').innerText(),
  rows: await options.locator('#trashList .trash-row').count(),
  listScrollable: await options.evaluate(() => {
    const list = document.querySelector('#trashList');
    if (!list) return null;
    const style = getComputedStyle(list);
    return { maxHeight: style.maxHeight, overflowY: style.overflowY };
  }),
};
await options.click('#trashClose');

// Popup with a TOTP account. A local page stands in for the site tab so the
// screenshot does not depend on network access.
const http = await import('node:http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>github.com</title><h1>Sign in</h1>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const sitePort = server.address().port;
const site = await context.newPage();
await site.goto(`http://127.0.0.1:${sitePort}/`);
await site.waitForTimeout(600);

const popupUrl = `chrome-extension://${id}/src/popup/popup.html`;
// The popup resolves the site from the *active* tab, so the site tab must stay
// active: open the popup as a background tab from that page.
await options.evaluate(async (url) => {
  const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
  await chrome.tabs.create({ url, active: false });
}, popupUrl);
await options.waitForTimeout(1500);
const popup = context.pages().find((p) => p.url() === popupUrl);
if (!popup) throw new Error('popup tab not found');
await popup.waitForTimeout(2200);
// The popup resolves the site from the active tab, so it must stay backgrounded
// while rendering. Background tabs cannot be screenshotted through the normal
// API, so capture the surface over CDP instead of bringing it to the front
// (which would make the popup itself the active tab and empty the list).
const popupShot = await popup.evaluate(() => {
  const rows = [...document.querySelectorAll('.entry-row')].map((row) => ({
    user: row.querySelector('.entry-user')?.textContent?.trim() || '',
    hasHost: Boolean(row.querySelector('.entry-title')),
    meta: row.querySelector('.entry-meta')?.textContent?.trim() || '',
    otp: row.querySelector('.entry-otp strong')?.textContent?.trim() || '',
  }));
  const otp = document.querySelector('.entry-otp strong');
  return {
    rows,
    otpFontSize: otp ? getComputedStyle(otp).fontSize : null,
    host: document.querySelector('#siteHost')?.textContent || null,
    locked: !document.querySelector('#lockedView')?.hidden,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
  };
});
const cdp = await context.newCDPSession(popup);
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 400,
  height: 640,
  deviceScaleFactor: 1,
  mobile: false,
});
await popup.waitForTimeout(400);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(path.join(out, 'ui-2.5.0-popup.png'), Buffer.from(shot.data, 'base64'));
await cdp.send('Emulation.clearDeviceMetricsOverride');

console.log(JSON.stringify({ trashShot, popupShot }, null, 2));
await context.close();
