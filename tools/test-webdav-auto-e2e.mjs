import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-webdav-auto-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const base = path.join(root, '.tmp-webdav-auto', String(Date.now()));
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
const archives = new Map();

function multistatus() {
  const items = [];
  if (exists) {
    items.push({ name: 'state.json', size: body.length, modified: new Date(2026, 0, 1, 0, 0, 0).toUTCString() });
  }
  for (const [name, item] of archives) {
    items.push({ name, size: item.buf.length, modified: new Date(item.modified).toUTCString() });
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${items
    .map(
      (item) =>
        `<d:response><d:href>/dav/subvault/${item.name}</d:href><d:propstat><d:prop><d:getlastmodified>${item.modified}</d:getlastmodified><d:getcontentlength>${item.size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
    )
    .join('')}</d:multistatus>`;
}

const server = http.createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const auth = req.headers.authorization || '';
  const expected = `Basic ${Buffer.from(`${davUser}:${davPass}`).toString('base64')}`;
  if (auth !== expected) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="subvault"' }); res.end(); return; }
  const archiveMatch = /^\/dav\/subvault\/([^/]+\.json)$/.exec(req.url);
  if (archiveMatch && archiveMatch[1] !== 'state.json') {
    if (req.method === 'DELETE') {
      if (!archives.delete(archiveMatch[1])) { res.writeHead(404); res.end('missing'); return; }
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'PUT') { res.writeHead(405); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.headers['if-none-match'] === '*' && archives.has(archiveMatch[1])) { res.writeHead(412); res.end(); return; }
      archives.set(archiveMatch[1], { buf: Buffer.concat(chunks), modified: Date.now() });
      res.writeHead(201); res.end();
    });
    return;
  }
  if (req.url === '/dav/subvault' && req.method === 'PROPFIND') {
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(multistatus());
    return;
  }
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
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
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

const results = {};
let app = null;
try {
  app = await openExtension(path.join(base, 'profile'));
  const setup = await send(app.page, 'SV_SETUP', { password });
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await send(app.page, 'SV_SET_SETTINGS', {
    settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
  });

  results.setConfig = await send(app.page, 'SV_SET_WEBDAV', {
    webdav: { url: davUrl, username: davUser, password: davPass },
  });
  if (!results.setConfig?.ok) throw new Error(`set config: ${results.setConfig?.error}`);
  await send(app.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.com', username: 'alice', password: 'alice-secret' },
  });

  // Auto backup is off by default: a tick must skip instead of writing.
  results.defaultStatus = await send(app.page, 'SV_WEBDAV_BACKUP_STATUS');
  results.disabledTick = await send(app.page, 'SV_WEBDAV_BACKUP_RUN', { force: false });
  results.disabledDidNotBackup = !exists;

  // Seed two old archive copies so the retention rule has work to do.
  for (const name of ['subvault-20200101-000000.json', 'subvault-20200102-000000.json']) {
    archives.set(name, { buf: Buffer.from('{"seed":true}', 'utf8'), modified: Date.UTC(2020, 0, 1) });
  }
  results.seededCount = archives.size;

  // Enabling schedules the alarm and persists the interval.
  await send(app.page, 'SV_SET_SETTINGS', {
    settings: {
      webdavAutoBackup: true,
      webdavAutoBackupHours: 2,
      webdavKeepCopies: 2,
      webdavArchiveDays: 0,
    },
  });
  results.enabledStatus = await send(app.page, 'SV_WEBDAV_BACKUP_STATUS');
  results.alarm = await app.page.evaluate(async () => {
    const list = await chrome.alarms.getAll();
    const alarm = list.find((item) => item.name === 'subvault-webdav-backup');
    return alarm ? { periodInMinutes: alarm.periodInMinutes } : null;
  });

  // First forced run writes state.json, one archive copy, then prunes to keep=2.
  results.firstRun = await send(app.page, 'SV_WEBDAV_BACKUP_RUN');
  results.firstArchiveName = results.firstRun?.name || '';
  results.firstArchiveCount = archives.size;
  results.firstPruneDeleted = results.firstRun?.pruned?.deleted || [];

  // A second run inside the same second collides on the archive name: the host
  // must report it rather than overwrite the existing copy.
  await send(app.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.org', username: 'bob', password: 'bob-secret' },
  });
  results.secondRun = await send(app.page, 'SV_WEBDAV_BACKUP_RUN');
  results.secondArchiveCount = archives.size;
  results.secondArchiveError = results.secondRun?.archiveError || '';
  // The archive name is second-resolution, so a second backup either collides
  // with the first (same second → 412, reported as archiveError) or writes a
  // new copy. Both are correct; assert whichever branch actually happened
  // instead of depending on wall-clock timing.
  results.secondName = results.secondRun?.name || '';
  results.secondCollided = results.secondName === results.firstArchiveName;
  results.secondBranchOk = results.secondCollided
    ? /历史备份副本写入失败/.test(results.secondArchiveError) && results.secondArchiveCount === 2
    : results.secondArchiveError === '' && results.secondArchiveCount === 3;

  results.history = await send(app.page, 'SV_WEBDAV_HISTORY');
  results.historyNames = (results.history?.archives || []).map((item) => item.name);

  // Seed one aged copy so the age rule has a deterministic target regardless
  // of how many same-day copies the two runs above produced.
  archives.set('subvault-20250101-000000.json', {
    buf: Buffer.from('{"aged":true}', 'utf8'),
    modified: Date.now() - 60 * 24 * 60 * 60 * 1000,
  });
  const beforePrune = archives.size;
  // keep=0 + olderThanDays drops only the aged copies, never today's.
  results.pruneByAge = await send(app.page, 'SV_WEBDAV_PRUNE', { keep: 0, olderThanDays: 30 });
  results.pruneRemaining = archives.size;
  // Every aged copy goes (the seeded one plus any 2020 leftover the earlier
  // keep=2 prune retained), and today's copy must survive.
  const prunedNames = results.pruneByAge?.deleted || [];
  results.pruneRemovedOnlyAged =
    prunedNames.includes('subvault-20250101-000000.json')
    && !prunedNames.includes(results.firstArchiveName)
    && results.pruneRemaining === beforePrune - prunedNames.length
    && archives.has(results.firstArchiveName);
  results.pruneNoop = await send(app.page, 'SV_WEBDAV_PRUNE', { keep: 0, olderThanDays: 0 });

  // A fresh backup means the next automatic tick is not due.
  results.notDueTick = await send(app.page, 'SV_WEBDAV_BACKUP_RUN', { force: false });
  results.notDueSkipped = results.notDueTick?.skipped || '';

  // UI wiring.
  await app.page.evaluate(() => document.querySelector('[data-section="sync"]')?.click());
  await app.page.waitForSelector('#webdavCard', { state: 'attached', timeout: 10000 });
  await app.page.evaluate(() => { const shield = document.getElementById('privacyShield'); if (shield) shield.hidden = true; });
  await app.page.waitForTimeout(400);
  results.ui = await app.page.evaluate(() => ({
    autoToggle: Boolean(document.getElementById('webdavAutoBackup')),
    autoChecked: document.getElementById('webdavAutoBackup')?.checked,
    hours: document.getElementById('webdavAutoBackupHours')?.value,
    keep: document.getElementById('webdavKeepCopies')?.value,
    days: document.getElementById('webdavArchiveDays')?.value,
    autoMeta: document.getElementById('webdavAutoMeta')?.textContent?.trim(),
    historyBtn: Boolean(document.getElementById('webdavHistoryBtn')),
    pruneBtn: Boolean(document.getElementById('webdavPruneBtn')),
  }));

  // History list renders after clicking the button.
  await app.page.evaluate(() => {
    const shield = document.getElementById('privacyShield');
    if (shield) shield.hidden = true;
    document.getElementById('webdavHistoryBtn')?.click();
  });
  await app.page.waitForTimeout(1200);
  results.historyUi = await app.page.evaluate(() => ({
    visible: !document.getElementById('webdavHistoryList')?.hidden,
    rows: document.querySelectorAll('#webdavHistoryList .archive-row').length,
    newest: Boolean(document.querySelector('#webdavHistoryList .archive-row.is-newest')),
    firstName: document.querySelector('#webdavHistoryList .archive-name')?.textContent?.trim() || '',
  }));

  results.pass = Boolean(
    results.setConfig?.ok
    && results.defaultStatus?.autoBackup === false
    && results.disabledTick?.skipped === 'disabled'
    && results.disabledDidNotBackup
    && results.seededCount === 2
    && results.enabledStatus?.autoBackup === true
    && results.enabledStatus?.autoBackupHours === 2
    && results.enabledStatus?.keepCopies === 2
    && results.enabledStatus?.archiveDays === 0
    && results.alarm?.periodInMinutes === 120
    && results.firstRun?.ok
    && /^subvault-\d{8}-\d{6}\.json$/.test(results.firstArchiveName)
    && results.firstPruneDeleted?.length === 1
    && results.firstPruneDeleted?.[0] === 'subvault-20200101-000000.json'
    && results.firstArchiveCount === 2
    && results.secondRun?.ok
    && results.secondBranchOk
    && results.history?.ok
    && results.history?.count === results.secondArchiveCount
    && results.pruneByAge?.ok
    && results.pruneRemovedOnlyAged
    && results.pruneNoop?.ok
    && results.pruneNoop?.deleted?.length === 0
    && typeof results.pruneNoop?.skipped === 'string'
    && results.notDueSkipped === 'not-due'
    && results.ui?.autoToggle
    && results.ui?.autoChecked === true
    && results.ui?.hours === '2'
    && results.ui?.keep === '2'
    && results.ui?.days === '0'
    && /下次自动备份/.test(results.ui?.autoMeta || '')
    && results.ui?.historyBtn
    && results.ui?.pruneBtn
    && results.historyUi?.visible
    && results.historyUi?.rows >= 1
    && results.historyUi?.newest
  );
} catch (error) {
  results.error = String(error?.stack || error);
  results.pass = false;
} finally {
  if (app) await app.context.close().catch(() => {});
  server.close();
}
console.log(JSON.stringify({ ...results, requests, errors }, null, 2));
process.exit(results.pass && errors.length === 0 ? 0 : 1);
