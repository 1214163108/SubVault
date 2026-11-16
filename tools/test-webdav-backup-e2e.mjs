import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, '.tmp-webdav-backup', String(Date.now()));
const password = 'SubVault-Test-2026!Qm7#';
const davUser = 'alice';
const davPass = 'webdav-pass';
try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* ignore */ }
fs.mkdirSync(base, { recursive: true });

let exists = false;
let collection = false;
let body = Buffer.alloc(0);
let etag = '"v0"';
let counter = 0;
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const auth = req.headers.authorization || '';
  const expected = `Basic ${Buffer.from(`${davUser}:${davPass}`).toString('base64')}`;
  if (auth !== expected) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="subvault"' }); res.end(); return; }
  if (req.url !== '/dav/subvault/state.json' && req.url !== '/dav/subvault') { res.writeHead(404); res.end(); return; }
  if (req.method === 'MKCOL') { collection = true; res.writeHead(201); res.end(); return; }
  if (!collection) { res.writeHead(req.method === 'GET' ? 404 : 409); res.end(); return; }
  if (req.method === 'GET') {
    if (!exists) { res.writeHead(404); res.end(); return; }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag }); res.end(body); return;
  }
  if (req.method === 'PUT') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.headers['if-none-match'] === '*' && exists) { res.writeHead(412); res.end(); return; }
      if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412); res.end(); return; }
      body = Buffer.concat(chunks); exists = true; counter += 1; etag = `"v${counter}"`;
      res.writeHead(201, { ETag: etag }); res.end();
    });
    return;
  }
  res.writeHead(405); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const davUrl = `http://127.0.0.1:${server.address().port}/dav`;
const errors = [];

async function openExtension(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--no-first-run', '--no-default-browser-check',
      '--window-position=-32000,-32000', '--window-size=920,900',
    ],
    locale: 'zh-CN',
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = worker.url().split('/')[2];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`chrome-extension://${id}/src/options/options.html`);
  await page.waitForSelector('#syncStateTag', { state: 'attached', timeout: 10000 });
  return { context, page };
}
const send = (page, type, payload = {}) =>
  page.evaluate(([kind, extra]) => chrome.runtime.sendMessage({ type: kind, ...extra }), [type, payload]);
const noIdle = (page) => send(page, 'SV_SET_SETTINGS', {
  settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
});

const results = {};
let app = null;
try {
  app = await openExtension(path.join(base, 'profile'));
  const setup = await send(app.page, 'SV_SETUP', { password });
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await noIdle(app.page);
  results.setConfig = await send(app.page, 'SV_SET_WEBDAV', {
    webdav: { url: davUrl, username: davUser, password: davPass },
  });
  if (!results.setConfig?.ok) throw new Error(`set config: ${results.setConfig?.error}`);

  await send(app.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.com', username: 'alice', password: 'alice-secret' },
  });
  results.backup = await send(app.page, 'SV_WEBDAV_BACKUP_NOW');
  results.exists = exists;
  results.revision = counter;
  const envelope = JSON.parse(body.toString('utf8'));
  results.envelopeVault = Boolean(envelope.vault?.box);
  results.envelopeRevision = envelope.revision;

  await send(app.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.org', username: 'bob', password: 'bob-secret' },
  });
  const before = await send(app.page, 'SV_LIST_ENTRIES');
  results.beforeRestore = before.entries?.map((entry) => entry.username).sort();

  await app.page.evaluate(() => document.querySelector('[data-section="sync"]')?.click());
  await app.page.waitForTimeout(500);
  results.sectionDebug = await app.page.evaluate(() => ({
    active: document.querySelector('.section.active')?.id || '',
    sectionSyncHidden: document.getElementById('section-sync')?.hidden,
    gap: document.getElementById('gate')?.hidden,
    card: Boolean(document.getElementById('webdavCard')),
  }));
  await app.page.waitForSelector('#webdavCard', { state: 'attached', timeout: 10000 });
  await app.page.evaluate(() => { const shield = document.getElementById('privacyShield'); if (shield) shield.hidden = true; });
  await app.page.waitForTimeout(400);
  results.ui = await app.page.evaluate(() => ({
    transportSelect: Boolean(document.getElementById('syncTransportSelect')),
    webdavCard: Boolean(document.getElementById('webdavCard')),
    tag: document.getElementById('webdavBackupTag')?.textContent?.trim(),
    meta: document.getElementById('webdavBackupMeta')?.textContent?.trim(),
    backupVisible: Boolean(document.getElementById('webdavBackupBtn')),
    restoreVisible: Boolean(document.getElementById('webdavRestoreBtn')),
  }));

  results.restore = await send(app.page, 'SV_WEBDAV_RESTORE', { password, keyFileBase64: '' });
  const statusAfter = await send(app.page, 'SV_GET_STATUS');
  results.lockedAfterRestore = statusAfter.locked;
  const unlock = await send(app.page, 'SV_UNLOCK', { password });
  results.unlockAfterRestore = unlock?.ok;
  const after = await send(app.page, 'SV_LIST_ENTRIES');
  results.afterRestore = after.entries?.map((entry) => entry.username).sort();
  results.backupStatus = await send(app.page, 'SV_WEBDAV_BACKUP_STATUS');
  results.requests = requests;
  results.pass = Boolean(
    results.setConfig?.ok
    && results.backup?.ok
    && results.exists
    && results.revision >= 1
    && results.envelopeVault
    && results.beforeRestore?.includes('alice')
    && results.beforeRestore?.includes('bob')
    && results.ui?.transportSelect === false
    && results.ui?.webdavCard === true
    && results.ui?.tag === '已备份'
    && results.ui?.backupVisible
    && results.restore?.ok
    && results.lockedAfterRestore === true
    && results.unlockAfterRestore === true
    && results.afterRestore?.includes('alice')
    && !results.afterRestore?.includes('bob')
    && results.backupStatus?.ok
  );
} catch (error) {
  results.error = String(error?.stack || error);
  results.pass = false;
} finally {
  if (app) await app.context.close().catch(() => {});
  server.close();
}
console.log(JSON.stringify({ ...results, errors }, null, 2));
process.exit(results.pass && errors.length === 0 ? 0 : 1);
