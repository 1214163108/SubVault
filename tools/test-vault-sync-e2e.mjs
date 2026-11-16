import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-vault-sync', String(Date.now()));
const profile = path.join(root, '.tmp-vault-sync', 'profile');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
  ],
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
});
let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
const id = worker.url().split('/')[2];
const page = await context.newPage();
await page.goto(`chrome-extension://${id}/src/options/options.html`);
await page.waitForSelector('#gate');

const send = (message) => page.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
const master = 'SubVault-Test-2026!Qm7#';
const result = {};

await send({ type: 'SV_SETUP', password: master });
await send({ type: 'SV_SET_SETTINGS', settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 } });
await send({ type: 'SV_ADD_ENTRY', entry: { host: 'default.example.com', username: 'default-user', password: 'default-secret-1' } });
await send({ type: 'SV_SYNC_NOW' });
await page.waitForTimeout(1500);
const statusDefault = await send({ type: 'SV_SYNC_STATUS' });
result.defaultRevision = statusDefault.revision;
result.defaultTransport = statusDefault.transport;
result.defaultPath = statusDefault.path;

const created = await send({ type: 'SV_CREATE_VAULT', name: '工作库', password: master });
result.workId = created.activeVaultId;
await send({ type: 'SV_UNLOCK', password: master, vaultId: created.activeVaultId });
await send({ type: 'SV_ADD_ENTRY', entry: { host: 'work.example.com', username: 'work-user', password: 'work-secret-1' } });
await send({ type: 'SV_SYNC_NOW' });
await page.waitForTimeout(1500);
const statusWork = await send({ type: 'SV_SYNC_STATUS' });
result.workRevision = statusWork.revision;
result.workPath = statusWork.path;
result.workActive = statusWork.activeVaultId;

const files = fs.readdirSync(syncDir).filter((name) => name.endsWith('.json')).sort();
result.files = files;
result.defaultFile = files.includes('state.json');
result.workFile = files.includes(`vault-${created.activeVaultId}.json`);
const defaultState = JSON.parse(fs.readFileSync(path.join(syncDir, 'state.json'), 'utf8'));
const workState = JSON.parse(fs.readFileSync(path.join(syncDir, `vault-${created.activeVaultId}.json`), 'utf8'));
result.defaultRevisionOnDisk = defaultState.revision;
result.workRevisionOnDisk = workState.revision;

await send({ type: 'SV_UNLOCK', password: master, vaultId: 'default' });
await send({ type: 'SV_SYNC_NOW' });
await page.waitForTimeout(1200);
const entries = await send({ type: 'SV_LIST_ENTRIES' });
result.defaultEntries = entries.entries?.map((entry) => entry.username);
const statusBack = await send({ type: 'SV_SYNC_STATUS' });
result.backRevision = statusBack.revision;
result.backPath = statusBack.path;
result.errors = errors;
result.pass = result.defaultRevision >= 1
  && result.workRevision >= 1
  && result.defaultFile
  && result.workFile
  && result.defaultEntries?.length === 1
  && result.defaultEntries[0] === 'default-user'
  && statusBack.revision === defaultState.revision
  && errors.length === 0;
console.log(JSON.stringify(result, null, 2));
await context.close();
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.rmSync(syncDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!result.pass) process.exit(1);
