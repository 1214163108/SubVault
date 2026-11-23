import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'screenshot-v260-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const profile = path.join(root, '.tmp-shot260');
const gateProfile = path.join(root, '.tmp-shot260-gate');
const out = path.join(root, 'docs');
for (const dir of [profile, gateProfile]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const MASTER = 'Shot-Pass-2026!x9Kq7vT';
const SEED = [
  { host: 'github.com', username: 'octocat@example.com', password: 'gh-pass-1', totpSecret: 'JBSWY3DPEHPK3PXP', tags: ['work'] },
  { host: 'github.com', username: 'octocat-personal', password: 'gh-pass-2', tags: ['personal'] },
  { host: 'example.com', username: 'alice@example.com', password: 'ex-pass-1' },
  { host: 'example.com', username: 'bob', password: 'ex-pass-2', totpSecret: 'JBSWY3DPEHPK3PXP' },
  { host: 'gitee.com', username: 'gitee-user', password: 'gitee-pass', totpSecret: 'JBSWY3DPEHPK3PXP' },
  { host: '127.0.0.1', username: 'octocat@example.com', password: 'gh-pass-1', totpSecret: 'JBSWY3DPEHPK3PXP' },
  { host: '127.0.0.1', username: 'octocat-work', password: 'gh-pass-2' },
];

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--window-size=1180,940',
  ],
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const id = worker.url().split('/')[2];

const options = await context.newPage();
await options.setViewportSize({ width: 1180, height: 940 });
await options.goto(`chrome-extension://${id}/src/options/options.html`);
await options.evaluate(async (seed) => {
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
  for (const entry of seed) await chrome.runtime.sendMessage({ type: 'SV_ADD_ENTRY', entry });
}, SEED);
await options.reload();
await options.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
await options.waitForTimeout(900);

const vaultShot = await options.evaluate(() => ({
  stats: [...document.querySelectorAll('.stat')].map((el) => el.dataset.statFilter || ''),
  statTag: document.querySelector('.stat')?.tagName || null,
  healthRingTag: document.querySelector('#healthRing')?.tagName || null,
  navGroups: [...document.querySelectorAll('.nav-group-label')].map((el) => el.textContent.trim()),
  rowButtons: [...document.querySelectorAll('.entry-card .entry-actions button')].map((el) => el.className),
  favicons: document.querySelectorAll('.entry-avatar .entry-favicon').length,
}));
await options.screenshot({ path: path.join(out, 'ui-2.6.0-vault.png') });

// Flat row actions (v2.6.1 replaced the collapsed "more" menu).
const rowShot = await options.evaluate(() => {
  const card =
    document.querySelector('.entry-card:has(.entry-totp)') ||
    document.querySelector('.entry-card');
  return {
    items: [...card.querySelectorAll('.entry-actions button')].map((el) => el.textContent.trim()),
    totpChip: Boolean(card.querySelector('.entry-totp')),
    actionsSameRow: (() => {
      const actions = card.querySelector('.entry-actions');
      const main = card.querySelector('.entry-main');
      if (!actions || !main) return false;
      const a = actions.getBoundingClientRect();
      const m = main.getBoundingClientRect();
      return Math.abs(a.top - m.top) < m.height / 2;
    })(),
    cardHeight: Math.round(card.getBoundingClientRect().height),
  };
});
console.log('row actions:', JSON.stringify(rowShot));
await options.screenshot({ path: path.join(out, 'ui-2.6.1-entry-actions.png') });

// WebDAV auto-backup card in the sync section.
await options.click('[data-section="sync"]');
await options.waitForTimeout(500);
await options.evaluate(() => {
  const card = document.querySelector('#webdavCard');
  if (card) card.scrollIntoView({ block: 'start' });
});
await options.waitForTimeout(400);
const webdavShot = await options.evaluate(() => ({
  autoToggle: Boolean(document.querySelector('#webdavAutoBackup')),
  hours: document.querySelector('#webdavAutoBackupHours')?.value || null,
  keep: document.querySelector('#webdavKeepCopies')?.value || null,
  days: document.querySelector('#webdavArchiveDays')?.value || null,
  historyBtn: Boolean(document.querySelector('#webdavHistoryBtn')),
  pruneBtn: Boolean(document.querySelector('#webdavPruneBtn')),
}));
await options.screenshot({ path: path.join(out, 'ui-2.6.0-webdav-auto.png') });

// Popup with cross-site search results.
const http = await import('node:http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>127.0.0.1</title><h1>Sign in</h1>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const sitePort = server.address().port;
const site = await context.newPage();
await site.goto(`http://127.0.0.1:${sitePort}/`);
await site.waitForTimeout(600);

const popupUrl = `chrome-extension://${id}/src/popup/popup.html`;
await options.evaluate(async (url) => {
  const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
  await chrome.tabs.create({ url, active: false });
}, popupUrl);
await options.waitForTimeout(1500);
const popup = context.pages().find((p) => p.url() === popupUrl);
if (!popup) throw new Error('popup tab not found');
await popup.waitForSelector('.entry-row', { timeout: 15000 });
await popup.waitForTimeout(1800);

const capturePopup = async (file) => {
  const cdp = await context.newCDPSession(popup);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 400,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await popup.waitForTimeout(400);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, file), Buffer.from(shot.data, 'base64'));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
};

const popupSiteShot = await popup.evaluate(() => ({
  title: document.querySelector('#siteTitleText')?.textContent?.trim() || '',
  hasSearch: Boolean(document.querySelector('#popupSearch')),
  rows: document.querySelectorAll('.entry-row').length,
  height: Math.round(document.querySelector('.app')?.getBoundingClientRect().height || 0),
}));
await capturePopup('ui-2.6.1-popup.png');
await context.close();

// Fresh profile: the first-install WebDAV restore gate.
const gateContext = await chromium.launchPersistentContext(gateProfile, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--window-size=1180,940',
  ],
});
const gateWorker = gateContext.serviceWorkers()[0] || (await gateContext.waitForEvent('serviceworker'));
const gateId = gateWorker.url().split('/')[2];
const gate = await gateContext.newPage();
await gate.setViewportSize({ width: 1180, height: 940 });
await gate.goto(`chrome-extension://${gateId}/src/options/options.html`);
await gate.waitForSelector('#gateWebdavOpen', { timeout: 15000 });
const gateVisible = await gate.evaluate(() => {
  const btn = document.querySelector('#gateWebdavOpen');
  const style = btn ? getComputedStyle(btn) : null;
  return { hidden: btn?.hidden, display: style?.display, visibility: style?.visibility };
});
await gate.click('#gateWebdavOpen');
await gate.waitForSelector('#gateWebdavForm:not([hidden])', { timeout: 8000 });
await gate.waitForTimeout(400);
const gateShot = await gate.evaluate(() => ({
  formVisible: !document.querySelector('#gateWebdavForm')?.hidden,
  setupHidden: document.querySelector('#gateSetupForm')?.hidden,
  fields: ['gateWebdavUrl', 'gateWebdavUsername', 'gateWebdavPassword', 'gateWebdavMaster'].map(
    (id) => Boolean(document.getElementById(id)),
  ),
}));
await gate.screenshot({ path: path.join(out, 'ui-2.6.0-gate-webdav.png') });

console.log(
  JSON.stringify({ vaultShot, rowShot, webdavShot, popupSiteShot, gateVisible, gateShot }, null, 2),
);
// The local HTTP server keeps the event loop alive, so close everything and
// exit explicitly instead of waiting on context teardown.
server.close();
await gateContext.close().catch(() => {});
process.exit(0);
