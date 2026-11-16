import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const PROFILE = path.join(ROOT, '.tmp-v2', String(Date.now()));
const MASTER = 'SubVault-Test-2026!Qm7#';
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body>
    <form>
      <input id="fullName" name="fullName" placeholder="姓名" />
      <input id="email" name="email" type="email" />
      <input id="phone" name="phone" type="tel" />
      <textarea id="address" name="address"></textarea>
    </form>
  </body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = worker.url().split('/')[2];
const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await options.waitForSelector('#gate');

const errors = [];
options.on('pageerror', (error) => errors.push(String(error)));
const send = (message) => options.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const result = {};

await send({ type: 'SV_SETUP', password: MASTER });
await send({ type: 'SV_SET_SETTINGS', settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 } });

const saved = await send({ type: 'SV_SAVE_PROFILE', profile: {
  name: '个人资料',
  fullName: 'Alice Example',
  email: 'alice@example.com',
  phone: '+86 138 0000 0000',
  address: 'Example Street 1',
} });
result.profileSaved = saved.ok === true;

const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/profile`);
await page.waitForSelector('#fullName');
const tabId = await options.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*'] });
  return tabs[0]?.id;
});
const fill = await options.evaluate(async ({ tabId, id }) => {
  return await new Promise((resolve) => chrome.tabs.sendMessage(tabId, { type: 'SV_FILL_PROFILE_BY_ID', id }, (response) => resolve(response || { ok: false })));
}, { tabId, id: saved.profile.id });
result.fillOk = fill.ok === true;
result.filled = await page.evaluate(() => ({
  fullName: document.querySelector('#fullName').value,
  email: document.querySelector('#email').value,
  phone: document.querySelector('#phone').value,
  address: document.querySelector('#address').value,
}));

const created = await send({ type: 'SV_CREATE_VAULT', name: '工作库', password: MASTER });
result.vaultCreated = created.ok === true && Boolean(created.activeVaultId);
await send({ type: 'SV_UNLOCK', password: MASTER, vaultId: created.activeVaultId });
await send({ type: 'SV_ADD_ENTRY', entry: { host: 'work.example.com', username: 'work-user', password: 'work-secret-1' } });
const workCount = await send({ type: 'SV_LIST_ENTRIES' });
result.workEntries = workCount.stats?.total;
await send({ type: 'SV_UNLOCK', password: MASTER, vaultId: 'default' });
const merged = await send({ type: 'SV_MERGE_VAULT', vaultId: created.activeVaultId, password: MASTER });
result.merged = merged.ok === true ? merged : merged;
const afterMerge = await send({ type: 'SV_LIST_ENTRIES' });
result.defaultEntries = afterMerge.stats?.total;
result.profileListed = await options.evaluate(async () => {
  const response = await chrome.runtime.sendMessage({ type: 'SV_LIST_PROFILES' });
  return response.profiles?.length;
});
result.errors = errors;
result.pass = result.profileSaved
  && result.fillOk
  && result.filled.fullName === 'Alice Example'
  && result.filled.email === 'alice@example.com'
  && result.filled.phone === '+86 138 0000 0000'
  && result.filled.address === 'Example Street 1'
  && result.vaultCreated
  && result.workEntries === 1
  && result.merged.ok === true
  && result.defaultEntries === 1
  && result.profileListed === 1
  && errors.length === 0;
console.log(JSON.stringify(result, null, 2));
await context.close();
server.close();
fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!result.pass) process.exit(1);
