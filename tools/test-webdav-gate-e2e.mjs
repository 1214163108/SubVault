import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-webdav-gate-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const base = path.join(root, '.tmp-webdav-gate', String(Date.now()));
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
  return { context, page, id };
}
const send = (page, type, payload = {}) =>
  page.evaluate(([kind, extra]) => chrome.runtime.sendMessage({ type: kind, ...extra }), [type, payload]);

const results = {};
let host = null;
let fresh = null;
try {
  // Profile A creates the vault and publishes it to WebDAV.
  host = await openExtension(path.join(base, 'profile-a'));
  const setup = await send(host.page, 'SV_SETUP', { password });
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await send(host.page, 'SV_SET_SETTINGS', {
    settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
  });
  const cfg = await send(host.page, 'SV_SET_WEBDAV', {
    webdav: { url: davUrl, username: davUser, password: davPass },
  });
  if (!cfg?.ok) throw new Error(`set webdav: ${cfg?.error}`);
  await send(host.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.com', username: 'alice', password: 'alice-secret' },
  });
  await send(host.page, 'SV_ADD_ENTRY', {
    entry: { host: 'example.org', username: 'bob', password: 'bob-secret' },
  });
  results.hostBackup = await send(host.page, 'SV_WEBDAV_BACKUP_NOW');
  results.remoteExists = exists;
  await host.context.close();
  host = null;

  // Profile B is a brand-new install: the gate must offer the WebDAV wizard.
  fresh = await openExtension(path.join(base, 'profile-b'));
  await fresh.page.waitForSelector('#gate', { state: 'visible', timeout: 10000 });
  // The gate runs an async "is there an existing vault?" probe. This machine has
  // a native sync host installed, so a fresh profile may be offered the import
  // prompt first; pick "new install" to reach the setup form.
  await fresh.page.waitForSelector('#gateImportPrompt, #gateSetupForm', { state: 'visible', timeout: 15000 });
  results.importPromptShown = await fresh.page.locator('#gateImportPrompt').isVisible();
  if (results.importPromptShown) {
    await fresh.page.locator('#gateNewInstall').click();
  }
  await fresh.page.waitForSelector('#gateSetupForm', { state: 'visible', timeout: 10000 });
  results.gateTitle = (await fresh.page.locator('#gateTitle').innerText()).trim();
  results.setupVisible = await fresh.page.locator('#gateSetupForm').isVisible();
  results.webdavOpenVisible = await fresh.page.locator('#gateWebdavOpen').isVisible();
  results.webdavFormHiddenInitially = await fresh.page.locator('#gateWebdavForm').isHidden();

  await fresh.page.locator('#gateWebdavOpen').click();
  await fresh.page.waitForTimeout(300);
  results.webdavFormVisible = await fresh.page.locator('#gateWebdavForm').isVisible();
  results.setupHiddenAfterOpen = await fresh.page.locator('#gateSetupForm').isHidden();

  // Back returns to the setup form without leaving the gate.
  await fresh.page.locator('#gateWebdavBack').click();
  await fresh.page.waitForTimeout(200);
  results.backToSetup = await fresh.page.locator('#gateSetupForm').isVisible();
  results.backHidWebdav = await fresh.page.locator('#gateWebdavForm').isHidden();

  // Validation: missing URL / bad protocol / missing master password.
  await fresh.page.locator('#gateWebdavOpen').click();
  await fresh.page.waitForTimeout(200);
  await fresh.page.locator('#gateWebdavBtn').click();
  await fresh.page.waitForTimeout(300);
  results.errorNoUrl = (await fresh.page.locator('#gateError').innerText()).trim();

  await fresh.page.locator('#gateWebdavUrl').fill('ftp://example.com/dav');
  await fresh.page.locator('#gateWebdavMaster').fill(password);
  await fresh.page.locator('#gateWebdavBtn').click();
  await fresh.page.waitForTimeout(300);
  results.errorBadProtocol = (await fresh.page.locator('#gateError').innerText()).trim();

  await fresh.page.locator('#gateWebdavUrl').fill(davUrl);
  await fresh.page.locator('#gateWebdavMaster').fill('');
  await fresh.page.locator('#gateWebdavBtn').click();
  await fresh.page.waitForTimeout(300);
  results.errorNoMaster = (await fresh.page.locator('#gateError').innerText()).trim();

  // Wrong master password (with valid credentials) must not create a local vault.
  await fresh.page.locator('#gateWebdavUsername').fill(davUser);
  await fresh.page.locator('#gateWebdavPassword').fill(davPass);
  await fresh.page.locator('#gateWebdavMaster').fill('Wrong-Master-Pass-2026!zz');
  await fresh.page.locator('#gateWebdavBtn').click();
  await fresh.page.waitForTimeout(3000);
  results.wrongMasterError = (await fresh.page.locator('#gateError').innerText()).trim();
  results.stillOnGate = await fresh.page.locator('#gate').isVisible();
  results.noLocalVault = await fresh.page.evaluate(async () => {
    const status = await chrome.runtime.sendMessage({ type: 'SV_GET_STATUS' });
    return status?.initialized === false;
  });

  // The real restore: form fields plus master password.
  await fresh.page.locator('#gateWebdavUrl').fill(davUrl);
  await fresh.page.locator('#gateWebdavUsername').fill(davUser);
  await fresh.page.locator('#gateWebdavPassword').fill(davPass);
  await fresh.page.locator('#gateWebdavMaster').fill(password);
  await fresh.page.locator('#gateWebdavBtn').click();
  await fresh.page.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });
  results.gateHiddenAfterRestore = await fresh.page.locator('#gate').isHidden();
  results.shellVisible = await fresh.page.locator('#shell').isVisible();

  const listed = await send(fresh.page, 'SV_LIST_ENTRIES');
  results.restoredUsers = (listed?.entries || []).map((entry) => entry.username).sort();
  results.unlocked = !(await send(fresh.page, 'SV_GET_STATUS'))?.locked;

  // The imported config is persisted, so a later manual backup works without re-entering it.
  results.afterStatus = await send(fresh.page, 'SV_WEBDAV_BACKUP_STATUS');
  results.savedConfigUrl = results.afterStatus?.configured === true;

  await fresh.page.locator('#vaultList .entry-card').first().waitFor({ timeout: 10000 });
  results.listRows = await fresh.page.locator('#vaultList .entry-card').count();
  results.masterCleared = await fresh.page.locator('#gateWebdavMaster').inputValue();

  results.pass = Boolean(
    results.hostBackup?.ok
    && results.remoteExists
    && /创建本地密码库/.test(results.gateTitle)
    && results.setupVisible
    && results.webdavOpenVisible
    && results.webdavFormHiddenInitially
    && results.webdavFormVisible
    && results.setupHiddenAfterOpen
    && results.backToSetup
    && results.backHidWebdav
    && /请填写 WebDAV 地址/.test(results.errorNoUrl)
    && /必须使用 HTTPS/.test(results.errorBadProtocol)
    && /请输入该备份的主密码/.test(results.errorNoMaster)
    && /主密码|解密|密码不正确/.test(results.wrongMasterError)
    && results.stillOnGate
    && results.noLocalVault
    && results.gateHiddenAfterRestore
    && results.shellVisible
    && results.restoredUsers?.includes('alice')
    && results.restoredUsers?.includes('bob')
    && results.unlocked
    && results.savedConfigUrl
    && results.listRows === 2
    && results.masterCleared === ''
  );
} catch (error) {
  results.error = String(error?.stack || error);
  results.pass = false;
} finally {
  if (host) await host.context.close().catch(() => {});
  if (fresh) await fresh.context.close().catch(() => {});
  server.close();
}
console.log(JSON.stringify({ ...results, requests, errors }, null, 2));
process.exit(results.pass && errors.length === 0 ? 0 : 1);
